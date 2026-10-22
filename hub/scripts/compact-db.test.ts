import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(withMessages: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'hapi-compact-permissions-'))
    roots.push(root)
    const source = join(root, 'source.db'), output = join(root, 'output.db')
    const db = new Database(source)
    db.exec('PRAGMA user_version=15; CREATE TABLE fixture_private(value TEXT);')
    db.prepare('INSERT INTO fixture_private VALUES(?)').run('synthetic-private-data')
    if (withMessages) db.exec('CREATE TABLE messages(content TEXT)')
    db.close()
    return { source, output }
}

function compact(source: string, output: string) {
    // Start with the normal permissive umask: the tool must protect every copy,
    // including snapshots left behind when transformation fails.
    const previous = process.umask(0o022)
    try {
        return Bun.spawnSync([process.execPath, join(import.meta.dir, 'compact-db.ts'), `--db=${source}`, `--out=${output}`], {
            stdout: 'pipe', stderr: 'pipe',
        })
    } finally { process.umask(previous) }
}

const posixTest = process.platform === 'win32' ? test.skip : test
posixTest('keeps a failed work snapshot private from its creation', () => {
    const { source, output } = fixture(false)
    const before = createHash('sha256').update(readFileSync(source)).digest('hex')
    expect(compact(source, output).exitCode).not.toBe(0)
    expect(statSync(`${output}.work`).mode & 0o777).toBe(0o600)
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(before)
})

posixTest('produces a private valid compacted copy without modifying source', () => {
    const { source, output } = fixture(true)
    const before = createHash('sha256').update(readFileSync(source)).digest('hex')
    expect(compact(source, output).exitCode).toBe(0)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    const db = new Database(output, { readonly: true })
    try { expect(db.prepare('SELECT value FROM fixture_private').get()).toEqual({ value: 'synthetic-private-data' }) }
    finally { db.close() }
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(before)
})
