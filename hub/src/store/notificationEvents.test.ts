import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { NotificationCursorError, NotificationEventStore } from './notificationEvents'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function setup() {
    const store = new Store(':memory:')
    cleanup.push(() => store.close())
    const session = store.sessions.getOrCreateSession('first', { path: '/work' }, null, 'project-a')
    const foreign = store.sessions.getOrCreateSession('second', { path: '/other' }, null, 'project-b')
    return { store, session, foreign, db: (store as unknown as { db: Database }).db }
}
const ready = { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }
const task = { role: 'agent', content: { type: 'output', data: { type: 'system', subtype: 'task_notification', status: 'completed', summary: 'SYNTHETIC_PRIVATE_TASK_TEXT' } } }

describe('durable notification recovery', () => {
    it('deletion never skips surviving events from other sessions and merge preserves identity', () => {
        const { store, session } = setup()
        const other = store.sessions.getOrCreateSession('other', {}, null, 'project-a')
        const initial = store.notificationEvents.page('project-a').nextCursor
        const expected: string[] = []
        for (let i = 0; i < 5; i++) {
            store.messages.addMessage(session.id, ready)
            expected.push(store.messages.addMessage(other.id, ready).id)
        }
        store.sessions.deleteSession(session.id, 'project-a')
        const recovered = store.notificationEvents.page('project-a', { after: initial })
        expect(recovered.gap).toBe(false)
        expect(recovered.items.map(row => row.messageId)).toEqual(expected)
        const target = store.sessions.getOrCreateSession('target', {}, null, 'project-a')
        store.messages.mergeSessionMessages(other.id, target.id)
        store.sessions.deleteSession(other.id, 'project-a')
        const moved = store.notificationEvents.page('project-a', { after: initial })
        expect(moved.items.map(row => row.messageId)).toEqual(expected)
        expect(moved.items.every(row => row.sessionId === target.id)).toBe(true)
    })

    it('copy and import index history without creating fresh completion events', () => {
        const { store, session } = setup()
        const target = store.sessions.getOrCreateSession('target', {}, null, 'project-a')
        const source = store.messages.addMessage(session.id, ready)
        const before = store.notificationEvents.page('project-a').nextCursor
        store.messages.copyMessageToSession(target.id, source)
        store.messages.copyMessagesToSession(target.id, [source])
        store.messages.addImportedMessage(target.id, task, 'historical-task', Date.now() - 60_000)
        expect(store.notificationEvents.page('project-a', { after: before }).items).toEqual([])
    })

    it('explicit restore invalidation rejects a previously valid cursor', () => {
        const { store, session } = setup()
        store.messages.addMessage(session.id, ready)
        const cursor = store.notificationEvents.page('project-a').nextCursor
        store.notificationEvents.invalidateCursorsAfterRestore()
        expect(() => store.notificationEvents.page('project-a', { after: cursor })).toThrow(NotificationCursorError)
    })
    it('persists distinct offline tasks across hub restart without copying private text', () => {
        const dir = mkdtempSync(join(tmpdir(), 'evolved-notification-'))
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
        const path = join(dir, 'hub.db')
        let store = new Store(path)
        const s = store.sessions.getOrCreateSession('recovery', { path: '/work' }, null, 'project-a')
        store.messages.addMessage(s.id, ready)
        const before = store.notificationEvents.page('project-a').nextCursor
        const ids = [store.messages.addMessage(s.id, task).id, store.messages.addMessage(s.id, task).id]
        store.close()
        store = new Store(path)
        try {
            const recovered = store.notificationEvents.page('project-a', { after: before })
            expect(recovered.items.map(x => x.messageId)).toEqual(ids)
            expect(recovered.gap).toBe(false)
            expect(JSON.stringify(recovered)).not.toContain('SYNTHETIC_PRIVATE_TASK_TEXT')
            expect(store.notificationEvents.page('project-a', { after: recovered.nextCursor }).items).toEqual([])
        } finally { store.close() }
    })

    it('commits a notification and its source message atomically', () => {
        const { store, session, db } = setup()
        db.exec(`CREATE TRIGGER fail_journal BEFORE INSERT ON notification_events BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END;`)
        expect(() => store.messages.addMessage(session.id, ready)).toThrow('synthetic disk failure')
        expect(store.messages.countMessages(session.id)).toBe(0)
        expect(store.notificationEvents.page('project-a').items).toEqual([])
    })

    it('isolates namespace cursors and bounds a stable snapshot while new messages arrive', () => {
        const { store, session, foreign } = setup()
        for (let i = 0; i < 3; i++) store.messages.addMessage(session.id, ready)
        store.messages.addMessage(foreign.id, task)
        const first = store.notificationEvents.page('project-a', { limit: 1 })
        const later = store.messages.addMessage(session.id, task)
        const second = store.notificationEvents.page('project-a', { after: first.nextCursor, until: first.highWater, limit: 10 })
        expect(second.items).toHaveLength(2)
        expect(second.items.every(x => x.sessionId === session.id)).toBe(true)
        expect(second.hasMore).toBe(false)
        expect(store.notificationEvents.page('project-a', { after: second.nextCursor }).items[0]?.messageId).toBe(later.id)
        expect(() => store.notificationEvents.page('project-b', { after: first.nextCursor })).toThrow(NotificationCursorError)
        expect(() => store.notificationEvents.page('project-a', { after: first.nextCursor + '0' })).toThrow(NotificationCursorError)
    })

    it('reports retention gaps, source deletion and idempotent completion without resurrecting requests', () => {
        const { store, session, db } = setup()
        let now = 1_000
        const journal = new NotificationEventStore(db, () => now, 100, 2)
        const initial = journal.page('project-a').nextCursor
        journal.recordCompletion(session.id, 10)
        journal.recordCompletion(session.id, 10)
        expect(journal.page('project-a').items).toHaveLength(1)
        journal.recordCompletion(session.id, 11)
        journal.recordCompletion(session.id, 12)
        const page = journal.page('project-a', { after: initial })
        expect(page.gap).toBe(true)
        expect(page.items).toHaveLength(2)
        now = 2_000
        const expired = journal.page('project-a', { after: page.nextCursor })
        expect(expired.items).toEqual([])
        const message = store.messages.addMessage(session.id, task)
        const beforeDelete = store.notificationEvents.page('project-a').earliestCursor
        db.prepare('DELETE FROM messages WHERE id=?').run(message.id)
        const afterDelete = store.notificationEvents.page('project-a', { after: beforeDelete })
        expect(afterDelete.gap).toBe(false)
        expect(afterDelete.items).toEqual([])
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'event', data: { type: 'permission_requested' } } })
        expect(store.notificationEvents.page('project-a').items).toEqual([])
    })
})
