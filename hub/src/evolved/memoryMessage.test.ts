import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createMemoryRoutes } from './memory'
import { MemoryService } from './memoryService'
import { memoryHash, type MemoryItem } from './memoryStore'
import { EvolvedStore } from './store'
import { Store } from '../store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function setup() {
    const store = new EvolvedStore(':memory:'); stores.push(store)
    for (const user of ['alice', 'bob']) store.db.query('INSERT INTO evolved_users VALUES(?,?,?,?)').run(user, user, 0, Date.now())
    const team = store.createTeam('alice', 'Project team'), project = store.createProject('alice', team.id, 'Project')
    const otherTeam = store.createTeam('bob', 'Other team'), other = store.createProject('bob', otherTeam.id, 'Other')
    const messages = new Map<string, unknown>([['session:message', { role: 'user', content: { type: 'text', text: 'Use atomic writes for configuration.' } }]])
    const service = new MemoryService(store, { available: async () => false, request: async () => { throw new Error('No cloud calls permitted') } })
    let resolveCount = 0, onResolve: (() => void) | undefined
    const app = new Hono().route('/api/evolved', createMemoryRoutes({ store, service, origin: 'https://hapi.test', resolveMessage: (namespace, session, message) => {
        resolveCount++; onResolve?.()
        const content = namespace === project.namespace ? messages.get(`${session}:${message}`) : undefined
        return content === undefined ? null : { content }
    } }))
    const token = store.createSession('alice')
    const request = (suffix: string, body?: unknown, id = project.id) => app.request(`https://hapi.test/api/evolved/projects/${id}/memory/${suffix}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { cookie: `__Host-hapi-evolved=${token}`, origin: 'https://hapi.test', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { store, service, team, project, other, messages, request, setOnResolve: (callback: () => void) => { onResolve = callback }, count: () => resolveCount }
}
const sourceQuery = 'message-source?sessionId=session&messageId=message'
describe('explicit memory from stored conversation', () => {
    test('real persisted Hub message roundtrip retains the event source hash during later source reconciliation', async () => {
        const f = setup(), directory = mkdtempSync(join(tmpdir(), 'memory-source-roundtrip-'))
        let hub = new Store(join(directory, 'hub.db'))
        try {
            const session = hub.sessions.getOrCreateSession('memory-source', {}, null, f.project.namespace)
            const eventMessage = hub.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Stored source 😀\r\n'.repeat(1000) } })
            const eventBody = JSON.stringify(eventMessage.content)
            hub.close(); hub = new Store(join(directory, 'hub.db'))
            const app = new Hono().route('/api/evolved', createMemoryRoutes({ store: f.store, service: f.service, origin: 'https://hapi.test', resolveMessage: (namespace, sessionId, messageId) => {
                if (hub.sessions.getSession(sessionId)?.namespace !== namespace) return null
                return hub.messages.getMessageById(sessionId, messageId)
            } }))
            const token = f.store.createSession('alice'), base = `https://hapi.test/api/evolved/projects/${f.project.id}/memory`
            const headers = { cookie: `__Host-hapi-evolved=${token}`, origin: 'https://hapi.test', 'content-type': 'application/json' }
            const source = await (await app.request(`${base}/message-source?sessionId=${session.id}&messageId=${eventMessage.id}`, { headers })).json() as { sourceHash: string }
            expect(source.sourceHash).toBe(memoryHash(eventBody))
            const response = await app.request(`${base}/from-message`, { method: 'POST', headers, body: JSON.stringify({ sessionId: session.id, messageId: eventMessage.id, expectedSourceHash: source.sourceHash, title: 'Persisted message', excerpt: { start: 0, end: 12 } }) })
            expect(response.status).toBe(201)
            const { item } = await response.json() as { item: MemoryItem }
            f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
            f.service.reconcileHubMessage({ namespace: f.project.namespace, sessionId: session.id, messageId: eventMessage.id, content: eventMessage.content })
            expect(f.service.ledger.get(f.project.id, item.id)).not.toBeNull()
        } finally { hub.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test('projects visible text, binds the raw Hub source hash, preserves proposed status and deduplicates', async () => {
        const f = setup(), source = await f.request(sourceQuery)
        expect(source.status).toBe(200); expect(source.headers.get('cache-control')).toBe('private, no-store')
        const data = await source.json() as {body:string;sourceHash:string}
        expect(data.body).toBe('Use atomic writes for configuration.')
        expect(data.sourceHash).toBe(memoryHash(JSON.stringify(f.messages.get('session:message'))))
        const proposal = { sessionId: 'session', messageId: 'message', title: 'Atomic config', expectedSourceHash: data.sourceHash }
        const first = await f.request('from-message', proposal), second = await f.request('from-message', proposal)
        expect(first.status).toBe(201); expect(second.status).toBe(201)
        const { item } = await first.json() as {item:MemoryItem}
        expect(item.status).toBe('proposed'); expect(item.sources[0]).toMatchObject({ kind: 'chat', origin: 'hub:session:session', hash: data.sourceHash, sessionId: 'session', messageId: 'message' })
        expect(item.body).toBe(data.body)
        expect(f.service.ledger.list(f.project.id)).toHaveLength(1)
        expect(f.service.ledger.settings(f.project.id).cloudAllowed).toBe(false)
        f.service.forgetMessage(f.project.namespace, 'session', 'message')
        expect(f.service.ledger.list(f.project.id)).toHaveLength(0)
    })
    test('rejects foreign projects, unsupported messages, stale sources and credential text', async () => {
        const f = setup(), original = await (await f.request(sourceQuery)).json() as {sourceHash:string}
        expect((await f.request(sourceQuery, undefined, f.other.id)).status).toBe(403)
        f.messages.set('session:message', { role: 'user', content: { type: 'text', text: 'Changed source' } })
        expect((await f.request('from-message', { sessionId: 'session', messageId: 'message', title: 'Fact', expectedSourceHash: original.sourceHash })).status).toBe(409)
        f.messages.set('session:message', { role: 'agent', content: { type: 'tool-result', data: 'internal-only' } })
        expect((await f.request(sourceQuery)).status).toBe(422)
        f.messages.set('session:message', { role: 'user', content: { type: 'text', text: `api_key = sk-${'x'.repeat(30)}` } })
        const sensitive = await f.request(sourceQuery)
        expect(sensitive.status).toBe(422); expect(await sensitive.text()).not.toContain('sk-')
        f.messages.delete('session:message')
        expect((await f.request(sourceQuery)).status).toBe(404)
    })
    test('uses codepoint excerpts and keeps the original source hash compatible', async () => {
        const f = setup()
        const content = { role: 'user', content: { type: 'text', text: 'A😀BC' } }
        f.messages.set('session:message', content)
        const source = await (await f.request(sourceQuery)).json() as {sourceHash:string}
        const proposal = { sessionId: 'session', messageId: 'message', title: 'Excerpt', expectedSourceHash: source.sourceHash, excerpt: { start: 1, end: 3 } }
        const response = await f.request('from-message', proposal)
        expect(response.status).toBe(201)
        const { item } = await response.json() as {item:MemoryItem}
        expect(item.body).toBe('[Auszug, nicht automatisch verifiziert]\n\n😀B')
        f.service.ledger.configure(f.project.id, { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 100, jobBudgetMicros: 20 }, 'alice')
        f.service.reconcileHubMessage({ namespace: f.project.namespace, sessionId: 'session', messageId: 'message', content })
        expect(f.service.ledger.get(f.project.id, item.id)).not.toBeNull()
        expect((await f.request('from-message', { ...proposal, excerpt: { start: 0, end: 10 } })).status).toBe(400)
        expect((await f.request('from-message', { ...proposal, body: 'Forged source text' })).status).toBe(400)
    })
    test('denies viewers and authority revoked during source resolution', async () => {
        const f = setup()
        f.store.setMember('alice', f.team.id, 'bob', 'admin')
        f.setOnResolve(() => { f.store.setMember('bob', f.team.id, 'alice', null) })
        const response = await f.request('from-message', { sessionId: 'session', messageId: 'message', title: 'Fact', expectedSourceHash: memoryHash(JSON.stringify(f.messages.get('session:message'))) })
        expect(response.status).toBe(403); expect(f.service.ledger.list(f.project.id)).toHaveLength(0)
        f.store.setMember('bob', f.team.id, 'alice', 'viewer')
        expect((await f.request(sourceQuery)).status).toBe(403)
    })
})
