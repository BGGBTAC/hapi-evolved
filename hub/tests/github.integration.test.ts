import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolvedError, EvolvedStore } from '../src/evolved/store'
import { createGithubGitTransport } from '../src/evolved/github'
import { createRunnerRoutes } from '../src/evolved/runner'
import { SESSION_COOKIE } from '../src/evolved/security'
import { EvolvedVault, RemoteVaultClient, createVaultSigningKey } from '../src/evolved/vault'
import { createVaultServer } from '../src/evolved/vaultServer'
import { createRunnerProxy } from '../../services/runner-proxy/server'

test('native Git clone, fetch and branch push cross proxy, Hub and signed vault without exporting credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-native-git-')), cleanup: Array<() => void> = []
    const native = async (args: string[], cwd = directory, extra: Record<string, string> = {}, success = true) => {
        const child = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra }, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        if (success && code !== 0) throw new Error(`Local Git fixture failed (${code}): ${stderr}`)
        return { stdout: stdout.trim(), stderr, code }
    }
    try {
        const repositories = join(directory, 'repositories'), bare = join(repositories, 'owner/repo.git')
        mkdirSync(join(repositories, 'owner'), { recursive: true })
        await native(['init', '--bare', '--initial-branch=main', bare])
        await native(['config', 'http.receivepack', 'true'], bare)
        const seed = join(directory, 'seed'); mkdirSync(seed)
        await native(['init', '--initial-branch=main'], seed)
        await native(['config', 'user.name', 'Synthetic Test'], seed)
        await native(['config', 'user.email', 'synthetic@example.invalid'], seed)
        writeFileSync(join(seed, 'README.md'), 'Synthetic native Git acceptance\n')
        await native(['add', 'README.md'], seed)
        await native(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], seed)
        await native(['push', bare, 'main'], seed)
        const token = `github_pat_${'t'.repeat(40)}`
        const observed: Array<{ host: string; path: string; authorization: string | null }> = []
        const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
            const headers = new Headers(init.headers)
            observed.push({ host: url.hostname, path: url.pathname, authorization: headers.get('authorization') })
            expect(init.redirect).toBe('error')
            if (url.hostname === 'api.github.com') return Response.json(url.pathname === '/user' ? { id: 7, login: 'owner' } : { id: 42, full_name: 'owner/repo' })
            expect(url.hostname).toBe('github.com')
            expect(Buffer.from(headers.get('authorization')!.slice(6), 'base64').toString()).toBe(`x-access-token:${token}`)
            const body = init.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.alloc(0)
            const child = Bun.spawn(['git', 'http-backend'], {
                cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
                    REQUEST_METHOD: init.method ?? 'GET', CONTENT_TYPE: headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.length),
                    HTTP_GIT_PROTOCOL: headers.get('git-protocol') ?? '', REMOTE_USER: 'synthetic', REMOTE_ADDR: '127.0.0.1' },
                stdin: body, stdout: 'pipe', stderr: 'pipe',
            })
            const [bytes, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited])
            expect(code).toBe(0)
            const data = Buffer.from(bytes), offset = data.indexOf('\r\n\r\n')
            expect(offset).toBeGreaterThan(0)
            const responseHeaders = new Headers(); let status = 200
            for (const line of data.subarray(0, offset).toString().split('\r\n')) {
                const separator = line.indexOf(':'); const key = line.slice(0, separator), value = line.slice(separator + 1).trim()
                if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0])
                else responseHeaders.set(key, value)
            }
            return new Response(data.subarray(offset + 4), { status, headers: responseHeaders })
        }) as typeof fetch
        const vault = new EvolvedVault({ dbPath: join(directory, 'vault.db'), masterKeyFile: join(directory, 'master'), githubFetcher: fetcher })
        cleanup.push(() => vault.close())
        const signingKeyFile = join(directory, 'signing'), { publicKey } = createVaultSigningKey(signingKeyFile)
        const vaultServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createVaultServer({ vault, hubPublicKey: publicKey }).fetch })
        cleanup.push(() => vaultServer.stop(true))
        const remoteVault = new RemoteVaultClient({ url: vaultServer.url.toString(), signingKeyFile })
        const store = new EvolvedStore(':memory:'); cleanup.push(() => store.close())
        store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('admin', 'Synthetic admin', 1, Date.now())
        const team = store.createTeam('admin', 'Synthetic team'), project = store.createProject('admin', team.id, 'Synthetic project')
        store.setProfile('admin', project.id, 'workspace')
        await remoteVault.request({ userId: 'admin', projectId: project.id, operation: 'github', payload: { action: 'connect', token } })
        await remoteVault.request({ userId: 'admin', projectId: project.id, operation: 'github', payload: { action: 'grant', repository: 'owner/repo', permission: 'write' } })
        const origin = 'https://synthetic.example.invalid', transport = createGithubGitTransport({ store, vault: remoteVault, origin })
        cleanup.push(transport.close)
        const app = new Hono()
        app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code }, error.status as 400) : c.json({ error: 'Synthetic failure' }, 500))
        app.route('/api/evolved', transport.routes)
        app.route('/api/evolved', createRunnerRoutes(store))
        const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch }); cleanup.push(() => hub.stop(true))
        const leaseResponse = await app.request(`${origin}/api/evolved/projects/${project.id}/runner-leases`, {
            method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${store.createSession('admin')}` },
            body: JSON.stringify({ name: 'Synthetic Git test', scopes: ['runner:connect', 'git:read', 'git:write'] }),
        })
        expect(leaseResponse.status).toBe(201)
        const lease = await leaseResponse.json() as { id: string; token: string }
        const leaseFile = join(directory, 'lease'); writeFileSync(leaseFile, lease.token, { mode: 0o600 })
        const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: project.id, port: 0 })
        cleanup.push(proxy.close)
        // Same rewrite as /etc/gitconfig in the runner image, scoped to this test.
        const local = `${proxy.server.url}evolved-git/github.com/`
        const gitEnv = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${local}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/', GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false' }
        const clone = join(directory, 'clone')
        await native(['clone', 'https://github.com/owner/repo.git', clone], directory, gitEnv)
        expect(readFileSync(join(clone, 'README.md'), 'utf8')).toContain('Synthetic native Git')
        expect((await native(['remote', 'get-url', 'origin'], clone)).stdout).toBe('https://github.com/owner/repo.git')
        await native(['checkout', '-b', 'test/broker-acceptance'], clone)
        writeFileSync(join(clone, 'proof.txt'), 'Synthetic branch, no GitHub mutation\n')
        await native(['add', 'proof.txt'], clone)
        await native(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic branch'], clone)
        await native(['push', 'origin', 'HEAD'], clone, gitEnv)
        expect((await native(['show', 'refs/heads/test/broker-acceptance:proof.txt'], bare)).stdout).toContain('Synthetic branch')
        await native(['fetch', 'origin'], clone, gitEnv)
        const config = readFileSync(join(clone, '.git/config'), 'utf8')
        expect(config).not.toContain(token); expect(config).not.toContain(lease.token)
        expect(observed.some(row => row.path.endsWith('/git-receive-pack'))).toBe(true)
        expect(observed.some(row => row.path.endsWith('/git-upload-pack'))).toBe(true)
        await remoteVault.request({ userId: 'admin', projectId: project.id, operation: 'github', payload: { action: 'revoke', repositoryId: '42' } })
        const denied = await native(['fetch', 'origin'], clone, gitEnv, false)
        expect(denied.code).not.toBe(0)
        expect(denied.stderr).not.toContain(token); expect(denied.stderr).not.toContain(lease.token)
    } finally {
        while (cleanup.length) cleanup.pop()!()
        rmSync(directory, { recursive: true, force: true })
    }
}, 30_000)
