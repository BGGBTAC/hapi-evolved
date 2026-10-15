import type { Database } from 'bun:sqlite'
import { extractAssistantPlainText, extractNotifySummary, extractSearchableMessageText, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { decodeMessageContent } from './contentCodec'

const initialized = new WeakSet<Database>()

export function ensureSessionActivityTable(db: Database): void {
    if (initialized.has(db)) return
    db.exec(`CREATE TABLE IF NOT EXISTS session_activity_messages (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        created_at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        notify_status TEXT
    );
    CREATE INDEX IF NOT EXISTS session_activity_latest ON session_activity_messages(session_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS session_activity_assistant ON session_activity_messages(session_id,created_at DESC) WHERE role='assistant';`)
    db.exec("CREATE INDEX IF NOT EXISTS session_activity_user ON session_activity_messages(session_id,seq DESC) WHERE role='user'")
    db.exec('CREATE INDEX IF NOT EXISTS session_activity_latest_seq ON session_activity_messages(session_id,seq DESC)')
    initialized.add(db)
}

export async function getLatestUserMessageId(db: Database, sessionId: string): Promise<string | null> {
    ensureSessionActivityTable(db)
    const pending = db.prepare("SELECT 1 FROM message_content_backfill WHERE id=1 AND phase != 'done'").get()
    if (!pending) {
        const row = db.prepare("SELECT message_id FROM session_activity_messages WHERE session_id=? AND role='user' ORDER BY seq DESC LIMIT 1").get(sessionId) as { message_id: string } | null
        return row?.message_id ?? null
    }
    // Upgrades can have an incomplete derived index. Walk newest-first in bounded
    // pages, yielding between pages; never mistake an older indexed prompt for
    // the latest one and never block startup on a full transcript scan.
    const latestSeq = () => (db.prepare('SELECT MAX(seq) AS seq FROM messages WHERE session_id=?').get(sessionId) as { seq: number | null }).seq
    const highwater = latestSeq()
    if (highwater === null) return null
    let before = highwater + 1
    while (true) {
        const rows = db.prepare('SELECT id,seq,content FROM messages WHERE session_id=? AND seq<? AND invoked_at IS NOT NULL ORDER BY seq DESC LIMIT 50')
            .all(sessionId, before) as Array<{ id: string; seq: number; content: string | Uint8Array }>
        if (!rows.length) return null
        for (const row of rows) {
            if (extractSearchableMessageText(decodeMessageContent(row.content), { maxSourceCharacters: 32_768 })?.role === 'user') {
                return latestSeq() === highwater ? row.id : null
            }
        }
        before = rows[rows.length - 1]!.seq
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        if (latestSeq() !== highwater) return null
    }
}

/** Called only after the shared visibility normalizer accepts a transcript row. */
export function recordSessionMessageActivity(db: Database, message: { id: string; sessionId: string; role: 'user' | 'assistant'; createdAt: number; seq?: number; text?: string }): void {
    ensureSessionActivityTable(db)
    const seq = message.seq ?? (db.prepare('SELECT seq FROM messages WHERE id=?').get(message.id) as { seq: number }).seq
    const raw = message.role === 'assistant' ? db.prepare('SELECT content FROM messages WHERE id=?').get(message.id) as { content: string | Uint8Array } | null : null
    const envelope = raw ? unwrapRoleWrappedRecordEnvelope(decodeMessageContent(raw.content)) : null
    const notifyStatus = envelope?.role === 'agent' && extractNotifySummary(extractAssistantPlainText(envelope.content))?.status === 'blocked' ? 'blocked' : null
    db.prepare(`INSERT INTO session_activity_messages VALUES(?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
        session_id=excluded.session_id,role=excluded.role,created_at=excluded.created_at,seq=excluded.seq,notify_status=excluded.notify_status`)
        .run(message.id, message.sessionId, message.role, message.createdAt, seq, notifyStatus)
}

export function deleteSessionMessageActivity(db: Database, messageIds: string[]): void {
    ensureSessionActivityTable(db)
    const remove = db.prepare('DELETE FROM session_activity_messages WHERE message_id=?')
    for (const id of messageIds) remove.run(id)
}

export function clearSessionMessageActivity(db: Database, sessionId?: string): void {
    ensureSessionActivityTable(db)
    if (sessionId === undefined) db.exec('DELETE FROM session_activity_messages')
    else db.prepare('DELETE FROM session_activity_messages WHERE session_id=?').run(sessionId)
}

export function getSessionActivity(db: Database, sessionId: string): { lastMessageAt: number | null; lastAssistantMessageAt: number | null; notifyStatus: 'blocked' | null } {
    ensureSessionActivityTable(db)
    // Three indexed probes, independent of the size of the conversation.
    const last = db.prepare('SELECT created_at FROM session_activity_messages WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId) as { created_at: number } | null
    const assistant = db.prepare("SELECT created_at FROM session_activity_messages WHERE session_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(sessionId) as { created_at: number } | null
    const latest = db.prepare('SELECT notify_status FROM session_activity_messages WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(sessionId) as { notify_status: 'blocked' | null } | null
    return { notifyStatus: latest?.notify_status ?? null, lastMessageAt: last?.created_at ?? null, lastAssistantMessageAt: assistant?.created_at ?? null }
}
