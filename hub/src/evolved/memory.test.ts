import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { EvolvedStore } from './store'
import { MemoryLedger, memoryHash } from './memoryStore'
import { MemoryService, containsCredential, readMemorySource, type MemoryBackend } from './memoryService'
import { createMemoryRoutes, proposeMemoryFile } from './memory'
import { createCodegraphRoutes } from './codegraph'

const resources: Array<() => void> = []
afterEach(() => { for (const close of resources.splice(0)) close() })
function setup(backend?: MemoryBackend) {
    const store = new EvolvedStore(':memory:'); resources.push(() => store.close())
    for (const id of ['alice', 'bob']) store.db.query('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, 0, Date.now())
    const team = store.createTeam('alice', 'A'), otherTeam = store.createTeam('bob', 'B')
    const project = store.createProject('alice', team.id, 'A'), other = store.createProject('bob', otherTeam.id, 'B')
    const service = new MemoryService(store, backend ?? { available: async () => false, request: async () => { throw new Error('unavailable') } })
    const app = new Hono().route('/api/evolved', createMemoryRoutes({ store, service, origin: 'https://hapi.test' }))
        .route('/api/evolved', createCodegraphRoutes({ store, origin: 'https://hapi.test' }))
    const sessions = { alice: store.createSession('alice'), bob: store.createSession('bob') }
    const request = (path: string, user: 'alice' | 'bob' = 'alice', body?: unknown, method?: string, bearer?: string) => app.request(`https://hapi.test/api/evolved${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: `__Host-hapi-evolved=${sessions[user]}` }), origin: 'https://hapi.test', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { store, project, other, service, request, team }
}

describe('Memory ledger budgets and source lifecycle', () => {
    test('two SQLite connections cannot oversubscribe a monthly budget; receipts are idempotent', () => {
        const dir = mkdtempSync(join(tmpdir(), 'evolved-budget-')); resources.push(() => rmSync(dir, { recursive: true, force: true }))
        const db1 = new Database(join(dir, 'test.db')), db2 = new Database(join(dir, 'test.db'))
        resources.unshift(() => { db1.close(); db2.close() })
        const first = new MemoryLedger(db1), second = new MemoryLedger(db2)
        first.configure('p', { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 60 })
        expect(first.reserve('p', 'one')).toBe(60)
        expect(second.reserve('p', 'one')).toBe(60)
        expect(() => second.reserve('p', 'two')).toThrow('exhausted')
        first.settle('one', 20); second.settle('one', 20)
        expect(second.reserve('p', 'two')).toBe(60)
        expect(first.budget('p')).toMatchObject({ spentMicros: 20, reservedMicros: 60 })
        expect(() => second.settle('two', 61)).toThrow('exceeded')
    })
    test('forget removes ledger content/sources and makes purge precede every reindex', () => {
        const { service, project } = setup()
        const ledger = service.ledger
        ledger.configure(project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
        const first = ledger.create(project.id, 'alice', 'first', 'sensitive old fact', [{ kind: 'manual', projectId: project.id, hash: 'one' }])
        ledger.create(project.id, 'alice', 'second', 'retained fact', [{ kind: 'manual', projectId: project.id, hash: 'two' }])
        const result = ledger.forget(project.id, first.id, 'alice')
        expect(result.generation).toBe(1)
        expect(ledger.get(project.id, first.id)).toBeNull()
        expect(ledger.db.query('SELECT * FROM evolved_memory_sources WHERE item_id=?').all(first.id)).toHaveLength(0)
        expect(ledger.search([project.id], 'sensitive')).toHaveLength(0)
        const purge = ledger.claim()!
        expect(purge.kind).toBe('purge')
        expect(ledger.claim()).toBeNull()
        ledger.complete(purge)
        expect(ledger.claim()?.kind).toBe('index')
    })
    test('session events never create knowledge but changed explicit sources invalidate without cloud approval', () => {
        const { service, project } = setup()
        const content = { role: 'user', content: { type: 'text', text: 'We selected a PostgreSQL adapter.' } }
        const input = { namespace: project.namespace, sessionId: 's', messageId: 'm', content }
        service.ledger.configure(project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        expect(service.reconcileHubMessage(input)).toBe(0)
        expect(service.ledger.list(project.id)).toHaveLength(0)
        const item = service.ledger.create(project.id, 'alice', 'Selected database', 'Use PostgreSQL.', [{
            projectId: project.id, kind: 'chat', sessionId: 's', messageId: 'm', origin: 'hub:session:s', hash: memoryHash(JSON.stringify(content))
        }])
        service.ledger.configure(project.id, { enabled: false, cloudAllowed: false })
        expect(service.reconcileHubMessage(input)).toBe(0)
        expect(service.ledger.get(project.id, item.id)).not.toBeNull()
        expect(service.reconcileHubMessage({ ...input, content: { role: 'user', content: { type: 'text', text: 'Changed source' } } })).toBe(1)
        expect(service.ledger.get(project.id, item.id)).toBeNull()
        expect(service.ledger.list(project.id)).toHaveLength(0)
    })
    test('changed and deleted code sources remove their facts before a subsequent read', async () => {
        const { service, store, project } = setup()
        const root = mkdtempSync(join(tmpdir(), 'evolved-memory-file-')); resources.push(() => rmSync(root, { recursive: true, force: true }))
        store.db.query('UPDATE evolved_projects SET root_path=? WHERE id=?').run(root, project.id)
        const body = 'export const policy = "old"'
        writeFileSync(join(root, 'policy.ts'), body)
        service.ledger.create(project.id, 'alice', 'Policy', body, [{ kind: 'code', projectId: project.id, path: 'policy.ts', hash: memoryHash(body) }])
        await service.reconcileSources([project.id])
        expect(service.ledger.list(project.id)).toHaveLength(1)
        writeFileSync(join(root, 'policy.ts'), 'export const policy = "new"')
        await service.reconcileSources([project.id])
        expect(service.ledger.list(project.id)).toHaveLength(0)
        expect(service.ledger.settings(project.id).generation).toBe(1)
    })
    test('final cost receipts settle cancelled operations but unknown or foreign receipts retain reservations', async () => {
        let projectId = ''
        const fixture = setup({ available: async () => true, request: async (path, input) => {
            expect(path).toBe('/receipt')
            if (input.operationId === 'unknown') throw new Error('not received')
            return { projectId: input.operationId === 'foreign' ? 'other-project' : projectId, final: true, spentMicros: 7 }
        } })
        projectId = fixture.project.id
        fixture.service.ledger.configure(projectId, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
        for (const id of ['cancelled', 'unknown', 'foreign']) fixture.service.ledger.reserve(projectId, id)
        fixture.service.forgetProject(projectId)
        await fixture.service.reconcileReservations()
        expect(fixture.service.ledger.budget(projectId)).toMatchObject({ spentMicros: 7, reservedMicros: 40 })
        await fixture.service.reconcileReservations()
        expect(fixture.service.ledger.budget(projectId)).toMatchObject({ spentMicros: 7, reservedMicros: 40 })
    })
    test('new source exclusions do not purge unchanged legacy knowledge during reconciliation', async () => {
        const { service, store, project } = setup()
        const root = mkdtempSync(join(tmpdir(), 'evolved-memory-policy-')); resources.push(() => rmSync(root, { recursive: true, force: true }))
        store.db.query('UPDATE evolved_projects SET root_path=? WHERE id=?').run(root, project.id)
        const body = 'A historical security design note.'
        writeFileSync(join(root, 'secret-handling.md'), body)
        const item = service.ledger.create(project.id, 'alice', 'Existing policy note', body, [{ kind: 'code', projectId: project.id, path: 'secret-handling.md', hash: memoryHash(body) }])
        await expect(readMemorySource(root, 'secret-handling.md')).rejects.toThrow('excluded')
        await service.reconcileSources([project.id])
        expect(service.ledger.get(project.id, item.id)).not.toBeNull()
    })
    test('repository file proposals recheck the grant after file I/O and preserve proposed provenance', async () => {
        const f = setup(), root = mkdtempSync(join(tmpdir(), 'evolved-memory-repo-'))
        resources.push(() => rmSync(root, { recursive: true, force: true }))
        f.store.db.query('UPDATE evolved_projects SET root_path=? WHERE id=?').run(root, f.project.id)
        writeFileSync(join(root, 'source.ts'), 'export const value = 1')
        const request = new Request('https://hapi.test', { headers: { cookie: `__Host-hapi-evolved=${f.store.createSession('alice')}` } })
        const args = { store: f.store, service: f.service, request, projectId: f.project.id, path: 'source.ts' }
        await expect(proposeMemoryFile({ ...args, recheck: async () => { throw new Error('Grant revoked') } })).rejects.toThrow('Grant revoked')
        expect(f.service.ledger.list(f.project.id)).toHaveLength(0)
        const { item } = await proposeMemoryFile({ ...args, recheck: async () => {} })
        expect(item.status).toBe('proposed'); expect(item.sources[0]).toMatchObject({ kind: 'code', path: 'source.ts', hash: memoryHash('export const value = 1') })
        expect(item.sources[0]?.commit).toBeUndefined()
        f.store.setMember('alice', f.team.id, 'bob', 'admin')
        await expect(proposeMemoryFile({ ...args, recheck: async () => { f.store.setMember('bob', f.team.id, 'alice', null) } })).rejects.toThrow()
        expect(f.service.ledger.list(f.project.id)).toHaveLength(1)
    })
    test('a FIFO source is rejected without waiting for a writer', async () => {
        if (process.platform !== 'linux') return
        const root = mkdtempSync(join(tmpdir(), 'evolved-memory-fifo-')); resources.push(() => rmSync(root, { recursive: true, force: true }))
        execFileSync('mkfifo', [join(root, 'source.md')])
        const start = performance.now()
        await expect(readMemorySource(root, 'source.md')).rejects.toThrow('regular')
        expect(performance.now() - start).toBeLessThan(1000)
    })
    test('temporary filesystem access failures preserve source facts instead of purging them', async () => {
        if (process.getuid?.() === 0) return // Root bypasses the POSIX permission fixture.
        const { service, store, project } = setup()
        const root = mkdtempSync(join(tmpdir(), 'evolved-memory-access-'))
        resources.push(() => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }) })
        store.db.query('UPDATE evolved_projects SET root_path=? WHERE id=?').run(root, project.id)
        const body = 'export const policy = true'
        writeFileSync(join(root, 'policy.ts'), body)
        service.ledger.create(project.id, 'alice', 'Policy', body, [{ kind: 'code', projectId: project.id, path: 'policy.ts', hash: memoryHash(body) }])
        chmodSync(root, 0)
        await expect(service.reconcileSources([project.id])).rejects.toThrow()
        expect(service.ledger.list(project.id)).toHaveLength(1)
        expect(service.ledger.settings(project.id).generation).toBe(0)
        chmodSync(root, 0o700)
    })
    test('project purge keeps only a durable graph deletion task and no ledger/source content', () => {
        const { service, project } = setup()
        service.ledger.create(project.id, 'alice', 'Private', 'Content to forget', [{ kind: 'manual', projectId: project.id, hash: 'x' }])
        service.forgetProject(project.id)
        expect(service.ledger.list(project.id)).toHaveLength(0)
        expect(service.ledger.sources(project.id)).toHaveLength(0)
        expect(service.ledger.claim()?.kind).toBe('purge')
        expect(service.ledger.claim()).toBeNull()
    })
})

describe('Memory and codegraph authorization', () => {
    test('unauthorized projects cannot be listed, searched, or queried through codegraph', async () => {
        const { service, project, other, request } = setup()
        service.ledger.create(other.id, 'bob', 'Bob private', 'Hidden information', [{ kind: 'manual', projectId: other.id, hash: 'x' }])
        expect((await request(`/projects/${other.id}/memory`)).status).toBe(403)
        expect((await request(`/memory/search?q=Hidden&projectId=${other.id}`)).status).toBe(403)
        expect((await request(`/projects/${other.id}/codegraph/status`)).status).toBe(403)
        const result = await (await request('/memory/search?q=Hidden')).json() as { results: unknown[] }
        expect(result.results).toHaveLength(0)
        const unconfigured = await request(`/projects/${project.id}/codegraph/status`)
        expect(unconfigured.status).toBe(503)
        expect(await unconfigured.json()).toMatchObject({ available: false, state: 'unconfigured', code: 'codegraph_unconfigured' })
    })
    test('capability cannot escape its project, self-verify facts, or enable cloud spending', async () => {
        const { store, project, request } = setup()
        const capability = store.issueCapability('alice', project.id, ['memory:write', 'memory:read'], [], 300)
        const create = await request(`/projects/${project.id}/memory`, 'alice', { title: 'Fact', body: 'A safe observation.' }, 'POST', capability.token)
        expect(create.status).toBe(201)
        const { item } = await create.json() as { item: { id: string } }
        expect((await request(`/projects/${project.id}/memory/${item.id}`, 'alice', { status: 'verified' }, 'PATCH', capability.token)).status).toBe(403)
        expect((await request(`/projects/${project.id}/memory/settings`, 'alice', { enabled: true }, 'PATCH', capability.token)).status).toBe(403)
        expect((await request(`/projects/${project.id}/codegraph/status`, 'alice', undefined, 'GET', capability.token)).status).toBe(403)
    })
    test('ACL is checked before any backend search', async () => {
        let calls = 0
        const backend: MemoryBackend = { available: async () => true, request: async () => { calls++; return { spentMicros: 0, results: [] } } }
        const { service, project, other } = setup(backend)
        service.ledger.configure(project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
        await expect(service.hybridSearch('alice', [other.id], 'private')).rejects.toThrow('denied')
        expect(calls).toBe(0)
        await service.hybridSearch('alice', [project.id], 'visible')
        expect(calls).toBe(1)
    })
    test('membership revoked while the backend searches prevents returning its facts', async () => {
        let revoke = () => undefined
        const backend: MemoryBackend = { available: async () => true, request: async () => { revoke(); return { spentMicros: 0, results: [] } } }
        const { service, store, project, team } = setup(backend)
        store.setMember('alice', team.id, 'bob', 'admin')
        revoke = () => { store.setMember('bob', team.id, 'alice', null); return undefined }
        service.ledger.configure(project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
        await expect(service.hybridSearch('alice', [project.id], 'fact')).rejects.toThrow('denied')
    })
    test('unavailable processing retains durable reservation and local search still works', async () => {
        const { service, project } = setup()
        service.ledger.configure(project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 })
        service.ledger.create(project.id, 'alice', 'Available locally', 'The ledger remains usable.', [{ kind: 'manual', projectId: project.id, hash: 'x' }])
        expect(await service.processOne()).toBe(false)
        expect(service.ledger.budget(project.id).reservedMicros).toBe(20)
        expect(service.ledger.search([project.id], 'ledger')).toHaveLength(1)
    })
    test('secret files and obvious credential content are never ingested', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evolved-source-')); resources.push(() => rmSync(root, { recursive: true, force: true }))
        writeFileSync(join(root, '.env'), 'secret')
        writeFileSync(join(root, 'test.ts'), 'export const safe = true')
        writeFileSync(join(root, '.npmrc'), 'synthetic registry configuration')
        symlinkSync(join(root, '.npmrc'), join(root, 'alias.txt'))
        await expect(readMemorySource(root, '.env')).rejects.toThrow('excluded')
        await expect(readMemorySource(root, 'alias.txt')).rejects.toThrow('excluded')
        await expect(readMemorySource(root, '../outside.ts')).rejects.toThrow()
        expect(await readMemorySource(root, 'test.ts')).toContain('safe')
        expect(containsCredential('-----BEGIN PRIVATE KEY-----')).toBe(true)
        expect(containsCredential('Use the vault for passwords.')).toBe(false)
    })
})


test('a capability revoked during backend availability checks never starts a paid query', async () => {
    let requests = 0
    const fixture = setup({ available: async () => {
        fixture.store.db.query('DELETE FROM evolved_capabilities').run()
        return true
    }, request: async () => { requests++; return { spentMicros: 0, results: [] } } })
    fixture.service.ledger.configure(fixture.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
    const capability = fixture.store.issueCapability('alice', fixture.project.id, ['memory:read'], [], 60)
    const response = await fixture.request(`/memory/search?q=architecture&mode=hybrid`, 'alice', undefined, 'GET', capability.token)
    expect(response.status).toBe(401)
    expect(requests).toBe(0)
    expect(fixture.service.ledger.budget(fixture.project.id).reservedMicros).toBe(0)
})
