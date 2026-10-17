import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRunnerProxy } from './server'
import { parseGitRequest } from '../../hub/src/evolved/githubProtocol'

// Real native Git sends gzip for the fetch negotiation of a multi-ref clone.
// A tiny fixture proves that behavior without provider access or large objects.
test.each(['not-found', 'bad-gateway', 'transport-failure'])('native private multi-ref clone retains bounded gzip normalization after anonymous %s', async anonymousFailure => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-git-clone-'))
    const exportRoot = join(directory, 'export'), repository = join(exportRoot, 'synthetic', 'repo.git')
    mkdirSync(join(exportRoot, 'synthetic'), { recursive: true })
    const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic',
        GIT_COMMITTER_EMAIL: 'synthetic@example.invalid', GIT_TERMINAL_PROMPT: '0', LANG: 'C' }
    const git = (args: string[], input?: string) => {
        const result = spawnSync('git', args, { env, input, encoding: 'utf8', timeout: 5000 })
        if (result.status !== 0) throw new Error('Synthetic Git fixture setup failed')
        return result.stdout.trim()
    }
    let hub: ReturnType<typeof Bun.serve> | undefined, proxy: ReturnType<typeof createRunnerProxy> | undefined
    try {
        git(['init', '--bare', '--initial-branch=main', repository])
        const tree = git([`--git-dir=${repository}`, 'mktree'], '')
        for (let i = 0; i < 122; i++) {
            const oid = git([`--git-dir=${repository}`, 'commit-tree', tree, '-m', `Synthetic unique head ${i}`])
            git([`--git-dir=${repository}`, 'update-ref', `refs/heads/${i === 0 ? 'main' : `head-${i}`}`, oid])
        }
        const bodies: Array<{ size: number; encoding: string | null }> = []
        hub = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            const url = new URL(request.url)
            if (url.pathname === '/api/evolved/runner/token') return Response.json({ token: 'x'.repeat(43), projectId: 'a', expiresAt: Date.now() + 900_000 })
            if (!url.pathname.startsWith('/api/evolved/projects/a/git/')) return new Response(null, { status: 404 })
            expect(request.headers.get('authorization')).toBe(`Bearer ${'x'.repeat(43)}`)
            try { parseGitRequest(request, '/api/evolved/projects/a/git/') }
            catch { return new Response(null, { status: 400 }) }
            const body = Buffer.from(await request.arrayBuffer())
            if (request.method === 'POST') bodies.push({ size: body.length, encoding: request.headers.get('content-encoding') })
            const child = Bun.spawn(['git', 'http-backend'], { env: { ...env, GIT_PROJECT_ROOT: exportRoot, GIT_HTTP_EXPORT_ALL: '1',
                REQUEST_METHOD: request.method, PATH_INFO: url.pathname.slice('/api/evolved/projects/a/git'.length), QUERY_STRING: url.search.slice(1),
                CONTENT_TYPE: request.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.length), HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '' },
                stdin: body, stdout: 'pipe', stderr: 'pipe' })
            const output = Buffer.from(await new Response(child.stdout).arrayBuffer())
            if (await child.exited !== 0) return new Response(null, { status: 502 })
            const split = output.indexOf('\r\n\r\n'), headers = new Headers()
            let status = 200
            for (const line of output.subarray(0, split).toString().split('\r\n')) {
                const colon = line.indexOf(':'), key = line.slice(0, colon), value = line.slice(colon + 1).trim()
                if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0])
                else headers.set(key, value)
            }
            return new Response(output.subarray(split + 4), { status, headers })
        } })
        const leaseFile = join(directory, 'lease')
        writeFileSync(leaseFile, 'synthetic-lease', { mode: 0o600 })
        proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'a', port: 0,
            publicGitFetcher: async () => {
                if (anonymousFailure === 'transport-failure') throw new Error('Synthetic public egress unavailable')
                return new Response(null, { status: anonymousFailure === 'not-found' ? 404 : 502 })
            } })
        // Decoder failures must release the existing two-transfer allowance.
        // Four rejected bodies followed by a real clone also prove no malformed
        // compressed request reaches the authenticated Hub transport.
        for (let i = 0; i < 4; i++) {
            const invalid = await fetch(new URL('/evolved-git/github.com/synthetic/repo.git/git-upload-pack', proxy.server.url), {
                method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip' }, body: 'invalid-gzip',
            })
            expect(invalid.status).toBe(502)
            await invalid.body?.cancel()
        }
        expect(bodies).toHaveLength(0)
        const target = join(directory, 'checkout')
        const child = Bun.spawn(['git', '-c', 'protocol.version=2', 'clone', '--quiet', '--no-checkout', new URL('/evolved-git/github.com/synthetic/repo.git', proxy.server.url).toString(), target], {
            env: { ...env, GIT_TRACE_CURL: '1', GIT_TRACE_CURL_NO_DATA: '1' }, stdout: 'pipe', stderr: 'pipe',
        })
        const timer = setTimeout(() => child.kill(), 15_000)
        try {
            const trace = await new Response(child.stderr).text()
            expect(trace.toLowerCase()).toContain('content-encoding: gzip')
            expect(await child.exited).toBe(0)
            expect(bodies.some(body => body.size > 1024)).toBe(true)
            expect(bodies.every(body => body.encoding === null)).toBe(true)
            expect(git(['-C', target, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin']).split('\n')).toHaveLength(123)
        } finally { clearTimeout(timer); child.kill() }
    } finally { proxy?.close(); hub?.stop(true); rmSync(directory, { recursive: true, force: true }) }
}, 30_000)
