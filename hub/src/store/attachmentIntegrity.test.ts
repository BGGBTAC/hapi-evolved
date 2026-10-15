import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, link, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { checkAttachmentIntegrity } from './attachmentIntegrity'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'hapi-attachment-audit-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const root = join(home, 'attachments'); await mkdir(root)
    const path = join(home, 'hapi.db'), db = new Database(path)
    db.exec('CREATE TABLE attachments(id TEXT PRIMARY KEY, original_path TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL); CREATE TABLE attachment_deletions(original_path TEXT PRIMARY KEY); PRAGMA user_version=31')
    const add = (id: string, content = 'original', location = join(root, `${id}.original`)) => db.query('INSERT INTO attachments VALUES(?,?,?,?)').run(id, location, Buffer.byteLength(content), createHash('sha256').update(content).digest('hex'))
    return { home, root, path, db, add }
}
describe('read-only offline attachment restore audit', () => {
    it('accepts consistent data and expected pending deletion without changing DB or files', async () => {
        const f = await fixture(); f.add('good'); await writeFile(join(f.root, 'good.original'), 'original')
        await writeFile(join(f.root, 'pending.original'), 'pending')
        f.db.query('INSERT INTO attachment_deletions VALUES(?),(?)').run(join(f.root, 'pending.original'), join(f.root, 'already-deleted.original'))
        f.db.close(); const before = await readFile(f.path)
        const result = await checkAttachmentIntegrity(f.path, f.root)
        expect(result).toMatchObject({ ok: true, checkedRows: 1, checkedFiles: 1, pendingJournalRows: 2, counts: { pendingDeletion: 1, pendingDeletionMissing: 1 } })
        expect(await readFile(f.path)).toEqual(before)
        expect(await readFile(join(f.root, 'pending.original'), 'utf8')).toBe('pending')
    })
    it('finds missing, corrupt, orphan and unsafe paths without following symlinks', async () => {
        const f = await fixture(); f.add('missing'); f.add('wrong'); f.add('linked'); f.add('hardlinked'); f.add('outside', 'private', join(f.home, 'private'))
        await writeFile(join(f.root, 'wrong.original'), 'corrupted and larger')
        await writeFile(join(f.home, 'private'), 'private'); await symlink(join(f.home, 'private'), join(f.root, 'linked.original')); await link(join(f.home, 'private'), join(f.root, 'hardlinked.original'))
        await writeFile(join(f.root, 'orphan.original'), 'orphan'); await mkdir(join(f.root, 'unexpected'))
        f.db.close()
        const result = await checkAttachmentIntegrity(f.path, f.root)
        expect(result).toMatchObject({ ok: false, checkedFiles: 1, counts: { missingFile: 1, sizeMismatch: 1, hashMismatch: 1, symlink: 1, invalidPath: 2, orphanFile: 1, unexpectedDirectory: 1 } })
        expect(await readFile(join(f.home, 'private'), 'utf8')).toBe('private')
    })
    it('pages the full ledger including invalid empty IDs without materializing it all', async () => {
        const f = await fixture()
        for (let n = 0; n < 301; n++) f.add(`missing-${n}`)
        f.add(''); f.db.query('INSERT INTO attachment_deletions VALUES(?)').run(''); f.db.close()
        const report = await checkAttachmentIntegrity(f.path, f.root)
        expect(report.checkedRows).toBe(302); expect(report.pendingJournalRows).toBe(1)
        expect(report.counts.missingFile).toBe(301); expect(report.counts.invalidPath).toBe(2)
        expect(report.samples).toHaveLength(100)
    })
    it('handles corrupt NULL and numeric keys without looping or skipping rows', async () => {
        const f = await fixture()
        f.db.exec('DROP TABLE attachments; DROP TABLE attachment_deletions; CREATE TABLE attachments(id,original_path,size,sha256); CREATE TABLE attachment_deletions(original_path)')
        const insert = f.db.query('INSERT INTO attachments VALUES(?,?,?,?)')
        for (let n = 0; n < 300; n++) insert.run(null, null, 1, 'bad')
        insert.run(42, 123, -1, null)
        f.db.query('INSERT INTO attachment_deletions VALUES(NULL),(42)').run()
        f.db.close()
        const report = await checkAttachmentIntegrity(f.path, f.root)
        expect(report.checkedRows).toBe(301); expect(report.pendingJournalRows).toBe(2)
        expect(report.counts.invalidPath).toBe(303); expect(report.samples).toHaveLength(100)
    })
    it('CLI returns reviewable JSON and a failure exit status without mutating an inconsistent restore', async () => {
        const f = await fixture(); f.add('missing'); f.db.close()
        const before = await readFile(f.path)
        const script = fileURLToPath(new URL('../../scripts/check-restored-attachments.ts', import.meta.url))
        const child = Bun.spawn([process.execPath, script, f.path, f.root], { stdout: 'pipe', stderr: 'pipe' })
        const output = await new Response(child.stdout).text()
        expect(await child.exited).toBe(1)
        expect(JSON.parse(output)).toMatchObject({ ok: false, counts: { missingFile: 1 } })
        expect(await readFile(f.path)).toEqual(before)
    })
    it('bounds report samples and rejects relative or symlinked roots', async () => {
        const f = await fixture()
        await Promise.all(Array.from({ length: 105 }, (_, n) => writeFile(join(f.root, `${n}.original`), 'orphan'))); f.db.close()
        const result = await checkAttachmentIntegrity(f.path, f.root)
        expect(result.counts.orphanFile).toBe(105); expect(result.samples).toHaveLength(100); expect(result.samplesTruncated).toBe(true)
        await expect(checkAttachmentIntegrity('relative.db', f.root)).rejects.toThrow('absolute')
        await symlink(f.root, join(f.home, 'alias'))
        await expect(checkAttachmentIntegrity(f.path, join(f.home, 'alias'))).rejects.toThrow('symlinks')
    })
})
