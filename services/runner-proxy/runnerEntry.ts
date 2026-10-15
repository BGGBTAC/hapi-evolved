import { spawn, spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { validRunnerRoot } from './workspace'

export type RunnerNamespace = { version: 1; bootId: string; pidNamespace: string }
const namespaceFile = '.runner-namespace.json'
const transientFiles = ['runner.state.json', 'runner.state.json.lock']
function requireSafe(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino }

export function currentRunnerNamespace(): RunnerNamespace {
    requireSafe(process.platform === 'linux', 'Supervised runner requires Linux')
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const namespace = statSync('/proc/self/ns/pid')
    requireSafe(/^[0-9a-f-]{36}$/.test(bootId), 'Linux boot identity unavailable')
    return { version: 1, bootId, pidNamespace: `${namespace.dev}:${namespace.ino}` }
}

function privateDirectory(path: string): void {
    const info = lstatSync(path)
    requireSafe(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o700
        && realpathSync(path) === path, 'Runner home must be a canonical private directory owned by the runner')
}
function ownedFile(path: string): Stats | undefined {
    let info: Stats
    try { info = lstatSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
    requireSafe(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.(), 'Unsafe runner metadata file')
    return info
}
function readNamespace(path: string): RunnerNamespace | undefined {
    const before = ownedFile(path)
    if (!before) return undefined
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const opened = fstatSync(fd)
        requireSafe(sameInode(before, opened) && opened.size <= 4096 && (opened.mode & 0o7777) === 0o600, 'Unsafe runner namespace marker')
        const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
        requireSafe(value && typeof value === 'object' && !Array.isArray(value), 'Invalid runner namespace marker')
        const record = value as Partial<RunnerNamespace>
        requireSafe(record.version === 1 && typeof record.bootId === 'string' && /^[0-9a-f-]{36}$/.test(record.bootId)
            && typeof record.pidNamespace === 'string' && /^\d+:\d+$/.test(record.pidNamespace), 'Invalid runner namespace marker')
        return record as RunnerNamespace
    } finally { closeSync(fd) }
}

/** Keep this descriptor open for the entire native runner lifetime. Never unlink its path. */
export function acquireRunnerHome(home: string) {
    privateDirectory(home)
    const lockPath = join(home, '.supervisor.lock')
    let fd: number
    try { fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        fd = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    }
    let closed = false
    const close = () => { if (!closed) { closed = true; closeSync(fd) } }
    try {
        const identity = fstatSync(fd), pathIdentity = ownedFile(lockPath)
        requireSafe(identity.isFile() && identity.uid === process.getuid?.() && identity.nlink === 1
            && (identity.mode & 0o7777) === 0o600 && pathIdentity && sameInode(identity, pathIdentity), 'Unsafe supervisor lock')
        // Child fd 3 shares this open-file description. flock exits, while this
        // process retains the kernel lock; the native CLI receives only stdio 0..2.
        const acquired = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
            stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000,
        })
        requireSafe(!acquired.error && acquired.status === 0, 'Runner home is already supervised or its kernel lock is unavailable')
        const assertOwnership = () => {
            const current = ownedFile(lockPath)
            requireSafe(!closed && current && sameInode(identity, current), 'Supervisor lock path changed')
        }
        return {
            close,
            prepare(scope: RunnerNamespace, allowLegacy: boolean): { reset: boolean } {
                assertOwnership()
                const stateHome = join(home, 'hapi')
                try { mkdirSync(stateHome, { mode: 0o700 }) } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                }
                privateDirectory(stateHome)
                const markerPath = join(stateHome, namespaceFile), previous = readNamespace(markerPath)
                const files = transientFiles.map(name => ({ path: join(stateHome, name), info: ownedFile(join(stateHome, name)) }))
                const sameNamespace = previous?.bootId === scope.bootId && previous.pidNamespace === scope.pidNamespace
                if (sameNamespace) return { reset: false }
                // Legacy PID-only files have no namespace information. Migration is
                // allowed only by the verified container PID1 entry, under this lock.
                requireSafe(previous || allowLegacy || files.every(file => !file.info), 'Legacy runner state requires verified supervised startup')
                for (const file of files) {
                    if (!file.info) continue
                    assertOwnership()
                    const current = ownedFile(file.path)
                    requireSafe(current && sameInode(file.info, current), 'Runner metadata changed during namespace handoff')
                    unlinkSync(file.path)
                }
                assertOwnership()
                const temporary = join(stateHome, `.runner-namespace.${randomUUID()}.tmp`)
                try {
                    writeFileSync(temporary, JSON.stringify(scope) + '\n', { mode: 0o600, flag: 'wx' })
                    renameSync(temporary, markerPath)
                } finally {
                    try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
                }
                return { reset: true }
            },
        }
    } catch (error) { close(); throw error }
}

async function main(): Promise<void> {
    requireSafe(process.getuid?.() !== 0 && process.env.HAPI_RUNNER_SUPERVISED === '1'
        && process.env.HAPI_HOME === '/runner/hapi', 'Unprivileged supervised runner entry required')
    const initArgs = readFileSync('/proc/1/cmdline', 'utf8').split('\0')
    requireSafe(initArgs.includes('/app/services/runner-proxy/supervisor.ts'), 'Expected container PID1 supervisor missing')
    const root = process.env.EVOLVED_RUNNER_ROOT
    requireSafe(root && validRunnerRoot(root, process.env.EVOLVED_PROJECT_ID ?? '') && realpathSync(root) === root, 'Canonical project root required')
    const guard = acquireRunnerHome('/runner')
    try {
        guard.prepare(currentRunnerNamespace(), true)
        await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['/app/cli/src/index.ts', 'runner', 'start-sync', '--workspace-root', root], {
                stdio: ['inherit', 'inherit', 'inherit'], env: process.env,
            })
            child.once('error', () => reject(new Error('Native runner could not start')))
            child.once('exit', code => { process.exitCode = code ?? 1; resolve() })
        })
    } finally { guard.close() }
}
if (import.meta.main) void main().catch(() => { console.error('Supervised runner entry refused: check private home, namespace and kernel lock'); process.exitCode = 1 })
