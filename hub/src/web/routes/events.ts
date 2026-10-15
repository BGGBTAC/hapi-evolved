import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SSEManager } from '../../sse/sseManager'
import type { SyncEngine } from '../../sync/syncEngine'
import type { VisibilityState } from '../../visibility/visibilityTracker'
import type { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { compressSseResponse } from '../sseCompression'
import { requireSession } from './guards'
import { NotificationCursorError } from '../../store/notificationEvents'

function parseOptionalId(value: string | undefined): string | null {
    if (!value) {
        return null
    }
    return value.trim() ? value : null
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) {
        return false
    }
    return value === 'true' || value === '1'
}

function parseVisibility(value: string | undefined): VisibilityState {
    return value === 'visible' ? 'visible' : 'hidden'
}

const visibilitySchema = z.object({
    subscriptionId: z.string().min(1),
    visibility: z.enum(['visible', 'hidden'])
})

export function createEventsRoutes(
    getSseManager: () => SSEManager | null,
    getSyncEngine: () => SyncEngine | null,
    getVisibilityTracker: () => VisibilityTracker | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/notifications/events', (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const { after, until, limit } = c.req.query()
        if ((after?.length ?? 0) > 150 || (until?.length ?? 0) > 150) return c.json({ error: 'Invalid cursor' }, 400)
        const parsedLimit = limit === undefined ? 100 : Number(limit)
        if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) return c.json({ error: 'Invalid limit' }, 400)
        c.header('Cache-Control', 'no-store')
        try { return c.json(engine.getNotificationEvents(c.get('namespace'), { after, until, limit: parsedLimit })) }
        catch (error) {
            if (error instanceof NotificationCursorError) return c.json({ error: error.message }, 400)
            throw error
        }
    })

    app.get('/events', (c) => {
        const manager = getSseManager()
        if (!manager) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const query = c.req.query()
        const all = parseBoolean(query.all)
        const sessionId = parseOptionalId(query.sessionId)
        const machineId = parseOptionalId(query.machineId)
        const subscriptionId = randomUUID()
        const visibility = parseVisibility(query.visibility)
        // Native EventSource auto-reconnects keep the original URL and carry
        // the freshest cursor in the standard Last-Event-ID header; the query
        // parameter covers manually created reconnects (new EventSource with
        // a rebuilt URL). Header wins - it is never staler than the URL.
        const resumeFrom = parseOptionalId(c.req.header('Last-Event-ID'))
            ?? parseOptionalId(query.lastEventId)
        const namespace = c.get('namespace')
        let resolvedSessionId = sessionId

        if (sessionId || machineId) {
            const engine = getSyncEngine()
            if (!engine) {
                return c.json({ error: 'Not connected' }, 503)
            }
            if (sessionId) {
                const sessionResult = requireSession(c, engine, sessionId)
                if (sessionResult instanceof Response) {
                    return sessionResult
                }
                resolvedSessionId = sessionResult.sessionId
            }
            if (machineId) {
                const machine = engine.getMachine(machineId)
                if (!machine) {
                    return c.json({ error: 'Machine not found' }, 404)
                }
                if (machine.namespace !== namespace) {
                    return c.json({ error: 'Machine access denied' }, 403)
                }
            }
        }

        const response = streamSSE(c, async (stream) => {
            const authorized = c.get('isAuthorized') ?? (() => true)
            let closed = false
            let finish!: () => void
            const finished = new Promise<void>(resolve => { finish = () => { closed = true; resolve() } })
            c.req.raw.signal.addEventListener('abort', finish, { once: true })
            stream.onAbort(finish)
            if (c.req.raw.signal.aborted) finish()
            const revoke = async () => {
                manager.unsubscribe(subscriptionId)
                finish()
                await stream.close()
            }
            const sendAuthorized = async (event: unknown, id?: string) => {
                if (closed) return
                if (!authorized()) { await revoke(); return }
                await stream.writeSSE({ data: JSON.stringify(event), id })
            }
            // Reconnects supply the last SSE id they saw; when the manager
            // still has everything after it, the missed events are replayed
            // here and the client skips its REST resync (`resume: 'ok'`).
            const { resume, replay } = manager.subscribe({
                id: subscriptionId,
                namespace,
                all,
                sessionId: resolvedSessionId,
                machineId,
                visibility,
                resumeFrom,
                send: sendAuthorized,
                sendHeartbeat: async () => {
                    if (closed) return
                    if (!authorized()) { await revoke(); return }
                    await stream.writeSSE({
                        data: JSON.stringify({
                            type: 'heartbeat',
                            namespace,
                            data: {
                                timestamp: Date.now()
                            }
                        })
                    })
                }
            })

            try {
                // Verdict first, replay second, live traffic third: the client
                // decides whether to resync from the verdict, so it must never
                // see replayed or live events before it.
                await stream.writeSSE({
                    data: JSON.stringify({
                        type: 'connection-changed',
                        data: {
                            status: 'connected',
                            subscriptionId,
                            resume
                        }
                    })
                })

                for (const item of replay) {
                    if (closed) break
                    await sendAuthorized(item.event, item.eventId)
                }
                await manager.drainPending(subscriptionId)

                await finished
            } finally {
                c.req.raw.signal.removeEventListener('abort', finish)
                manager.unsubscribe(subscriptionId)
            }
        })

        return compressSseResponse(response, c.req.header('Accept-Encoding'))
    })

    app.post('/visibility', async (c) => {
        const tracker = getVisibilityTracker()
        if (!tracker) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = visibilitySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const updated = tracker.setVisibility(parsed.data.subscriptionId, namespace, parsed.data.visibility)
        if (!updated) {
            return c.json({ error: 'Subscription not found' }, 404)
        }

        return c.json({ ok: true })
    })

    return app
}
