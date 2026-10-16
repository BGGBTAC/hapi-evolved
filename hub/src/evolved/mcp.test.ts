import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolvedError, EvolvedStore } from './store'
import { EvolvedVault } from './vault'
import { createProjectMcpRoutes, McpCallJournal, ProjectMcpService, type ProjectMcpRemote } from './mcp'
import { normalizeMcpTools, type McpConnection } from './mcpVault'
import { createCodegraphRoutes } from './codegraph'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const secret = 'SYNTHETIC-MCP-KEY-DO-NOT-RETURN'
const catalog = normalizeMcpTools([
    { name: 'docs', description: 'Read documentation', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'write', description: 'Change remote state', inputSchema: { type: 'object' } },
])
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'evolved-mcp-')), store = new EvolvedStore(':memory:')
    const vault = new EvolvedVault({ dbPath: ':memory:', masterKeyFile: join(dir, 'master.key') })
    cleanup.push(() => { store.close(); vault.close(); rmSync(dir, { recursive: true, force: true }) })
    for (const user of ['admin', 'member', 'viewer', 'other']) store.db.query('INSERT INTO evolved_users VALUES(?,?,0,?)').run(user, user, store.now())
    const team = store.createTeam('admin', 'Team'), project = store.createProject('admin', team.id, 'Project')
    store.setProfile('admin', project.id, 'workspace')
    store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    const sessions = Object.fromEntries(['admin', 'member', 'viewer', 'other'].map(user => [user, store.createSession(user)]))
    const calls: string[] = []
    const remote: ProjectMcpRemote = {
        discover: async (_config, check) => { await check(); calls.push('discover'); return catalog },
        call: async (_config, name, _args, _fingerprint, check) => { await check(); calls.push(name); return { content: [{ type: 'text', text: 'documented' }], structuredContent: { ok: true }, isError: false } },
    }
    const service = new ProjectMcpService(vault, remote)
    const app = new Hono().route('/api/evolved', createProjectMcpRoutes({ store, service, origin: 'https://hapi.test' }))
        .route('/api/evolved', createCodegraphRoutes({ store, origin: 'https://hapi.test' }))
    const base = `/api/evolved/projects/${project.id}/mcp`
    const request = (method = 'GET', suffix = '', body?: unknown, user = 'admin', bearer?: string) => app.request(`https://hapi.test${base}${suffix}`, {
        method, headers: { origin: 'https://hapi.test', 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: `__Host-hapi-evolved=${sessions[user]}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const create = async () => {
        const response = await request('POST', '', { id: crypto.randomUUID(), kind: 'custom', endpoint: 'https://public.example/mcp', auth: { mode: 'bearer', token: secret } })
        expect(response.status).toBe(201)
        return (await response.json() as { connection: McpConnection }).connection
    }
    const enabled = async () => {
        let connection = await create()
        const discovered = await request('POST', `/${connection.id}/discover`, { version: connection.version }); expect(discovered.status).toBe(200)
        connection = (await discovered.json() as { connection: McpConnection }).connection
        const granted = await request('PUT', `/${connection.id}`, { version: connection.version, catalogRevision: connection.catalogRevision, enabled: true, enabledTools: ['docs', 'write'], readOnlyTools: ['docs'] }); expect(granted.status).toBe(200)
        return (await granted.json() as { connection: McpConnection }).connection
    }
    const input = (connection: McpConnection, toolName = 'docs') => ({ toolName, arguments: { query: 'safe docs query' }, version: connection.version, catalogRevision: connection.catalogRevision })
    return { store, vault, service, remote, calls, app, base, request, create, enabled, input, project, team, sessions }
}

describe('project MCP gateway', () => {
    test('fixed Context7 template, write-only key, explicit discovery and grants, metadata-only history', async () => {
        const f = fixture(), c = await f.enabled()
        const listing = await (await f.request()).json() as { templates: unknown[] }
        expect(listing.templates[0]).toMatchObject({ id: 'context7', endpoint: 'https://mcp.context7.com/mcp' })
        expect(JSON.stringify(listing)).not.toContain(secret)
        expect(f.calls).toEqual(['discover'])
        const result = await f.request('POST', `/servers/${c.id}/query`, f.input(c), 'member')
        expect(result.status).toBe(200)
        expect(await result.json()).toMatchObject({ isError: false, structuredContent: { ok: true }, content: [{ type: 'text', text: 'documented' }] })
        const history = await (await f.request('GET', `/${c.id}/history`, undefined, 'viewer')).json() as { calls: Array<{ toolName: string; status: string }> }
        expect(history.calls).toHaveLength(1); expect(history.calls[0]).toMatchObject({ toolName: 'docs', status: 'success', errorCode: null })
        for (const sensitive of [secret, 'safe docs query', 'documented']) expect(JSON.stringify(history)).not.toContain(sensitive)
        expect(JSON.stringify(f.store.db.query('SELECT * FROM evolved_audit').all())).not.toContain(secret)
    })
    test('capabilities only see enabled granted data, cannot manage credentials or history', async () => {
        const f = fixture(), c = await f.enabled(), cap = f.store.issueCapability('admin', f.project.id, ['runner:connect'], [], 300)
        expect((await f.request('GET', '/servers', undefined, 'admin', cap.token)).status).toBe(200)
        expect((await f.request('GET', `/servers/${c.id}/tools`, undefined, 'admin', cap.token)).status).toBe(200)
        expect((await f.request('POST', `/servers/${c.id}/query`, f.input(c), 'admin', cap.token)).status).toBe(200)
        for (const [method, suffix, body] of [['GET', '', undefined], ['GET', `/${c.id}/history`, undefined], ['POST', `/${c.id}/discover`, { version: c.version }], ['DELETE', `/${c.id}`, { version: c.version }]] as const) expect((await f.request(method, suffix, body, 'admin', cap.token)).status).toBe(403)
        const narrow = f.store.issueCapability('admin', f.project.id, ['memory:read'], [], 300)
        expect((await f.request('GET', '/servers', undefined, 'admin', narrow.token)).status).toBe(403)
        const other = f.store.createProject('admin', f.team.id, 'Other'), cross = f.store.issueCapability('admin', other.id, ['runner:connect'], [], 300)
        expect((await f.request('GET', '/servers', undefined, 'admin', cross.token)).status).toBe(403)
    })
    test('query path enforces human read-only grant; restricted profiles hide writable tools', async () => {
        const f = fixture(), c = await f.enabled()
        expect((await f.request('POST', `/servers/${c.id}/query`, f.input(c, 'write'))).status).toBe(403)
        expect((await f.request('POST', `/servers/${c.id}/call`, f.input(c, 'write'))).status).toBe(200)
        f.store.setProfile('admin', f.project.id, 'restricted')
        const listing = await (await f.request('GET', `/servers/${c.id}/tools`)).json() as { tools: Array<{ name: string }> }
        expect(listing.tools.map((tool: {name:string}) => tool.name)).toEqual(['docs'])
        expect((await f.request('POST', `/servers/${c.id}/call`, f.input(c, 'write'))).status).toBe(403)
        expect((await f.request('POST', `/servers/${c.id}/query`, f.input(c))).status).toBe(200)
    })
    test('member/viewer/outsider/freshness/CSRF protections reject credential changes', async () => {
        const f = fixture(), c = await f.create()
        for (const user of ['member', 'viewer', 'other']) expect((await f.request('POST', `/${c.id}/discover`, { version: c.version }, user)).status).toBe(403)
        const csrf = await f.app.request(`https://hapi.test${f.base}/${c.id}/discover`, { method: 'POST', headers: { cookie: `__Host-hapi-evolved=${f.sessions.admin}`, origin: 'https://evil.test' }, body: JSON.stringify({ version: c.version }) })
        expect(csrf.status).toBe(403)
        f.store.db.query('UPDATE evolved_sessions SET created_at=?').run(f.store.now() - 600_000)
        expect((await f.request('POST', `/${c.id}/discover`, { version: c.version })).status).toBe(403)
        expect(f.calls).toHaveLength(0)
    })
    test('body streaming logout cannot create a connection after prior authentication', async () => {
        const f = fixture(); let finish!: () => void
        const body = new ReadableStream({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: crypto.randomUUID(), kind: 'context7', auth: { mode: 'none' } }))); controller.close() } } })
        const pending = f.app.request(new Request(`https://hapi.test${f.base}`, { method: 'POST', headers: { cookie: `__Host-hapi-evolved=${f.sessions.admin}`, origin: 'https://hapi.test', 'content-type': 'application/json' }, body } as RequestInit))
        await Promise.resolve(); f.store.revokeSession(f.sessions.admin!); finish()
        expect((await pending).status).toBe(401)
        expect((await f.service.list('admin', f.project.id))).toHaveLength(0)
    })
    test('disable while discovery is in flight wins and late discovery cannot revive it', async () => {
        const f = fixture(), c = await f.enabled(); let resume!: () => void, started!: () => void
        const waiting = new Promise<void>(resolve => { started = resolve })
        f.remote.discover = async () => { started(); await new Promise<void>(resolve => { resume = resolve }); return catalog }
        const pending = f.request('POST', `/${c.id}/discover`, { version: c.version }); await waiting
        const disabled = await f.request('PUT', `/${c.id}`, { version: c.version, catalogRevision: c.catalogRevision, enabled: false, enabledTools: ['docs'], readOnlyTools: ['docs'] })
        expect(disabled.status).toBe(200); resume()
        expect((await pending).status).toBe(409)
        expect((await f.service.connection('admin', f.project.id, c.id)).enabled).toBe(false)
        expect((await f.request('POST', `/servers/${c.id}/query`, f.input(c))).status).toBe(409)
    })
    test.each(['logout', 'profile', 'role'] as const)('revalidation blocks remote send after %s', async change => {
        const f = fixture(), c = await f.enabled(); let sent = false
        f.remote.call = async (_config, _name, _args, _fingerprint, check) => {
            if (change === 'logout') f.store.revokeSession(f.sessions.admin!)
            if (change === 'profile') f.store.setProfile('admin', f.project.id, 'restricted')
            if (change === 'role') { f.store.setMember('admin', f.team.id, 'viewer', 'admin'); f.store.setMember('viewer', f.team.id, 'admin', 'viewer') }
            await check(); sent = true; return { content: [] }
        }
        const capability = f.store.issueCapability('admin', f.project.id, ['runner:connect'], [], 300)
        const result = await f.request('POST', `/servers/${c.id}/call`, f.input(c), 'admin', change === 'logout' ? undefined : capability.token)
        expect([401,403]).toContain(result.status); expect(sent).toBe(false)
    })
    test('schema drift blocks call and marks connection for explicit rediscovery', async () => {
        const f = fixture(), c = await f.enabled()
        f.remote.call = async () => { throw new EvolvedError('mcp_catalog_changed', 'Definition changed', 409) }
        expect((await f.request('POST', `/servers/${c.id}/call`, f.input(c))).status).toBe(409)
        const current = await f.service.connection('admin', f.project.id, c.id)
        expect(current).toMatchObject({ enabled: false, enabledTools: [], status: { state: 'catalog_changed' } })
    })
    test('tool errors preserve MCP isError; thrown remote errors do not leak content or retry', async () => {
        const f = fixture(), c = await f.enabled(); let calls = 0
        f.remote.call = async () => { calls++; return { isError: true, content: [{ type: 'text', text: 'provider rejected query' }] } }
        expect(await (await f.request('POST', `/servers/${c.id}/call`, f.input(c))).json()).toMatchObject({ isError: true })
        f.remote.call = async () => { calls++; throw new Error(secret) }
        const failed = await f.request('POST', `/servers/${c.id}/call`, f.input(c))
        expect(failed.status).toBe(502); expect(await failed.text()).not.toContain(secret); expect(calls).toBe(2)
        const history = await (await f.request('GET', `/${c.id}/history`)).json() as { calls: Array<{ status: string }> }
        expect(history.calls.map((call: {status:string}) => call.status)).toEqual(['unknown','tool_error'])
    })
    test('configuration change after external execution returns non-retryable unknown instead of stale409', async () => {
        const f = fixture(), c = await f.enabled(); let externalEffects = 0
        f.remote.call = async () => {
            externalEffects++
            await f.service.request('admin', f.project.id, 'update', { id: c.id, version: c.version, catalogRevision: c.catalogRevision, enabled: true, name: 'Renamed', enabledTools: ['docs', 'write'], readOnlyTools: ['docs'] })
            return { content: [{ type: 'text', text: 'private-result-must-be-withheld' }] }
        }
        const response = await f.request('POST', `/servers/${c.id}/call`, f.input(c, 'write'))
        expect(response.status).toBe(502)
        const body = await response.json() as { code: string; error: string }
        expect(body.code).toBe('mcp_outcome_unknown'); expect(body.error).toContain('Nicht erneut ausführen')
        expect(JSON.stringify(body)).not.toContain('private-result'); expect(externalEffects).toBe(1)
        const history = await (await f.request('GET', `/${c.id}/history`)).json() as { calls: Array<{ status: string; errorCode: string }> }
        expect(history.calls[0]).toMatchObject({ status: 'unknown', errorCode: 'mcp_outcome_unknown' })
    })
    test('a completed remote call cannot recreate history after connection removal', async () => {
        const f = fixture(), c = await f.enabled()
        f.remote.call = async () => {
            expect((await f.request('DELETE', `/${c.id}`, { version: c.version })).status).toBe(200)
            return { content: [] }
        }
        expect((await f.request('POST', `/servers/${c.id}/call`, f.input(c))).status).toBe(502)
        expect(f.store.db.query('SELECT * FROM evolved_mcp_calls').all()).toHaveLength(0)
    })
    test('stale revisions and excessive input fail before remote activity', async () => {
        const f = fixture(), c = await f.enabled()
        for (const body of [{ ...f.input(c), version: c.version - 1 }, { ...f.input(c), catalogRevision: 'a'.repeat(64) }]) expect((await f.request('POST', `/servers/${c.id}/call`, body)).status).toBe(409)
        expect((await f.request('POST', `/servers/${c.id}/call`, { ...f.input(c), arguments: { query: 'x'.repeat(65_536) } })).status).toBe(413)
        let deep: unknown = 'x'; for (let i = 0; i < 35; i++) deep = { deep }
        expect((await f.request('POST', `/servers/${c.id}/call`, { ...f.input(c), arguments: { deep } })).status).toBe(400)
        expect(f.calls).toEqual(['discover'])
    })
    test('journal is bounded and project deletion cascades', async () => {
        const f = fixture(), c = await f.enabled(), journal = new McpCallJournal(f.store)
        for (let i = 0; i < 70; i++) journal.record(f.project.id, c.id, 'docs', f.store.now(), 'success')
        expect(journal.list(f.project.id, c.id)).toHaveLength(50)
        f.store.db.query('DELETE FROM evolved_projects WHERE id=?').run(f.project.id)
        expect(journal.list(f.project.id, c.id)).toHaveLength(0)
        journal.record(f.project.id, c.id, 'docs', f.store.now(), 'failed')
        expect(journal.list(f.project.id, c.id)).toHaveLength(0)
    })
    test('one actor cannot exhaust global slots by opening more projects', async () => {
        const f = fixture(); let release!: () => void
        const hold = new Promise<void>(resolve => { release = resolve })
        const pending = Array.from({ length: 4 }, (_, index) => f.service.bounded({ id: `project-${index}`, teamId: 'team-a' }, 'same-user', 'call', () => hold))
        await expect(f.service.bounded({ id: 'another-project', teamId: 'team-b' }, 'same-user', 'call', async () => true)).rejects.toMatchObject({ code: 'mcp_busy', status: 429 })
        expect(await f.service.bounded({ id: 'other-project', teamId: 'team-b' }, 'other-user', 'call', async () => true)).toBe(true)
        release(); await Promise.all(pending)
        expect(await f.service.bounded({ id: 'after-completion', teamId: 'team-a' }, 'same-user', 'call', async () => true)).toBe(true)
    })
    test('read-only Codegraph scope cannot trigger reindex; humans retain it', async () => {
        const f = fixture(), token = f.store.issueCapability('admin', f.project.id, ['codegraph:read'], [], 300).token
        const url = `https://hapi.test/api/evolved/projects/${f.project.id}/codegraph/reindex`
        expect((await f.app.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
        expect((await f.app.request(url, { method: 'POST', headers: { origin: 'https://hapi.test', cookie: `__Host-hapi-evolved=${f.sessions.admin}` } })).status).toBe(503)
    })
})
