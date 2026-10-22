import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createEvolvedRoutes } from './api'
import { SESSION_COOKIE } from './security'
import { EvolvedStore } from './store'

const stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup() {
    let now = Date.UTC(2026, 9, 15, 12)
    const store = new EvolvedStore(':memory:', { now: () => now }); stores.push(store)
    for (const [id, name] of [['admin', 'Admin'], ['other', 'Other'], ['viewer', 'Viewer']]) {
        store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(id!, name!, now)
    }
    const team = store.createTeam('admin', 'Team'), project = store.createProject('admin', team.id, 'Project')
    store.setMember('admin', team.id, 'other', 'admin')
    store.setMember('admin', team.id, 'viewer', 'viewer')
    store.setProfile('admin', project.id, 'workspace')
    const origin = 'https://evolved.example.test'
    const app = new Hono().route('/api/evolved', createEvolvedRoutes({ store, origin, vault: { request: async () => ({}) } }))
    const sessions = Object.fromEntries(['admin', 'other', 'viewer'].map(id => [id, store.createSession(id)]))
    const path = `/projects/${project.id}/runner-leases`
    const call = (path: string, body?: unknown, options: { method?: string; user?: string; bearer?: string } = {}) => app.request(`${origin}/api/evolved${path}`, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { origin, 'content-type': 'application/json', ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : { cookie: `${SESSION_COOKIE}=${sessions[options.user ?? 'admin']}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const issue = async () => {
        const response = await call(path, { name: 'Permanent runner', expiresInSeconds: null })
        expect(response.status).toBe(201)
        return await response.json() as { id: string; token: string; expiresAt: null }
    }
    const exchange = async (token: string) => {
        const response = await call('/runner/token', {}, { bearer: token })
        expect(response.status).toBe(200)
        return await response.json() as { id: string; token: string; expiresAt: number; leaseExpiresAt: number | null }
    }
    return { store, team, project, path, call, issue, exchange, app, origin, sessions, now: () => now, advance: (ms: number) => { now += ms } }
}

describe('permanent runner access', () => {
    test('manual defaults include project systems, while an existing managed lease gains missing scopes on exchange', async () => {
        const t = setup()
        const manual = await t.issue()
        const defaults = t.store.capability((await t.exchange(manual.token)).token)?.capability?.scopes ?? []
        for (const scope of ['runner:connect', 'git:read', 'git:write', 'memory:read', 'memory:write', 'codegraph:read', 'peers:read', 'peers:send', 'peers:manage']) {
            expect(defaults).toContain(scope)
        }
        expect(defaults).not.toContain('resource:execute')

        t.store.db.query('UPDATE evolved_runner_leases SET scopes=? WHERE id=?').run('["runner:connect","git:read"]', manual.id)
        const narrowManual = t.store.capability((await t.exchange(manual.token)).token)?.capability?.scopes
        expect(narrowManual).toEqual(['runner:connect', 'git:read'])

        t.store.db.exec('CREATE TABLE IF NOT EXISTS evolved_managed_runners(project_id TEXT PRIMARY KEY,lease_id TEXT NOT NULL,ready INTEGER NOT NULL)')
        t.store.db.query('INSERT INTO evolved_managed_runners VALUES(?,?,1)').run(t.project.id, manual.id)
        const upgraded = t.store.capability((await t.exchange(manual.token)).token)?.capability?.scopes ?? []
        for (const scope of defaults) expect(upgraded).toContain(scope)
        expect(upgraded).not.toContain('resource:execute')
        const saved = t.store.db.query('SELECT scopes FROM evolved_runner_leases WHERE id=?').get(manual.id) as { scopes: string }
        expect(JSON.parse(saved.scopes)).toEqual(upgraded)
    })

    test('direct capabilities support Git scopes with the same restricted-profile boundary as leases', async () => {
        const t = setup(), path = `/projects/${t.project.id}/capabilities`
        const granted = await t.call(path, { scopes: ['git:read', 'git:write'], expiresInSeconds: 300 })
        expect(granted.status).toBe(201)
        const body = await granted.json() as { token: string }
        expect(t.store.capability(body.token)?.capability?.scopes).toEqual(['git:read', 'git:write'])
        t.store.setProfile('admin', t.project.id, 'restricted')
        expect((await t.call(path, { scopes: ['git:write'] })).status).toBe(403)
        expect((await t.call(path, { scopes: ['git:read'] })).status).toBe(201)
        expect((await t.call(path, { scopes: ['git:read'] }, { user: 'viewer' })).status).toBe(403)
        expect((await t.call(path, { scopes: ['git:read'] }, { bearer: body.token })).status).toBe(401)
    })

    test('explicit null expiry survives time while exchanged capabilities remain short lived', async () => {
        const t = setup(), lease = await t.issue()
        expect(lease.expiresAt).toBeNull()
        expect(t.store.db.query('SELECT expires_at FROM evolved_runner_leases WHERE id=?').get(lease.id)).toEqual({ expires_at: null })
        const listing = await (await t.call(t.path)).json() as { leases: Array<{ id: string; expiresAt: number | null }> }
        expect(listing.leases).toContainEqual(expect.objectContaining({ id: lease.id, expiresAt: null }))
        expect(JSON.stringify(listing)).not.toContain(lease.token)
        const authority = await t.call('/runner/authority', undefined, { bearer: lease.token })
        expect(authority.status).toBe(200)
        expect(await authority.json()).toMatchObject({ projectId: t.project.id, profile: 'workspace', expiresAt: null })
        const cap = await t.exchange(lease.token)
        expect(cap.leaseExpiresAt).toBeNull()
        expect(cap.expiresAt).toBe(t.now() + 900_000)
        expect(t.store.capability(cap.token)?.capability?.scopes).toContain('git:write')
        t.advance(901_000)
        expect(t.store.capability(cap.token)).toBeNull()
        t.advance(365 * 86400_000)
        expect((await t.call('/runner/authority', undefined, { bearer: lease.token })).status).toBe(200)
        const renewed = await t.exchange(lease.token)
        expect(renewed.expiresAt).toBe(t.now() + 900_000)
        expect(renewed.leaseExpiresAt).toBeNull()
        t.store.setProfile('admin', t.project.id, 'workspace')
        expect(t.store.capability(renewed.token)).not.toBeNull()
        expect(() => t.store.db.prepare('UPDATE evolved_capabilities SET expires_at=NULL WHERE id=?').run(renewed.id)).toThrow()
        expect(() => t.store.issueCapability('admin', t.project.id, ['runner:connect'], [], 901)).toThrow('15 minutes')
    })

    test('omitted duration retains 24 hours and explicit finite durations retain their bounds', async () => {
        const t = setup()
        const defaultResponse = await t.call(t.path, { name: 'Default runner' })
        expect(defaultResponse.status).toBe(201)
        expect(await defaultResponse.json()).toMatchObject({ expiresAt: t.now() + 86400_000 })
        for (const duration of [60, 7 * 86400]) {
            const response = await t.call(t.path, { name: 'Finite runner', expiresInSeconds: duration })
            expect(response.status).toBe(201)
            const lease = await response.json() as { token: string; expiresAt: number }
            expect(lease.expiresAt).toBe(t.now() + duration * 1000)
            expect((await t.exchange(lease.token)).expiresAt).toBe(t.now() + Math.min(duration, 900) * 1000)
        }
        for (const duration of [0, -1, 59, 60.5, 7 * 86400 + 1, 'null', 'permanent', true]) {
            expect((await t.call(t.path, { name: 'Invalid runner', expiresInSeconds: duration })).status).toBe(400)
        }
    })

    test('permanent creation preserves human administrator, passkey and profile restrictions', async () => {
        const t = setup(), body = { name: 'Permanent runner', expiresInSeconds: null }
        expect((await t.call(t.path, body, { user: 'viewer' })).status).toBe(403)
        const cap = t.store.issueCapability('admin', t.project.id, ['runner:connect'], [], 300)
        expect((await t.call(t.path, body, { bearer: cap.token })).status).toBe(403)
        t.store.setProfile('admin', t.project.id, 'restricted')
        expect((await t.call(t.path, { ...body, scopes: ['runner:connect', 'git:write'] })).status).toBe(403)
        t.advance(6 * 60_000)
        const stale = await t.call(t.path, body)
        expect(stale.status).toBe(403)
        expect(await stale.json()).toMatchObject({ code: 'step_up_required' })
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_runner_leases').get()).toEqual({ n: 0 })
    })

    test.each(['explicit revoke', 'profile change', 'role downgrade', 'membership removal', 'account recovery'] as const)('%s invalidates permanent leases and derived capabilities', async action => {
        const t = setup(), lease = await t.issue(), cap = await t.exchange(lease.token)
        if (action === 'explicit revoke') expect((await t.call(`${t.path}/${lease.id}`, undefined, { method: 'DELETE' })).status).toBe(200)
        if (action === 'profile change') t.store.setProfile('admin', t.project.id, 'restricted')
        if (action === 'role downgrade') t.store.setMember('other', t.team.id, 'admin', 'viewer')
        if (action === 'membership removal') t.store.setMember('other', t.team.id, 'admin', null)
        if (action === 'account recovery') t.store.recover('Admin', t.store.rotateRecoveryCodes('admin')[0]!)
        expect((await t.call('/runner/authority', undefined, { bearer: lease.token })).status).toBe(401)
        expect((await t.call('/runner/token', {}, { bearer: lease.token })).status).toBe(401)
        expect(t.store.capability(cap.token)).toBeNull()
        expect(t.store.db.query('SELECT expires_at,revoked_at FROM evolved_runner_leases WHERE id=?').get(lease.id)).toEqual({ expires_at: null, revoked_at: t.now() })
    })
})


describe('runner lease body authorization boundary', () => {
    test.each(['logout', 'role removal', 'profile change', 'unchanged'] as const)('%s while a request body is pending uses current authority', async action => {
        const t = setup(), payload = JSON.stringify({ name: 'Delayed request', expiresInSeconds: null, scopes: ['runner:connect', 'git:write'] })
        let controller!: ReadableStreamDefaultController<Uint8Array>
        let reading!: () => void
        const started = new Promise<void>(resolve => { reading = resolve })
        const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
        // Observe actual body consumption, not ReadableStream's eager pull: the
        // old handler reached json() only after authorizing the stale session.
        const request = new Request(`${t.origin}/api/evolved${t.path}`, { method: 'POST', headers: { origin: t.origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), cookie: `${SESSION_COOKIE}=${t.sessions.admin}` }, body: stream, duplex: 'half' } as RequestInit)
        const readText = request.text.bind(request), readJson = request.json.bind(request)
        Object.defineProperties(request, {
            text: { value: () => { reading(); return readText() } },
            json: { value: () => { reading(); return readJson() } },
        })
        const response = t.app.fetch(request)
        await started
        if (action === 'logout') t.store.revokeSession(t.sessions.admin)
        if (action === 'role removal') t.store.setMember('other', t.team.id, 'admin', null)
        if (action === 'profile change') t.store.setProfile('other', t.project.id, 'restricted')
        controller.enqueue(new TextEncoder().encode(payload)); controller.close()
        const result = await response
        expect(result.status).toBe(action === 'unchanged' ? 201 : action === 'logout' ? 401 : 403)
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_runner_leases').get()).toEqual({ n: action === 'unchanged' ? 1 : 0 })
    })
})
