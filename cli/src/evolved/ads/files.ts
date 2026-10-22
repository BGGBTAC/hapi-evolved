/**
 * Project-scoped file boundary of `hapi evolved ads` (Linux only, the supported runtime).
 *
 * Every user path is relative and validated segment by segment. Each directory is opened from `/` one component at a
 * time with O_DIRECTORY|O_NOFOLLOW relative to the descriptor of its already opened parent (via /proc/self/fd/<fd>/<name>),
 * and all final I/O happens on a single leaf name inside the held directory descriptor. Replacing a path component by a
 * symbolic link (or renaming a validated directory away) therefore cannot redirect a read or write to another target.
 * Reads open the leaf O_NOFOLLOW|O_NONBLOCK, require a regular file within the bound, compare the inode and reject short
 * reads, growth or changes during the read. Writes create a private temporary file and publish it with link() (never
 * overwriting), all relative to the held directory. Without Linux /proc these operations fail closed.
 *
 * Not covered: another process of the same user can still modify a file's contents in place or move a held directory
 * elsewhere; the operation then acts on that same directory inode, never on a different path target.
 */
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, normalize } from 'node:path'
import { CLAUDE_ADS_ARTIFACTS_DIRECTORY } from '@hapi/protocol/bundledPlugins'

export class AdsUsageError extends Error {}
export const fail = (message: string): never => { throw new AdsUsageError(message) }

const SEGMENT = /^[A-Za-z0-9_+@.][A-Za-z0-9 _.+@-]{0,127}$/
const SYSTEM = /^\/(?:etc|usr|bin|sbin|lib|lib64|proc|sys|dev|boot|var|opt|app|runner)(?:\/|$)/
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** Relative path without traversal, hidden option-like segments, control characters or backslashes. */
export function relativePath(value: string, label: string): string {
    if (!value || value.length > 512 || isAbsolute(value) || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} must be a relative path`)
    const segments = value.split('/')
    if (segments.some(segment => segment === '.' || segment === '..' || !SEGMENT.test(segment) || segment.endsWith(' '))) fail(`${label} must be a relative path without "..", empty or option-like segments`)
    return segments.join('/')
}

/**
 * The project root: explicit --project-root or EVOLVED_RUNNER_ROOT. Any canonical absolute path (spaces, Unicode and
 * `@` are fine) without control characters, equal to its realpath, an existing directory and not a system directory.
 */
export function adsProjectRoot(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
    const value = explicit ?? env.EVOLVED_RUNNER_ROOT
    if (!value) return fail('Project folder unknown: run inside a HAPI runner (EVOLVED_RUNNER_ROOT) or pass --project-root <absolute folder>.')
    if (!isAbsolute(value) || normalize(value) !== value || value === '/' || value.endsWith('/') || value.length > 4096 || CONTROL.test(value)) fail('--project-root must be a canonical absolute path without control characters')
    if (SYSTEM.test(value)) fail('System directories cannot be project folders')
    let real: string
    try { real = realpathSync(value) } catch { return fail('The project folder does not exist') }
    if (real !== value) fail('The project folder must not contain symbolic links')
    if (!statSync(real).isDirectory()) fail('The project folder is not a directory')
    return real
}

// ------------------------------------------------------------------ pinned directory descriptors

const PROC_FD = '/proc/self/fd'
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
let procChecked = false
function requireProc(): void {
    if (procChecked) return
    if (process.platform !== 'linux' || !existsSync(`${PROC_FD}/0`) && !existsSync(PROC_FD)) fail('Claude Ads file operations need Linux with /proc (the supported runtime); refusing an insecure fallback.')
    procChecked = true
}
/** Path of a single name inside a held directory descriptor. */
const at = (fd: number, name: string) => `${PROC_FD}/${fd}/${name}`
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code

function openChild(parent: number, name: string, create: boolean, label: string): number | null {
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return openSync(at(parent, name), DIRECTORY_FLAGS) } catch (error) {
            const reason = code(error)
            if (reason === 'ELOOP' || reason === 'ENOTDIR') return fail(`Not a plain directory (symbolic links are not followed): ${label}`)
            if (reason !== 'ENOENT') throw error
            if (!create) return null
            try { mkdirSync(at(parent, name), { mode: 0o700 }) } catch (inner) { if (code(inner) !== 'EEXIST') throw inner }
        }
    }
    return fail(`Directory could not be opened: ${label}`)
}

/**
 * Runs `use` with a held descriptor of `base/relDir`, opened component by component from `/`. Only the `relDir`
 * components may be created (writes). Returns null when a component is missing and `create` is false.
 */
function withDirectory<T>(base: string, relDir: readonly string[], create: boolean, use: (fd: number) => T): T | null {
    requireProc()
    const baseSegments = base.split('/').filter(Boolean)
    let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY)
    try {
        const steps = [...baseSegments.map(name => ({ name, create: false })), ...relDir.map(name => ({ name, create }))]
        for (const step of steps) {
            const next = openChild(fd, step.name, step.create, [...relDir].join('/') || base)
            closeSync(fd); fd = -1
            if (next === null) return null
            fd = next
        }
        return use(fd)
    } finally { if (fd >= 0) closeSync(fd) }
}
const split = (rel: string) => { const parts = rel.split('/'); return { directory: parts.slice(0, -1), leaf: parts.at(-1)! } }

export type BelowKind = 'missing' | 'file' | 'directory' | 'other'
/** Kind and size of `rel` below `base` without following any symbolic link (a symlinked component is an error). */
export function statBelow(base: string, rel: string): { kind: BelowKind; size: number } {
    const { directory, leaf } = split(rel)
    const result = withDirectory(base, directory, false, fd => {
        let stat
        try { stat = lstatSync(at(fd, leaf)) } catch (error) { if (code(error) === 'ENOENT') return { kind: 'missing' as const, size: 0 }; throw error }
        if (stat.isSymbolicLink()) return fail(`Symbolic links are not followed: ${rel}`)
        return { kind: stat.isFile() ? 'file' as const : stat.isDirectory() ? 'directory' as const : 'other' as const, size: stat.size }
    })
    return result ?? { kind: 'missing', size: 0 }
}

/** Workspace = project root or a directory below it (e.g. a repository checkout), given absolute or project-relative. */
export function adsWorkspace(projectRoot: string, value: string | undefined): string {
    if (value === undefined) return projectRoot
    const rel = isAbsolute(value)
        ? (normalize(value) === projectRoot ? '' : normalize(value).startsWith(`${projectRoot}/`) ? normalize(value).slice(projectRoot.length + 1) : fail('--workspace must be the project folder or a folder inside it'))
        : relativePath(value, '--workspace')
    if (!rel) return projectRoot
    const checked = relativePath(rel, '--workspace')
    if (statBelow(projectRoot, checked).kind !== 'directory') fail('--workspace does not exist or is not a directory')
    return join(projectRoot, checked)
}

/**
 * Workspace of a call: an explicit --workspace wins; otherwise the caller's physical working directory when it is the
 * project folder or inside it (a HAPI session started in a bound checkout runs there, and that is where Claude Code and
 * Codex discover project skills); a working directory outside the project falls back to the project folder.
 */
export function adsSessionWorkspace(projectRoot: string, explicit: string | undefined, cwd: string): { path: string; source: 'explicit' | 'cwd' | 'project_root' } {
    if (explicit !== undefined) return { path: adsWorkspace(projectRoot, explicit), source: 'explicit' }
    let physical: string
    try { physical = realpathSync(cwd) } catch { return { path: projectRoot, source: 'project_root' } }
    if (physical !== projectRoot && !physical.startsWith(`${projectRoot}/`)) return { path: projectRoot, source: 'project_root' }
    return { path: adsWorkspace(projectRoot, physical), source: 'cwd' }
}

/** Resolves an input path: `.hapi/.cache/artifacts/ads/...` against the project root, anything else against the workspace. */
export function inputPath(projectRoot: string, workspace: string, value: string, label: string): { base: string; rel: string } {
    const rel = relativePath(value, label)
    return rel.startsWith(`${CLAUDE_ADS_ARTIFACTS_DIRECTORY}/`) ? { base: projectRoot, rel } : { base: workspace, rel }
}

/**
 * Reads a regular file below `base` through the held parent descriptor: O_NOFOLLOW|O_NONBLOCK leaf, regular file within
 * `maxBytes`, same inode as checked, exactly the expected size (short reads, growth or changes are rejected).
 */
export function readInput(base: string, rel: string, maxBytes: number): Buffer {
    const { directory, leaf } = split(rel)
    const result = withDirectory(base, directory, false, dir => {
        let before
        try { before = lstatSync(at(dir, leaf)) } catch (error) { if (code(error) === 'ENOENT') return fail(`File not found: ${rel}`); throw error }
        if (before.isSymbolicLink()) fail(`Symbolic links are not followed: ${rel}`)
        if (!before.isFile()) fail(`Not a regular file: ${rel}`)
        if (before.size > maxBytes) fail(`File exceeds ${maxBytes} bytes: ${rel}`)
        let fd: number
        try { fd = openSync(at(dir, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
            if (code(error) === 'ELOOP') return fail(`Symbolic links are not followed: ${rel}`)
            throw error
        }
        try {
            const stat = fstatSync(fd)
            if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > maxBytes) fail(`File changed while reading: ${rel}`)
            const buffer = Buffer.alloc(stat.size)
            let offset = 0
            while (offset < buffer.length) {
                const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
                if (read <= 0) break
                offset += read
            }
            if (offset !== stat.size) fail(`File changed while reading (short read): ${rel}`)
            if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail(`File changed while reading (grew): ${rel}`)
            const after = fstatSync(fd)
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) fail(`File changed while reading: ${rel}`)
            return buffer
        } finally { closeSync(fd) }
    })
    return result ?? fail(`File not found: ${rel}`)
}

/**
 * Writes a new file below `base` (directories created 0700 as needed); an existing entry (file, symlink or directory)
 * is never replaced. The temporary file, the link and the cleanup all use the same held directory descriptor.
 */
export function writeNew(base: string, rel: string, data: string | Uint8Array): string {
    const { directory, leaf } = split(rel)
    const written = withDirectory(base, directory, true, dir => {
        try { lstatSync(at(dir, leaf)); fail(`Refusing to overwrite existing file: ${rel}`) } catch (error) { if (error instanceof AdsUsageError) throw error; if (code(error) !== 'ENOENT') throw error }
        const temp = `.${leaf}.${randomBytes(6).toString('hex')}.tmp`
        const fd = openSync(at(dir, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
            try { const bytes = Buffer.from(data); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset) } finally { closeSync(fd) }
            try { linkSync(at(dir, temp), at(dir, leaf)) } catch { fail(`Refusing to overwrite existing file: ${rel}`) }
        } finally { try { unlinkSync(at(dir, temp)) } catch { /* already gone */ } }
        return true
    })
    if (written === null) fail(`The project folder is no longer available: ${base}`)
    return join(base, rel)
}
