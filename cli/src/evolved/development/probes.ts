import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, opendir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

/** System directories only. PATH, the project and the user's home are never searched. */
export const TRUSTED_BIN_DIRECTORIES = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'] as const

export type TrustedExecutable = { path: string; resolved: string }
export type ProbeOutput = { ok: true; code: number | null; stdout: string; stderr: string } | { ok: false; reason: 'timeout' | 'spawn_failed' | 'output_limit' }

/** Fixed, minimal environment: no credentials, proxies, NODE_OPTIONS/JAVA_TOOL_OPTIONS/PYTHON* injection. */
export const PROBE_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent', TERM: 'dumb' })

export type ProbeSystem = {
    platform: NodeJS.Platform
    arch: string
    uid: number | null
    /** Owner check of executables and their directories (root, not group/other writable). */
    trusted: (path: string) => Promise<TrustedExecutable | null>
    run: (executable: TrustedExecutable, argv: readonly string[], options?: { timeoutMs?: number; maxBytes?: number }) => Promise<ProbeOutput>
    exists: (path: string) => Promise<'file' | 'directory' | 'char' | 'other' | 'missing'>
    accessible: (path: string, mode: number) => Promise<boolean>
    list: (path: string) => Promise<string[]>
}

/** Owner IDs accepted as "system": root, or the kernel overflow UID under which an unmapped root appears in user namespaces. */
let systemOwners: Promise<Set<number>> | null = null
function trustedOwners(): Promise<Set<number>> {
    systemOwners ??= readFile('/proc/sys/fs/overflowuid', 'utf8').then(value => new Set([0, Number(value.trim())].filter(Number.isInteger)), () => new Set([0, 65534]))
    return systemOwners
}

async function rootOwnedChain(path: string): Promise<boolean> {
    const owners = await trustedOwners(), self = process.getuid?.() ?? -1
    let current = path
    for (let depth = 0; depth < 32; depth++) {
        const info = await lstat(current).catch(() => null)
        if (!info || info.isSymbolicLink() || !owners.has(info.uid) || info.uid === self || (info.mode & 0o022) !== 0) return false
        // Group membership or ACLs must not let this process replace the file or directory entry.
        if (self !== 0 && await access(current, constants.W_OK).then(() => true, () => false)) return false
        if (current === '/') return true
        current = dirname(current)
    }
    return false
}

/**
 * Resolve an absolute candidate to a root-owned regular executable whose whole
 * directory chain is root-owned and not group/world writable.
 */
export async function trustedExecutable(path: string): Promise<TrustedExecutable | null> {
    if (!isAbsolute(path)) return null
    const resolved = await realpath(path).catch(() => null)
    if (!resolved) return null
    const info = await stat(resolved).catch(() => null)
    if (!info?.isFile() || (info.mode & 0o111) === 0) return null
    if (!await rootOwnedChain(resolved)) return null
    // The link itself and its directory must be equally trusted.
    if (resolved !== path) {
        const linkDirectory = await realpath(dirname(path)).catch(() => null)
        if (!linkDirectory || !await rootOwnedChain(linkDirectory)) return null
    }
    return { path, resolved }
}

export async function runProbe(executable: TrustedExecutable, argv: readonly string[], options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ProbeOutput> {
    const timeoutMs = options.timeoutMs ?? 4000, maxBytes = options.maxBytes ?? 16 * 1024
    return new Promise(resolve => {
        let child
        try {
            child = spawn(executable.path, argv, { cwd: '/', env: { ...PROBE_ENVIRONMENT }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: false })
        } catch { resolve({ ok: false, reason: 'spawn_failed' }); return }
        const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
        let bytes = 0, settled = false
        const finish = (value: ProbeOutput) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, reason: 'timeout' }) }, timeoutMs)
        const collect = (key: 'stdout' | 'stderr') => (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > maxBytes) { child.kill('SIGKILL'); finish({ ok: false, reason: 'output_limit' }); return }
            chunks[key].push(chunk)
        }
        child.stdout.on('data', collect('stdout'))
        child.stderr.on('data', collect('stderr'))
        child.on('error', () => finish({ ok: false, reason: 'spawn_failed' }))
        child.on('close', code => finish({ ok: true, code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') }))
    })
}

export function createProbeSystem(): ProbeSystem {
    return {
        platform: process.platform,
        arch: process.arch,
        uid: process.getuid?.() ?? null,
        trusted: trustedExecutable,
        run: runProbe,
        exists: async path => {
            const info = await lstat(path).catch(() => null)
            if (!info) return 'missing'
            if (info.isSymbolicLink()) {
                const target = await stat(path).catch(() => null)
                return !target ? 'missing' : target.isFile() ? 'file' : target.isDirectory() ? 'directory' : target.isCharacterDevice() ? 'char' : 'other'
            }
            return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isCharacterDevice() ? 'char' : 'other'
        },
        accessible: async (path, mode) => access(path, mode).then(() => true, () => false),
        list: async path => boundedNames(path, 200),
    }
}

/** Find a named tool in trusted system directories (and fixed extra system directories). */
/** First `max` names of a directory, read incrementally (never the whole directory). */
export async function boundedNames(path: string, max: number): Promise<string[]> {
    const names: string[] = []
    let directory
    try { directory = await opendir(path, { bufferSize: 32 }) } catch { return names }
    try {
        for (let entry = await directory.read(); entry && names.length < max; entry = await directory.read()) names.push(entry.name)
    } catch {} finally { try { await directory.close() } catch {} }
    return names.sort()
}

export async function findTrusted(system: ProbeSystem, name: string, extraDirectories: readonly string[] = []): Promise<TrustedExecutable | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name)) return null
    for (const directory of [...TRUSTED_BIN_DIRECTORIES, ...extraDirectories]) {
        const found = await system.trusted(`${directory}/${name}`)
        if (found) return found
    }
    return null
}

/** First meaningful output line, without control characters, bounded. */
export function firstLine(output: string, max = 120): string {
    const line = output.split(/\r?\n/).map(value => value.trim()).find(Boolean) ?? ''
    return line.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
}

export function parseVersion(value: string): number[] | null {
    const match = /([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/.exec(value)
    return match ? match.slice(1).filter(part => part !== undefined).map(Number) : null
}

export function compareVersions(left: readonly number[], right: readonly number[]): number {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0)
        if (difference) return difference
    }
    return 0
}

export const ACCESS = constants
