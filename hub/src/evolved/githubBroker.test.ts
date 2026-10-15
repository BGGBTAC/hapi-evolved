import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { EvolvedVault, RemoteVaultClient, createVaultSigningKey, type VaultRequest } from './vault'
import { createVaultServer } from './vaultServer'
import { boundedGitResponse, gitBodyHash, parseGitRequest, readGitBody, type GitCredentialRequest, type GitOperation } from './githubProtocol'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const synthetic = `github_pat_${'x'.repeat(40)}`
const manage = (action: string, extra: Record<string, unknown> = {}, projectId = 'p'): VaultRequest => ({ userId: 'u', projectId, operation: 'github', payload: { action, ...extra } })
const git: GitOperation = { owner: 'owner', name: 'repo', service: 'git-upload-pack', advertisement: true }
function request(operation = git, profile: GitCredentialRequest['payload']['profile'] = 'workspace', body = Buffer.alloc(0), projectId = 'p'): GitCredentialRequest {
    return { userId: 'u', projectId, operation: 'githubGit', payload: { git: operation, profile, bodyHash: gitBodyHash(body) } }
}
function fixture(handler?: (url: URL, init: RequestInit) => Promise<Response> | Response) {
    const dir = mkdtempSync(join(tmpdir(), 'evolved-github-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const calls: Array<{ url: string; headers: Headers; redirect: RequestInit['redirect'] }> = []
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        calls.push({ url: url.toString(), headers: new Headers(init.headers), redirect: init.redirect })
        if (handler) return handler(url, init)
        if (url.hostname === 'api.github.com') return Response.json(url.pathname === '/user' ? { id: 1, login: 'owner' } : { id: 12, full_name: 'owner/repo' })
        return new Response('0000', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'set-cookie': 'must-not-cross=1', location: 'https://other.test', 'www-authenticate': 'Basic secret' } })
    }) as typeof fetch
    const vault = new EvolvedVault({ dbPath: join(dir, 'vault.db'), masterKeyFile: join(dir, 'master'), githubFetcher: fetcher })
    cleanup.push(() => vault.close())
    const connect = async (permission = 'read') => {
        await vault.request(manage('connect', { token: synthetic }))
        await vault.request(manage('grant', { repository: 'owner/repo', permission }))
    }
    return { vault, dir, calls, connect }
}

describe('GitHub vault credential boundary', () => {
    test('stores only ciphertext, exposes metadata and injects credentials only into pinned destinations', async () => {
        const s = fixture(); await s.connect()
        const status = await s.vault.request(manage('status'))
        expect(status).toMatchObject({ connected: true, account: { id: 1, login: 'owner' }, repositories: [{ id: '12', permission: 'read' }] })
        for (const value of [status, s.vault.db.prepare('SELECT * FROM github_connections').all(), s.vault.db.prepare('SELECT * FROM audit').all()]) {
            expect(JSON.stringify(value)).not.toContain(synthetic)
        }
        const response = await s.vault.git(request(), Buffer.alloc(0))
        expect(await response.text()).toBe('0000')
        expect([...response.headers.keys()].sort()).toEqual(['cache-control', 'content-type', 'x-content-type-options'])
        expect(s.calls.every(c => ['api.github.com', 'github.com'].includes(new URL(c.url).hostname) && c.redirect === 'error')).toBe(true)
        const final = s.calls.at(-1)!
        expect(final.url).toBe('https://github.com/owner/repo.git/info/refs?service=git-upload-pack')
        expect(Buffer.from(final.headers.get('authorization')!.slice(6), 'base64').toString()).toBe(`x-access-token:${synthetic}`)
        expect(await s.vault.request(manage('status', {}, 'other'))).toEqual({ connected: false, repositories: [] })
    })
    test('both push operations require a write grant and a writable profile', async () => {
        const s = fixture(); await s.connect('read')
        for (const advertisement of [true, false]) {
            const operation: GitOperation = { ...git, service: 'git-receive-pack', advertisement }
            await expect(s.vault.git(request(operation), Buffer.alloc(0))).rejects.toThrow('not granted')
        }
        await s.vault.request(manage('grant', { repository: 'owner/repo', permission: 'write' }))
        for (const advertisement of [true, false]) await expect(s.vault.git(request({ ...git, service: 'git-receive-pack', advertisement }, 'restricted'), Buffer.alloc(0))).rejects.toThrow('not granted')
        expect(s.calls.filter(c => new URL(c.url).hostname === 'github.com')).toHaveLength(0)
    })
    test('connection rotation clears grants; disconnect and project purge revoke access', async () => {
        const s = fixture(); await s.connect()
        expect(await s.vault.request(manage('connect', { token: synthetic }))).toMatchObject({ repositories: [] })
        await expect(s.vault.git(request(), Buffer.alloc(0))).rejects.toThrow('not granted')
        await s.vault.request(manage('disconnect'))
        expect(await s.vault.request(manage('status'))).toEqual({ connected: false, repositories: [] })
        await s.connect()
        await s.vault.request({ userId: 'u', projectId: 'p', operation: 'purgeProject', payload: {} })
        await expect(s.vault.git(request(), Buffer.alloc(0))).rejects.toThrow('deleted')
        expect(s.vault.db.prepare('SELECT * FROM github_connections').all()).toHaveLength(0)
    })
    test('grant generation cannot repeat after revoke and regrant', async () => {
        const s = fixture(); await s.connect()
        const generation = () => (s.vault.db.prepare('SELECT generation FROM github_repositories WHERE project_id=? AND repository_id=?').get('p', '12') as { generation: number }).generation
        const before = generation()
        await s.vault.request(manage('revoke', { repositoryId: '12' }))
        await s.vault.request(manage('grant', { repository: 'owner/repo', permission: 'read' }))
        expect(generation()).toBeGreaterThan(before)
        const again = generation()
        await s.vault.request(manage('connect', { token: synthetic }))
        await s.vault.request(manage('grant', { repository: 'owner/repo', permission: 'read' }))
        expect(generation()).toBeGreaterThan(again)
    })
    test('a stale transfer cannot resume after disconnect, reconnect and regrant', async () => {
        let pauseNext = false, release: (() => void) | undefined
        const s = fixture(async url => {
            if (url.hostname === 'github.com') return new Response('0000', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
            if (url.pathname.startsWith('/repos/') && pauseNext) {
                pauseNext = false
                // Deliberately ignore AbortSignal in this synthetic provider:
                // the connection-generation check must also stop late results.
                await new Promise<void>(resolve => { release = resolve })
            }
            return Response.json(url.pathname === '/user' ? { id: 1, login: 'owner' } : { id: 12, full_name: 'owner/repo' })
        })
        await s.connect(); pauseNext = true
        const stale = s.vault.git(request(), Buffer.alloc(0))
        await Promise.resolve()
        await s.vault.request(manage('disconnect'))
        await s.connect()
        release!()
        await expect(stale).rejects.toThrow('authorization changed')
        expect(s.calls.filter(call => new URL(call.url).hostname === 'github.com')).toHaveLength(0)
        expect(await (await s.vault.git(request(), Buffer.alloc(0))).text()).toBe('0000')
    })
    test('rejects repository identity replacement before forwarding any Git request', async () => {
        let repositoryId = 12, gitCalls = 0
        const s = fixture(url => {
            if (url.hostname === 'github.com') { gitCalls++; return new Response('unexpected') }
            return Response.json(url.pathname === '/user' ? { id: 1, login: 'owner' } : { id: repositoryId, full_name: 'owner/repo' })
        })
        await s.connect(); repositoryId = 13
        await expect(s.vault.git(request(), Buffer.alloc(0))).rejects.toThrow('identity changed')
        expect(gitCalls).toBe(0)
    })
    test('a concurrent revoke cannot be overwritten by an earlier pending grant validation', async () => {
        let wait = false, release: (() => void) | undefined
        const s = fixture(async url => {
            if (url.pathname.startsWith('/repos/') && wait) await new Promise<void>(resolve => { release = resolve })
            return Response.json(url.pathname === '/user' ? { id: 1, login: 'owner' } : { id: 12, full_name: 'owner/repo' })
        })
        await s.connect(); wait = true
        const pending = s.vault.request(manage('grant', { repository: 'owner/repo', permission: 'write' }))
        await Promise.resolve()
        await s.vault.request(manage('revoke', { repositoryId: '12' }))
        release!()
        await expect(pending).rejects.toThrow('Grant changed')
        expect(await s.vault.request(manage('status'))).toMatchObject({ repositories: [] })
    })
    test('repo revocation cancels an already active response stream', async () => {
        let upstreamCancelled = false
        const s = fixture(url => {
            if (url.hostname === 'api.github.com') return Response.json(url.pathname === '/user' ? { id: 1, login: 'owner' } : { id: 12, full_name: 'owner/repo' })
            return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('0008test')) }, cancel() { upstreamCancelled = true } }), { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
        })
        await s.connect()
        const response = await s.vault.git(request(), Buffer.alloc(0)), reader = response.body!.getReader()
        await reader.read()
        await s.vault.request(manage('revoke', { repositoryId: '12' }))
        await expect(reader.read()).rejects.toThrow('cancelled')
        expect(upstreamCancelled).toBe(true)
    })
    test('signed transport crosses the real vault HTTP boundary without credential response headers', async () => {
        const s = fixture(); await s.connect()
        const signingKeyFile = join(s.dir, 'signing'), { publicKey } = createVaultSigningKey(signingKeyFile)
        const app = createVaultServer({ vault: s.vault, hubPublicKey: publicKey })
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch }); cleanup.push(() => server.stop(true))
        const client = new RemoteVaultClient({ url: server.url.toString(), signingKeyFile })
        expect(await (await client.git(request(), Buffer.alloc(0))).text()).toBe('0000')
        await expect(client.git(request(), Buffer.from('tampered'))).rejects.toThrow('denied')
        const unsigned = await fetch(new URL('/v1/github/git', server.url), { method: 'POST', body: '0000' })
        expect(unsigned.status).toBe(401)
    })
    test('vault reserves capacity before reading bodies and releases it on cancellation', async () => {
        const s = fixture(); await s.connect()
        const pair = generateKeyPairSync('ed25519')
        const app = createVaultServer({ vault: s.vault, hubPublicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
        const make = (body: RequestInit['body'], signal?: AbortSignal, expiresAt = Date.now() + 10_000) => {
            const envelope = JSON.stringify({ ...request(), nonce: randomUUID(), expiresAt })
            return new Request('http://vault/v1/github/git', { method: 'POST', body, signal, headers: {
                'x-evolved-request': Buffer.from(envelope).toString('base64url'),
                'x-evolved-signature': sign(null, Buffer.from(envelope), pair.privateKey).toString('base64url'),
            }, duplex: 'half' } as RequestInit)
        }
        const a = new AbortController(), b = new AbortController()
        const pendingA = app.fetch(make(new ReadableStream(), a.signal))
        const pendingB = app.fetch(make(new ReadableStream(), b.signal))
        expect((await app.fetch(make(null))).status).toBe(429)
        a.abort(); b.abort()
        await Promise.all([pendingA, pendingB])
        const accepted = await app.fetch(make(null))
        expect(accepted.status).toBe(200); await accepted.text()
        const expired = await app.fetch(make(new ReadableStream(), undefined, Date.now() + 15))
        expect(expired.status).toBe(401)
        expect(s.calls.filter(call => new URL(call.url).hostname === 'github.com')).toHaveLength(1)
    })
    test('a slow push failure after admission retains its transport error', async () => {
        const start = Date.now(), now = spyOn(Date, 'now').mockReturnValue(start)
        try {
            const s = fixture(url => {
                if (url.hostname === 'api.github.com') return Response.json(url.pathname === '/user' ? { id: 1, login: 'owner' } : { id: 12, full_name: 'owner/repo' })
                now.mockReturnValue(start + 31_000)
                throw new Error('Synthetic provider failure after admission')
            })
            await s.connect('write')
            const pair = generateKeyPairSync('ed25519')
            const app = createVaultServer({ vault: s.vault, hubPublicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
            const envelope = JSON.stringify({ ...request({ ...git, service: 'git-receive-pack', advertisement: false }), nonce: randomUUID(), expiresAt: start + 30_000 })
            const response = await app.request('/v1/github/git', { method: 'POST', headers: {
                'x-evolved-request': Buffer.from(envelope).toString('base64url'),
                'x-evolved-signature': sign(null, Buffer.from(envelope), pair.privateKey).toString('base64url'),
            } })
            expect(response.status).toBe(502)
            expect(await response.json()).toMatchObject({ code: 'github_unavailable', error: 'GitHub transfer interrupted. Inspect remote refs before retrying a push.' })
            expect(s.calls.filter(call => new URL(call.url).hostname === 'github.com')).toHaveLength(1)
        } finally { now.mockRestore() }
    })
})

describe('Git protocol limits', () => {
    test('accepts only exact smart endpoints and single service query', () => {
        const base = 'http://proxy/evolved-git/github.com/'
        expect(parseGitRequest(new Request(`${base}owner/repo.git/info/refs?service=git-upload-pack`), '/evolved-git/github.com/')).toEqual(git)
        for (const path of ['owner/repo.git/config', 'owner/repo.git/HEAD', 'owner/repo.git/info/refs', 'owner/repo.git/info/refs?service=git-upload-pack&service=git-receive-pack', 'owner/repo.git/info/refs?service=git-upload-pack&x=1', 'owner/repo%2fother.git/info/refs?service=git-upload-pack', 'owner/repo.git/git-upload-pack']) {
            expect(() => parseGitRequest(new Request(base + path), '/evolved-git/github.com/')).toThrow()
        }
        expect(() => parseGitRequest(new Request(`${base}owner/repo.git/info/refs?service=git-upload-pack`, { headers: { 'git-protocol': 'version=2:host=evil.test' } }), '/evolved-git/github.com/')).toThrow()
    })
    test('bounds upload bytes and aborts stalled bodies without signing partial input', async () => {
        await expect(readGitBody(new Request('https://example.test', { method: 'POST', body: '12345' }), 4)).rejects.toThrow('limit')
        let cancelled = false
        const controller = new AbortController()
        const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } })
        const pending = readGitBody(new Request('https://example.test', { method: 'POST', body, signal: controller.signal, duplex: 'half' } as RequestInit))
        controller.abort()
        await expect(pending).rejects.toThrow()
        expect(cancelled).toBe(true)
    })
    test('bounds streamed responses and runs cleanup once', async () => {
        const controller = new AbortController(); let finished = 0
        const response = boundedGitResponse(new Response('12345'), controller, () => { finished++ }, 4)
        await expect(response.text()).rejects.toThrow('cancelled')
        expect(finished).toBe(1)
    })
})
