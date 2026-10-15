import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

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
    target?: Anchor
    git?: Anchor
    deadline = Date.now() + 240_000
    constructor(readonly root: string, readonly repository: WorkspaceRepository) {}
    async open(path: string, source = path): Promise<Anchor> {
        const handle = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const stat = await handle.stat()
        const anchor = { handle, path, dev: stat.dev, ino: stat.ino }
        this.anchors.push(anchor)
        return anchor
    }
    async check() {
        this.remaining()
        for (const anchor of this.anchors) {
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
    const running = new Set<string>()
    const environment: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false', GIT_SSH_COMMAND: '/bin/false',
        GIT_ALLOW_PROTOCOL: 'http', GIT_PROTOCOL_FROM_USER: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_LFS_SKIP_SMUDGE: '1',
        GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: '/',
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
    async function git(args: string[], settings: { paths?: Paths; input?: Buffer; authorize?: () => Promise<void>; timeout?: number; allowedFailure?: boolean } = {}) {
        if (process.getuid?.() === 0) fail('unavailable')
        await permission(settings.authorize)
        await settings.paths?.check()
        const paths = settings.paths
        const prefix = config.flatMap(value => ['-c', value])
        if (paths?.git && paths.target) prefix.push(`--git-dir=${fdPath(paths.git.handle)}`, `--work-tree=${fdPath(paths.target.handle)}`)
        const maxTime = settings.timeout ?? options.commandTimeoutMs ?? 120_000
        const timeout = paths ? paths.remaining(maxTime) : maxTime
        const child = spawn('/usr/bin/git', [...prefix, ...args], {
            cwd: paths?.target ? fdPath(paths.target.handle) : '/', env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
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
        child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > 1_048_576) stop(new RepositoryWorkspaceError('limit')); else buffers.push(data) })
        child.stderr.on('data', (data: Buffer) => { size += data.length; if (size > 1_048_576) stop(new RepositoryWorkspaceError('limit')) })
        child.stdin.on('error', () => { /* A rejected command can close stdin early. */ })
        child.stdin.end(settings.input)
        try {
            const code = await new Promise<number | null>((resolve, reject) => { child.once('error', () => reject(new RepositoryWorkspaceError('git_failed'))); child.once('close', resolve) })
            if (failure) throw failure
            if (code !== 0 && !settings.allowedFailure) fail('git_failed')
            await settings.paths?.check()
            return { code, output: Buffer.concat(buffers).toString('utf8') }
        } finally { finished = true; clearTimeout(deadline); clearTimeout(escalation); clearInterval(heartbeat); kill() }
    }
    async function file(path: string, maxBytes: number): Promise<Buffer> {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('configuration'))
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
        const seen = new Set<string>()
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
            if (branch && safeBranch(branch[1]!) && (branch[2] === 'remote' && value === 'origin' || branch[2] === 'merge' && value === `refs/heads/${branch[1]}`)) continue
            fail('configuration')
        }
        if (!seen.has('remote.origin.url') || !seen.has('remote.origin.fetch') || !seen.has('core.repositoryformatversion') || !seen.has('core.bare')) fail('configuration')
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
        return digest(data)
    }
    async function verify(paths: Paths, expected: string) {
        if (await configuration(paths) !== expected) fail('changed')
    }
    async function state(paths: Paths, authorize?: () => Promise<void>) {
        const snapshot = await configuration(paths)
        const branchReply = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { paths, authorize, allowedFailure: true, timeout: 3000 })
        const branch = branchReply.output.trim()
        if (branchReply.code !== 0 || !safeBranch(branch)) fail('detached')
        await verify(paths, snapshot)
        const headReply = await git(['rev-parse', '--verify', 'HEAD'], { paths, authorize, allowedFailure: true, timeout: 3000 })
        const head = headReply.code === 0 ? headReply.output.trim() : null
        if (head !== null && !/^[0-9a-f]{40}$/.test(head)) fail('configuration')
        if (head === null && (await git(['for-each-ref', '--count=1', '--format=%(objectname)'], { paths, authorize, timeout: 3000 })).output.trim()) fail('configuration')
        await verify(paths, snapshot)
        const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'], { paths, authorize, timeout: 5000 })
        await verify(paths, snapshot)
        return { snapshot, head, branch: head === null ? null : branch, dirty: status.output.length > 0 }
    }
    async function inspectRepositories(root: string, repositories: WorkspaceRepository[]) {
        if (running.has(root)) return repositories.map(repository => ({ id: repository.id, local: { state: 'unknown' as const, branch: null, dirty: null, message: messages.busy } }))
        const deadline = Date.now() + 10_000, results: Array<{ id: string; local: RepositoryLocal }> = []
        for (const repository of repositories) {
            const paths = new Paths(root, repository)
            paths.deadline = deadline
            try {
                paths.remaining()
                if (!await paths.initialize(false)) { results.push({ id: repository.id, local: missing() }); continue }
                await paths.openGit()
                const info = await state(paths)
                results.push({ id: repository.id, local: { state: 'ready', branch: info.branch, dirty: info.dirty } })
            } catch (error) {
                const safe = safeError(error)
                results.push({ id: repository.id, local: { state: ['unavailable', 'timeout'].includes(safe.code) ? 'unknown' : 'blocked', branch: null, dirty: null, message: safe.message } })
            } finally { await paths.close() }
        }
        return results
    }
    async function syncRepository(root: string, repository: WorkspaceRepository, action: 'clone' | 'pull', authorize: () => Promise<void>): Promise<RepositoryLocal> {
        if (running.has(root)) fail('busy')
        running.add(root)
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
                const snapshot = await configuration(paths)
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
                if (before.head === null || before.branch === null) fail('unborn')
                if (before.dirty) fail('dirty')
                await verify(paths, before.snapshot)
                await git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--', transport, `+refs/heads/${before.branch}:refs/remotes/origin/${before.branch}`], { paths, authorize })
                await permission(authorize)
                const current = await state(paths, authorize)
                if (current.snapshot !== before.snapshot || current.head !== before.head || current.branch !== before.branch) fail('changed')
                if (current.dirty) fail('dirty')
                // FETCH_HEAD belongs to the whole checkout and can be overwritten
                // by an agent fetching another branch while this job is running.
                const next = (await git(['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${before.branch}^{commit}`], { paths, authorize, timeout: 3000 })).output.trim()
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
        } finally { await paths.close(); running.delete(root) }
    }
    return { inspectRepositories, syncRepository }
}

const workspace = createRepositoryWorkspace()
export const inspectRepositories = workspace.inspectRepositories
export const syncRepository = workspace.syncRepository
