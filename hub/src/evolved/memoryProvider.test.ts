import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolvedStore } from './store'
import { EvolvedVault } from './vault'
import { HttpMemoryBackend, MemoryService } from './memoryService'
import { createMemoryProviderRoutes, MemoryProviderService, type MemoryProviderConfig } from './memoryProvider'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const key = 'SYNTHETIC-memory-provider-canary'
const config: MemoryProviderConfig = { provider: 'openai', apiKey: key, model: 'chat-model', embeddingModel: 'text-embedding-3-small', embeddingDimensions: 1536, inputUsdPerMTok: '0.4', outputUsdPerMTok: '1.6', embeddingUsdPerMTok: '0.02', maxOutputTokens: 1024 }
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'memory-provider-')), store = new EvolvedStore(':memory:')
    const vault = new EvolvedVault({ dbPath: ':memory:', masterKeyFile: join(dir, 'master.key'), workspaceRoot: process.cwd() })
    cleanup.push(() => { store.close(); vault.close(); rmSync(dir, { recursive: true, force: true }) })
    for (const id of ['admin', 'member', 'viewer', 'other']) store.db.query('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, 0, store.now())
    const team = store.createTeam('admin', 'Team'), project = store.createProject('admin', team.id, 'Project')
    store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    const sessions = Object.fromEntries(['admin', 'member', 'viewer', 'other'].map(id => [id, store.createSession(id)]))
    new MemoryService(store, { available: async () => false, request: async () => ({}) })
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    let upstream = async (path: string, _body: Record<string, unknown>) => Response.json(path.endsWith('/models') ? { models: ['chat-model', 'text-embedding-3-small', 'text-embedding-3-large'] } : { ok: true })
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)) as Record<string, unknown>
        calls.push({ path, body }); return upstream(path, body)
    }) as typeof fetch
    const service = new MemoryProviderService(store, vault, 'http://memory.test', 'internal-test-token', fetcher)
    const app = new Hono().route('/api/evolved', createMemoryProviderRoutes({ store, service, origin: 'https://hapi.test' }))
    const path = `/projects/${project.id}/memory/provider`
    const request = (method = 'GET', body?: unknown, suffix = '', user = 'admin', headers: Record<string, string> = {}) => app.request(`https://hapi.test/api/evolved${path}${suffix}`, {
        method, headers: { cookie: `__Host-hapi-evolved=${sessions[user]}`, origin: 'https://hapi.test', 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { store, vault, service, project, team, sessions, calls, request, setUpstream: (fn: typeof upstream) => { upstream = fn } }
}

describe('human-only project memory provider setup', () => {
    test('stores a project credential privately, preserves blank keys, and uses version CAS', async () => {
        const f = fixture()
        expect(await (await f.request()).json()).toMatchObject({ configured: false, source: 'environment', version: 0 })
        const saved = await f.request('PUT', { ...config, version: 0 })
        expect(saved.status).toBe(200)
        const body = await saved.json()
        expect(body).toMatchObject({ configured: true, source: 'project', apiKeyConfigured: true, version: 1, config: { model: 'chat-model' } })
        expect(JSON.stringify(body)).not.toContain(key)
        expect(await f.service.resolve(f.project.id)).toEqual(config)
        expect(await f.vault.request({ userId: 'admin', projectId: f.project.id, operation: 'list', payload: {} })).toEqual({ secrets: [] })
        expect(JSON.stringify(f.store.db.query('SELECT * FROM evolved_audit').all())).not.toContain(key)
        expect(JSON.stringify(f.vault.db.query('SELECT * FROM audit').all())).not.toContain(key)
        const updated = await f.request('PUT', { ...config, apiKey: '', maxOutputTokens: 512, version: 1 })
        expect(updated.status).toBe(200)
        expect((await f.service.resolve(f.project.id))?.apiKey).toBe(key)
        expect((await f.request('PUT', { ...config, version: 1 })).status).toBe(409)
        expect((await f.request('DELETE', { version: 1 })).status).toBe(409)
        expect((await f.request('DELETE', { version: 2 })).status).toBe(200)
        expect(await f.service.resolve(f.project.id)).toBeNull()
        expect(await (await f.request()).json()).toMatchObject({ source: 'disabled', version: 3, config: null, apiKeyConfigured: false, boundEmbeddingModel: config.embeddingModel })
        expect((await f.request('PUT', { ...config, apiKey: '', version: 3 })).status).toBe(400)
    })

    test('project snapshots and deletion state cannot fall through to another project credential', async () => {
        const f = fixture(), other = f.store.createProject('admin', f.team.id, 'Other')
        await f.request('PUT', { ...config, version: 0 })
        const second = { ...config, apiKey: 'SYNTHETIC-other-project-key', model: 'second-model' }
        await f.vault.request({ userId: 'admin', projectId: other.id, operation: 'memoryProvider', payload: { action: 'set', version: 0, config: second } })
        expect(await f.service.resolve(f.project.id)).toEqual(config)
        expect(await f.service.resolve(other.id)).toEqual(second)
        f.store.db.query('UPDATE evolved_projects SET deleting_at=? WHERE id=?').run(f.store.now(), other.id)
        expect(await f.service.resolve(other.id)).toBeNull()
        expect(await f.service.resolve('missing-project')).toBeNull()
        expect(await f.service.resolve(f.project.id)).toEqual(config)
    })

    test('members only read sanitized settings; capabilities and viewers cannot access any setup action', async () => {
        const f = fixture()
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        expect((await f.request('GET', undefined, '', 'member')).status).toBe(200)
        expect((await f.request('GET', undefined, '', 'viewer')).status).toBe(403)
        expect((await f.request('GET', undefined, '', 'other')).status).toBe(403)
        const issued = f.store.issueCapability('admin', f.project.id, ['memory:read', 'memory:write'], [], 300)
        for (const [method, suffix, body] of [['GET', '', undefined], ['PUT', '', { ...config, version: 1 }], ['DELETE', '', { version: 1 }], ['POST', '/models', {}], ['POST', '/test', {}]] as const) {
            expect((await f.request(method, body, suffix, 'admin', { authorization: `Bearer ${issued.token}` })).status).toBe(403)
            if (method !== 'GET') expect((await f.request(method, body, suffix, 'member')).status).toBe(403)
        }
        expect(f.calls).toHaveLength(1)
    })

    test('fresh passkeys, CSRF and bounded strict input protect credential operations', async () => {
        const f = fixture()
        expect((await f.request('PUT', { ...config, version: 0, apiBase: 'http://attacker.invalid' })).status).toBe(400)
        expect((await f.request('PUT', { ...config, version: 0, embeddingDimensions: 3072 })).status).toBe(400)
        for (const price of ['Infinity', '0', '0.000', '-1', '1e2', '1000001']) expect((await f.request('PUT', { ...config, version: 0, inputUsdPerMTok: price })).status).toBe(400)
        expect((await f.request('PUT', { ...config, version: 0, apiKey: '' })).status).toBe(400)
        for (const origin of ['', 'https://attacker.invalid']) expect((await f.request('PUT', { ...config, version: 0 }, '', 'admin', { origin })).status).toBe(403)
        expect((await f.request('PUT', { ...config, version: 0, apiKey: 'x'.repeat(20_000) })).status).toBe(413)
        f.store.db.query('UPDATE evolved_sessions SET created_at=?').run(f.store.now() - 600_000)
        expect((await f.request('GET')).status).toBe(200)
        for (const [method, suffix, body] of [['PUT', '', { ...config, version: 0 }], ['DELETE', '', { version: 0 }], ['POST', '/models', { apiKey: key }], ['POST', '/test', {}]] as const) expect((await f.request(method, body, suffix)).status).toBe(403)
        expect(f.calls).toHaveLength(0)
    })

    test('models/auth and stored connection checks perform no inference and never echo upstream errors', async () => {
        const f = fixture()
        expect((await f.request('POST', { apiKey: key }, '/models')).status).toBe(200)
        expect(await f.service.resolve(f.project.id)).toBeUndefined()
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        expect(await (await f.request('POST', {}, '/test')).json()).toEqual({ ok: true, backend: 'graphiti-0.30.2/neo4j', modelsVerified: true, inferenceTested: false })
        expect(f.calls.map(call => call.path)).toEqual(['/configuration/models', '/configuration/models', '/configuration/models', '/configuration/check'])
        f.setUpstream(async () => new Response(JSON.stringify({ error: key }), { status: 401 }))
        const denied = await f.request('POST', {}, '/models')
        expect(denied.status).toBe(400)
        expect(await denied.text()).not.toContain(key)
    })

    test('first setup accepts never-started local work but rejects unknown existing graph bindings', async () => {
        const f = fixture()
        f.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,created_at) VALUES('task',?,'admin','index',0,?)").run(f.project.id, f.store.now())
        expect(await (await f.request()).json()).toMatchObject({ embeddingLocked: false })
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        expect(await (await f.request()).json()).toMatchObject({ embeddingLocked: true })
        const legacy = fixture()
        legacy.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,state,created_at) VALUES('legacy-task',?,'admin','index',0,'complete',?)").run(legacy.project.id, legacy.store.now())
        expect((await legacy.request('PUT', { ...config, version: 0 })).status).toBe(409)
        expect(await legacy.service.resolve(legacy.project.id)).toBeUndefined()
    })

    test('prevents embedding changes for queued or existing graph work, even across delete/recreate', async () => {
        const f = fixture()
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        f.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,created_at) VALUES('task',?,'admin','index',0,?)").run(f.project.id, f.store.now())
        expect((await f.request('PUT', { ...config, embeddingModel: 'text-embedding-3-large', version: 1 })).status).toBe(409)
        expect((await f.request('DELETE', { version: 1 })).status).toBe(200)
        expect((await f.request('PUT', { ...config, embeddingModel: 'text-embedding-3-large', version: 2 })).status).toBe(409)
        expect((await f.request('PUT', { ...config, apiKey: 'SYNTHETIC-rotated-key', version: 2 })).status).toBe(200)
        expect(await (await f.request()).json()).toMatchObject({ embeddingLocked: true, version: 3 })
    })

    test('legacy failed jobs allow first binding only after a service proof of no graph or active operation', async () => {
        const f = fixture()
        f.store.db.query("INSERT INTO evolved_memory_reservations(id,project_id,period,reserved_micros,spent_micros,state,created_at) VALUES('old',?,'2026-10',20,0,'settled',?)").run(f.project.id, f.store.now())
        f.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,state,reservation_id,attempts,created_at) VALUES('old-task',?,'admin','index',0,'failed','old',1,?)").run(f.project.id, f.store.now())
        let empty: unknown = false
        f.setUpstream(async path => Response.json(path.endsWith('/binding') ? { empty } : { models: ['chat-model', 'text-embedding-3-small'] }))
        expect(await (await f.request()).json()).toMatchObject({ embeddingLocked: true, boundEmbeddingModel: null })
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(409)
        empty = 'true'
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(409)
        empty = true
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        expect(f.calls.filter(call => call.path === '/configuration/binding').map(call => call.body)).toEqual(Array(3).fill({ projectId: f.project.id, embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions }))
        expect(f.store.db.query('SELECT state,reservation_id FROM evolved_memory_tasks WHERE id=?').get('old-task')).toEqual({ state: 'failed', reservation_id: 'old' })
        expect(f.store.db.query('SELECT state,spent_micros FROM evolved_memory_reservations WHERE id=?').get('old')).toEqual({ state: 'settled', spent_micros: 0 })
        expect(await (await f.request()).json()).toMatchObject({ boundEmbeddingModel: config.embeddingModel, embeddingLocked: true })
    })

    test('revocation during model validation blocks save, and concurrent processing blocks settings mutation', async () => {
        const f = fixture()
        f.setUpstream(async () => { f.store.setMember('admin', f.team.id, 'other', 'admin'); f.store.setMember('other', f.team.id, 'admin', null); return Response.json({ models: ['chat-model', 'text-embedding-3-small'] }) })
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(403)
        expect(await f.service.resolve(f.project.id)).toBeUndefined()
        const g = fixture()
        let finish!: () => void
        const running = g.service.using(g.project.id, () => new Promise<void>(resolve => { finish = resolve }))
        expect((await g.request('PUT', { ...config, version: 0 })).status).toBe(409)
        expect((await g.request('DELETE', { version: 0 })).status).toBe(409)
        finish(); await running
        expect((await g.request('PUT', { ...config, version: 0 })).status).toBe(200)
    })

    test('model/auth probes have bounded admission', async () => {
        const f = fixture()
        for (let n = 0; n < 6; n++) expect((await f.request('POST', { apiKey: key }, '/models')).status).toBe(200)
        expect((await f.request('POST', { apiKey: key }, '/models')).status).toBe(429)
        expect(f.calls).toHaveLength(6)
    })
})

describe('internal project-specific memory snapshots', () => {
    test('failed preflight creates no reservation or graph binding that would block first browser setup', async () => {
        const f = fixture(), calls: string[] = []
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
            calls.push(new URL(request.url).pathname)
            return Response.json({ error: 'Memory model is not configured' }, { status: 503 })
        } })
        cleanup.unshift(() => server.stop(true))
        const service = new MemoryService(f.store, new HttpMemoryBackend(`http://127.0.0.1:${server.port}`, 'internal-test-token', f.service.resolve, f.service.using))
        service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
        service.ledger.create(f.project.id, 'admin', 'Local knowledge', 'Retained source', [{ kind: 'manual', projectId: f.project.id, hash: 'manual' }])
        expect(await service.processOne()).toBe(false)
        expect(calls).toEqual(['/health'])
        expect(service.ledger.budget(f.project.id).reservedMicros).toBe(0)
        expect(await (await f.request()).json()).toMatchObject({ embeddingLocked: false })
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        expect(service.ledger.list(f.project.id)).toHaveLength(1)
    })

    test('processing revalidates project permission and cloud consent after the asynchronous Vault lookup', async () => {
        const calls: string[] = []
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => { calls.push(new URL(request.url).pathname); return Response.json({ ok: true, spentMicros: 0, results: [] }) } })
        cleanup.unshift(() => server.stop(true))
        for (const revoke of ['member', 'cloud', 'generation'] as const) {
            const f = fixture()
            let lookups = 0
            const backend = new HttpMemoryBackend(`http://127.0.0.1:${server.port}`, 'internal-test-token', async () => {
                if (++lookups === 1) return config
                await Promise.resolve()
                if (revoke === 'member') { f.store.setMember('admin', f.team.id, 'other', 'admin'); f.store.setMember('other', f.team.id, 'admin', null) }
                else if (revoke === 'cloud') service.ledger.configure(f.project.id, { enabled: false, cloudAllowed: false, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
                else f.store.db.query('UPDATE evolved_memory_settings SET generation=generation+1 WHERE project_id=?').run(f.project.id)
                return config
            })
            const service = new MemoryService(f.store, backend)
            service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
            service.ledger.create(f.project.id, 'admin', 'Local knowledge', 'Source-backed knowledge', [{ kind: 'manual', projectId: f.project.id, hash: 'manual' }])
            expect(await service.processOne()).toBe(false)
        }
        expect(calls).toEqual(['/configuration/check', '/configuration/check', '/configuration/check'])
    })

    test('sends credentials only with processing/check requests and preserves legacy environment fallback', async () => {
        const calls: Array<{ path: string; body: Record<string, unknown> | null }> = []
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            calls.push({ path: new URL(request.url).pathname, body: request.method === 'POST' ? await request.json() as Record<string, unknown> : null })
            return Response.json({ ok: true, spentMicros: 0 })
        } })
        cleanup.unshift(() => server.stop(true))
        const seen: string[] = []
        let resolved: MemoryProviderConfig | null | undefined = config
        const backend = new HttpMemoryBackend(`http://127.0.0.1:${server.port}`, 'internal-test-token', async id => { seen.push(id); return resolved })
        expect(await backend.available('project-a')).toBe(true)
        await backend.request('/ingest', { projectId: 'project-a', operationId: 'op' })
        await backend.request('/search', { projects: [{ projectId: 'project-a' }], operationId: 'search' })
        for (const path of ['/reset', '/receipt']) await backend.request(path, { projectId: 'project-a', providerConfig: config })
        expect(seen).toEqual(['project-a', 'project-a', 'project-a'])
        expect(calls.slice(0, 3).every(call => JSON.stringify(call.body).includes(key))).toBe(true)
        expect(calls.slice(3).every(call => !JSON.stringify(call.body).includes(key))).toBe(true)
        resolved = undefined
        expect(await backend.available('project-b')).toBe(true)
        expect(calls.at(-1)?.path).toBe('/health')
        await backend.request('/ingest', { projectId: 'project-b' })
        expect(calls.at(-1)?.body).not.toHaveProperty('providerConfig')
        resolved = null
        expect(await backend.available('project-a')).toBe(false)
        await expect(backend.request('/ingest', { projectId: 'project-a' })).rejects.toThrow('disabled')
        await backend.request('/reset', { projectId: 'project-a' })
        expect(calls.at(-1)?.path).toBe('/reset')
    })
})
