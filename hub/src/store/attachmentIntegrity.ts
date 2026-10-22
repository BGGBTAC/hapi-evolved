import { Database } from 'bun:sqlite'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

type AttachmentRow = { row_id: string; id: unknown; original_path: unknown; size: unknown; sha256: unknown }
export type AttachmentIntegrityKind = 'missingFile' | 'sizeMismatch' | 'hashMismatch' | 'invalidPath' | 'symlink' | 'notRegularFile' | 'readError' | 'orphanFile' | 'unexpectedDirectory' | 'pendingDeletion' | 'pendingDeletionMissing' | 'staleDeletionJournal'
export type AttachmentIntegrityReport = {
    ok: boolean; checkedRows: number; checkedFiles: number; pendingJournalRows: number
    counts: Partial<Record<AttachmentIntegrityKind, number>>
    samples: Array<{ kind: AttachmentIntegrityKind; path: string; attachmentId?: string; expected?: boolean }>
    samplesTruncated: boolean
}

/** Offline only: caller must stop every writer before restoring or running this audit.
 * No Store constructor, migration, repair, deletion or checkpoint is performed.
 * Linux directory-fd anchoring prevents a renamed/symlinked root from escaping.
 */
export async function checkAttachmentIntegrity(databasePath: string, attachmentRoot: string): Promise<AttachmentIntegrityReport> {
    if (!isAbsolute(databasePath) || !isAbsolute(attachmentRoot)) throw new Error('Database and attachment root must be absolute paths')
    if (process.platform !== 'linux') throw new Error('This no-follow offline auditor requires Linux /proc/self/fd')
    const root = resolve(attachmentRoot)
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('Attachment root must be a canonical directory without symlinks')
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    // An ancestor may have been swapped between realpath() and open(); trust only the opened inode.
    if (await realpath(`/proc/self/fd/${directory.fd}`).catch(() => null) !== root) {
        await directory.close()
        throw new Error('Attachment root must be a canonical directory without symlinks')
    }
    let db: Database | undefined
    const report: AttachmentIntegrityReport = { ok: true, checkedRows: 0, checkedFiles: 0, pendingJournalRows: 0, counts: {}, samples: [], samplesTruncated: false }
    const record = (kind: AttachmentIntegrityKind, path: string, attachmentId?: string, expected = false) => {
        report.counts[kind] = (report.counts[kind] ?? 0) + 1
        if (!expected) report.ok = false
        if (report.samples.length < 100) report.samples.push({ kind, path, ...(attachmentId ? { attachmentId } : {}), ...(expected ? { expected } : {}) })
        else report.samplesTruncated = true
    }
    const anchoredRoot = `/proc/self/fd/${directory.fd}`
    const safePath = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && dirname(path) === root && resolve(path) === path && !path.includes('\0')
    try {
        db = new Database(databasePath, { readonly: true, strict: true })
        db.exec('PRAGMA query_only=ON')
        db.exec('BEGIN')
        const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        if (!table.get('attachments') || !table.get('attachment_deletions')) throw new Error('Attachment schema is absent; this read-only tool does not migrate databases')
        const rows = db.query<AttachmentRow, [string | null, string | null, number]>('SELECT CAST(rowid AS TEXT) AS row_id,id,original_path,size,sha256 FROM attachments WHERE (? IS NULL OR rowid>CAST(? AS INTEGER)) ORDER BY rowid LIMIT ?')
        let cursor: string | null = null
        for (;;) {
            const page = rows.all(cursor, cursor, 250)
            if (!page.length) break
            for (const row of page) {
                report.checkedRows++
                cursor = row.row_id
                if (typeof row.id !== 'string' || !Number.isSafeInteger(row.size) || Number(row.size) < 0 || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
                    || !safePath(row.original_path) || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || basename(row.original_path) !== `${row.id}.original`) {
                    record('invalidPath', typeof row.original_path === 'string' ? row.original_path : '<invalid non-text path>', typeof row.id === 'string' ? row.id : undefined); continue
                }
                const path = join(anchoredRoot, basename(row.original_path))
                let file: Awaited<ReturnType<typeof open>> | undefined
                try {
                    const stat = await lstat(path)
                    if (stat.isSymbolicLink()) { record('symlink', row.original_path, row.id); continue }
                    if (!stat.isFile()) { record('notRegularFile', row.original_path, row.id); continue }
                    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
                    const opened = await file.stat()
                    if (!opened.isFile()) { record('notRegularFile', row.original_path, row.id); continue }
                    if (opened.nlink !== 1) { record('invalidPath', row.original_path, row.id); continue }
                    if (opened.size !== row.size) record('sizeMismatch', row.original_path, row.id)
                    const hash = createHash('sha256')
                    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) hash.update(chunk)
                    if (hash.digest('hex') !== row.sha256) record('hashMismatch', row.original_path, row.id)
                    report.checkedFiles++
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code
                    record(code === 'ENOENT' ? 'missingFile' : code === 'ELOOP' ? 'symlink' : 'readError', row.original_path, row.id)
                } finally { await file?.close() }
            }
        }
        const pending = db.query<{ row_id: string; original_path: unknown }, [string | null, string | null, number]>('SELECT CAST(rowid AS TEXT) AS row_id,original_path FROM attachment_deletions WHERE (? IS NULL OR rowid>CAST(? AS INTEGER)) ORDER BY rowid LIMIT ?')
        const owner = db.query<{ original_path: string }, [string]>('SELECT original_path FROM attachments WHERE id=?')
        const tombstone = db.query('SELECT 1 FROM attachment_deletions WHERE original_path=?')
        cursor = null
        for (;;) {
            const page = pending.all(cursor, cursor, 250)
            if (!page.length) break
            for (const row of page) {
                cursor = row.row_id; report.pendingJournalRows++
                if (!safePath(row.original_path)) { record('invalidPath', typeof row.original_path === 'string' ? row.original_path : '<invalid non-text path>'); continue }
                const id = basename(row.original_path).replace(/\.original$/, '')
                if (owner.get(id)?.original_path === row.original_path) { record('staleDeletionJournal', row.original_path, id, true); continue }
                try {
                    const stat = await lstat(join(anchoredRoot, basename(row.original_path)))
                    if (stat.isSymbolicLink()) record('symlink', row.original_path)
                    else if (!stat.isFile()) record('notRegularFile', row.original_path)
                    else record('pendingDeletion', row.original_path, undefined, true)
                } catch (error) { record((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'pendingDeletionMissing' : 'readError', row.original_path, undefined, (error as NodeJS.ErrnoException).code === 'ENOENT') }
            }
        }
        const entries = await opendir(anchoredRoot)
        for await (const entry of entries) {
            const path = join(root, entry.name)
            const id = entry.name.replace(/\.original$/, '')
            if (owner.get(id)?.original_path === path || tombstone.get(path)) continue
            if (entry.isSymbolicLink()) record('symlink', path)
            else if (entry.isDirectory()) record('unexpectedDirectory', path)
            else if (!entry.isFile()) record('notRegularFile', path)
            else record('orphanFile', path)
        }
        return report
    } finally {
        try {
            if (db) {
                try { if (db.inTransaction) db.exec('ROLLBACK') } catch { /* preserve the original audit/IO error */ }
                finally { db.close() }
            }
        } finally { await directory.close() }
    }
}
