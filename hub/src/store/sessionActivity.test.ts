import { expect, test } from 'bun:test'
import { Store } from './index'
import { SessionCache } from '../sync/sessionCache'
import type { EventPublisher } from '../sync/eventPublisher'
import type { Database } from 'bun:sqlite'
import { scheduleMessageContentBackfill, processMessageContentBackfill } from './messageContentSearch'

test('state refreshes never alter conversation clocks; visible assistant prose does', async () => {
    const store = new Store(':memory:')
    try {
        const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
        const session = cache.getOrCreateSession('clock', { path: '/tmp', host: 'localhost' }, null, 'ns')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, undefined, null, 100)
        const assistant = store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'answer' } } }, undefined, null, 200)
        cache.refreshSession(session.id)
        expect(cache.getSession(session.id)).toMatchObject({ lastMessageAt: 200, lastAssistantMessageAt: 200 })
        store.sessions.updateSessionAgentState(session.id, { controlledByUser: false, requests: {}, codexUsage: { quota: 1 } }, 0, 'ns')
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Bash', input: { command: 'echo x' } } } }, undefined, null, 300)
        cache.refreshSession(session.id)
        expect(cache.getSession(session.id)).toMatchObject({ lastMessageAt: 200, lastAssistantMessageAt: 200 })
        expect((await store.messages.getLatestUserMessage(session.id))?.createdAt).toBe(100)
        store.messages.updateMessageContent(assistant.id, { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Bash', input: {} } } })
        expect(store.messages.getConversationActivity(session.id)).toEqual({ lastMessageAt: 100, lastAssistantMessageAt: null, notifyStatus: null })
    } finally { store.close() }
})


test('only an explicit latest assistant blocked footer sets notifyStatus; a new prompt clears it', () => {
    const store = new Store(':memory:')
    try {
        const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
        const session = cache.getOrCreateSession('notify', { path: '/tmp', host: 'localhost' }, null, 'ns')
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Need a decision.\nAGENT_NOTIFY_SUMMARY {"status":"blocked","summary":"Choose a target"}' } } })
        cache.refreshMessageActivity(session.id)
        expect(cache.getSession(session.id)?.notifyStatus).toBe('blocked')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Use A' } })
        cache.refreshMessageActivity(session.id)
        expect(cache.getSession(session.id)?.notifyStatus).toBeNull()
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'The word blocked alone proves nothing.' } } })
        cache.refreshMessageActivity(session.id)
        expect(cache.getSession(session.id)?.notifyStatus).toBeNull()
    } finally { store.close() }
})

test('empty sessions expose unknown clocks and retain valid clocks throughout FTS maintenance', () => {
    const store = new Store(':memory:')
    try {
        const db = (store as unknown as { db: Database }).db
        const session = store.sessions.getOrCreateSession('backfill-clock', { path: '/tmp', host: 'local' }, null, 'ns')
        expect(store.messages.getConversationActivity(session.id)).toEqual({ lastMessageAt: null, lastAssistantMessageAt: null, notifyStatus: null })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, undefined, null, 100)
        scheduleMessageContentBackfill(db)
        expect(store.messages.getConversationActivity(session.id).lastMessageAt).toBe(100)
        while (processMessageContentBackfill(db)) {}
        expect(store.messages.getConversationActivity(session.id).lastMessageAt).toBe(100)
    } finally { store.close() }
})

test('an incomplete upgrade index cannot hide the latest user prompt behind tool rows', async () => {
    const store = new Store(':memory:')
    try {
        const db = (store as unknown as { db: Database }).db
        const session = store.sessions.getOrCreateSession('backfill-user', { path: '/tmp', host: 'local' }, null, 'ns')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'old prompt' } })
        const latest = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'current prompt' }, meta: { peer: { trust: 'project-runner' } } })
        for (let i = 0; i < 120; i++) store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Bash', input: { i } } } })
        scheduleMessageContentBackfill(db)
        db.prepare('DELETE FROM session_activity_messages WHERE message_id=?').run(latest.id)
        const result = await store.messages.getLatestUserMessage(session.id)
        expect(result?.id).toBe(latest.id)
        expect(JSON.stringify(result?.content)).not.toContain('project-runner')
    } finally { store.close() }
})
