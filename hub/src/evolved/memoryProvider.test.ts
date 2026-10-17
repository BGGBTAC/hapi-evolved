import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolvedError, EvolvedStore } from './store'
import { EvolvedVault } from './vault'
import { HttpMemoryBackend, MemoryService } from './memoryService'
import { createMemoryProviderRoutes, MemoryProviderService, type MemoryProviderConfig, type MemoryProviderPublic } from './memoryProvider'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const key = 'SYNTHETIC-memory-provider-canary'
const config: MemoryProviderConfig = { schemaVersion: 2,
    llm: { provider: 'openai', apiKey: key, model: 'chat-model', inputUsdPerMTok: '0.4', outputUsdPerMTok: '1.6', maxOutputTokens: 1024 },
    embedding: { provider: 'openai', apiKey: key, model: 'text-embedding-3-small', dimensions: 1536, inputUsdPerMTok: '0.02' }, reranker: { provider: 'rrf' } }
const catalogRequest = { component: 'llm', provider: 'openai' }
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
    let upstream = async (path: string, _body: Record<string, unknown>) => Response.json(path.endsWith('/models') ? { verified: true, models: ['chat-model', 'text-embedding-3-small', 'text-embedding-3-large'] } : path.endsWith('/binding') ? { bound: true } : { ok: true })
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
    test('Claude and Voyage work without any OpenAI key and report unverified catalogs honestly', async () => {
        const f = fixture(), selected: MemoryProviderConfig = {
            schemaVersion: 2,
            llm: { ...config.llm, provider: 'anthropic', apiKey: 'SYNTHETIC-anthropic-only', model: 'claude-test' },
            embedding: { ...config.embedding, provider: 'voyage', apiKey: 'SYNTHETIC-voyage-only', model: 'voyage-test', dimensions: 1024 },
            reranker: { provider: 'rrf' },
        }
        f.setUpstream(async (path, body) => Response.json(path.endsWith('/models')
            ? body.provider === 'anthropic' ? { models: ['claude-test'], verified: true } : { models: [], verified: false }
            : path.endsWith('/binding') ? { bound: true } : { ok: true }))
        const saved = await f.request('PUT', { ...selected, version: 0 })
        expect(saved.status).toBe(200)
        expect(await saved.json()).toMatchObject({ keyConfigured: { llm: true, embedding: true, reranker: false },
            apiKeyConfigured: true, boundEmbeddingProvider: 'voyage', boundEmbeddingModel: 'voyage-test', boundEmbeddingDimensions: 1024 })
        expect(await f.service.resolve(f.project.id)).toEqual(selected)
        expect(await (await f.request('POST', {}, '/test')).json()).toMatchObject({ ok: true, modelsVerified: false, unverifiedComponents: ['embedding'], inferenceTested: false })
        expect(f.calls.filter(call => call.path.endsWith('/models')).map(call => call.body)).toEqual([
            { provider: 'anthropic', apiKey: selected.llm.apiKey }, { provider: 'voyage', apiKey: selected.embedding.apiKey },
            { provider: 'anthropic', apiKey: selected.llm.apiKey }, { provider: 'voyage', apiKey: selected.embedding.apiKey },
        ])
        expect(f.calls.find(call => call.path.endsWith('/binding'))?.body).toEqual({ projectId: f.project.id,
            embeddingProvider: 'voyage', embeddingModel: 'voyage-test', embeddingDimensions: 1024 })
    })

    test('each component retains only its own credential and public results redact all three keys', async () => {
        for (const provider of ['openai', 'voyage'] as const) {
            const f = fixture(), selected: MemoryProviderConfig = { ...config,
                embedding: { ...config.embedding, apiKey: 'SYNTHETIC-embedding-private' },
                reranker: provider === 'openai' ? { ...config.llm, provider, apiKey: 'SYNTHETIC-reranker-private' }
                    : { provider, model: 'rerank-test', apiKey: 'SYNTHETIC-reranker-private', inputUsdPerMTok: '0.1' },
            }
            f.setUpstream(async (path, body) => Response.json(path.endsWith('/models')
                ? body.provider === 'voyage' ? { models: [], verified: false } : { models: ['chat-model', config.embedding.model], verified: true }
                : path.endsWith('/binding') ? { bound: true } : { ok: true }))
            const saved = await f.request('PUT', { ...selected, version: 0 })
            expect(saved.status).toBe(200)
            const publicText = await saved.text()
            for (const value of [selected.llm.apiKey, selected.embedding.apiKey, 'SYNTHETIC-reranker-private']) expect(publicText).not.toContain(value)
            expect(JSON.parse(publicText).keyConfigured).toEqual({ llm: true, embedding: true, reranker: true })
            const body = JSON.parse(publicText).config
            expect((await f.request('PUT', { ...body, version: 1 })).status).toBe(200)
            expect(await f.service.resolve(f.project.id)).toEqual(selected)
            for (const component of ['llm', 'embedding', 'reranker'] as const) {
                expect((await f.request('POST', { component, provider: selected[component].provider }, '/models')).status).toBe(200)
                expect(f.calls.at(-1)?.body.apiKey).toBe(component === 'reranker' ? 'SYNTHETIC-reranker-private' : selected[component].apiKey)
            }
            expect(await (await f.request('POST', {}, '/test')).json()).toMatchObject({ modelsVerified: provider === 'openai',
                unverifiedComponents: provider === 'openai' ? [] : ['reranker'] })
        }
    })

    test('switching providers or enabling another slot never reuses an existing component key', async () => {
        const changes = [
            { llm: { ...config.llm, provider: 'anthropic', apiKey: '' } },
            { embedding: { ...config.embedding, provider: 'voyage', dimensions: 1024, apiKey: '' } },
            { reranker: { ...config.llm, provider: 'openai', apiKey: '' } },
        ]
        for (const change of changes) {
            const f = fixture()
            expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
            f.calls.length = 0
            const denied = await f.request('PUT', { ...config, ...change, version: 1 })
            expect(denied.status).toBe(400)
            expect(await denied.json()).toMatchObject({ code: 'memory_provider_key_required' })
            expect(f.calls).toEqual([])
            const component = Object.keys(change)[0]
            const provider = Object.values(change)[0].provider
            expect((await f.request('POST', { component, provider }, '/models')).status).toBe(400)
            expect(f.calls).toEqual([])
            expect(await f.service.resolve(f.project.id)).toEqual(config)
        }
        const first = fixture()
        expect((await first.request('PUT', { ...config, embedding: { ...config.embedding, apiKey: '' }, version: 0 })).status).toBe(400)
        expect(first.calls).toEqual([])
    })

    test('catalogs reject invalid, oversized or credential-bearing model IDs and cannot claim false verification', async () => {
        for (const response of [
            { models: [key], verified: true }, { models: ['invalid/model'], verified: true },
            { models: Array(5001).fill('chat-model'), verified: true }, { models: [], verified: false },
            { models: ['chat-model'], verified: true, apiKey: key },
        ]) {
            const f = fixture()
            f.setUpstream(async () => Response.json(response))
            const result = await f.request('POST', { ...catalogRequest, apiKey: key }, '/models')
            expect(result.status).toBe(502)
            expect(await result.text()).not.toContain(key)
        }
        const voyage = fixture()
        voyage.setUpstream(async () => Response.json({ models: ['voyage-test'], verified: true }))
        expect((await voyage.request('POST', { component: 'embedding', provider: 'voyage', apiKey: key }, '/models')).status).toBe(502)
    })

    test('oversized catalog streams stop at the response limit without buffering the entire stream', async () => {
        const f = fixture()
        let canceled = false, reads = 0
        f.setUpstream(async () => new Response(new ReadableStream({
            pull(controller) { reads++; controller.enqueue(new Uint8Array(600_000)) },
            cancel() { canceled = true },
        })))
        expect((await f.request('POST', { ...catalogRequest, apiKey: key }, '/models')).status).toBe(502)
        expect(canceled).toBe(true)
        expect(reads).toBeLessThanOrEqual(3)
    })

    test('binding identity contains provider and dimensions even when model IDs are identical', async () => {
        const f = fixture(), selected: MemoryProviderConfig = { ...config, embedding: { ...config.embedding, provider: 'openai', dimensions: 1024 } }
        expect((await f.request('PUT', { ...selected, version: 0 })).status).toBe(200)
        f.setUpstream(async (path, body) => Response.json(path.endsWith('/models')
            ? body.provider === 'voyage' ? { models: [], verified: false } : { models: ['chat-model'], verified: true }
            : { bound: body.embeddingProvider === 'openai' && body.embeddingDimensions === 1024 }))
        const changed = { ...selected, embedding: { ...selected.embedding, provider: 'voyage', apiKey: 'SYNTHETIC-voyage-new' } }
        expect((await f.request('PUT', { ...changed, version: 1 })).status).toBe(409)
        expect(await f.service.resolve(f.project.id)).toEqual(selected)
        expect((await f.request('DELETE', { version: 1 })).status).toBe(200)
        expect(await (await f.request()).json()).toMatchObject({ keyConfigured: { llm: false, embedding: false, reranker: false },
            boundEmbeddingProvider: 'openai', boundEmbeddingModel: config.embedding.model, boundEmbeddingDimensions: 1024 })
        expect((await f.request('PUT', { ...changed, version: 2 })).status).toBe(409)
    })

    test('stores a project credential privately, preserves blank keys, and uses version CAS', async () => {
        const f = fixture()
        expect(await (await f.request()).json()).toMatchObject({ configured: false, source: 'environment', version: 0 })
        const saved = await f.request('PUT', { ...config, version: 0 })
        expect(saved.status).toBe(200)
        const body = await saved.json()
        expect(body).toMatchObject({ configured: true, source: 'project', apiKeyConfigured: true, version: 1, config: { llm: { model: 'chat-model' } } })
        expect(JSON.stringify(body)).not.toContain(key)
        expect(await f.service.resolve(f.project.id)).toEqual(config)
        expect(await f.vault.request({ userId: 'admin', projectId: f.project.id, operation: 'list', payload: {} })).toEqual({ secrets: [] })
        expect(JSON.stringify(f.store.db.query('SELECT * FROM evolved_audit').all())).not.toContain(key)
        expect(JSON.stringify(f.vault.db.query('SELECT * FROM audit').all())).not.toContain(key)
        const updated = await f.request('PUT', { ...config, llm: { ...config.llm, apiKey: '', maxOutputTokens: 512 }, embedding: { ...config.embedding, apiKey: '' }, version: 1 })
        expect(updated.status).toBe(200)
        expect((await f.service.resolve(f.project.id))?.llm.apiKey).toBe(key)
        expect((await f.request('PUT', { ...config, version: 1 })).status).toBe(409)
        expect((await f.request('DELETE', { version: 1 })).status).toBe(409)
        expect((await f.request('DELETE', { version: 2 })).status).toBe(200)
        expect(await f.service.resolve(f.project.id)).toBeNull()
        expect(await (await f.request()).json()).toMatchObject({ source: 'disabled', version: 3, config: null, apiKeyConfigured: false, boundEmbeddingModel: config.embedding.model })
        expect((await f.request('PUT', { ...config, llm: { ...config.llm, apiKey: '' }, version: 3 })).status).toBe(400)
    })

    test('project snapshots and deletion state cannot fall through to another project credential', async () => {
        const f = fixture(), other = f.store.createProject('admin', f.team.id, 'Other')
        await f.request('PUT', { ...config, version: 0 })
        const second = { ...config, llm: { ...config.llm, apiKey: 'SYNTHETIC-other-project-key', model: 'second-model' } }
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
        expect(f.calls).toHaveLength(2)
    })

    test('fresh passkeys, CSRF and bounded strict input protect credential operations', async () => {
        const f = fixture()
        expect((await f.request('PUT', { ...config, version: 0, apiBase: 'http://attacker.invalid' })).status).toBe(400)
        expect((await f.request('PUT', { ...config, version: 0, embedding: { ...config.embedding, dimensions: 3073 } })).status).toBe(400)
        for (const change of [
            { schemaVersion: 1 }, { llm: { ...config.llm, provider: 'voyage' } },
            { embedding: { ...config.embedding, provider: 'anthropic' } },
            { embedding: { ...config.embedding, provider: 'voyage', dimensions: 1536 } },
            { reranker: { provider: 'rrf', apiKey: key } }, { llm: { ...config.llm, apiBase: 'http://attacker.invalid' } },
        ]) expect((await f.request('PUT', { ...config, ...change, version: 0 })).status).toBe(400)
        for (const price of ['Infinity', '0', '0.000', '-1', '1e2', '1000001']) expect((await f.request('PUT', { ...config, version: 0, llm: { ...config.llm, inputUsdPerMTok: price } })).status).toBe(400)
        expect((await f.request('PUT', { ...config, version: 0, llm: { ...config.llm, apiKey: '' } })).status).toBe(400)
        for (const origin of ['', 'https://attacker.invalid']) expect((await f.request('PUT', { ...config, version: 0 }, '', 'admin', { origin })).status).toBe(403)
        expect((await f.request('PUT', { ...config, version: 0, llm: { ...config.llm, apiKey: 'x'.repeat(20_000) } })).status).toBe(413)
        f.store.db.query('UPDATE evolved_sessions SET created_at=?').run(f.store.now() - 600_000)
        expect((await f.request('GET')).status).toBe(200)
        for (const [method, suffix, body] of [['PUT', '', { ...config, version: 0 }], ['DELETE', '', { version: 0 }], ['POST', '/models', { ...catalogRequest, apiKey: key }], ['POST', '/test', {}]] as const) expect((await f.request(method, body, suffix)).status).toBe(403)
        expect(f.calls).toHaveLength(0)
    })

    test('models/auth and stored connection checks perform no inference and never echo upstream errors', async () => {
        const f = fixture()
        expect((await f.request('POST', { ...catalogRequest, apiKey: key }, '/models')).status).toBe(200)
        expect(await f.service.resolve(f.project.id)).toBeUndefined()
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        expect(await (await f.request('POST', {}, '/test')).json()).toEqual({ ok: true, backend: 'graphiti-0.30.2/neo4j', modelsVerified: true, unverifiedComponents: [], inferenceTested: false })
        expect(f.calls.map(call => call.path)).toEqual(['/configuration/models', '/configuration/models', '/configuration/binding', '/configuration/models', '/configuration/check'])
        f.setUpstream(async () => new Response(JSON.stringify({ error: key }), { status: 401 }))
        const denied = await f.request('POST', catalogRequest, '/models')
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
        legacy.setUpstream(async path => Response.json(path.endsWith('/binding') ? { bound: false } : { verified: true, models: ['chat-model', 'text-embedding-3-small'] }))
        legacy.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,state,created_at) VALUES('legacy-task',?,'admin','index',0,'complete',?)").run(legacy.project.id, legacy.store.now())
        expect((await legacy.request('PUT', { ...config, version: 0 })).status).toBe(409)
        expect(await legacy.service.resolve(legacy.project.id)).toBeUndefined()
    })

    test('prevents embedding changes when the graph service cannot prove it is empty, even across delete/recreate', async () => {
        const f = fixture()
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        f.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,created_at) VALUES('task',?,'admin','index',0,?)").run(f.project.id, f.store.now())
        f.setUpstream(async (path, body) => Response.json(path.endsWith('/binding') ? { bound: body.embeddingModel === config.embedding.model } : { verified: true, models: ['chat-model', 'text-embedding-3-small', 'text-embedding-3-large'] }))
        expect((await f.request('PUT', { ...config, embedding: { ...config.embedding, model: 'text-embedding-3-large' }, version: 1 })).status).toBe(409)
        expect((await f.request('DELETE', { version: 1 })).status).toBe(200)
        expect((await f.request('PUT', { ...config, embedding: { ...config.embedding, model: 'text-embedding-3-large' }, version: 2 })).status).toBe(409)
        expect((await f.request('PUT', { ...config, llm: { ...config.llm, apiKey: 'SYNTHETIC-rotated-key' }, version: 2 })).status).toBe(200)
        expect(await (await f.request()).json()).toMatchObject({ embeddingLocked: true, version: 3 })
    })

    test('legacy failed jobs allow first binding only after a service proof of no graph or active operation', async () => {
        const f = fixture()
        f.store.db.query("INSERT INTO evolved_memory_reservations(id,project_id,period,reserved_micros,spent_micros,state,created_at) VALUES('old',?,'2026-10',20,0,'settled',?)").run(f.project.id, f.store.now())
        f.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,state,reservation_id,attempts,created_at) VALUES('old-task',?,'admin','index',0,'failed','old',1,?)").run(f.project.id, f.store.now())
        let bound: unknown = false
        f.setUpstream(async path => Response.json(path.endsWith('/binding') ? { bound, empty: true } : { verified: true, models: ['chat-model', 'text-embedding-3-small'] }))
        expect(await (await f.request()).json()).toMatchObject({ embeddingLocked: true, boundEmbeddingModel: null })
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(409)
        bound = 'true'
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(409)
        bound = true
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        expect(f.calls.filter(call => call.path === '/configuration/binding').map(call => call.body)).toEqual(Array(3).fill({ projectId: f.project.id, embeddingProvider: 'openai', embeddingModel: config.embedding.model, embeddingDimensions: config.embedding.dimensions }))
        expect(f.store.db.query('SELECT state,reservation_id FROM evolved_memory_tasks WHERE id=?').get('old-task')).toEqual({ state: 'failed', reservation_id: 'old' })
        expect(f.store.db.query('SELECT state,spent_micros FROM evolved_memory_reservations WHERE id=?').get('old')).toEqual({ state: 'settled', spent_micros: 0 })
        expect(await (await f.request()).json()).toMatchObject({ boundEmbeddingModel: config.embedding.model, embeddingLocked: true })
    })

    test('known model bindings can change after a durable empty-graph proof, even with no local tasks remaining', async () => {
        const f = fixture()
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        f.store.db.query("INSERT INTO evolved_memory_tasks(id,project_id,actor_id,kind,generation,created_at) VALUES('queued',?,'admin','index',0,?)").run(f.project.id, f.store.now())
        f.store.db.query("INSERT INTO evolved_memory_reservations(id,project_id,period,reserved_micros,spent_micros,state,created_at) VALUES('old',?,'2026-10',20,0,'settled',?)").run(f.project.id, f.store.now())
        expect((await f.request('PUT', { ...config, embedding: { ...config.embedding, model: 'text-embedding-3-large' }, version: 1 })).status).toBe(200)
        expect(await f.service.resolve(f.project.id)).toMatchObject({ embedding: { model: 'text-embedding-3-large' } })
        // Python can retain a binding after local queue/ledger housekeeping.
        f.store.db.query('DELETE FROM evolved_memory_tasks').run()
        f.store.db.query('DELETE FROM evolved_memory_reservations').run()
        f.calls.length = 0
        expect((await f.request('PUT', { ...config, version: 2 })).status).toBe(200)
        expect(f.calls.find(call => call.path === '/configuration/binding')?.body).toEqual({ projectId: f.project.id, embeddingProvider: 'openai', embeddingModel: config.embedding.model, embeddingDimensions: 1536 })
    })

    test('every save confirms its binding and repairs a Python bind whose later Vault commit failed', async () => {
        const f = fixture()
        let pythonBinding: unknown = null, graphEmpty = true
        f.setUpstream(async (path, body) => {
            if (!path.endsWith('/binding')) return Response.json({ verified: true, models: ['chat-model', 'text-embedding-3-small', 'text-embedding-3-large'] })
            const allowed = pythonBinding === body.embeddingModel || graphEmpty
            if (allowed) pythonBinding = body.embeddingModel
            return Response.json({ bound: allowed })
        })
        expect((await f.request('PUT', { ...config, version: 0 })).status).toBe(200)
        const request = f.vault.request.bind(f.vault)
        let failNextCommit = true
        f.vault.request = async input => {
            if (input.operation === 'memoryProvider' && input.payload.action === 'set' && failNextCommit) {
                failNextCommit = false
                throw new EvolvedError('memory_provider_conflict', 'Concurrent configuration change', 409)
            }
            return request(input)
        }
        expect((await f.request('PUT', { ...config, embedding: { ...config.embedding, model: 'text-embedding-3-large' }, version: 1 })).status).toBe(409)
        expect(pythonBinding).toBe('text-embedding-3-large')
        expect(await f.service.resolve(f.project.id)).toMatchObject({ embedding: { model: config.embedding.model } })
        // Saving the unchanged Vault selection repairs the successful external bind.
        expect((await f.request('PUT', { ...config, version: 1 })).status).toBe(200)
        expect(pythonBinding).toBe(config.embedding.model)
        graphEmpty = false
        expect((await f.request('PUT', { ...config, llm: { ...config.llm, apiKey: 'SYNTHETIC-rotated-key', inputUsdPerMTok: '0.5' }, version: 2 })).status).toBe(200)
        expect(f.calls.filter(call => call.path === '/configuration/binding').map(call => call.body.embeddingModel)).toEqual([
            config.embedding.model, 'text-embedding-3-large', config.embedding.model, config.embedding.model,
        ])
    })

    test('revocation during model validation blocks save, and concurrent processing blocks settings mutation', async () => {
        const f = fixture()
        f.setUpstream(async () => { f.store.setMember('admin', f.team.id, 'other', 'admin'); f.store.setMember('other', f.team.id, 'admin', null); return Response.json({ verified: true, models: ['chat-model', 'text-embedding-3-small'] }) })
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
        for (let n = 0; n < 6; n++) expect((await f.request('POST', { ...catalogRequest, apiKey: key }, '/models')).status).toBe(200)
        expect((await f.request('POST', { ...catalogRequest, apiKey: key }, '/models')).status).toBe(429)
        expect(f.calls).toHaveLength(6)
    })
})

describe('internal project-specific memory snapshots', () => {
    test('fresh requests rejected before transport release their budget and can later succeed without a conflicting zero receipt', async () => {
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => Response.json({ ok: true, spentMicros: new URL(request.url).pathname === '/ingest' ? 7 : 0 }) })
        cleanup.unshift(() => server.stop(true))
        for (const reason of ['busy', 'disabled'] as const) {
            const f = fixture()
            let admitted = false, lookups = 0
            const backend = new HttpMemoryBackend(`http://127.0.0.1:${server.port}`, 'internal-token', async () => ++lookups === 1 || admitted || reason === 'busy' ? config : null,
                async (_project, operation) => { if (!admitted && reason === 'busy') throw new EvolvedError('memory_provider_busy', 'Busy', 409); return operation() })
            const service = new MemoryService(f.store, backend)
            service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
            service.ledger.create(f.project.id, 'admin', 'Knowledge', 'Retained', [{ kind: 'manual', projectId: f.project.id, hash: 'x' }])
            expect(await service.processOne()).toBe(false)
            expect(service.ledger.budget(f.project.id)).toMatchObject({ reservedMicros: 0, spentMicros: 0 })
            expect(f.store.db.query('SELECT * FROM evolved_memory_reservations').all()).toEqual([])
            admitted = true
            f.store.db.query('UPDATE evolved_memory_tasks SET lease_until=0').run()
            expect(await service.processOne()).toBe(true)
            expect(service.ledger.budget(f.project.id)).toMatchObject({ reservedMicros: 0, spentMicros: 7 })
        }
    })

    test('previous or potentially transmitted reservations survive both pretransport denial and missing receipts', async () => {
        const paths: string[] = []
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
            const path = new URL(request.url).pathname; paths.push(path)
            return path === '/ingest' ? Response.json({ error: 'Receipt unavailable' }, { status: 503 }) : Response.json({ ok: true })
        } })
        cleanup.unshift(() => server.stop(true))
        for (const prior of ['crash-before-task-link', 'linked', 'new-but-transmitted'] as const) {
            const f = fixture()
            const backend = new HttpMemoryBackend(`http://127.0.0.1:${server.port}`, 'internal-token', async () => config,
                async (_project, operation) => { if (prior !== 'new-but-transmitted') throw new EvolvedError('memory_provider_busy', 'Busy', 409); return operation() })
            const service = new MemoryService(f.store, backend)
            service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
            service.ledger.create(f.project.id, 'admin', 'Knowledge', 'Retained', [{ kind: 'manual', projectId: f.project.id, hash: 'x' }])
            const task = f.store.db.query('SELECT id FROM evolved_memory_tasks').get() as { id: string }
            if (prior !== 'new-but-transmitted') service.ledger.reserve(f.project.id, task.id)
            if (prior === 'linked') service.ledger.taskReservation(task.id, task.id)
            expect(await service.processOne()).toBe(false)
            expect(service.ledger.budget(f.project.id).reservedMicros).toBe(20)
        }
        expect(paths.filter(path => path === '/ingest')).toHaveLength(1)
    })

    test('hybrid search releases only freshly reserved requests rejected before transport', async () => {
        const f = fixture(), backend = new HttpMemoryBackend('http://unused.invalid', 'internal-token', async () => null)
        const service = new MemoryService(f.store, backend)
        service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
        await expect(service.hybridSearch('admin', [f.project.id], 'query')).rejects.toThrow('disabled')
        expect(service.ledger.budget(f.project.id)).toMatchObject({ reservedMicros: 0, spentMicros: 0 })
        expect(f.store.db.query('SELECT * FROM evolved_memory_reservations').all()).toEqual([])
    })

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
            expect(service.ledger.budget(f.project.id).reservedMicros).toBe(0)
            expect(f.store.db.query('SELECT * FROM evolved_memory_reservations').all()).toEqual([])
            expect(f.store.db.query('SELECT state,reservation_id FROM evolved_memory_tasks').get()).toEqual({ state: revoke === 'member' ? 'failed' : 'queued', reservation_id: null })
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
        await expect(backend.request('/ingest', { projectId: 'project-a' })).rejects.toThrow('not sent')
        await backend.request('/reset', { projectId: 'project-a' })
        expect(calls.at(-1)?.path).toBe('/reset')
    })
})

describe('memory model capabilities and safe legacy repair', () => {
    test('embedding catalogs contain only discovered embedding models, including new versions', async () => {
        const f = fixture()
        f.setUpstream(async () => Response.json({ verified: true, models: ['chat-latest', 'text-embedding-future-9', 'text-embedding-3-small'] }))
        const response = await f.request('POST', { component: 'embedding', provider: 'openai', apiKey: key }, '/models')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ verified: true, models: ['text-embedding-3-small', 'text-embedding-future-9'] })
        const textResponse = await f.request('POST', { component: 'llm', provider: 'openai', apiKey: key }, '/models')
        expect(await textResponse.json()).toEqual({ verified: true, models: ['chat-latest'] })
    })
    test('catalog membership cannot make a chat model an embedder; rejection makes no binding or write', async () => {
        const f = fixture()
        const result = await f.request('PUT', { ...config, version: 0, embedding: { ...config.embedding, model: 'chat-model' } })
        expect(result.status).toBe(400)
        expect(await result.json()).toMatchObject({ code: 'memory_provider_model_role' })
        expect(f.calls).toEqual([])
        expect((await f.service.record(f.project.id, 'admin')).version).toBe(0)
    })
    test('incorrect historical configs remain readable and repairable without exposing or reentering keys', async () => {
        const f = fixture(), legacy = { ...config, embedding: { ...config.embedding, model: 'chat-model' } }
        await f.vault.request({ userId: 'admin', projectId: f.project.id, operation: 'memoryProvider', payload: { action: 'set', version: 0, config: legacy } })
        const status = await (await f.request()).json() as { config: MemoryProviderPublic }
        expect(status.config.embedding.model).toBe('chat-model')
        expect(JSON.stringify(status)).not.toContain(key)
        expect((await f.request('POST', {}, '/test')).status).toBe(400)
        expect(await f.service.modelsForProject(f.project.id, { component: 'embedding', provider: 'openai' }, async () => f.store.requireProject('admin', f.project.id, 'admin')))
            .toEqual({ verified: true, models: ['text-embedding-3-large', 'text-embedding-3-small'] })
        const result = await f.service.savePublic(f.project.id, 'admin', { ...status.config, version: 1, embedding: { ...status.config.embedding, model: config.embedding.model } }, async () => f.store.requireProject('admin', f.project.id, 'admin'))
        expect(result.config?.embedding.model).toBe(config.embedding.model)
        expect(JSON.stringify(result)).not.toContain(key)
        expect((await f.service.resolve(f.project.id))?.embedding.apiKey).toBe(key)
        expect(f.store.db.query('SELECT COUNT(*) AS n FROM evolved_memory_tasks').get()).toEqual({ n: 0 })
        expect(f.calls.every(call => ['/configuration/models', '/configuration/binding'].includes(call.path))).toBe(true)
    })
    test('invalid roles block availability and ingestion before transport or spending', async () => {
        const f = fixture(), invalid = { ...config, embedding: { ...config.embedding, model: 'chat-model' } }
        const backend = new HttpMemoryBackend('http://127.0.0.1:1', 'synthetic-token', async () => invalid)
        expect(await backend.available(f.project.id)).toBe(false)
        await expect(backend.prepare(f.project.id)).rejects.toThrow('not ready')
        await expect(backend.request('/ingest', { projectId: f.project.id })).rejects.toThrow('Memory request was not sent')
        expect(f.calls).toEqual([])
    })
})

test('new configuration rejects known incompatible dimensions before storing a binding', async () => {
    for (const [model, dimensions] of [['text-embedding-3-small', 1537], ['text-embedding-ada-002', 1024]] as const) {
        const f = fixture()
        const response = await f.request('PUT', { ...config, version: 0, embedding: { ...config.embedding, model, dimensions } })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'memory_provider_embedding_dimensions' })
        expect(f.calls).toEqual([])
    }
})
