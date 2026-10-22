import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Deterministic race regressions for the Ads file boundary with real files. `node:fs` is wrapped only in this test
 * file (vitest isolates modules per file): a hook fires inside the production operation at the exact moment the
 * reviewer probes used, renaming the validated parent away and replacing it with a symlink to an outside directory,
 * or truncating the input after fstat.
 */
const hook = vi.hoisted(() => ({ open: null as null | ((path: string, flags: number) => void), read: null as null | (() => void) }))
vi.mock('node:fs', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
        ...real,
        openSync: (path: string, flags: number, mode?: number) => { hook.open?.(String(path), Number(flags)); return real.openSync(path, flags as never, mode) },
        readSync: (...args: Parameters<typeof real.readSync>) => { hook.read?.(); return (real.readSync as (...a: unknown[]) => number)(...args) },
    }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { adsProjectRoot, readInput, statBelow, writeNew } = await import('./files')

const directories: string[] = []
afterEach(() => { hook.open = null; hook.read = null; for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true }) })
function fixture() {
    const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hapi-ads-boundary-'))); directories.push(base)
    const root = join(base, 'project'), parent = join(root, 'folder'), outside = join(base, 'outside'), moved = join(root, 'held-original')
    fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(parent, 'input.json'), 'project input'); fs.writeFileSync(join(outside, 'input.json'), 'outside private synthetic input')
    let swapped = false
    const swap = () => { if (swapped) return; swapped = true; fs.renameSync(parent, moved); fs.symlinkSync(outside, parent) }
    return { root, parent, outside, moved, swap, swapped: () => swapped }
}

describe('parent directory swap during production I/O', () => {
    it('a read whose parent is replaced by a symlink right before the leaf open never returns outside bytes', () => {
        const t = fixture()
        hook.open = path => { if (/^\/proc\/self\/fd\/\d+\/input\.json$/.test(path)) t.swap() }
        let value: string | null = null, error: unknown = null
        try { value = readInput(t.root, 'folder/input.json', 1024).toString('utf8') } catch (caught) { error = caught }
        expect(t.swapped()).toBe(true)
        expect(fs.lstatSync(t.parent).isSymbolicLink()).toBe(true)
        expect(value).not.toBe('outside private synthetic input')
        // The held descriptor still names the original (renamed) directory: the project bytes are read.
        expect({ value, error }).toEqual({ value: 'project input', error: null })
    })
    it('a write whose parent is replaced by a symlink right before the temporary file is created never lands outside', () => {
        const t = fixture()
        hook.open = (_path, flags) => { if (flags & fs.constants.O_CREAT) t.swap() }
        writeNew(t.root, 'folder/report.json', 'project output')
        expect(t.swapped()).toBe(true)
        expect(fs.readdirSync(t.outside)).toEqual(['input.json'])
        expect(fs.readFileSync(join(t.moved, 'report.json'), 'utf8')).toBe('project output')
        expect(fs.readdirSync(t.moved).sort()).toEqual(['input.json', 'report.json'])
    })
    it('after a completed swap every later path operation refuses the symlinked component', () => {
        const t = fixture()
        t.swap()
        expect(() => readInput(t.root, 'folder/input.json', 1024)).toThrow(/symbolic links/i)
        expect(() => writeNew(t.root, 'folder/new.json', 'x')).toThrow(/symbolic links/i)
        expect(() => statBelow(t.root, 'folder/input.json')).toThrow(/symbolic links/i)
        expect(fs.readdirSync(t.outside)).toEqual(['input.json'])
    })
    it('fails when the project root disappears instead of reporting an unwritten output', () => {
        const t = fixture(), movedRoot = `${t.root}-moved`
        fs.renameSync(t.root, movedRoot)
        expect(() => writeNew(t.root, 'folder/report.json', 'project output')).toThrow(/project folder/i)
        expect(fs.readdirSync(join(movedRoot, 'folder'))).toEqual(['input.json'])
        expect(fs.existsSync(t.root)).toBe(false)
    })
})

describe('short reads', () => {
    it('rejects a real file truncated to valid JSON after fstat instead of returning a partial snapshot', () => {
        const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hapi-ads-short-'))); directories.push(base)
        const file = join(base, 'input.json')
        fs.writeFileSync(file, `{}${' '.repeat(100)}`)
        let injected = false
        hook.read = () => { if (!injected) { injected = true; fs.truncateSync(file, 2) } }
        expect(() => readInput(base, 'input.json', 1024)).toThrow(/changed while reading/)
        expect(injected).toBe(true)
        expect(fs.readFileSync(file, 'utf8')).toBe('{}')
    })
    it('rejects a file that grows while it is read', () => {
        const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hapi-ads-grow-'))); directories.push(base)
        const file = join(base, 'input.json')
        fs.writeFileSync(file, '{"a":1}')
        let injected = false
        hook.read = () => { if (!injected) { injected = true; fs.appendFileSync(file, ' ') } }
        expect(() => readInput(base, 'input.json', 1024)).toThrow(/changed while reading/)
    })
})

describe('project roots', () => {
    it('accepts ordinary absolute folders with spaces, Unicode and @, but no control characters or symlinks', () => {
        const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hapi-ads-root-'))); directories.push(base)
        const root = join(base, 'Ads Projekt ä@2026')
        fs.mkdirSync(join(root, 'exports'), { recursive: true }); fs.writeFileSync(join(root, 'exports', 'daten 1.csv'), 'x')
        expect(adsProjectRoot(root, {})).toBe(root)
        expect(readInput(root, 'exports/daten 1.csv', 10).toString()).toBe('x')
        expect(() => adsProjectRoot(`${root}\n`, {})).toThrow(/control/)
        expect(() => adsProjectRoot(`${base}/x\u0007y`, {})).toThrow(/control/)
        expect(() => adsProjectRoot(`${root}/`, {})).toThrow()
        expect(() => adsProjectRoot('relative/path', {})).toThrow()
        expect(() => adsProjectRoot('/var/tmp', {})).toThrow(/System/)
        fs.symlinkSync(root, join(base, 'link'))
        expect(() => adsProjectRoot(join(base, 'link'), {})).toThrow(/symbolic/)
    })
})
