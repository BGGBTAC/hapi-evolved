import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import type { SyncEvent } from '@hapi/protocol/types'
import { extractMessageEventType, extractTaskNotification } from '../notifications/eventParsing'

type MessageInput = { id: string; sessionId: string; content: unknown; seq: number; createdAt: number; invokedAt: number | null }
type State = { epoch: string; head: number; floor: number }
type Row = { seq: number; session_id: string; message_id: string | null; kind: 'ready' | 'task' | 'completed'; created_at: number; status: string | null }
const journals = new WeakMap<Database, NotificationEventStore>()
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_EVENTS = 20_000

export class NotificationCursorError extends Error {}

/** A bounded durable feed, independent of the process-local high-frequency SSE ring.
 * Message events share the source message transaction. Payloads contain references,
 * never copied transcript text, credentials, or stale permission requests.
 */
export class NotificationEventStore {
    constructor(private readonly db: Database, private readonly now = Date.now,
        private readonly retentionMs = RETENTION_MS, private readonly maxEvents = MAX_EVENTS) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS notification_cursors (
                namespace TEXT PRIMARY KEY, epoch TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS notification_events (
                namespace TEXT NOT NULL, seq INTEGER NOT NULL, source_key TEXT NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
                kind TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT,
                PRIMARY KEY(namespace, seq), UNIQUE(namespace, source_key)
            );
            CREATE INDEX IF NOT EXISTS idx_notification_retention ON notification_events(namespace, created_at);
            CREATE INDEX IF NOT EXISTS idx_notification_session ON notification_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_notification_message ON notification_events(message_id);
            DROP TRIGGER IF EXISTS notification_pruned;
        `)
    }

    private state(namespace: string): State {
        this.db.prepare('INSERT OR IGNORE INTO notification_cursors(namespace,epoch) VALUES(?,?)').run(namespace, randomUUID())
        return this.db.prepare('SELECT epoch,head,floor FROM notification_cursors WHERE namespace=?').get(namespace) as State
    }

    private cursor(namespace: string, state: State, seq: number): string {
        const scope = createHash('sha256').update(`${state.epoch}:${namespace}`).digest('hex').slice(0, 24)
        return `n1:${scope}:${seq}`
    }

    private parse(value: string, namespace: string, state: State): number {
        const seq = Number(value.split(':')[2])
        if (!Number.isSafeInteger(seq) || seq < 0 || seq > state.head || value !== this.cursor(namespace, state, seq)) {
            throw new NotificationCursorError('Invalid notification cursor for this project or database.')
        }
        return seq
    }

    private prune(namespace: string): void {
        const state = this.state(namespace)
        this.db.prepare('UPDATE notification_cursors SET floor=MAX(floor,COALESCE((SELECT MAX(seq) FROM notification_events WHERE namespace=? AND (seq<=? OR created_at<?)),0)) WHERE namespace=?')
            .run(namespace, state.head - this.maxEvents, this.now() - this.retentionMs, namespace)
        this.db.prepare('DELETE FROM notification_events WHERE namespace=? AND (seq<=? OR created_at<?)')
            .run(namespace, state.head - this.maxEvents, this.now() - this.retentionMs)
    }

    private append(sessionId: string, key: string, kind: Row['kind'], messageId: string | null, status: string | null): string | null {
        const run = () => {
            const session = this.db.prepare('SELECT namespace FROM sessions WHERE id=?').get(sessionId) as { namespace: string } | null
            if (!session) return null
            const namespace = session.namespace
            let state = this.state(namespace)
            const duplicate = this.db.prepare('SELECT seq FROM notification_events WHERE namespace=? AND source_key=?')
                .get(namespace, key) as { seq: number } | null
            if (duplicate) return this.cursor(namespace, state, duplicate.seq)
            this.db.prepare('UPDATE notification_cursors SET head=head+1 WHERE namespace=?').run(namespace)
            state = this.state(namespace)
            this.db.prepare(`INSERT INTO notification_events(namespace,seq,source_key,session_id,message_id,kind,created_at,status)
                VALUES(?,?,?,?,?,?,?,?)`).run(namespace, state.head, key, sessionId, messageId, kind, this.now(), status)
            this.prune(namespace)
            return this.cursor(namespace, state, state.head)
        }
        return this.db.inTransaction ? run() : this.db.transaction(run)()
    }

    recordMessage(message: MessageInput): string | null {
        if (message.invokedAt === null) return null
        const event: SyncEvent = { type: 'message-received', sessionId: message.sessionId,
            message: { id: message.id, seq: message.seq, createdAt: message.createdAt, localId: null, content: message.content } }
        if (extractMessageEventType(event) === 'ready') return this.append(message.sessionId, `message:${message.id}`, 'ready', message.id, null)
        const task = extractTaskNotification(event)
        if (!task) return null
        // Only a finite status is copied; callers fetch the referenced message for text.
        const status = ['completed', 'failed', 'stopped', 'cancelled'].includes(task.status ?? '') ? task.status! : null
        return this.append(message.sessionId, `message:${message.id}`, 'task', message.id, status)
    }

    recordCompletion(sessionId: string, at: number): string | null {
        if (!Number.isFinite(at)) return null
        return this.append(sessionId, `completed:${sessionId}:${at}`, 'completed', null, 'completed')
    }

    /** Required after restoring a backup; normal restarts preserve recovery cursors. */
    invalidateCursorsAfterRestore(): void {
        this.db.prepare('UPDATE notification_cursors SET epoch=?').run(randomUUID())
    }

    messageCursor(namespace: string, messageId: string): string | undefined {
        const row = this.db.prepare('SELECT seq FROM notification_events WHERE namespace=? AND message_id=?')
            .get(namespace, messageId) as { seq: number } | null
        return row ? this.cursor(namespace, this.state(namespace), row.seq) : undefined
    }

    page(namespace: string, options: { after?: string; until?: string; limit?: number } = {}) {
        return this.db.transaction(() => {
            this.prune(namespace)
            const state = this.state(namespace)
            const requestedAfter = options.after ? this.parse(options.after, namespace, state) : 0
            const until = options.until ? this.parse(options.until, namespace, state) : state.head
            if (requestedAfter > until) throw new NotificationCursorError('Cursor follows the snapshot boundary.')
            const gap = requestedAfter < state.floor
            const after = requestedAfter // Never skip surviving rows when retention has holes (clock changes).
            const limit = Math.max(1, Math.min(500, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 100))
            const rows = this.db.prepare(`SELECT e.seq,e.session_id,e.message_id,e.kind,e.created_at,e.status
                FROM notification_events e JOIN sessions s ON s.id=e.session_id AND s.namespace=e.namespace
                WHERE e.namespace=? AND e.seq>? AND e.seq<=? ORDER BY e.seq LIMIT ?`)
                .all(namespace, after, until, limit + 1) as Row[]
            const hasMore = rows.length > limit
            const items = rows.slice(0, limit)
            const next = hasMore ? items[items.length - 1]!.seq : until
            return {
                items: items.map(row => ({ id: this.cursor(namespace, state, row.seq), sessionId: row.session_id,
                    messageId: row.message_id, kind: row.kind, createdAt: row.created_at, status: row.status })),
                nextCursor: this.cursor(namespace, state, next), highWater: this.cursor(namespace, state, until),
                earliestCursor: this.cursor(namespace, state, state.floor), hasMore, gap,
                retention: { days: this.retentionMs / 86_400_000, maxEvents: this.maxEvents },
            }
        })()
    }
}

export function notificationEvents(db: Database): NotificationEventStore {
    let store = journals.get(db)
    if (!store) { store = new NotificationEventStore(db); journals.set(db, store) }
    return store
}
