import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { EvolvedStore } from './store'
import { MemoryLedger, memoryHash, type MemoryItem, type MemorySource } from './memoryStore'
import { MemoryService, type MemoryBackend } from './memoryService'
import { createMemoryRoutes } from './memory'

const stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const textEnvelope = { role: 'user', content: { type: 'text', text: 'Please inspect the configuration.' } }
const screenshotEnvelope = { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: {
    content: [{ type: 'tool_use', id: 'synthetic-tool', name: 'mcp__hapi__display_image', input: { path: '/tmp/synthetic-screenshot.png' } }]
} } } }

function fixture(backend: MemoryBackend = { available: async () => false, request: async () => { throw Error('No provider calls') } }) {
    const store = new EvolvedStore(':memory:'); stores.push(store)
    for (const id of ['alice', 'bob']) store.db.query('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, 0, Date.now())
    const team = store.createTeam('alice', 'Team'), project = store.createProject('alice', team.id, 'Project')
    const otherTeam = store.createTeam('bob', 'Other'), other = store.createProject('bob', otherTeam.id, 'Other')
    let service = new MemoryService(store, backend)
    const token = store.createSession('alice')
    const legacy = (sessionId: string, body = JSON.stringify(textEnvelope), changes: { title?: string; source?: Partial<MemorySource>; extraSource?: boolean } = {}) => {
        const sources: MemorySource[] = [{ projectId: project.id, kind: 'chat', sessionId, messageId: `message-${sessionId}`,
            origin: `hub:session:${sessionId}`, hash: memoryHash(body), ...changes.source }]
        if (changes.extraSource) sources.push({ projectId: project.id, kind: 'manual', hash: memoryHash(body) })
        return service.ledger.create(project.id, 'alice', changes.title ?? `Conversation ${sessionId.slice(0, 12)}`, body, sources)
    }
    const upgrade = () => {
        // A pre-upgrade database has not recorded this migration. Real legacy
        // rows, sources, receipts and task states are retained by the constructor.
        store.db.query("DELETE FROM evolved_memory_migrations WHERE name='archive-automatic-conversations-v1'").run()
        service = new MemoryService(store, backend)
        return service
    }
    const request = (suffix = '', method = 'GET', body?: unknown, bearer?: string, projectId = project.id) => {
        const app = new Hono().route('/api/evolved', createMemoryRoutes({ store, service, origin: 'https://hapi.test' }))
        return app.request(`https://hapi.test/api/evolved/projects/${projectId}/memory${suffix}`, { method,
            headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: `__Host-hapi-evolved=${token}` }), origin: 'https://hapi.test', 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    }
    return { store, project, other, legacy, upgrade, request, get service() { return service } }
}

describe('explicit knowledge and quarantined historical conversation imports', () => {
    test('legacy migration installs indexed provenance and audit lookups before scanning imports', () => {
        const f = fixture(), old = f.legacy('indexed-migration')
        f.store.db.exec(`DROP INDEX evolved_memory_source_item;
            DROP INDEX evolved_memory_audit_target;
            DROP INDEX evolved_memory_task_item`)
        f.upgrade()
        expect(f.service.ledger.archivedImports(f.project.id)).toBe(1)
        const plans = [
            ["SELECT source_json FROM evolved_memory_sources WHERE item_id=?", [old.id]],
            ["SELECT 1 FROM evolved_audit WHERE target_id=? AND action LIKE 'memory.%'", [old.id]],
            ["SELECT actor_id FROM evolved_memory_tasks WHERE item_id=? AND project_id=? AND kind='index' ORDER BY created_at DESC,id DESC LIMIT 1", [old.id, f.project.id]],
        ] as const
        for (const [sql, args] of plans) {
            const plan = f.store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]
            expect(plan.some(row => row.detail.includes('SEARCH') && row.detail.includes('INDEX'))).toBe(true)
            expect(plan.some(row => row.detail.includes('SCAN') || row.detail.includes('TEMP B-TREE'))).toBe(false)
        }
    })

    test('ordinary text and screenshot tool events create no items or jobs, even with cloud enabled', () => {
        const f = fixture()
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        for (const content of [textEnvelope, screenshotEnvelope]) {
            expect(f.service.reconcileHubMessage({ namespace: f.project.namespace, sessionId: 'session', messageId: 'message', content })).toBe(0)
        }
        expect(f.service.ledger.list(f.project.id)).toEqual([])
        expect(f.store.db.query('SELECT * FROM evolved_memory_tasks').all()).toEqual([])
        expect(f.store.db.query('SELECT * FROM evolved_memory_reservations').all()).toEqual([])
    })

    test('a replayed Hub event does not mistake a manual chat-reference body hash for an attested raw-source hash', () => {
        const f = fixture()
        const item = f.service.ledger.create(f.project.id, 'alice', 'Manual observation', 'Use atomic writes.', [{
            projectId: f.project.id, kind: 'chat', sessionId: 'manual', messageId: 'message', origin: 'user:reference', hash: memoryHash('Use atomic writes.')
        }])
        expect(f.service.ledger.settings(f.project.id).enabled).toBe(false)
        expect(f.service.reconcileHubMessage({ namespace: f.project.namespace, sessionId: 'manual', messageId: 'message', content: textEnvelope })).toBe(0)
        expect(f.service.ledger.get(f.project.id, item.id)).not.toBeNull()
        expect(f.service.forgetSession(f.project.namespace, 'manual')).toBe(1)
        expect(f.service.ledger.get(f.project.id, item.id)).toBeNull()
    })

    test('migration preserves original envelopes and provenance, excludes them from knowledge, and is idempotent', () => {
        const f = fixture(), screenshot = f.legacy('screenshot-session', JSON.stringify(screenshotEnvelope)), text = f.legacy('text-session')
        const originalSources = f.store.db.query('SELECT * FROM evolved_memory_sources ORDER BY item_id').all()
        // Exercise an actual legacy schema without the new flag.
        f.store.db.exec('ALTER TABLE evolved_memory_items DROP COLUMN archived_import')
        const service = f.upgrade(), ledger = service.ledger
        expect(ledger.list(f.project.id)).toEqual([])
        expect(ledger.search([f.project.id], 'configuration')).toEqual([])
        expect(ledger.get(f.project.id, screenshot.id)).toBeNull()
        expect(ledger.list(f.project.id, 100, 'imports').map(item => item.id).sort()).toEqual([screenshot.id, text.id].sort())
        expect(ledger.get(f.project.id, screenshot.id, true)).toMatchObject({ body: screenshot.body, sources: screenshot.sources, archivedImport: true, status: 'proposed' })
        expect(f.store.db.query('SELECT * FROM evolved_memory_sources ORDER BY item_id').all()).toEqual(originalSources)
        expect(ledger.archivedImports(f.project.id)).toBe(2)
        const before = f.store.db.query('SELECT * FROM evolved_memory_tasks ORDER BY id').all()
        new MemoryLedger(f.store.db)
        expect(ledger.settings(f.project.id).generation).toBe(1)
        expect(f.store.db.query('SELECT * FROM evolved_memory_tasks ORDER BY id').all()).toEqual(before)
        expect(() => ledger.create(f.project.id, 'alice', text.title, text.body, text.sources)).toThrow('Archived import cannot be reused')
        expect(() => ledger.setStatus(f.project.id, text.id, 'verified')).toThrow('cannot be verified')
    })

    test('confirmed facts, explicit intake audits, manual exports and ambiguous provenance are never classified', () => {
        const f = fixture(), retained: MemoryItem[] = []
        const verified = f.legacy('verified'); f.service.ledger.setStatus(f.project.id, verified.id, 'verified'); retained.push(verified)
        for (const action of ['memory.from_message', 'memory.propose', 'memory.intake', 'memory.status']) {
            const item = f.legacy(action); f.store.audit('alice', f.project.id, action, item.id); retained.push(item)
        }
        retained.push(f.legacy('real-fact', 'Always use atomic configuration writes.'))
        retained.push(f.legacy('manual-export', JSON.stringify(textEnvelope, null, 2)))
        retained.push(f.legacy('other-title', undefined, { title: 'Explicit JSON export' }))
        retained.push(f.legacy('manual-origin', undefined, { source: { origin: 'user:reference' } }))
        retained.push(f.legacy('missing-origin', undefined, { source: { origin: undefined } }))
        retained.push(f.legacy('wrong-hash', undefined, { source: { hash: 'wrong' } }))
        retained.push(f.legacy('multiple-sources', undefined, { extraSource: true }))
        retained.push(f.legacy('not-envelope', JSON.stringify({ content: { type: 'text', text: 'A user export' } })))
        const wrongFingerprint = f.legacy('wrong-fingerprint'); retained.push(wrongFingerprint)
        f.store.db.query('UPDATE evolved_memory_items SET content_hash=? WHERE id=?').run('invalid-fingerprint', wrongFingerprint.id)
        const archived = f.legacy('real-auto-import')
        const service = f.upgrade()
        expect(service.ledger.archivedImports(f.project.id)).toBe(1)
        expect(service.ledger.get(f.project.id, archived.id)).toBeNull()
        expect(service.ledger.list(f.project.id).map(item => item.id).sort()).toEqual(retained.map(item => item.id).sort())
    })

    test('historical failed tasks and all cost reservations are retained without new paid retries', () => {
        const f = fixture(), old = f.legacy('failed-auto')
        const fact = f.service.ledger.create(f.project.id, 'alice', 'Verified design', 'Use atomic writes.', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }])
        f.service.ledger.setStatus(f.project.id, fact.id, 'verified')
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        for (const id of ['paid-failure', 'uncertain']) f.service.ledger.reserve(f.project.id, id)
        f.service.ledger.settle('paid-failure', 7)
        f.store.db.exec("UPDATE evolved_memory_tasks SET state='failed'; UPDATE evolved_memory_items SET index_state='error'")
        const reservations = f.store.db.query('SELECT * FROM evolved_memory_reservations ORDER BY id').all()
        f.upgrade()
        expect(f.service.ledger.get(f.project.id, old.id)).toBeNull()
        expect(f.service.ledger.get(f.project.id, fact.id)?.indexState).toBe('error')
        expect(f.store.db.query("SELECT * FROM evolved_memory_tasks WHERE kind='index' AND state IN ('queued','running')").all()).toHaveLength(0)
        expect(f.store.db.query('SELECT * FROM evolved_memory_reservations ORDER BY id').all()).toEqual(reservations)
        expect(f.service.ledger.claim()?.kind).toBe('purge')
        expect(f.service.ledger.claim()).toBeNull()
    })

    test('projection generation and purge fence stale running tasks; only successful active knowledge rebuilds', async () => {
        let release!: (result: Record<string, unknown>) => void
        const f = fixture({ available: async () => true, request: async path => {
            if (path === '/ingest') return new Promise(resolve => { release = resolve })
            return { ok: true }
        } })
        const old = f.legacy('in-flight')
        const fact = f.service.ledger.create(f.project.id, 'alice', 'Real fact', 'Retained indexed knowledge', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }])
        f.store.db.query("UPDATE evolved_memory_items SET index_state='indexed' WHERE id=?").run(fact.id)
        f.store.db.query("UPDATE evolved_memory_tasks SET state='complete' WHERE item_id=?").run(fact.id)
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        const previous = f.service, running = previous.processOne()
        while (!release) await new Promise(resolve => setTimeout(resolve, 1))
        f.upgrade()
        release({ ok: true, spentMicros: 7 }); expect(await running).toBe(true)
        expect(f.service.ledger.get(f.project.id, old.id, true)?.indexState).toBe('archived')
        expect(f.service.ledger.budget(f.project.id)).toMatchObject({ spentMicros: 7, reservedMicros: 0 })
        const purge = f.service.ledger.claim()!; expect(purge.kind).toBe('purge')
        expect(f.service.ledger.claim()).toBeNull()
        f.service.ledger.complete(purge)
        const next = f.service.ledger.claim()!
        expect(next.item_id).toBe(fact.id); expect(next.generation).toBe(1)
        expect(f.store.db.query("SELECT * FROM evolved_memory_tasks WHERE item_id=? AND state IN ('queued','running')").all(old.id)).toEqual([])
    })

    test('rebuild retains the current task actor when the historical spending approver has left', async () => {
        const calls: string[] = []
        const f = fixture({ available: async () => true, request: async (path, _payload, revalidate) => {
            await revalidate?.(); calls.push(path)
            return { ok: true, spentMicros: 3 }
        } })
        f.store.setMember('alice', f.project.teamId, 'bob', 'admin')
        const fact = f.service.ledger.create(f.project.id, 'bob', 'Retained fact', 'Useful knowledge', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }])
        f.store.db.query("UPDATE evolved_memory_items SET index_state='indexed' WHERE id=?").run(fact.id)
        f.store.db.query("UPDATE evolved_memory_tasks SET state='complete' WHERE item_id=?").run(fact.id)
        f.legacy('old-approver-import')
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        f.store.setMember('bob', f.project.teamId, 'alice', null)
        f.upgrade()
        expect(f.store.db.query("SELECT actor_id FROM evolved_memory_tasks WHERE item_id=? AND generation=1").get(fact.id)).toEqual({ actor_id: 'bob' })
        expect(await f.service.processOne()).toBe(true) // Projection purge.
        expect(await f.service.processOne()).toBe(true) // Current actor's rebuild.
        expect(calls).toEqual(['/reset', '/ingest'])
        expect(f.service.ledger.get(f.project.id, fact.id)?.indexState).toBe('indexed')
        expect(f.service.ledger.budget(f.project.id)).toMatchObject({ spentMicros: 3, reservedMicros: 0 })
    })

    test('a revoked task actor is not replaced with the still-authorized spending approver', async () => {
        const calls: string[] = []
        const f = fixture({ available: async () => true, request: async path => { calls.push(path); return { ok: true, spentMicros: 0 } } })
        f.store.setMember('alice', f.project.teamId, 'bob', 'member')
        const fact = f.service.ledger.create(f.project.id, 'bob', 'Revoked actor fact', 'Retained local knowledge', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }])
        f.store.db.query("UPDATE evolved_memory_items SET index_state='indexed' WHERE id=?").run(fact.id)
        f.store.db.query("UPDATE evolved_memory_tasks SET state='complete' WHERE item_id=?").run(fact.id)
        f.legacy('still-authorized-approver-import')
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        f.store.setMember('alice', f.project.teamId, 'bob', null)
        f.upgrade()
        expect(f.store.db.query("SELECT actor_id FROM evolved_memory_tasks WHERE item_id=? AND generation=1").get(fact.id)).toEqual({ actor_id: 'bob' })
        expect(await f.service.processOne()).toBe(true)
        expect(await f.service.processOne()).toBe(false)
        expect(calls).toEqual(['/reset'])
        expect(f.store.db.query('SELECT * FROM evolved_memory_reservations').all()).toEqual([])
        expect(f.service.ledger.get(f.project.id, fact.id)?.indexState).toBe('error')
        expect(f.store.db.query("SELECT state,error FROM evolved_memory_tasks WHERE item_id=? AND generation=1").get(fact.id))
            .toEqual({ state: 'failed', error: 'Authorization revoked' })
    })

    test('late failed extraction settles its cost without overwriting the replacement generation state', async () => {
        let release!: (result: Record<string, unknown>) => void
        const f = fixture({ available: async () => true, request: async () => new Promise(resolve => { release = resolve }) })
        const fact = f.service.ledger.create(f.project.id, 'alice', 'Active fact', 'Actual knowledge', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }])
        f.legacy('archive-other')
        f.store.db.query('UPDATE evolved_memory_tasks SET created_at=0 WHERE item_id=?').run(fact.id)
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        const running = f.service.processOne()
        while (!release) await new Promise(resolve => setTimeout(resolve, 1))
        f.upgrade()
        release({ ok: false, spentMicros: 9 })
        expect(await running).toBe(true)
        expect(f.service.ledger.get(f.project.id, fact.id)?.indexState).toBe('pending')
        expect(f.service.ledger.budget(f.project.id)).toMatchObject({ spentMicros: 9, reservedMicros: 0 })
        expect(f.store.db.query("SELECT state,generation FROM evolved_memory_tasks WHERE item_id=? ORDER BY generation").all(fact.id))
            .toEqual([{ state: 'cancelled', generation: 0 }, { state: 'queued', generation: 1 }])
    })

    test('stale task leases cannot mark an item failed', () => {
        const f = fixture()
        const item = f.service.ledger.create(f.project.id, 'alice', 'Actual fact', 'Useful knowledge', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }])
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        const task = f.service.ledger.claim()!
        f.store.db.query('UPDATE evolved_memory_tasks SET lease_until=? WHERE id=?').run(task.lease_until + 1, task.id)
        f.service.ledger.fail(task, 'Authorization revoked')
        expect(f.service.ledger.get(f.project.id, item.id)?.indexState).toBe('pending')
        expect(f.store.db.query('SELECT state FROM evolved_memory_tasks WHERE id=?').get(task.id)).toEqual({ state: 'running' })
        f.service.ledger.fail({ ...task, lease_until: task.lease_until + 1 }, 'Authorization revoked')
        expect(f.service.ledger.get(f.project.id, item.id)?.indexState).toBe('error')
    })

    test('hybrid output rejects any archived provenance and requests only the new graph generation', async () => {
        const queries: Record<string, unknown>[] = []
        let oldId = '', factId = ''
        const f = fixture({ available: async () => true, request: async (path, input) => {
            expect(path).toBe('/search'); queries.push(input)
            return { ok: true, spentMicros: 0, results: [{ fact: 'archived', memoryIds: [oldId] }, { fact: 'mixed', memoryIds: [factId, oldId] }, { fact: 'active', memoryIds: [factId] }] }
        } })
        oldId = f.legacy('archived-fact').id
        factId = f.service.ledger.create(f.project.id, 'alice', 'Actual knowledge', 'Visible fact', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }]).id
        f.upgrade()
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        f.store.db.query("UPDATE evolved_memory_items SET index_state='indexed' WHERE id=?").run(factId)
        const results = await f.service.hybridSearch('alice', [f.project.id], 'fact')
        expect(results.map(item => item.fact)).toEqual(['active'])
        expect(queries[0].projects).toEqual([{ projectId: f.project.id, generation: 1 }])
    })

    test('archived imports remain deletable and source deletion still removes archived and explicit provenance', () => {
        const f = fixture(), first = f.legacy('deleted-source'), second = f.legacy('forgotten-entry')
        const explicit = f.service.ledger.create(f.project.id, 'alice', 'Explicit fact', 'Visible knowledge', first.sources)
        f.store.audit('alice', f.project.id, 'memory.from_message', explicit.id)
        f.upgrade()
        expect(f.service.forgetMessage(f.project.namespace, 'deleted-source', 'message-deleted-source')).toBe(2)
        expect(f.service.ledger.get(f.project.id, first.id, true)).toBeNull()
        expect(f.service.ledger.get(f.project.id, explicit.id)).toBeNull()
        f.service.ledger.forget(f.project.id, second.id, 'alice')
        expect(f.service.ledger.archivedImports(f.project.id)).toBe(0)
        expect(f.service.ledger.sources(f.project.id)).toEqual([])
    })

    test('forgetting only archived imports does not purge or requeue successful active knowledge', async () => {
        const f = fixture(), archived = f.legacy('forget-archive')
        const active = f.service.ledger.create(f.project.id, 'alice', 'Actual knowledge', 'Retained fact', [{ projectId: f.project.id, kind: 'manual', hash: 'fact' }])
        f.upgrade()
        f.store.db.query("UPDATE evolved_memory_tasks SET state='complete' WHERE generation=1").run()
        f.store.db.query("UPDATE evolved_memory_items SET index_state='indexed' WHERE id=?").run(active.id)
        const before = f.store.db.query('SELECT * FROM evolved_memory_tasks ORDER BY id').all()
        const response = await f.request(`/${archived.id}`, 'DELETE')
        expect(response.status).toBe(202)
        expect(await response.json()).toMatchObject({ deleted: true, graphPurgePending: false, generation: 1, taskId: null })
        expect(f.service.ledger.get(f.project.id, archived.id, true)).toBeNull()
        expect(f.service.ledger.get(f.project.id, active.id)?.indexState).toBe('indexed')
        expect(f.store.db.query('SELECT * FROM evolved_memory_tasks ORDER BY id').all()).toEqual(before)
        expect(f.service.ledger.settings(f.project.id).generation).toBe(1)
    })

    test('imports API is human-only, paginated stably, project-scoped and refuses verification', async () => {
        const f = fixture()
        for (let i = 0; i < 103; i++) f.legacy(`page-${i}`)
        f.store.db.exec('UPDATE evolved_memory_items SET created_at=100')
        f.upgrade()
        const active = await (await f.request()).json() as { items: MemoryItem[]; archivedImports: number }
        expect(active).toMatchObject({ items: [], archivedImports: 103 })
        const first = await (await f.request('?view=imports')).json() as { items: MemoryItem[]; archivedImports: number }
        const second = await (await f.request('?view=imports&offset=100')).json() as { items: MemoryItem[]; archivedImports: number }
        expect(first.items).toHaveLength(100); expect(second.items).toHaveLength(3)
        expect(second.archivedImports).toBe(103)
        expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(103)
        expect(first.items.every(item => item.archivedImport && item.body === JSON.stringify(textEnvelope))).toBe(true)
        expect((await f.request(`/${first.items[0].id}`, 'PATCH', { status: 'verified' })).status).toBe(409)
        const capability = f.store.issueCapability('alice', f.project.id, ['memory:read', 'memory:write'], [], 300)
        expect((await f.request('?view=imports', 'GET', undefined, capability.token)).status).toBe(403)
        expect((await f.request('', 'GET', undefined, capability.token)).status).toBe(200)
        expect((await f.request('?view=imports', 'GET', undefined, undefined, f.other.id)).status).toBe(403)
        for (const value of ['-1', '1.5', '1e2', 'NaN', '2147483648']) expect((await f.request(`?view=imports&offset=${value}`)).status).toBe(400)
        expect((await f.request('?view=unknown')).status).toBe(400)
        expect((await f.request(`/${first.items[0].id}`, 'DELETE')).status).toBe(202)
        expect(f.service.ledger.archivedImports(f.project.id)).toBe(102)
    })
})
