import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { randomUUID } from 'node:crypto'
import { EvolvedError, EvolvedStore, hashToken, randomToken } from './store'
import { createGithubGitTransport, createGithubRoutes } from './github'
import { SESSION_COOKIE } from './security'
import type { VaultClient, VaultRequest } from './vault'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
function setup() {
    const store = new EvolvedStore(':memory:')
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('admin', 'Admin', 1, Date.now())
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('viewer', 'Viewer', 0, Date.now())
    const team = store.createTeam('admin', 'Team')
    store.setMember('admin', team.id, 'viewer', 'viewer')
    const project = store.createProject('admin', team.id, 'Project')
    const other = store.createProject('admin', team.id, 'Other')
    const requests: VaultRequest[] = []
    const gitRequests: unknown[] = []
    const vault: VaultClient = {
        request: async input => { requests.push(input); return { connected: true, account: { id: 42, login: 'test-account' }, repositories: [] } },
        git: async (input, body) => {
            gitRequests.push({ input, bytes: body.byteLength })
            const git = input.payload.git
            return new Response('0000', { headers: { 'content-type': `application/x-${git.service}-${git.advertisement ? 'advertisement' : 'result'}` } })
        },
    }
    const origin = 'https://evolved.example.test'
    const transport = createGithubGitTransport({ store, vault, origin })
    const app = new Hono()
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code }, error.status as 400) : c.json({ error: 'test failed' }, 500))
    app.route('/api/evolved', transport.routes)
    app.use('/api/evolved/*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ code: 'body_too_large' }, 413) }))
    app.route('/api/evolved', createGithubRoutes({ store, vault, origin }))
    app.post('/api/evolved/non-git', async c => { await c.req.arrayBuffer(); return c.json({ ok: true }) })
    const session = store.createSession('admin')
    const management = (path = '', options: { method?: string; body?: unknown; user?: string; headers?: Record<string, string> } = {}) => app.request(`${origin}/api/evolved/projects/${project.id}/github${path}`, {
        method: options.method ?? 'GET', headers: { origin, cookie: `${SESSION_COOKIE}=${options.user === 'viewer' ? store.createSession('viewer') : session}`, 'content-type': 'application/json', ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const capability = (scopes = ['runner:connect', 'git:read']) => {
        const id = randomUUID(), now = Date.now(), current = store.requireProject('admin', project.id)
        store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id, 'Synthetic runner', hashToken(randomToken()), 'admin', project.id, JSON.stringify(scopes), '[]', current.profile, now, now + 3600_000)
        return store.issueCapability('admin', project.id, scopes, [], 900, id)
    }
    const git = (token: string, tail = 'owner/repository.git/info/refs?service=git-upload-pack', options: RequestInit = {}, projectId = project.id) => app.request(`${origin}/api/evolved/projects/${projectId}/git/${tail}`, {
        ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers as Record<string, string> ?? {}) },
    })
    cleanup.push(() => { transport.close(); store.close() })
    return { app, store, project, other, vault, requests, gitRequests, management, capability, git, session, origin }
}

describe('GitHub browser management', () => {
    test('read-only members can inspect metadata but cannot connect or grant repositories', async () => {
        const s = setup()
        expect((await s.management('', { user: 'viewer' })).status).toBe(200)
        expect((await s.management('', { user: 'viewer', method: 'POST', body: { token: 'synthetic-test-token' } })).status).toBe(403)
        expect((await s.management('/repositories', { user: 'viewer', method: 'PUT', body: { repository: 'owner/repo', permission: 'write' } })).status).toBe(403)
        expect(s.requests.map(r => r.payload.action)).toEqual(['status'])
    })
    test('connect, grant, revoke and disconnect require a fresh human session and fixed actions', async () => {
        const s = setup()
        expect((await s.management('', { method: 'POST', body: { token: 'synthetic-test-token' } })).status).toBe(200)
        expect((await s.management('/repositories', { method: 'PUT', body: { repository: 'owner/repo', permission: 'read' } })).status).toBe(200)
        expect((await s.management('/repositories/123', { method: 'DELETE' })).status).toBe(200)
        expect((await s.management('', { method: 'DELETE' })).status).toBe(200)
        expect(s.requests.map(r => r.payload.action)).toEqual(['connect', 'grant', 'revoke', 'disconnect'])
        s.store.db.prepare('UPDATE evolved_sessions SET created_at=0').run()
        expect((await s.management('', { method: 'DELETE' })).status).toBe(403)
        expect(s.requests).toHaveLength(4)
    })
    test('a restricted administrator can save write grants without enabling runner push', async () => {
        const s = setup(), existing = s.capability()
        expect(s.store.requireProject('admin', s.project.id).profile).toBe('restricted')
        const response = await s.management('/repositories', { method: 'PUT', body: { repository: 'owner/repository', permission: 'write' } })
        expect(response.status).toBe(200)
        expect(s.requests).toEqual([expect.objectContaining({
            userId: 'admin', projectId: s.project.id, operation: 'github',
            payload: { action: 'grant', repository: 'owner/repository', permission: 'write' },
        })])
        expect(s.store.requireProject('admin', s.project.id).profile).toBe('restricted')
        expect(s.store.capability(existing.token)?.capability?.scopes).toEqual(['runner:connect', 'git:read'])
        const advertisement = 'owner/repository.git/info/refs?service=git-receive-pack'
        const missingScope = await s.git(existing.token, advertisement)
        expect(missingScope.status).toBe(403)
        expect(await missingScope.json()).toEqual({ code: 'scope_denied' })
        // Even an independently constructed write-scoped lease cannot bypass the project profile.
        const write = s.capability(['runner:connect', 'git:read', 'git:write'])
        for (const denied of [
            await s.git(write.token, advertisement),
            await s.git(write.token, 'owner/repository.git/git-receive-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-receive-pack-request' }, body: '0000' }),
        ]) {
            expect(denied.status).toBe(403)
            expect(await denied.json()).toEqual({ code: 'profile_denied' })
        }
        expect(s.gitRequests).toHaveLength(0)
    })
    test('capabilities and hostile origins cannot manage a connection', async () => {
        const s = setup(), cap = s.capability()
        expect((await s.management('', { headers: { authorization: `Bearer ${cap.token}` } })).status).toBe(403)
        expect((await s.management('', { method: 'POST', body: { token: 'synthetic-test-token' }, headers: { origin: 'https://other.example.test' } })).status).toBe(403)
        expect(s.requests).toHaveLength(0)
    })
    test('does not return metadata if access changes while the broker responds', async () => {
        const s = setup()
        s.vault.request = async () => { s.store.revokeSession(s.session); return { connected: true, account: { login: 'private-account' } } }
        const response = await s.management()
        expect(response.status).toBe(401)
        expect(await response.text()).not.toContain('private-account')
    })
})

describe('project Git transport authorization', () => {
    test('accepts scoped fetch and rejects cookies, cross-project paths and missing scope', async () => {
        const s = setup(), cap = s.capability()
        expect(await (await s.git(cap.token)).text()).toBe('0000')
        expect((await s.git(cap.token, undefined, { headers: { cookie: `${SESSION_COOKIE}=${s.session}` } })).status).toBe(403)
        expect((await s.git(cap.token, undefined, {}, s.other.id)).status).toBe(403)
        expect((await s.git(s.capability(['runner:connect']).token)).status).toBe(403)
        expect(s.gitRequests).toHaveLength(1)
    })
    test('standalone capabilities cannot use Git even when their scopes claim runner and Git access', async () => {
        const s = setup(), token = s.store.issueCapability('admin', s.project.id, ['runner:connect', 'git:read'], [], 900)
        expect((await s.git(token.token)).status).toBe(403)
        expect(s.gitRequests).toHaveLength(0)
    })
    test('validates broker status and MIME, and never forwards incidental credential headers', async () => {
        const s = setup(), cap = s.capability()
        for (const response of [new Response('bad', { status: 201, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }), new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } }), new Response('bad', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-encoding': 'gzip' } })]) {
            s.vault.git = async () => response
            expect((await s.git(cap.token)).status).toBe(502)
        }
        s.vault.git = async () => new Response('0000', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'set-cookie': 'synthetic-only', 'www-authenticate': 'Basic realm=synthetic', location: 'https://unexpected.example.test', 'x-private-metadata': 'synthetic' } })
        const response = await s.git(cap.token)
        expect(await response.text()).toBe('0000')
        for (const header of ['set-cookie', 'www-authenticate', 'location', 'x-private-metadata']) expect(response.headers.has(header)).toBe(false)
        expect(response.headers.get('cache-control')).toBe('no-store')
    })
    test('push advertising and data both require write scope and a writable profile', async () => {
        const s = setup(), restricted = s.capability(['runner:connect', 'git:read', 'git:write'])
        const advertisement = 'owner/repository.git/info/refs?service=git-receive-pack'
        expect((await s.git(restricted.token, advertisement)).status).toBe(403)
        s.store.setProfile('admin', s.project.id, 'workspace')
        const read = s.capability(), write = s.capability(['runner:connect', 'git:read', 'git:write'])
        expect((await s.git(read.token, advertisement)).status).toBe(403)
        expect((await s.git(write.token, advertisement)).status).toBe(200)
        expect((await s.git(read.token, 'owner/repository.git/git-receive-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-receive-pack-request' }, body: '0000' })).status).toBe(403)
        expect(s.gitRequests).toHaveLength(1)
    })
    test('only exact authorized Git routes bypass the ordinary one-MiB body limit', async () => {
        const s = setup(), cap = s.capability(), body = new Uint8Array(1024 * 1024 + 8)
        const response = await s.git(cap.token, 'owner/repository.git/git-upload-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request' }, body })
        expect(response.status).toBe(200)
        await response.text()
        expect(s.gitRequests).toEqual([expect.objectContaining({ bytes: body.byteLength })])
        expect((await s.app.request(`${s.origin}/api/evolved/non-git`, { method: 'POST', body })).status).toBe(413)
        expect((await s.git(cap.token, 'owner/repository.git/arbitrary', { method: 'POST', body })).status).toBe(403)
    })
    test('access is checked again after reading a slow upload body', async () => {
        const s = setup(), cap = s.capability()
        const body = new ReadableStream<Uint8Array>({ start(controller) {
            s.store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE id=?').run(Date.now(), cap.id)
            controller.enqueue(new TextEncoder().encode('0000')); controller.close()
        } })
        expect((await s.git(cap.token, 'owner/repository.git/git-upload-pack', { method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request' }, body })).status).toBe(403)
        expect(s.gitRequests).toHaveLength(0)
    })
    test('revocation interrupts an in-flight response instead of waiting for token expiry', async () => {
        const s = setup(), cap = s.capability()
        let started = false
        s.vault.git = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { started = true; controller.enqueue(new TextEncoder().encode('0004')) } }), { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
        const response = await s.git(cap.token), reader = response.body!.getReader()
        expect(started).toBe(true)
        await reader.read()
        s.store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE id=?').run(Date.now(), cap.id)
        await expect(reader.read()).rejects.toBeDefined()
    })
})
