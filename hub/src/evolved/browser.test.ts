import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { BROWSER_DEFAULT_TOOLS } from '@hapi/protocol/browserTools'
import { EvolvedError, EvolvedStore, hashToken, randomToken } from './store'
import { BROWSER_CATALOG_REVISION, browserContextId, createBrowserRoutes } from './browser'
import { createProviderRoutes, type ProviderControl } from './providers'
import type { ControlRequest } from './runnerControlProtocol'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

function fixture(profile: 'restricted' | 'workspace' = 'workspace') {
    let offset = 0
    const store = new EvolvedStore(':memory:', { now: () => Date.now() + offset })
    cleanup.push(() => store.close())
    for (const user of ['admin', 'member', 'viewer', 'other']) store.db.query('INSERT INTO evolved_users VALUES(?,?,0,?)').run(user, user, store.now())
    const team = store.createTeam('admin', 'Team'), project = store.createProject('admin', team.id, 'Project')
    const other = store.createProject('admin', team.id, 'Other')
    store.setProfile('admin', project.id, profile)
    store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    const sessions = Object.fromEntries(['admin', 'member', 'viewer', 'other'].map(user => [user, store.createSession(user)]))
    const controls: ControlRequest[] = []
    let operator: { image: boolean; containers: Record<string, string> } = { image: true, containers: { 'browser-gateway': 'running', browser: 'running', 'browser-egress': 'running' } }
    let lifecycleError: EvolvedError | null = null, statusFails = false
    const control: ProviderControl = { request: async r => { controls.push(r); if (lifecycleError && (r.action === 'browser' || statusFails)) throw lifecycleError; return r.action === 'browser-status' ? operator : { ok: true } } }
    createProviderRoutes(store) // creates evolved_managed_runners
    const lease = (projectId: string, managed = true) => {
        const id = crypto.randomUUID(), token = randomToken()
        store.db.query('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id, 'runner', hashToken(token), 'admin', projectId, JSON.stringify(['runner:connect']), '[]', store.requireProject('admin', projectId, 'admin').profile, store.now(), null)
        if (managed) store.db.query('INSERT INTO evolved_managed_runners VALUES(?,?,1) ON CONFLICT(project_id) DO UPDATE SET lease_id=excluded.lease_id,ready=1').run(projectId, id)
        return { id, capability: store.issueCapability('admin', projectId, ['runner:connect'], [], 900, id).token }
    }
    const app = new Hono().route('/api/evolved', createBrowserRoutes({ store, origin: 'https://hapi.test', control }))
    const request = (method: string, suffix = '', body?: unknown, auth: { user?: string; bearer?: string } = { user: 'admin' }, projectId = project.id) => app.request(`https://hapi.test/api/evolved/projects/${projectId}/browser${suffix}`, {
        method, headers: { 'content-type': 'application/json', ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : { origin: 'https://hapi.test', cookie: `__Host-hapi-evolved=${sessions[auth.user!]}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const enable = async (extra: Partial<{ enabledTools: string[]; readOnlyTools: string[] }> = {}) => {
        const response = await request('PUT', '', { version: 0, enabled: true, enabledTools: [...BROWSER_DEFAULT_TOOLS], readOnlyTools: ['camofox_list_tabs'], ...extra })
        expect(response.status).toBe(200)
        return await response.json() as { config: { version: number }; lifecycle: { ok: boolean } }
    }
    return { store, project, other, sessions, controls, control, lease, request, enable, advance: (ms: number) => { offset += ms }, failLifecycle: (error: EvolvedError | null, status = false) => { lifecycleError = error; statusFails = status }, setOperator: (value: typeof operator) => { operator = value } }
}
const call = (version: number, toolName = 'camofox_create_tab', mode = 'call') => ({ phase: 'dispatch', mode, toolName, version, catalogRevision: BROWSER_CATALOG_REVISION })

describe('project browser configuration', () => {
    test('separate additive table, admin plus fresh passkey, explicit lifecycle control and no MCP vault use', async () => {
        const f = fixture()
        expect((await f.request('GET', '', undefined, { user: 'viewer' })).status).toBe(200)
        expect((await f.request('PUT', '', { version: 0, enabled: true, enabledTools: [], readOnlyTools: [] }, { user: 'member' })).status).toBe(403)
        const stale = f.store.createSession('admin'); f.store.db.query('UPDATE evolved_sessions SET created_at=0 WHERE token_hash=?').run(hashToken(stale))
        const app = new Hono().route('/api/evolved', createBrowserRoutes({ store: f.store, origin: 'https://hapi.test', control: f.control }))
        const staleResponse = await app.request(`https://hapi.test/api/evolved/projects/${f.project.id}/browser`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://hapi.test', cookie: `__Host-hapi-evolved=${stale}` }, body: JSON.stringify({ version: 0, enabled: false, enabledTools: [], readOnlyTools: [] }) })
        expect(staleResponse.status).toBe(403)
        // Read-only grants must be eligible and enabled.
        expect((await f.request('PUT', '', { version: 0, enabled: true, enabledTools: ['camofox_click'], readOnlyTools: ['camofox_click'] })).status).toBe(400)
        f.lease(f.project.id)
        const enabled = await f.enable()
        expect(enabled.config.version).toBe(1); expect(enabled.lifecycle.ok).toBe(true)
        expect(f.controls.filter(r => r.action === 'browser').map(r => r.browser)).toEqual([true])
        expect((await f.request('PUT', '', { version: 0, enabled: false, enabledTools: [], readOnlyTools: [] })).status).toBe(409)
        const disabled = await (await f.request('PUT', '', { version: 1, enabled: false, enabledTools: [], readOnlyTools: [] })).json() as { runtime: { state: string } }
        expect(disabled.runtime.state).toBe('disabled')
        expect(f.controls.filter(r => r.action === 'browser').map(r => r.browser)).toEqual([true, false])
        expect(f.store.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'mcp_%'").all()).toEqual([])
    })

    test('runtime states stay truthful: runner missing, image missing, stopped, starting, service only, ready, stale', async () => {
        const f = fixture()
        const state = async () => (await (await f.request('GET')).json() as { runtime: { state: string } }).runtime.state
        expect(await state()).toBe('disabled')
        await f.enable()
        expect(await state()).toBe('runner_missing')
        const lease = f.lease(f.project.id)
        f.setOperator({ image: false, containers: { 'browser-gateway': 'missing', browser: 'missing', 'browser-egress': 'missing' } })
        expect(await state()).toBe('image_missing')
        f.setOperator({ image: true, containers: { 'browser-gateway': 'running', browser: 'missing', 'browser-egress': 'running' } })
        expect(await state()).toBe('stopped')
        f.setOperator({ image: true, containers: { 'browser-gateway': 'running', browser: 'exited', 'browser-egress': 'running' } })
        expect(await state()).toBe('failed')
        f.setOperator({ image: true, containers: { 'browser-gateway': 'running', browser: 'running', 'browser-egress': 'running' } })
        expect(await state()).toBe('starting')
        expect((await f.request('POST', '/report', { service: 'reachable', engine: 'unknown' }, { bearer: lease.capability })).status).toBe(200)
        expect(await state()).toBe('service_ready')
        await f.request('POST', '/report', { service: 'reachable', engine: 'ready' }, { bearer: lease.capability })
        expect(await state()).toBe('ready')
        const probe = await (await f.request('POST', '/probe', {})).json() as { probeId: string }
        const reply = await (await f.request('POST', '/report', { service: 'reachable', engine: 'unknown' }, { bearer: lease.capability })).json() as { probe: { id: string } }
        expect(reply.probe.id).toBe(probe.probeId)
        await f.request('POST', '/report', { service: 'reachable', engine: 'failed', probeId: probe.probeId }, { bearer: lease.capability })
        expect(await state()).toBe('failed')
        f.advance(60_000)
        expect(await state()).toBe('stale')
    })
})

describe('project browser gateway authorization', () => {
    test('managed lease, current grants and catalog revision; derived identity is shared per project lease', async () => {
        const f = fixture(), lease = f.lease(f.project.id)
        const { config } = await f.enable()
        const response = await f.request('POST', '/authorize', call(config.version), { bearer: lease.capability })
        expect(response.status).toBe(200)
        const grant = await response.json() as { contextId: string; sessionKey: string; projectId: string }
        expect(grant).toMatchObject({ projectId: f.project.id, sessionKey: 'hapi', contextId: browserContextId(f.project.id, lease.id) })
        expect(grant.contextId).toMatch(/^hapi-[a-f0-9]{32}$/)
        // Stale version/catalog, ungranted evaluate, query on non-read-only tool.
        expect((await f.request('POST', '/authorize', call(config.version + 1), { bearer: lease.capability })).status).toBe(409)
        expect((await f.request('POST', '/authorize', { ...call(config.version), catalogRevision: 'a'.repeat(64) }, { bearer: lease.capability })).status).toBe(409)
        expect((await f.request('POST', '/authorize', call(config.version, 'camofox_evaluate'), { bearer: lease.capability })).status).toBe(403)
        expect((await f.request('POST', '/authorize', call(config.version, 'camofox_snapshot', 'query'), { bearer: lease.capability })).status).toBe(403)
        expect((await f.request('POST', '/authorize', call(config.version, 'camofox_list_tabs', 'query'), { bearer: lease.capability })).status).toBe(200)
        // Caller-supplied identity fields are rejected by the strict schema.
        expect((await f.request('POST', '/authorize', { ...call(config.version), userId: 'someone' }, { bearer: lease.capability })).status).toBe(400)
    })

    test('humans, manual leases, foreign projects, revoked and superseded leases are refused', async () => {
        const f = fixture(), lease = f.lease(f.project.id)
        const { config } = await f.enable()
        expect((await f.request('POST', '/authorize', call(config.version))).status).toBe(401)
        const manual = f.lease(f.project.id, false)
        expect((await f.request('POST', '/authorize', call(config.version), { bearer: manual.capability })).status).toBe(403)
        // Cross-project: capability of project A against project B.
        expect((await f.request('POST', '/authorize', call(config.version), { bearer: lease.capability }, f.other.id)).status).toBe(403)
        const otherLease = f.lease(f.other.id)
        expect((await f.request('POST', '/authorize', call(config.version), { bearer: otherLease.capability })).status).toBe(403)
        f.store.db.query('UPDATE evolved_runner_leases SET revoked_at=? WHERE id=?').run(f.store.now(), lease.id)
        expect((await f.request('POST', '/authorize', call(config.version), { bearer: lease.capability })).status).toBe(401)
        // A new managed lease yields a different browser identity.
        const next = f.lease(f.project.id)
        const grant = await (await f.request('POST', '/authorize', call(config.version), { bearer: next.capability })).json() as { contextId: string }
        expect(grant.contextId).not.toBe(browserContextId(f.project.id, lease.id))
    })

    test('disable revokes immediately; restricted profile only permits granted read-only tools', async () => {
        const f = fixture('restricted'), lease = f.lease(f.project.id)
        const { config } = await f.enable({ readOnlyTools: ['camofox_list_tabs', 'camofox_snapshot'] })
        expect((await f.request('POST', '/authorize', call(config.version, 'camofox_create_tab'), { bearer: lease.capability })).status).toBe(403)
        expect((await f.request('POST', '/authorize', call(config.version, 'camofox_snapshot'), { bearer: lease.capability })).status).toBe(200)
        const catalog = await (await f.request('POST', '/authorize', { phase: 'catalog' }, { bearer: lease.capability })).json() as { tools: Array<{ name: string }> }
        expect(catalog.tools.map(tool => tool.name).sort()).toEqual(['camofox_list_tabs', 'camofox_snapshot'])
        await f.request('PUT', '', { version: config.version, enabled: false, enabledTools: [], readOnlyTools: [] })
        expect((await f.request('POST', '/authorize', call(config.version + 1, 'camofox_snapshot'), { bearer: lease.capability })).status).toBe(403)
        expect((await f.request('POST', '/authorize', { phase: 'cleanup' }, { bearer: lease.capability })).status).toBe(400)
        const report = await (await f.request('POST', '/report', { service: 'reachable', engine: 'unknown' }, { bearer: lease.capability })).json()
        expect(report).toEqual({ enabled: false, probe: null })
    })
})

describe('agent browser discovery', () => {
    const agent = (f: ReturnType<typeof fixture>, bearer: string, projectId = f.project.id) => f.request('GET', '/agent', undefined, { bearer }, projectId)
    test('disabled, enabled, current grants and runtime are known to every runner session; no secrets', async () => {
        const f = fixture(), lease = f.lease(f.project.id)
        let body = await (await agent(f, lease.capability)).json() as any
        expect(body).toMatchObject({ enabled: false, available: false, managedRunner: true, profile: 'workspace', tools: [], runtime: { state: 'disabled' } })
        expect(body.guidance).toContain('disabled')
        const { config } = await f.enable()
        body = await (await agent(f, lease.capability)).json() as any
        expect(body).toMatchObject({ enabled: true, available: false, managedRunner: true, version: config.version, catalogRevision: BROWSER_CATALOG_REVISION, runtime: { state: 'starting' } })
        expect(body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...BROWSER_DEFAULT_TOOLS].sort())
        expect(body.tools.find((tool: { name: string }) => tool.name === 'camofox_list_tabs').readOnly).toBe(true)
        expect(body.sharing).toContain('No per-session isolation')
        // The verified engine result stays visible to agents between reports.
        await f.request('POST', '/report', { service: 'reachable', engine: 'ready' }, { bearer: lease.capability })
        await f.request('POST', '/report', { service: 'reachable', engine: 'unknown' }, { bearer: lease.capability })
        const controlCalls = f.controls.length
        body = await (await agent(f, lease.capability)).json() as any
        expect(body.runtime.state).toBe('ready'); expect(body.runtime.engineCheckedAt).toBeNumber()
        // Agents never trigger operator control or see human management data.
        expect(f.controls.length).toBe(controlCalls)
        expect(JSON.stringify(body)).not.toMatch(/canManage|updatedBy|key/i)
    })
    test('manual leases learn rights but not availability; restricted sees only read-only grants; humans and other projects refused', async () => {
        const f = fixture('restricted'), managed = f.lease(f.project.id)
        await f.enable({ readOnlyTools: ['camofox_list_tabs', 'camofox_screenshot'] })
        const manual = f.lease(f.project.id, false)
        expect(await (await agent(f, manual.capability)).json()).toMatchObject({ enabled: true, available: false, managedRunner: false })
        const body = await (await agent(f, managed.capability)).json() as any
        expect(body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['camofox_list_tabs', 'camofox_screenshot'])
        expect((await f.request('GET', '/agent')).status).toBe(401)
        expect((await agent(f, managed.capability, f.other.id)).status).toBe(403)
    })
    test('missing managed runner is reported, not hidden', async () => {
        const f = fixture()
        await f.enable()
        const manual = f.lease(f.project.id, false)
        expect(await (await agent(f, manual.capability)).json()).toMatchObject({ enabled: true, available: false, managedRunner: false, runtime: { state: 'runner_missing' } })
    })
})

describe('agent runtime truthfulness', () => {
    const agent = async (f: ReturnType<typeof fixture>, bearer: string) => await (await f.request('GET', '/agent', undefined, { bearer })).json() as any
    test('missing image seen by the operator makes the browser unavailable to agents', async () => {
        const f = fixture(), lease = f.lease(f.project.id)
        f.setOperator({ image: false, containers: { 'browser-gateway': 'missing', browser: 'missing', 'browser-egress': 'missing' } })
        f.failLifecycle(new EvolvedError('browser_image_missing', 'missing', 409))
        const response = await f.request('PUT', '', { version: 0, enabled: true, enabledTools: [...BROWSER_DEFAULT_TOOLS], readOnlyTools: ['camofox_list_tabs'] })
        expect(await response.json()).toMatchObject({ lifecycle: { ok: false, errorCode: 'browser_image_missing' }, runtime: { state: 'image_missing' } })
        expect(await agent(f, lease.capability)).toMatchObject({ enabled: true, available: false, runtime: { state: 'image_missing' } })
        // A later gateway report supersedes the old observation.
        f.advance(1000)
        await f.request('POST', '/report', { service: 'reachable', engine: 'ready' }, { bearer: lease.capability })
        expect(await agent(f, lease.capability)).toMatchObject({ available: true, runtime: { state: 'ready' } })
    })
    test('operator failure at enable time is visible; no reports for long is stale, not starting forever', async () => {
        const f = fixture(), lease = f.lease(f.project.id)
        // Operator socket down for lifecycle and status alike.
        f.failLifecycle(new EvolvedError('runner_unavailable', 'down', 503), true)
        await f.enable()
        expect(await agent(f, lease.capability)).toMatchObject({ available: false, runtime: { state: 'failed', errorCode: 'runner_unavailable' } })
        const g = fixture(), other = g.lease(g.project.id)
        await g.enable()
        expect(await agent(g, other.capability)).toMatchObject({ available: false, runtime: { state: 'starting' } })
        g.advance(60_000)
        expect(await agent(g, other.capability)).toMatchObject({ available: false, runtime: { state: 'stale' } })
    })
})
