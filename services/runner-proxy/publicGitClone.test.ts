import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRunnerProxy } from './server'

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'evolved-public-git-'))
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic',
        GIT_COMMITTER_EMAIL: 'synthetic@example.invalid', GIT_TERMINAL_PROMPT: '0', LANG: 'C' }
    const git = (args: string[], input?: string) => {
        const result = spawnSync('git', args, { env, input, encoding: 'utf8', timeout: 5000 })
        if (result.status !== 0) throw new Error('Synthetic Git fixture setup failed')
        return result.stdout.trim()
    }
    const clone = async (proxy: ReturnType<typeof createRunnerProxy>, repository: string, name = 'checkout') => {
        const replacement = new URL('/evolved-git/github.com/', proxy.server.url).toString()
        const child = Bun.spawn(['git', '-c', `url.${replacement}.insteadOf=https://github.com/`, '-c', 'protocol.version=2',
            'clone', '--quiet', `https://github.com/${repository}.git`, join(root, name)], { env, stdout: 'pipe', stderr: 'pipe' })
        const timer = setTimeout(() => child.kill(), 10_000)
        try {
            const output = await new Response(child.stderr).text()
            return { exitCode: await child.exited, output }
        } finally { clearTimeout(timer); child.kill() }
    }
    return { root, env, git, clone }
}

test('native public dependency clone works without a lease, project registration or GitHub account', async () => {
    const f = fixture(), exportRoot = join(f.root, 'export'), repository = join(exportRoot, 'public', 'dependency.git')
    mkdirSync(join(exportRoot, 'public'), { recursive: true })
    f.git(['init', '--bare', '--initial-branch=main', repository])
    const tree = f.git([`--git-dir=${repository}`, 'mktree'], '')
    const oid = f.git([`--git-dir=${repository}`, 'commit-tree', tree, '-m', 'Public synthetic dependency'])
    f.git([`--git-dir=${repository}`, 'update-ref', 'refs/heads/main', oid])
    let authorityCalls = 0, anonymousCalls = 0
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { authorityCalls++; return new Response(null, { status: 403 }) } })
    const leaseFile = join(f.root, 'no-lease-exists')
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'unregistered-project', port: 0,
        async publicGitFetcher(input, options) {
            anonymousCalls++
            const url = new URL(input), headers = new Headers(options.headers)
            expect(url.origin).toBe('https://github.com')
            expect(options.proxy).toBe('http://egress:3128')
            for (const name of ['authorization', 'cookie', 'x-github-token', 'x-target-url']) expect(headers.has(name)).toBe(false)
            const body = options.body ? Buffer.from(options.body as Uint8Array) : Buffer.alloc(0)
            const child = Bun.spawn(['git', 'http-backend'], { env: { ...f.env, GIT_PROJECT_ROOT: exportRoot, GIT_HTTP_EXPORT_ALL: '1',
                REQUEST_METHOD: options.method!, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_LENGTH: String(body.length),
                CONTENT_TYPE: headers.get('content-type') ?? '', HTTP_GIT_PROTOCOL: headers.get('git-protocol') ?? '' }, stdin: body, stdout: 'pipe', stderr: 'pipe' })
            const output = Buffer.from(await new Response(child.stdout).arrayBuffer())
            expect(await child.exited).toBe(0)
            const split = output.indexOf('\r\n\r\n'), resultHeaders = new Headers()
            let status = 200
            for (const line of output.subarray(0, split).toString().split('\r\n')) {
                const colon = line.indexOf(':'), key = line.slice(0, colon), value = line.slice(colon + 1).trim()
                if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0])
                else resultHeaders.set(key, value)
            }
            return new Response(output.subarray(split + 4), { status, headers: resultHeaders })
        },
    })
    try {
        const probe = await fetch(new URL('/evolved-git/github.com/public/dependency.git/info/refs?service=git-upload-pack', proxy.server.url), {
            headers: { authorization: 'Bearer SYNTHETIC_CLIENT_CANARY', cookie: 'session=SYNTHETIC_CLIENT_CANARY',
                'x-github-token': 'SYNTHETIC_CLIENT_CANARY', 'x-target-url': 'https://private.example' },
        })
        expect(probe.status).toBe(200); await probe.arrayBuffer()
        expect((await f.clone(proxy, 'public/dependency')).exitCode).toBe(0)
        expect(f.git(['-C', join(f.root, 'checkout'), 'rev-parse', 'HEAD'])).toBe(oid)
        expect(authorityCalls).toBe(0)
        expect(anonymousCalls).toBeGreaterThanOrEqual(3)
        expect(existsSync(leaseFile)).toBe(false)
    } finally { proxy.close(); hub.stop(true); rmSync(f.root, { recursive: true, force: true }) }
}, 20_000)

test('private ungranted clone remains denied and push never attempts anonymous access', async () => {
    const f = fixture(), leaseFile = join(f.root, 'lease'), token = 'p'.repeat(43)
    writeFileSync(leaseFile, 'synthetic-private-lease', { mode: 0o600 })
    let anonymousCalls = 0, exchanges = 0, privateCalls = 0
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/api/evolved/runner/token') {
            exchanges++
            expect(request.headers.get('authorization')).toBe('Bearer synthetic-private-lease')
            return Response.json({ token, projectId: 'project', expiresAt: Date.now() + 900_000 })
        }
        privateCalls++
        expect(request.headers.get('authorization')).toBe(`Bearer ${token}`)
        return new Response('Repository operation is not granted.', { status: 403 })
    } })
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'project', port: 0,
        async publicGitFetcher(_url, options) {
            anonymousCalls++
            expect(new Headers(options.headers).has('authorization')).toBe(false)
            return new Response(null, { status: 404 })
        },
    })
    try {
        const cloned = await f.clone(proxy, 'private/ungranted')
        expect(cloned.exitCode).not.toBe(0)
        expect(cloned.output).not.toContain(token)
        expect(cloned.output).not.toContain('synthetic-private-lease')
        expect(anonymousCalls).toBe(1)
        expect(exchanges).toBe(1)
        expect(privateCalls).toBe(1)
        const push = await fetch(new URL('/evolved-git/github.com/private/ungranted.git/info/refs?service=git-receive-pack', proxy.server.url))
        expect(push.status).toBe(403); await push.body?.cancel()
        expect(anonymousCalls).toBe(1)
        expect(privateCalls).toBe(2)
    } finally { proxy.close(); hub.stop(true); rmSync(f.root, { recursive: true, force: true }) }
}, 20_000)

test('cancelled public downloads release proxy transfer slots without contacting the Hub', async () => {
    const f = fixture()
    let authorityCalls = 0, cancelled = 0
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { authorityCalls++; return new Response(null, { status: 403 }) } })
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile: join(f.root, 'absent'), projectId: 'project', port: 0,
        async publicGitFetcher() {
            return new Response(new ReadableStream<Uint8Array>({ start(sink) { sink.enqueue(new TextEncoder().encode('0000')) }, cancel() { cancelled++ } }),
                { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
        },
    })
    try {
        for (let i = 0; i < 4; i++) {
            const cancellation = new AbortController()
            const response = await fetch(new URL('/evolved-git/github.com/public/dependency.git/info/refs?service=git-upload-pack', proxy.server.url), { signal: cancellation.signal })
            expect(response.status).toBe(200)
            const reader = response.body!.getReader()
            await reader.read(); cancellation.abort()
            await reader.cancel().catch(() => {})
            for (let attempt = 0; cancelled <= i && attempt < 100; attempt++) await Bun.sleep(5)
            expect(cancelled).toBe(i + 1)
        }
        expect(authorityCalls).toBe(0)
    } finally { proxy.close(); hub.stop(true); rmSync(f.root, { recursive: true, force: true }) }
})

test('a client abort before anonymous response headers never starts private authentication', async () => {
    const f = fixture()
    let authorityCalls = 0, started = 0, cancelled = 0
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { authorityCalls++; return new Response(null, { status: 403 }) } })
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile: join(f.root, 'absent'), projectId: 'project', port: 0,
        async publicGitFetcher(_input, options) {
            started++
            return new Promise<Response>((_resolve, reject) => {
                options.signal!.addEventListener('abort', () => { cancelled++; reject(new Error('Synthetic anonymous cancellation')) }, { once: true })
            })
        },
    })
    try {
        for (let i = 0; i < 4; i++) {
            const cancellation = new AbortController()
            const pending = fetch(new URL('/evolved-git/github.com/public/dependency.git/info/refs?service=git-upload-pack', proxy.server.url), { signal: cancellation.signal }).catch(() => null)
            for (let attempt = 0; started <= i && attempt < 100; attempt++) await Bun.sleep(5)
            expect(started).toBe(i + 1)
            cancellation.abort()
            expect(await pending).toBeNull()
            for (let attempt = 0; cancelled <= i && attempt < 100; attempt++) await Bun.sleep(5)
            expect(cancelled).toBe(i + 1)
        }
        expect(authorityCalls).toBe(0)
    } finally { proxy.close(); hub.stop(true); rmSync(f.root, { recursive: true, force: true }) }
})

test('eight public transfers have independent slots from two private broker transfers', async () => {
    const f = fixture(), leaseFile = join(f.root, 'lease')
    writeFileSync(leaseFile, 'synthetic-concurrency-lease', { mode: 0o600 })
    const publicStreams: ReadableStreamDefaultController<Uint8Array>[] = []
    const privateStreams: ReadableStreamDefaultController<Uint8Array>[] = []
    const readers: Promise<ArrayBuffer>[] = []
    let privateCalls = 0, anonymousCalls = 0
    const stream = (controllers: typeof publicStreams) => new Response(new ReadableStream<Uint8Array>({ start(sink) {
        controllers.push(sink); sink.enqueue(new TextEncoder().encode('0000'))
    } }), { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        if (new URL(request.url).pathname === '/api/evolved/runner/token') return Response.json({ token: 'q'.repeat(43), projectId: 'project', expiresAt: Date.now() + 900_000 })
        privateCalls++
        expect(request.headers.get('authorization')).toBe(`Bearer ${'q'.repeat(43)}`)
        return stream(privateStreams)
    } })
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'project', port: 0,
        async publicGitFetcher(input) {
            anonymousCalls++
            return new URL(input).pathname.startsWith('/private/') ? new Response(null, { status: 404 }) : stream(publicStreams)
        },
    })
    const download = async (owner: string, expected = 200) => {
        const response = await fetch(new URL(`/evolved-git/github.com/${owner}/repo.git/info/refs?service=git-upload-pack`, proxy.server.url))
        expect(response.status).toBe(expected)
        if (expected === 200) readers.push(response.arrayBuffer()); else await response.body?.cancel()
    }
    try {
        await download('private'); await download('private')
        // The rejected fallback must release its anonymous slot before checking
        // the private pool, leaving all eight public slots available afterwards.
        await download('private', 429)
        expect(privateCalls).toBe(2)
        for (let i = 0; i < 8; i++) await download('public')
        expect(anonymousCalls).toBe(11)
        await download('public', 429)
        expect(anonymousCalls).toBe(11)
        publicStreams.shift()!.close()
        await readers[2]
        await download('public')
        expect(anonymousCalls).toBe(12)
    } finally {
        for (const sink of [...publicStreams, ...privateStreams]) sink.close()
        await Promise.all(readers)
        proxy.close(); hub.stop(true); rmSync(f.root, { recursive: true, force: true })
    }
})
