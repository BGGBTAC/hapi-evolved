import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { excludedSourcePath, isSafeSourcePath } from '@hapi/protocol/evolvedSourcePolicy'

export type SafeReadFailure = 'missing' | 'symlink' | 'special' | 'too_large' | 'hardlink' | 'unsafe_path' | 'unavailable'
export type SafeRead = { ok: true; data: Buffer; size: number } | { ok: false; reason: SafeReadFailure }
export type EntryKind = 'file' | 'directory' | 'symlink' | 'special'
export type SafeEntry = { name: string; kind: EntryKind }

/**
 * Read-only, bounded access below one directory without following symlinks.
 * Every path component is checked with lstat; files are opened with O_NOFOLLOW
 * and O_NONBLOCK (a FIFO never blocks), must be regular, single-link files and
 * must keep the identity observed during the walk. This defends against
 * repository-controlled links/special files. It is not a boundary against a
 * concurrently running process of the same UID; the runner container is.
 */
export type SafeTreeLimits = { reads: number; bytes: number; entries: number; /** Absolute epoch ms after which no I/O starts. */ deadline?: number }

export class SafeTree {
    private budget: { reads: number; bytes: number; entries: number }
    private readonly deadline: number
    /** Set once the time budget stopped further I/O; results are then incomplete. */
    timedOut = false
    // Unique relative paths; bounded by the entry and read budgets.
    private readonly seenFiles = new Set<string>()
    private readonly seenDirectories = new Set<string>()
    private constructor(readonly root: string, private readonly rootStat: Stats, limits: SafeTreeLimits) {
        this.budget = { reads: limits.reads, bytes: limits.bytes, entries: limits.entries }
        this.deadline = limits.deadline ?? Number.POSITIVE_INFINITY
    }

    static async open(root: string, limits: SafeTreeLimits = { reads: 4000, bytes: 64 * 1024 * 1024, entries: 50_000 }): Promise<SafeTree | SafeReadFailure> {
        if (!isAbsolute(root) || normalize(root) !== root || root === '/' || root.endsWith('/')) return 'unsafe_path'
        const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' as const : 'unavailable' as const)
        if (typeof stat === 'string') return stat
        if (stat.isSymbolicLink()) return 'symlink'
        if (!stat.isDirectory()) return 'special'
        if (await realpath(root).catch(() => '') !== root) return 'unsafe_path'
        return new SafeTree(root, stat, limits)
    }

    /**
     * Unique regular files whose entry a successful list() returned or whose content read()
     * returned, and unique directories list() enumerated (the root included). stat()/kind()
     * metadata checks, failed reads, symbolic links, special files and source-policy excluded paths
     * (e.g. `.git`) are not counted; repeated reads or listings of a path count once.
     */
    get scanned(): { files: number; directories: number } { return { files: this.seenFiles.size, directories: this.seenDirectories.size } }

    private note(seen: Set<string>, relative: string) { if (relative === '' || !excludedSourcePath(relative)) seen.add(relative) }

    get exhausted(): boolean { return this.budget.reads <= 0 || this.budget.bytes <= 0 || this.budget.entries <= 0 || this.expired() }

    /** No new I/O starts after the deadline. */
    private expired(): boolean {
        if (!this.timedOut && Date.now() >= this.deadline) this.timedOut = true
        return this.timedOut
    }

    private absolute(relative: string): string { return relative === '' ? this.root : `${this.root}/${relative}` }

    /** lstat every component; returns the final stat or the reason it is unreachable. */
    async stat(relative: string): Promise<Stats | SafeReadFailure> {
        if (this.expired()) return 'unavailable'
        if (relative !== '' && !isSafeSourcePath(relative)) return 'unsafe_path'
        const parts = relative === '' ? [] : relative.split('/')
        let current = this.root
        const rootNow = await lstat(this.root).catch(() => null)
        if (!rootNow || !rootNow.isDirectory() || rootNow.dev !== this.rootStat.dev || rootNow.ino !== this.rootStat.ino) return 'unsafe_path'
        let stat: Stats = rootNow
        for (const [index, part] of parts.entries()) {
            current = `${current}/${part}`
            try { stat = await lstat(current) } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable'
            }
            if (stat.isSymbolicLink()) return 'symlink'
            if (index < parts.length - 1 && !stat.isDirectory()) return 'missing'
        }
        return stat
    }

    async kind(relative: string): Promise<EntryKind | 'missing' | 'unsafe_path' | 'unavailable'> {
        const stat = await this.stat(relative)
        if (stat === 'symlink') return 'symlink'
        if (typeof stat === 'string') return stat === 'missing' ? 'missing' : stat === 'unsafe_path' ? 'unsafe_path' : 'unavailable'
        return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'special'
    }

    async read(relative: string, maxBytes: number): Promise<SafeRead> {
        if (this.budget.reads <= 0 || this.budget.bytes <= 0 || this.expired()) return { ok: false, reason: this.timedOut ? 'unavailable' : 'too_large' }
        const before = await this.stat(relative)
        if (typeof before === 'string') return { ok: false, reason: before }
        if (!before.isFile()) return { ok: false, reason: 'special' }
        if (before.nlink !== 1) return { ok: false, reason: 'hardlink' }
        if (before.size > maxBytes) return { ok: false, reason: 'too_large' }
        this.budget.reads--
        let handle
        try {
            handle = await open(this.absolute(relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0))
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            return { ok: false, reason: code === 'ELOOP' ? 'symlink' : code === 'ENOENT' ? 'missing' : 'unavailable' }
        }
        try {
            const stat = await handle.stat()
            if (!stat.isFile()) return { ok: false, reason: 'special' }
            if (stat.dev !== before.dev || stat.ino !== before.ino) return { ok: false, reason: 'unsafe_path' }
            if (stat.nlink !== 1) return { ok: false, reason: 'hardlink' }
            if (stat.size > maxBytes) return { ok: false, reason: 'too_large' }
            const buffer = Buffer.alloc(Math.min(maxBytes, this.budget.bytes) + 1)
            let length = 0
            while (length < buffer.length) {
                const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
                if (bytesRead === 0) break
                length += bytesRead
            }
            if (length > maxBytes || length > this.budget.bytes) return { ok: false, reason: 'too_large' }
            this.budget.bytes -= length
            // The ancestors must still be the directories that were walked.
            const after = await this.stat(relative)
            if (typeof after === 'string' || after.dev !== before.dev || after.ino !== before.ino) return { ok: false, reason: 'unsafe_path' }
            this.note(this.seenFiles, relative)
            return { ok: true, data: buffer.subarray(0, length), size: length }
        } catch { return { ok: false, reason: 'unavailable' } } finally { await handle.close() }
    }

    /** UTF-8 text without NUL bytes; invalid encodings are rejected rather than replaced. */
    async readText(relative: string, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; reason: SafeReadFailure | 'binary' }> {
        const result = await this.read(relative, maxBytes)
        if (!result.ok) return result
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(result.data)
            if (text.includes('\u0000')) return { ok: false, reason: 'binary' }
            return { ok: true, text }
        } catch { return { ok: false, reason: 'binary' } }
    }

    /** Directory entries without following links, sorted, bounded. */
    async list(relative: string, max = 2000): Promise<{ entries: SafeEntry[]; truncated: boolean } | SafeReadFailure> {
        const stat = await this.stat(relative)
        if (typeof stat === 'string') return stat
        if (!stat.isDirectory()) return 'special'
        // Iterate the directory stream itself so huge directories are never read completely.
        const limit = Math.max(0, Math.min(max, this.budget.entries))
        const collected: SafeEntry[] = []
        let truncated = false
        let directory
        try { directory = await opendir(this.absolute(relative), { bufferSize: 64 }) } catch { return 'unavailable' }
        try {
            for (;;) {
                if (this.expired()) { truncated = true; break }
                const entry = await directory.read()
                if (!entry) break
                if (collected.length >= limit) { truncated = true; break }
                collected.push({ name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'special' })
            }
        } catch { return 'unavailable' } finally { await closeDirectory(directory) }
        this.budget.entries -= collected.length
        this.note(this.seenDirectories, relative)
        for (const entry of collected) if (entry.kind === 'file') this.note(this.seenFiles, joinRelative(relative, entry.name))
        const entries = collected.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
        return { entries, truncated }
    }
}

/** Node returns a promise, Bun may close synchronously or report an already closed handle; never throw. */
async function closeDirectory(directory: { close(): Promise<void> | void }): Promise<void> {
    try { await directory.close() } catch {}
}

export function joinRelative(...parts: string[]): string {
    return parts.filter(part => part !== '' && part !== '.').join('/')
}

export const readFailureText: Record<SafeReadFailure | 'binary', string> = {
    missing: 'fehlt',
    symlink: 'ist eine symbolische Verknüpfung und wird nicht gelesen',
    special: 'ist keine reguläre Datei',
    too_large: 'überschreitet die Größengrenze',
    hardlink: 'hat mehrere harte Verknüpfungen und wird nicht gelesen',
    unsafe_path: 'hat einen unsicheren oder veränderten Pfad',
    unavailable: 'ist nicht lesbar',
    binary: 'ist kein gültiger UTF-8-Text',
}
