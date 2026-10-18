import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { containsCredential, excludedSourcePath, isSafeSourcePath } from '@hapi/protocol/evolvedSourcePolicy'
import { RepoDiffRequestSchema, type RepoDiff, type RepoDiffRequest, type RepoFileStatus, type RepoWorktree } from '@hapi/protocol/evolvedWorkspace'

export type WorkspaceRepository = { id: string; owner: string; name: string; fullName: string; cloneUrl: string; path: string }
export type RepositoryLocal = { state: 'missing' | 'ready' | 'blocked' | 'unknown'; branch: string | null; dirty: boolean | null; message?: string }
const messages = {
    invalid_repository: 'Die Repositorydaten oder der Projektpfad sind ungültig.',
    unsafe_path: 'Der Repositorypfad wurde verändert oder enthält eine Verknüpfung. Bitte den Ordner prüfen.',
    unavailable: 'Der Projektordner oder Repositorystatus ist nicht verfügbar.',
    exists: 'Der Zielordner existiert bereits. Vorhandene Dateien werden nicht überschrieben.',
    missing: 'Das Repository wurde noch nicht in diesen Projektordner geklont.',
    configuration: 'Die lokale Git-Konfiguration wird für automatische Aktionen nicht unterstützt. Bitte mit Git prüfen.',
    incomplete: 'Der Zielordner enthält keinen vollständigen Git-Checkout. Bitte vorhandene Dateien sichern und den Ordner mit Git prüfen; er wird nicht automatisch gelöscht.',
    detached: 'Das Repository hat keinen aktiven Branch. Bitte zuerst mit Git einen Branch wählen.',
    unborn: 'Das Repository hat noch keinen Commit. Bitte zuerst einen Branch mit Inhalt erstellen.',
    dirty: 'Das Repository enthält lokale Änderungen. Bitte diese zuerst mit Git sichern oder abschließen.',
    changed: 'Das Repository wurde während der Aktion verändert. Bitte den Status neu prüfen.',
    diverged: 'Der Branch kann nicht per Fast-Forward aktualisiert werden. Bitte die Änderungen mit Git zusammenführen.',
    revoked: 'Die Freigabe wurde geändert oder konnte nicht mehr bestätigt werden. Bitte den Status neu prüfen.',
    timeout: 'Die Git-Aktion hat zu lange gedauert. Bitte zuerst den lokalen Status prüfen.',
    busy: 'Für diesen Projektordner läuft bereits eine Git-Aktion.',
    git_failed: 'Die Git-Aktion konnte nicht abgeschlossen werden. Bitte den lokalen Status und die Repositoryfreigabe prüfen.',
    limit: 'Das Repository überschreitet die Grenzen der automatischen Prüfung. Bitte mit Git prüfen.',
} as const
export class RepositoryWorkspaceError extends Error {
    constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = 'RepositoryWorkspaceError' }
}
function fail(code: keyof typeof messages): never { throw new RepositoryWorkspaceError(code) }
const missing = (): RepositoryLocal => ({ state: 'missing', branch: null, dirty: null, message: messages.missing })
const safeBranch = (branch: string) => branch.length > 0 && Buffer.byteLength(branch) <= 255
    && !/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(branch)
    && !branch.startsWith('-') && !branch.includes('..') && !branch.includes('@{') && !/[ ~^:?*\[\\]/.test(branch)
    && branch.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const fdPath = (handle: FileHandle) => `/proc/${process.pid}/fd/${handle.fd}`
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const safeError = (error: unknown) => error instanceof RepositoryWorkspaceError ? error : new RepositoryWorkspaceError('unavailable')

type Anchor = { handle: FileHandle; path: string; dev: number; ino: number }
class Paths {
    readonly anchors: Anchor[] = []
    // Stat-only worktree ancestors retain their identities, not an open FD for
    // every changed directory. Fixed project/repository anchors stay pinned.
    readonly directories = new Map<string, Omit<Anchor, 'handle'>>()
    target?: Anchor
    git?: Anchor
    deadline = Date.now() + 240_000
    constructor(readonly root: string, readonly repository: WorkspaceRepository) {}
    async open(path: string, source = path): Promise<Anchor> {
        const handle = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
            const stat = await handle.stat()
            const anchor = { handle, path, dev: stat.dev, ino: stat.ino }
            this.anchors.push(anchor)
            return anchor
        } catch (error) { await handle.close(); throw error }
    }
    async check() {
        this.remaining()
        for (const anchor of [...this.anchors, ...this.directories.values()]) {
            const stat = await lstat(anchor.path).catch(() => fail('unsafe_path'))
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== anchor.dev || stat.ino !== anchor.ino) fail('unsafe_path')
        }
        if (await realpath(this.root) !== this.root) fail('unsafe_path')
    }
    async close() { await Promise.all(this.anchors.map(anchor => anchor.handle.close())) }
    remaining(max = 120_000) { const remaining = this.deadline - Date.now(); if (remaining <= 0) fail('timeout'); return Math.min(max, remaining) }
    async initialize(create: boolean): Promise<boolean> {
        const r = this.repository
        if (!isAbsolute(this.root) || this.root === '/' || normalize(this.root) !== this.root
            || !/^[1-9][0-9]{0,19}$/.test(r.id) || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(r.owner)
            || !/^[a-z0-9._-]{1,100}$/.test(r.name) || ['.', '..', '.git'].includes(r.name.toLowerCase())
            || r.fullName !== `${r.owner}/${r.name}` || r.cloneUrl !== `https://github.com/${r.fullName}.git`
            || r.path !== join(this.root, 'repositories', r.owner, r.name)) fail('invalid_repository')
        if (await realpath(this.root).catch(() => '') !== this.root) fail('unavailable')
        let parent = await this.open(this.root)
        for (const segment of ['repositories', r.owner, r.name]) {
            await this.check()
            const path = join(parent.path, segment), source = join(fdPath(parent.handle), segment)
            const last = segment === r.name && parent.path === join(this.root, 'repositories', r.owner)
            if (create) {
                try { await mkdir(source, { mode: 0o700 }) }
                catch (error) { if (errorCode(error) !== 'EEXIST') throw error; if (last) fail('exists') }
            }
            try { parent = await this.open(path, source) }
            catch (error) {
                if (!create && errorCode(error) === 'ENOENT') { await this.check(); return false }
                if (['ELOOP', 'ENOTDIR'].includes(errorCode(error) ?? '')) fail('unsafe_path')
                throw error
            }
        }
        this.target = parent
        await this.check()
        return true
    }
    async openGit() {
        if (!this.target) fail('missing')
        this.git = await this.open(join(this.target.path, '.git'), join(fdPath(this.target.handle), '.git')).catch(error => fail(errorCode(error) === 'ENOENT' ? 'incomplete' : 'configuration'))
    }
}

/**
 * These checks prevent executing static repository configuration and reject changed
 * path identities. They do not isolate a malicious process already running as the
 * same authorized runner UID. The container/profile and broker remain that boundary.
 */
export function createRepositoryWorkspace(options: { proxyOrigin?: string; commandTimeoutMs?: number } = {}) {
    // Injection is for an isolated HTTP smart-Git test server; RPC callers cannot supply it.
    const origin = new URL(options.proxyOrigin ?? 'http://runner-proxy:3010')
    if (origin.protocol !== 'http:' || !['runner-proxy', '127.0.0.1', '[::1]'].includes(origin.hostname)
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('invalid_repository')
    const writing = new Set<string>()
    const readers = new Map<string, number>()
    const beginRead = (root: string) => { readers.set(root, (readers.get(root) ?? 0) + 1) }
    const endRead = (root: string) => {
        const remaining = (readers.get(root) ?? 1) - 1
        if (remaining > 0) readers.set(root, remaining); else readers.delete(root)
    }
    const environment: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false', GIT_SSH_COMMAND: '/bin/false',
        GIT_ALLOW_PROTOCOL: 'http', GIT_PROTOCOL_FROM_USER: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_LFS_SKIP_SMUDGE: '1',
        GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: '/', GIT_LITERAL_PATHSPECS: '1',
    }
    const config = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false',
        'core.attributesFile=/dev/null', 'credential.helper=', 'http.extraHeader=', 'http.proxy=', 'http.followRedirects=false',
        'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'protocol.allow=never', 'protocol.http.allow=always',
        'gc.auto=0', 'maintenance.auto=false', 'fetch.writeCommitGraph=false', 'core.quotePath=true']
    async function permission(authorize?: () => Promise<void>) {
        if (!authorize) return
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([authorize(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 10_000) })]) }
        catch { fail('revoked') } finally { clearTimeout(timer) }
    }
    async function git(args: string[], settings: { paths?: Paths; input?: Buffer; authorize?: () => Promise<void>; timeout?: number; allowedFailure?: boolean; readOnly?: boolean; maxOutput?: number } = {}) {
        if (process.getuid?.() === 0) fail('unavailable')
        await permission(settings.authorize)
        await settings.paths?.check()
        const paths = settings.paths
        const prefix = ['--literal-pathspecs', ...config.flatMap(value => ['-c', value])]
        if (paths?.git && paths.target) prefix.push(`--git-dir=${fdPath(paths.git.handle)}`, `--work-tree=${fdPath(paths.target.handle)}`)
        const maxTime = settings.timeout ?? options.commandTimeoutMs ?? 120_000
        const timeout = paths ? paths.remaining(maxTime) : maxTime
        const child = spawn('/usr/bin/git', [...prefix, ...args], {
            cwd: paths?.target ? fdPath(paths.target.handle) : '/', env: settings.readOnly ? { ...environment, GIT_ALLOW_PROTOCOL: '' } : environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        })
        const buffers: Buffer[] = []
        let size = 0, failure: RepositoryWorkspaceError | undefined, checking = false, finished = false
        let escalation: ReturnType<typeof setTimeout> | undefined
        const kill = (signal: NodeJS.Signals = 'SIGKILL') => { if (child.pid) { try { process.kill(-child.pid, signal) } catch { /* Already exited. */ } } }
        const stop = (error: RepositoryWorkspaceError) => {
            if (finished || failure) return
            failure = error
            // Give Git its normal signal cleanup (index/ref locks) before escalation.
            kill('SIGTERM'); escalation = setTimeout(() => kill(), 2000)
        }
        const deadline = setTimeout(() => stop(new RepositoryWorkspaceError('timeout')), timeout)
        const heartbeat = settings.authorize ? setInterval(() => {
            if (checking) return
            checking = true
            void permission(settings.authorize).catch(error => stop(safeError(error))).finally(() => { checking = false })
        }, 1000) : undefined
        child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > (settings.maxOutput ?? 1_048_576)) stop(new RepositoryWorkspaceError('limit')); else buffers.push(data) })
        child.stderr.on('data', (data: Buffer) => { size += data.length; if (size > 1_048_576) stop(new RepositoryWorkspaceError('limit')) })
        child.stdin.on('error', () => { /* A rejected command can close stdin early. */ })
        child.stdin.end(settings.input)
        try {
            const code = await new Promise<number | null>((resolve, reject) => { child.once('error', () => reject(new RepositoryWorkspaceError('git_failed'))); child.once('close', resolve) })
            if (failure) throw failure
            if (code !== 0 && !settings.allowedFailure) fail('git_failed')
            await settings.paths?.check()
            const raw = Buffer.concat(buffers)
            return { code, output: raw.toString('utf8'), raw }
        } finally { finished = true; clearTimeout(deadline); clearTimeout(escalation); clearInterval(heartbeat); kill() }
    }
    async function file(path: string, maxBytes: number): Promise<Buffer> {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => fail('configuration'))
        try {
            const stat = await handle.stat()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail('configuration')
            const buffer = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
            if (bytesRead > maxBytes) fail('configuration')
            return buffer.subarray(0, bytesRead)
        } finally { await handle.close() }
    }
    async function configuration(paths: Paths) {
        await paths.check()
        if (!paths.git) fail('configuration')
        const data = await file(join(fdPath(paths.git.handle), 'config'), 32_768)
        const parsed = await git(['config', '--file', '-', '--no-includes', '--null', '--list'], { input: data, timeout: paths.remaining(3000) })
        const seen = new Set<string>(), merges = new Map<string, string>()
        for (const record of parsed.output.split('\0').filter(Boolean)) {
            const split = record.indexOf('\n'), key = record.slice(0, split), value = record.slice(split + 1)
            if (split < 1 || seen.has(key) || /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(value)) fail('configuration')
            seen.add(key)
            if (/^core\.(filemode|logallrefupdates|ignorecase|precomposeunicode)$/.test(key) && /^(true|false)$/.test(value)) continue
            if (key === 'core.repositoryformatversion' && value === '0' || key === 'core.bare' && value === 'false') continue
            if (key === 'remote.origin.url' && value === paths.repository.cloneUrl) continue
            if (key === 'remote.origin.fetch' && value === '+refs/heads/*:refs/remotes/origin/*') continue
            if (/^user\.(name|email)$/.test(key) && value.length <= 255) continue
            const branch = /^branch\.(.+)\.(remote|merge)$/.exec(key)
            if (branch && safeBranch(branch[1]!) && branch[2] === 'remote' && value === 'origin') continue
            // Ordinary tracking, including a feature branch created from origin/main.
            if (branch && safeBranch(branch[1]!) && branch[2] === 'merge' && value.startsWith('refs/heads/') && safeBranch(value.slice(11))) { merges.set(branch[1]!, value.slice(11)); continue }
            fail('configuration')
        }
        if (!seen.has('remote.origin.url') || !seen.has('remote.origin.fetch') || !seen.has('core.repositoryformatversion') || !seen.has('core.bare')) fail('configuration')
        // A differently named upstream is only unambiguous with its explicit origin remote.
        for (const [local, merge] of merges) if (merge !== local && !seen.has(`branch.${local}.remote`)) fail('configuration')
        // Git follows these metadata paths even with hooks and all external transports disabled.
        let entries = 0
        const walk = async (directory: string, relative = ''): Promise<void> => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                paths.remaining()
                if (++entries > 50_000) fail('limit')
                const name = relative ? `${relative}/${entry.name}` : entry.name
                if (['commondir', 'config.worktree', 'worktrees', 'modules', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'refs/replace'].includes(name)) fail('configuration')
                const path = join(directory, entry.name), stat = await lstat(path)
                if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('configuration')
                if (stat.isDirectory()) await walk(path, name)
            }
        }
        await walk(fdPath(paths.git.handle))
        await paths.check()
        return { snapshot: digest(data), merges }
    }
    async function verify(paths: Paths, expected: string) {
        if ((await configuration(paths)).snapshot !== expected) fail('changed')
    }
    async function state(paths: Paths, authorize?: () => Promise<void>, allowDetached = false) {
        const { snapshot, merges } = await configuration(paths)
        const branchReply = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { paths, authorize, allowedFailure: true, timeout: 3000 })
        const branch = branchReply.output.trim()
        const detached = branchReply.code === 1
        if (!(allowDetached && detached) && (branchReply.code !== 0 || !safeBranch(branch))) fail('detached')
        await verify(paths, snapshot)
        const headReply = await git(['rev-parse', '--verify', 'HEAD'], { paths, authorize, allowedFailure: true, timeout: 3000 })
        const head = headReply.code === 0 ? headReply.output.trim() : null
        if (head !== null && !/^[0-9a-f]{40}$/.test(head)) fail('configuration')
        if (detached && head === null) fail('configuration')
        if (head === null && (await git(['for-each-ref', '--count=1', '--format=%(objectname)'], { paths, authorize, timeout: 3000 })).output.trim()) fail('configuration')
        await verify(paths, snapshot)
        const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'], { paths, authorize, timeout: 5000 })
        await verify(paths, snapshot)
        const current = head === null || detached ? null : branch
        // Pull follows the configured upstream like Git; without one, the same-name branch.
        return { snapshot, head, branch: current, upstream: current === null ? null : merges.get(current) ?? current, dirty: status.output.length > 0 }
    }

    const decoder = new TextDecoder('utf-8', { fatal: true })
    const text = (bytes: Buffer): string | null => { try { return decoder.decode(bytes) } catch { return null } }
    const statuses = new Set(['M', 'A', 'D', 'R', 'C', 'U', '?', ' ', 'T', '!'])
    const readStatus = (value: string): RepoFileStatus['index'] => {
        const status = value === '.' ? ' ' : value
        if (!statuses.has(status)) fail('configuration')
        return status as RepoFileStatus['index']
    }
    function takeFields(record: Buffer, count: number) {
        let offset = 0
        const fields: string[] = []
        for (let i = 0; i < count; i++) {
            const end = record.indexOf(32, offset)
            if (end < 0) fail('configuration')
            fields.push(record.subarray(offset, end).toString('ascii')); offset = end + 1
        }
        return { fields, path: record.subarray(offset) }
    }
    function fileStatus(pathBytes: Buffer, oldBytes: Buffer | undefined, index: string, worktree: string, modes: string[]): RepoFileStatus {
        const path = text(pathBytes), oldPath = oldBytes ? text(oldBytes) : undefined
        const unrepresentable = path === null || !isSafeSourcePath(path) || Buffer.byteLength(path) > 1024 || containsCredential(path)
            || oldBytes !== undefined && (oldPath == null || !isSafeSourcePath(oldPath) || Buffer.byteLength(oldPath) > 1024 || containsCredential(oldPath))
        const kind: RepoFileStatus['kind'] = modes.includes('160000') ? 'submodule' : modes.includes('120000') ? 'symlink' : 'file'
        if (unrepresentable) return { path: '', display: '[nicht anzeigbarer Pfad]', pathRef: digest(Buffer.concat([pathBytes, Buffer.from([0]), oldBytes ?? Buffer.alloc(0)])), index: readStatus(index), worktree: readStatus(worktree), kind: 'unknown', excluded: 'unrepresentable' }
        const sensitive = excludedSourcePath(path!) || oldPath !== undefined && excludedSourcePath(oldPath!)
        return { path: path!, ...(oldPath ? { oldPath } : {}), index: readStatus(index), worktree: readStatus(worktree), kind, ...(sensitive ? { excluded: 'sensitive_path' as const } : {}) }
    }
    /** Stat only. Every parent is checked before traversal; symlink destinations are never opened. */
    async function pathIdentity(paths: Paths, path: string) {
        if (!paths.target || !isSafeSourcePath(path)) fail('unsafe_path')
        const segments = path.split('/')
        let parent = paths.target
        let temporary: FileHandle | undefined
        try {
            for (const segment of segments.slice(0, -1)) {
                paths.remaining()
                const canonical = join(parent.path, segment)
                let handle: FileHandle
                try { handle = await open(join(fdPath(parent.handle), segment), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
                catch (error) { if (errorCode(error) === 'ENOENT') return null; fail('unsafe_path') }
                let next: Anchor
                try {
                    const info = await handle.stat()
                    const previous = paths.directories.get(canonical)
                    if (previous && (previous.dev !== info.dev || previous.ino !== info.ino)) fail('unsafe_path')
                    next = { handle, path: canonical, dev: info.dev, ino: info.ino }
                    paths.directories.set(canonical, { path: canonical, dev: info.dev, ino: info.ino })
                } catch (error) { await handle.close(); throw error }
                await temporary?.close()
                temporary = handle
                parent = next
            }
            const info = await lstat(join(fdPath(parent.handle), segments.at(-1)!), { bigint: true })
            if (!info.isFile() && !info.isSymbolicLink() && !info.isDirectory()) fail('unsafe_path')
            if (info.isFile() && info.nlink !== 1n) fail('unsafe_path')
            return { stamp: [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String), kind: info.isSymbolicLink() ? 'symlink' as const : info.isDirectory() ? 'unknown' as const : 'file' as const }
        } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
        finally { await temporary?.close() }
    }
    async function indexIdentity(paths: Paths) {
        if (!paths.git) fail('configuration')
        let handle: FileHandle
        try { handle = await open(join(fdPath(paths.git.handle), 'index'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
        catch (error) { if (errorCode(error) === 'ENOENT') return null; fail('configuration') }
        try {
            const info = await handle.stat({ bigint: true })
            if (!info.isFile() || info.nlink !== 1n) fail('configuration')
            return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String)
        } finally { await handle.close() }
    }
    async function readState(paths: Paths): Promise<RepoWorktree> {
        const configHash = (await configuration(paths)).snapshot, indexBefore = await indexIdentity(paths)
        const reply = await git(['status', '--porcelain=v2', '-z', '--branch', '--ahead-behind', '--untracked-files=all', '--ignore-submodules=all', '--renames'], { paths, readOnly: true, timeout: 5000 })
        const records: Buffer[] = []
        let offset = 0
        while (offset < reply.raw.length) {
            const end = reply.raw.indexOf(0, offset)
            if (end < 0) fail('configuration')
            records.push(reply.raw.subarray(offset, end)); offset = end + 1
        }
        let branch: string | null = null, head: string | null = null, detached = false, upstreamName: string | null = null
        let ahead = 0, behind = 0, totalFiles = 0, bytes = 0
        const files: RepoFileStatus[] = []
        for (let i = 0; i < records.length; i++) {
            const record = records[i]!
            if (record[0] === 35) {
                const header = text(record)
                if (!header) fail('configuration')
                if (header.startsWith('# branch.oid ')) {
                    const value = header.slice(13)
                    if (value !== '(initial)' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('configuration')
                    head = value === '(initial)' ? null : value
                } else if (header.startsWith('# branch.head ')) {
                    const value = header.slice(14); detached = value === '(detached)'
                    branch = !detached && safeBranch(value) && !containsCredential(value) ? value : null
                } else if (header.startsWith('# branch.upstream ')) {
                    const value = header.slice(18)
                    upstreamName = safeBranch(value) && !containsCredential(value) ? value : null
                } else if (header.startsWith('# branch.ab ')) {
                    const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(header)
                    if (!match) fail('configuration')
                    ahead = Number(match[1]); behind = Number(match[2])
                    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) fail('configuration')
                }
                continue
            }
            let file: RepoFileStatus
            if (record[0] === 63 || record[0] === 33) {
                if (record[1] !== 32) fail('configuration')
                file = fileStatus(record.subarray(2), undefined, String.fromCharCode(record[0]), ' ', [])
            } else if (record[0] === 49 || record[0] === 50 || record[0] === 117) {
                const count = record[0] === 49 ? 8 : record[0] === 50 ? 9 : 10
                const parsed = takeFields(record, count), xy = parsed.fields[1]!
                if (xy.length !== 2) fail('configuration')
                const old = record[0] === 50 ? records[++i] : undefined
                if (record[0] === 50 && !old) fail('configuration')
                file = fileStatus(parsed.path, old, xy[0]!, xy[1]!, parsed.fields.slice(3, record[0] === 117 ? 7 : 6))
            } else fail('configuration')
            totalFiles++
            const size = Buffer.byteLength(JSON.stringify(file))
            if (files.length < 2000 && bytes + size <= 524288) { files.push(file); bytes += size }
        }
        const identities: unknown[] = []
        for (const file of files) {
            paths.remaining()
            if (file.excluded === 'unrepresentable') continue
            for (const path of [file.path, ...(file.oldPath ? [file.oldPath] : [])]) {
                const identity = await pathIdentity(paths, path)
                identities.push([path, identity?.stamp ?? null])
                if (path === file.path && identity && file.kind !== 'submodule') file.kind = identity.kind
            }
        }
        await verify(paths, configHash)
        const indexAfter = await indexIdentity(paths)
        if (JSON.stringify(indexBefore) !== JSON.stringify(indexAfter)) fail('changed')
        // A bounded observation, not a frozen worktree. Subsequent diff re-observes both sides.
        const snapshotId = digest(Buffer.concat([Buffer.from(JSON.stringify([configHash, head, branch, indexAfter, identities])), reply.raw]))
        return { repositoryId: paths.repository.id, state: 'ready', branch, detached, head, upstream: upstreamName ? { name: upstreamName, ahead, behind } : null,
            snapshotId, observedAt: Date.now(), files, truncated: totalFiles > files.length, totalFiles }
    }
    async function readRepositoryWorktree(root: string, repository: WorkspaceRepository): Promise<RepoWorktree> {
        const empty = (state: RepoWorktree['state'], message: string): RepoWorktree => ({ repositoryId: repository.id, state, message, branch: null, detached: false, head: null, snapshotId: null, observedAt: Date.now(), files: [], truncated: false })
        if (writing.has(root)) return empty('syncing', messages.busy)
        beginRead(root)
        const paths = new Paths(root, repository); paths.deadline = Date.now() + 10_000
        try {
            if (!await paths.initialize(false)) return empty('missing', messages.missing)
            await paths.openGit()
            return await readState(paths)
        } catch (error) {
            const safe = safeError(error)
            return empty(['unavailable', 'timeout', 'changed'].includes(safe.code) ? 'unknown' : 'blocked', safe.message)
        } finally { try { await paths.close() } finally { endRead(root) } }
    }
    async function readRepositoryDiff(root: string, repository: WorkspaceRepository, raw: RepoDiffRequest): Promise<RepoDiff> {
        const request = RepoDiffRequestSchema.parse(raw)
        if (!isSafeSourcePath(request.path) || Buffer.byteLength(request.path) > 1024 || containsCredential(request.path)) fail('invalid_repository')
        if (writing.has(root)) fail('busy')
        beginRead(root)
        const paths = new Paths(root, repository); paths.deadline = Date.now() + 8000
        const result: RepoDiff = { path: request.path, side: request.side, patch: null, binary: false, truncated: false, observedAt: Date.now() }
        try {
            if (!await paths.initialize(false)) fail('missing')
            await paths.openGit()
            const before = await readState(paths)
            if (before.snapshotId !== request.snapshotId) fail('changed')
            const file = before.files.find(file => file.path === request.path && !file.excluded?.includes('unrepresentable'))
            if (!file) fail('changed')
            if (file.oldPath) result.oldPath = file.oldPath
            if (file.excluded || excludedSourcePath(file.path) || file.oldPath && excludedSourcePath(file.oldPath)) return { ...result, withheld: 'sensitive_path' }
            if (file.index === '?' || file.worktree === '?') return { ...result, withheld: 'untracked' }
            if (file.kind === 'submodule' || file.kind === 'unknown' || file.index === 'U' || file.worktree === 'U') return { ...result, withheld: 'unsupported' }
            const selected = [file.path, ...(file.oldPath ? [file.oldPath] : [])]
            const common = ['diff', ...(request.side === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--ignore-submodules=all']
            let patch: Buffer | null = null
            try {
                const stat = await git([...common, '--numstat', '-z', '--', ...selected], { paths, readOnly: true, timeout: 3000 })
                if (stat.output.split('\0').some(record => record.startsWith('-\t-\t'))) result.binary = true
                else patch = (await git([...common, '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', '--', ...selected], { paths, readOnly: true, maxOutput: 262144 })).raw
            } catch (error) { if (error instanceof RepositoryWorkspaceError && error.code === 'limit') result.truncated = true; else throw error }
            const after = await readState(paths)
            if (after.snapshotId !== before.snapshotId) fail('changed')
            if (patch) {
                const decoded = text(patch)
                if (decoded === null || patch.includes(0)) result.binary = true
                else if (containsCredential(decoded)) result.withheld = 'credential_pattern'
                else result.patch = decoded
            }
            result.observedAt = Date.now()
            return result
        } catch (error) { throw safeError(error) }
        finally { try { await paths.close() } finally { endRead(root) } }
    }
    async function inspectRepositories(root: string, repositories: WorkspaceRepository[]) {
        if (writing.has(root)) return repositories.map(repository => ({ id: repository.id, local: { state: 'unknown' as const, branch: null, dirty: null, message: messages.busy } }))
        // Catalog inspection is a best-effort observation, not a protected diff
        // snapshot. It never reserves the project against a user-requested sync.
        // Git optional index writes remain disabled, and path/config checks fail
        // closed if concurrent activity invalidates this observation.
        const deadline = Date.now() + 10_000, results: Array<{ id: string; local: RepositoryLocal }> = []
        for (const repository of repositories) {
            const paths = new Paths(root, repository)
            paths.deadline = deadline
            try {
                paths.remaining()
                if (!await paths.initialize(false)) { results.push({ id: repository.id, local: missing() }); continue }
                await paths.openGit()
                const info = await state(paths, undefined, true)
                results.push({ id: repository.id, local: { state: 'ready', branch: info.branch, dirty: info.dirty } })
            } catch (error) {
                const safe = safeError(error)
                results.push({ id: repository.id, local: { state: ['unavailable', 'timeout'].includes(safe.code) ? 'unknown' : 'blocked', branch: null, dirty: null, message: safe.message } })
            } finally { await paths.close() }
        }
        return results
    }
    async function syncRepository(root: string, repository: WorkspaceRepository, action: 'clone' | 'pull', authorize: () => Promise<void>): Promise<RepositoryLocal> {
        if (writing.has(root) || readers.has(root)) fail('busy')
        writing.add(root)
        const paths = new Paths(root, repository)
        try {
            if (!['clone', 'pull'].includes(action)) fail('invalid_repository')
            await permission(authorize)
            if (!await paths.initialize(action === 'clone')) fail('missing')
            const transport = `${origin.origin}/evolved-git/github.com/${repository.fullName}.git`
            if (action === 'clone') {
                // The exclusive target is retained on failure: never recursively remove files
                // that an agent might have created while clone was in progress.
                await git(['clone', '--quiet', '--no-checkout', '--no-recurse-submodules', '--no-local', '--template=', '--', transport, '.'], { paths, authorize })
                await paths.openGit()
                // Clone creates config from our fixed arguments and an empty template only.
                // Set the public canonical URL; native agent git will use the system broker rewrite.
                await permission(authorize)
                await git(['config', '--local', 'remote.origin.url', repository.cloneUrl], { paths })
                await permission(authorize)
                const { snapshot } = await configuration(paths)
                await permission(authorize)
                await verify(paths, snapshot)
                const head = await git(['rev-parse', '--verify', 'HEAD'], { paths, authorize, allowedFailure: true, timeout: 3000 })
                // Once authorized, finish this local Git mutation without an HTTP
                // heartbeat interrupting its index/worktree update. Recheck afterwards.
                await permission(authorize)
                if (head.code === 0) await git(['checkout', '--quiet', '--no-overwrite-ignore'], { paths })
                await permission(authorize)
                await verify(paths, snapshot)
            } else {
                await paths.openGit()
                const before = await state(paths, authorize)
                if (before.head === null || before.branch === null || before.upstream === null) fail('unborn')
                const upstream = before.upstream
                if (before.dirty) fail('dirty')
                await verify(paths, before.snapshot)
                await git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--', transport, `+refs/heads/${upstream}:refs/remotes/origin/${upstream}`], { paths, authorize })
                await permission(authorize)
                const current = await state(paths, authorize)
                if (current.snapshot !== before.snapshot || current.head !== before.head || current.branch !== before.branch || current.upstream !== upstream) fail('changed')
                if (current.dirty) fail('dirty')
                // FETCH_HEAD belongs to the whole checkout and can be overwritten
                // by an agent fetching another branch while this job is running.
                const next = (await git(['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${upstream}^{commit}`], { paths, authorize, timeout: 3000 })).output.trim()
                if (!/^[0-9a-f]{40}$/.test(next)) fail('configuration')
                const ancestor = await git(['merge-base', '--is-ancestor', before.head, next], { paths, authorize, allowedFailure: true, timeout: 5000 })
                if (ancestor.code !== 0) {
                    if (ancestor.code !== 1) fail('git_failed')
                    const ahead = await git(['merge-base', '--is-ancestor', next, before.head], { paths, authorize, allowedFailure: true, timeout: 5000 })
                    if (ahead.code !== 0) fail(ahead.code === 1 ? 'diverged' : 'git_failed')
                }
                await permission(authorize)
                await verify(paths, before.snapshot)
                // A branch containing additional local commits is already up to date.
                if (ancestor.code === 0) await git(['merge', '--ff-only', '--no-edit', '--no-stat', '--no-overwrite-ignore', '--', next], { paths })
                await permission(authorize)
                await verify(paths, before.snapshot)
            }
            await permission(authorize)
            const after = await state(paths, authorize)
            return { state: 'ready', branch: after.branch, dirty: after.dirty }
        } catch (error) {
            throw error instanceof RepositoryWorkspaceError ? error : new RepositoryWorkspaceError('git_failed')
        } finally { try { await paths.close() } finally { writing.delete(root) } }
    }
    return { inspectRepositories, syncRepository, readRepositoryWorktree, readRepositoryDiff }
}

const workspace = createRepositoryWorkspace()
export const inspectRepositories = workspace.inspectRepositories
export const syncRepository = workspace.syncRepository
export const readRepositoryWorktree = workspace.readRepositoryWorktree
export const readRepositoryDiff = workspace.readRepositoryDiff
