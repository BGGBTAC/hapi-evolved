import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'
import { processAttachmentRefBackfill } from './messageAttachmentRefs'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture(path = ':memory:') {
    const store = new Store(path); cleanup.push(() => store.close())
    const a = store.sessions.getOrCreateSession('a', {}, null, 'ns')
    const b = store.sessions.getOrCreateSession('b', {}, null, 'ns')
    return { store, a, b, db: (store as unknown as { db: Database }).db }
}
const message = (id: string) => ({ role: 'user', content: { type: 'text', text: 'Keep exact original', attachments: [{ attachmentId: id }] } })

test('partial unversioned legacy DB without messages creates the current derived schema safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'refs-partial-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'hub.db'), partial = new Database(path)
    // Existing parent tables are valid; only the transcript table was never
    // created. Unrelated malformed schemas are not silently reconstructed.
    const template = new Store(':memory:')
    const templateDb = (template as unknown as { db: Database }).db
    partial.exec((templateDb.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get() as { sql: string }).sql)
    template.close()
    partial.exec(`CREATE TABLE machines(id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, metadata TEXT, metadata_version INTEGER DEFAULT 1, runner_state TEXT,
        runner_state_version INTEGER DEFAULT 1, active INTEGER DEFAULT 0, active_at INTEGER, seq INTEGER DEFAULT 0);
        INSERT INTO machines(id,created_at,updated_at) VALUES('preserved',1,1);`)
    partial.close()
    const { store, a, db } = fixture(path)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 32 })
    expect(db.prepare('SELECT done FROM message_attachment_backfill').get()).toEqual({ done: 1 })
    expect(db.prepare('SELECT id FROM machines').get()).toEqual({ id: 'preserved' })
    expect(store.messages.hasAttachmentReference(a.id, 'absent')).toBe(false)
})

test('queued/imported/copied references are indexed, rewritten, moved and removed atomically', () => {
    const { store, a, b, db } = fixture()
    const queued = store.messages.addMessage(a.id, message('queued-original'), 'queued')
    expect(store.messages.hasAttachmentReference(a.id, 'queued-original')).toBe(true)
    store.messages.updateMessageContent(queued.id, message('replacement'))
    expect(store.messages.hasAttachmentReference(a.id, 'queued-original')).toBe(false)
    expect(store.messages.hasAttachmentReference(a.id, 'replacement')).toBe(true)
    const imported = store.messages.addImportedMessage(a.id, message('archive-original'), 'imported', Date.now()).message
    store.messages.copyMessageToSession(b.id, imported)
    expect(store.messages.referencedAttachmentIds(b.id)).toEqual(['archive-original'])
    expect(() => db.transaction(() => { store.messages.updateMessageContent(queued.id, message('rollback')); throw Error('rollback') })()).toThrow('rollback')
    expect(store.messages.hasAttachmentReference(a.id, 'replacement')).toBe(true)
    expect(store.messages.hasAttachmentReference(a.id, 'rollback')).toBe(false)
    store.messages.mergeSessionMessages(a.id, b.id)
    expect(store.messages.referencedAttachmentIds(a.id)).toEqual([])
    expect(store.messages.referencedAttachmentIds(b.id).sort()).toEqual(['archive-original', 'replacement'])
    db.prepare('DELETE FROM messages WHERE session_id=?').run(b.id)
    expect(store.messages.referencedAttachmentIds(b.id)).toEqual([])
})

test('reference checks use the covering index without decoding a 50k-row transcript', () => {
    const { store, a, db } = fixture()
    store.messages.addMessage(a.id, message('kept'))
    db.transaction(() => {
        const insert = db.prepare('INSERT INTO messages(id,session_id,content,created_at,seq,invoked_at) VALUES(?,?,?,1,?,1)')
        for (let i = 0; i < 50_000; i++) insert.run(`raw-${i}`, a.id, new Uint8Array([255, 0, 3]), i + 2)
    })()
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM message_attachment_refs WHERE session_id=? AND attachment_id=? LIMIT 1').all(a.id, 'kept')
    expect(JSON.stringify(plan)).toContain('idx_attachment_refs_session')
    const started = performance.now()
    for (let i = 0; i < 100; i++) {
        expect(store.messages.hasAttachmentReference(a.id, 'kept')).toBe(true)
        expect(store.messages.hasAttachmentReference(a.id, 'absent')).toBe(false)
    }
    expect(store.messages.referencedAttachmentIds(a.id)).toEqual(['kept'])
    expect(performance.now() - started).toBeLessThan(1000)
})

test('fork iteration closes its SQLite page before yielding and rejects a changed source epoch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refs-fork-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const { store, a, db } = fixture(join(dir, 'hub.db'))
    store.messages.addMessage(a.id, message('first'))
    store.messages.addMessage(a.id, { role: 'agent', content: { type: 'message', message: 'No attachment' } })
    store.messages.addMessage(a.id, message('second'))
    const iterator = store.messages.iterateForkAttachmentMessages(a.id)[Symbol.iterator]()
    expect(iterator.next().value?.content).toEqual(message('first'))
    await Promise.resolve()
    expect(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)')).not.toThrow()
    store.messages.bumpMessageEpoch(a.id)
    expect(() => iterator.next()).toThrow('source history changed')
})

test('v31 upgrade backfills bounded pages, survives reopen, and refuses unsafe deletion during indexing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'refs-upgrade-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'hub.db'), old = fixture(path)
    for (let i = 0; i < 110; i++) old.store.messages.addMessage(old.a.id, message(`old-${i}`))
    old.db.exec('DROP TRIGGER attachment_refs_session_move; DROP TABLE message_attachment_refs; DROP TABLE message_attachment_backfill; PRAGMA user_version=31')
    old.store.close()
    const upgraded = fixture(path)
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 32 })
    expect(() => upgraded.store.messages.hasAttachmentReference(old.a.id, 'old-109')).toThrow('being indexed')
    upgraded.store.close()
    const reopened = fixture(path)
    while (processAttachmentRefBackfill(reopened.db)) { /* finish persisted bounded pages */ }
    expect(reopened.store.messages.hasAttachmentReference(old.a.id, 'old-109')).toBe(true)
    expect(reopened.store.messages.referencedAttachmentIds(old.a.id)).toHaveLength(110)
})
