import { afterEach, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'
import { EventPublisher } from '../../sync/eventPublisher'
import type { SSEManager } from '../../sse/sseManager'
const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
it('serves bounded private pages and rejects cross-project cursors', async () => {
    const store = new Store(':memory:'); stores.push(store)
    const session = store.sessions.getOrCreateSession('a', {}, null, 'a')
    store.notificationEvents.recordCompletion(session.id, 1)
    const foreign = store.notificationEvents.page('b').nextCursor
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'a'); await next() })
    app.route('/api', createEventsRoutes(() => null, () => ({
        getNotificationEvents: (ns: string, options: Parameters<typeof store.notificationEvents.page>[1]) => store.notificationEvents.page(ns, options)
    }) as SyncEngine, () => null))
    const response = await app.request('/api/notifications/events')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { items: Array<{ sessionId: string }> }
    expect(body.items[0]?.sessionId).toBe(session.id)
    expect((await app.request(`/api/notifications/events?after=${foreign}`)).status).toBe(400)
    expect((await app.request('/api/notifications/events?limit=100000')).status).toBe(400)
})
it('adds the persisted message identity to live SSE before delivery', () => {
    const store = new Store(':memory:'); stores.push(store)
    const session = store.sessions.getOrCreateSession('a', {}, null, 'a')
    const message = store.messages.addMessage(session.id, { type: 'event', data: { type: 'ready' } })
    const sent: unknown[] = []
    const publisher = new EventPublisher({ broadcast: (event: unknown) => sent.push(event) } as unknown as SSEManager,
        () => 'a', (ns, id) => store.notificationEvents.messageCursor(ns, id))
    publisher.emit({ type: 'message-received', sessionId: session.id, message })
    expect((sent[0] as { notificationCursor: string }).notificationCursor).toBe(store.notificationEvents.page('a').items[0]?.id)
})
