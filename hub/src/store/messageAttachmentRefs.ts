import type { Database } from 'bun:sqlite'
import { decodeMessageContent } from './contentCodec'
import { prepareCached } from './statementCache'

const initialized = new WeakSet<Database>()
export function createMessageAttachmentRefs(db: Database): void {
    if (initialized.has(db)) return
    db.exec(`
        CREATE TABLE IF NOT EXISTS message_attachment_refs (
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            attachment_id TEXT NOT NULL,
            PRIMARY KEY(message_id, attachment_id)
        );
        CREATE INDEX IF NOT EXISTS idx_attachment_refs_session ON message_attachment_refs(session_id, attachment_id, message_id);
        CREATE TRIGGER IF NOT EXISTS attachment_refs_session_move AFTER UPDATE OF session_id ON messages
        BEGIN UPDATE message_attachment_refs SET session_id=NEW.session_id WHERE message_id=NEW.id; END;
        CREATE TABLE IF NOT EXISTS message_attachment_backfill (
            id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, highwater INTEGER NOT NULL, done INTEGER NOT NULL
        );
    `)
    initialized.add(db)
}

/** Called inside the canonical message transaction, including queued messages. */
export function indexMessageAttachmentRefs(db: Database, message: { id: string; sessionId: string; content: unknown }): void {
    createMessageAttachmentRefs(db)
    prepareCached(db, 'DELETE FROM message_attachment_refs WHERE message_id=?').run(message.id)
    const value = message.content as { role?: unknown; content?: { attachments?: unknown } } | null
    if (value?.role !== 'user' || !Array.isArray(value.content?.attachments)) return
    const insert = prepareCached(db, 'INSERT OR IGNORE INTO message_attachment_refs(message_id,session_id,attachment_id) VALUES(?,?,?)')
    for (const item of value.content.attachments) {
        const id = item?.attachmentId
        if (typeof id === 'string' && id.length > 0 && id.length <= 256) insert.run(message.id, message.sessionId, id)
    }
}

export function scheduleAttachmentRefBackfill(db: Database): void {
    createMessageAttachmentRefs(db)
    const highwater = (db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get() as { n: number }).n
    db.prepare('INSERT OR IGNORE INTO message_attachment_backfill(id,cursor,highwater,done) VALUES(1,0,?,?)').run(highwater, highwater === 0 ? 1 : 0)
}

export function assertAttachmentRefsReady(db: Database): void {
    createMessageAttachmentRefs(db)
    if (prepareCached(db, 'SELECT 1 FROM message_attachment_backfill WHERE id=1 AND done=0').get()) {
        throw new Error('Attachment references are being indexed after upgrade. Retry when the background index is complete.')
    }
}

/** No long-lived SQLite iterator: a bounded page commits before the next timer. */
export function processAttachmentRefBackfill(db: Database): boolean {
    return db.transaction(() => {
        const state = db.prepare('SELECT cursor,highwater FROM message_attachment_backfill WHERE id=1 AND done=0').get() as { cursor: number; highwater: number } | null
        if (!state) return false
        const rows = db.prepare('SELECT rowid AS row_id,id,session_id,content FROM messages WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 50').all(state.cursor, state.highwater) as Array<{ row_id: number; id: string; session_id: string; content: string | Uint8Array }>
        let cursor = state.cursor
        const started = performance.now()
        for (const row of rows) {
            indexMessageAttachmentRefs(db, { id: row.id, sessionId: row.session_id, content: decodeMessageContent(row.content) })
            cursor = row.row_id
            if (performance.now() - started >= 15) break
        }
        const done = rows.length === 0 || cursor >= state.highwater
        db.prepare('UPDATE message_attachment_backfill SET cursor=?,done=? WHERE id=1').run(cursor, done ? 1 : 0)
        return !done
    })()
}
