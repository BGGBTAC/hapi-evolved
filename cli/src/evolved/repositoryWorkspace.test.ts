import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRepositoryWorkspace, RepositoryWorkspaceError, type WorkspaceRepository } from './repositoryWorkspace'

const cleanEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C' }
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let directory: string, root: string, source: string, bare: string, server: Server, repo: WorkspaceRepository
let workspace: ReturnType<typeof createRepositoryWorkspace>, origin: string
let requests: string[], beforeResponse: (() => Promise<void>) | undefined
const authorize = async () => {}

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'evolved-repository-'))
    root = join(directory, 'project'); source = join(directory, 'source'); bare = join(directory, 'remote.git')
    await mkdir(root); await mkdir(source)
    git(source, 'init', '--initial-branch=main')
    await writeFile(join(source, 'README.md'), 'initial\n'); await writeFile(join(source, '.gitignore'), 'ignored.txt\n')
    git(source, 'add', '.'); git(source, 'commit', '-m', 'initial'); git(directory, 'clone', '--bare', source, bare)
    git(source, 'remote', 'add', 'origin', bare)
    repo = { id: '123', owner: 'synthetic-owner', name: 'example', fullName: 'synthetic-owner/example', cloneUrl: 'https://github.com/synthetic-owner/example.git', path: join(root, 'repositories/synthetic-owner/example') }
    requests = []; beforeResponse = undefined
    server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        requests.push(url.pathname)
        if (!url.pathname.startsWith('/evolved-git/github.com/synthetic-owner/example.git/')) { response.writeHead(403).end(); return }
        const child = spawn('/usr/lib/git-core/git-http-backend', [], { env: { ...cleanEnv, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method ?? 'GET', PATH_INFO: `/remote.git${url.pathname.split('example.git')[1]}`, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: request.headers['content-length'] ?? '', REMOTE_ADDR: '127.0.0.1' } })
        const chunks: Buffer[] = []
        child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume(); child.stdin.on('error', () => {})
        request.pipe(child.stdin)
        child.once('close', () => { void (async () => {
            const output = Buffer.concat(chunks), split = output.indexOf('\r\n\r\n')
            if (split < 0) { response.writeHead(500).end(); return }
            for (const line of output.subarray(0, split).toString().split('\r\n')) {
                const colon = line.indexOf(':'); const name = line.slice(0, colon), value = line.slice(colon + 1).trim()
                if (name.toLowerCase() === 'status') response.statusCode = Number(value.slice(0, 3)); else response.setHeader(name, value)
            }
            await beforeResponse?.()
            response.end(output.subarray(split + 4))
        })().catch(() => response.destroy()) })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    workspace = createRepositoryWorkspace({ proxyOrigin: origin })
})
afterEach(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
const clone = () => workspace.syncRepository(root, repo, 'clone', authorize)
async function upstream(file = 'README.md', contents = 'updated\n') {
    await writeFile(join(source, file), contents); git(source, 'add', '-f', file); git(source, 'commit', '-m', 'update'); git(source, 'push', 'origin', 'main')
}
const pull = () => workspace.syncRepository(root, repo, 'pull', authorize)

describe('project repository workspace', () => {
    it('clones over the fixed HTTP broker path, preserves the root, and fast-forwards a read-only grant', async () => {
        const rootInode = (await stat(root)).ino
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local.state).toBe('missing')
        expect(await clone()).toMatchObject({ state: 'ready', branch: 'main', dirty: false })
        expect(git(repo.path, 'remote', 'get-url', 'origin')).toBe(repo.cloneUrl)
        expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('initial\n')
        await upstream()
        expect(await pull()).toMatchObject({ state: 'ready', branch: 'main', dirty: false })
        expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('updated\n')
        expect(git(repo.path, 'rev-parse', 'origin/main')).toBe(git(repo.path, 'rev-parse', 'HEAD'))
        expect((await stat(root)).ino).toBe(rootInode)
        expect(requests.every(path => path.startsWith('/evolved-git/github.com/synthetic-owner/example.git/'))).toBe(true)
    })
    it('never confuses an unavailable root, invalid metadata, or an existing non-repository with missing', async () => {
        expect((await workspace.inspectRepositories(join(root, 'absent'), [{ ...repo, path: `${root}/absent/repositories/${repo.fullName}` }]))[0]?.local.state).toBe('unknown')
        expect((await workspace.inspectRepositories(root, [{ ...repo, path: `${root}/outside` }]))[0]?.local.state).toBe('blocked')
        await mkdir(repo.path, { recursive: true })
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local.state).toBe('blocked')
        await expect(clone()).rejects.toMatchObject({ code: 'exists' })
        expect(requests).toHaveLength(0)
    })
    it('clones an empty repository successfully and explains why pull is unavailable', async () => {
        await rm(bare, { recursive: true }); git(directory, 'init', '--bare', '--initial-branch=main', bare)
        expect(await clone()).toMatchObject({ state: 'ready', branch: null, dirty: false })
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local).toMatchObject({ state: 'ready', branch: null, dirty: false })
        await expect(pull()).rejects.toMatchObject({ code: 'unborn' })
    })
    it.each(['tracked', 'staged', 'untracked'])('preserves %s local changes without contacting the remote', async kind => {
        await clone(); requests.length = 0
        const path = join(repo.path, kind === 'untracked' ? 'local.txt' : 'README.md')
        await writeFile(path, 'preserve me\n')
        if (kind === 'staged') git(repo.path, 'add', 'README.md')
        await expect(pull()).rejects.toMatchObject({ code: 'dirty' })
        expect(await readFile(path, 'utf8')).toBe('preserve me\n'); expect(requests).toHaveLength(0)
    })
    it('does not overwrite ignored untracked files when the upstream starts tracking them', async () => {
        await clone(); const before = git(repo.path, 'rev-parse', 'HEAD')
        await writeFile(join(repo.path, 'ignored.txt'), 'local private contents\n'); await upstream('ignored.txt', 'remote contents\n')
        await expect(pull()).rejects.toBeInstanceOf(RepositoryWorkspaceError)
        expect(await readFile(join(repo.path, 'ignored.txt'), 'utf8')).toBe('local private contents\n')
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(before)
    })
    it('preserves a file created by an agent while clone downloads the repository', async () => {
        beforeResponse = async () => { await writeFile(join(repo.path, 'README.md'), 'concurrent local work\n') }
        await expect(clone()).rejects.toBeInstanceOf(RepositoryWorkspaceError)
        expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('concurrent local work\n')
    })
    it('rejects a diverged branch and never resets its commits', async () => {
        await clone(); await writeFile(join(repo.path, 'local.txt'), 'local'); git(repo.path, 'add', '.'); git(repo.path, 'commit', '-m', 'local')
        const before = git(repo.path, 'rev-parse', 'HEAD'); await upstream()
        await expect(pull()).rejects.toMatchObject({ code: 'diverged' })
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(before)
    })
    it('treats a branch with only additional local commits as an already up-to-date success', async () => {
        await clone(); await writeFile(join(repo.path, 'local.txt'), 'local'); git(repo.path, 'add', '.'); git(repo.path, 'commit', '-m', 'local')
        const before = git(repo.path, 'rev-parse', 'HEAD')
        expect(await pull()).toMatchObject({ state: 'ready', branch: 'main', dirty: false })
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(before)
        expect(await readFile(join(repo.path, 'local.txt'), 'utf8')).toBe('local')
    })
    it('rejects detached HEAD without changing it', async () => {
        await clone(); git(repo.path, 'checkout', '--detach'); requests.length = 0
        await expect(pull()).rejects.toMatchObject({ code: 'detached' }); expect(requests).toHaveLength(0)
    })
    it.each(['include.path', 'includeIf.gitdir:/.path', 'core.hooksPath', 'core.fsmonitor', 'filter.evil.smudge', 'core.sshCommand', 'url.http://evil.invalid/.insteadOf', 'remote.origin.pushurl', 'remote.origin.proxy', 'extensions.worktreeConfig'])('rejects unsafe local configuration %s before any transport', async key => {
        await clone(); requests.length = 0
        git(repo.path, 'config', '--local', key, key === 'extensions.worktreeConfig' ? 'true' : '/synthetic/never-execute')
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local.state).toBe('blocked')
        await expect(pull()).rejects.toMatchObject({ code: 'configuration' }); expect(requests).toHaveLength(0)
    })
    it('disables ordinary hooks and rejects an external remote and duplicate remote URL', async () => {
        await clone(); const sentinel = join(root, 'hook-executed')
        await mkdir(join(repo.path, '.git/hooks'))
        await writeFile(join(repo.path, '.git/hooks/post-merge'), `#!/bin/sh\ntouch '${sentinel}'\n`); await chmod(join(repo.path, '.git/hooks/post-merge'), 0o700)
        await upstream(); await pull(); await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
        git(repo.path, 'config', '--local', '--add', 'remote.origin.url', 'https://external.invalid/secret.git')
        await expect(pull()).rejects.toMatchObject({ code: 'configuration' })
    })
    it.each(['commondir', 'config.worktree', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts'])('rejects metadata redirection %s', async file => {
        await clone(); await mkdir(dirname(join(repo.path, '.git', file)), { recursive: true }); await writeFile(join(repo.path, '.git', file), '/synthetic/outside\n'); requests.length = 0
        await expect(pull()).rejects.toMatchObject({ code: 'configuration' }); expect(requests).toHaveLength(0)
    })
    it.each(['repositories', 'owner', 'target', 'git'])('rejects a symlink at %s without touching its destination', async where => {
        const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'untouched')
        if (where === 'git') { await clone(); await rename(join(repo.path, '.git'), join(directory, 'moved-git')); await symlink(outside, join(repo.path, '.git')) }
        else if (where === 'repositories') await symlink(outside, join(root, 'repositories'))
        else if (where === 'owner') { await mkdir(join(root, 'repositories')); await symlink(outside, join(root, 'repositories', repo.owner)) }
        else { await mkdir(join(root, 'repositories', repo.owner), { recursive: true }); await symlink(outside, repo.path) }
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local.state).toBe('blocked')
        await expect(where === 'git' ? pull() : clone()).rejects.toBeInstanceOf(RepositoryWorkspaceError)
        expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched')
    })
    it('detects a replaced project-root identity before spawning Git', async () => {
        let calls = 0
        await expect(workspace.syncRepository(root, repo, 'clone', async () => {
            if (++calls === 2) { await rename(root, `${root}-old`); await mkdir(root) }
        })).rejects.toMatchObject({ code: 'unsafe_path' })
        expect(requests).toHaveLength(0)
    })
    it('rechecks authorization after fetching and does not fast-forward after revocation', async () => {
        await clone(); const before = git(repo.path, 'rev-parse', 'HEAD'); await upstream()
        let revoked = false
        beforeResponse = async () => { revoked = true }
        await expect(workspace.syncRepository(root, repo, 'pull', async () => { if (revoked) throw new Error('private upstream detail') })).rejects.toMatchObject({ code: 'revoked' })
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(before)
        expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('initial\n')
    })
    it('reports authorization loss after a completed local update without leaving a partial index', async () => {
        await clone(); await upstream()
        await expect(workspace.syncRepository(root, repo, 'pull', async () => {
            if (await readFile(join(repo.path, 'README.md'), 'utf8') === 'updated\n') throw new Error('synthetic revocation after local update')
        })).rejects.toMatchObject({ code: 'revoked' })
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(git(source, 'rev-parse', 'HEAD'))
        expect(git(repo.path, 'status', '--porcelain')).toBe('')
        await expect(lstat(join(repo.path, '.git/index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('detects a changed branch during fetch and preserves the local branch', async () => {
        await clone(); await upstream(); let changed = false
        beforeResponse = async () => { if (!changed) { changed = true; git(repo.path, 'switch', '-c', 'local-branch') } }
        await expect(pull()).rejects.toMatchObject({ code: 'changed' })
        expect(git(repo.path, 'branch', '--show-current')).toBe('local-branch')
    })
    it('uses the selected branch tracking ref when another fetch overwrites FETCH_HEAD', async () => {
        await clone(); await upstream(); const expected = git(source, 'rev-parse', 'HEAD')
        git(source, 'switch', '-c', 'other'); await writeFile(join(source, 'README.md'), 'different branch\n')
        git(source, 'add', '.'); git(source, 'commit', '-m', 'other branch'); git(source, 'push', 'origin', 'other')
        const foreign = git(source, 'rev-parse', 'HEAD')
        git(repo.path, 'fetch', '--no-tags', bare, 'other')
        let changed = false
        await workspace.syncRepository(root, repo, 'pull', async () => {
            if (!changed && git(repo.path, 'rev-parse', 'origin/main') === expected) {
                changed = true
                await writeFile(join(repo.path, '.git/FETCH_HEAD'), `${foreign}\t\tbranch 'other' of synthetic\n`)
            }
        })
        expect(changed).toBe(true)
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(expected)
        expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('updated\n')
    })
    it('bounds a stalled remote and retains the exclusive target without destructive cleanup', async () => {
        workspace = createRepositoryWorkspace({ proxyOrigin: origin, commandTimeoutMs: 100 })
        beforeResponse = () => new Promise(resolve => setTimeout(resolve, 300))
        await expect(clone()).rejects.toMatchObject({ code: 'timeout' })
        expect((await lstat(repo.path)).isDirectory()).toBe(true)
    })
    it('shares the inspection deadline across repositories and never reports an unchecked path as missing', async () => {
        await clone()
        const now = Date.now(); let ticks = 0
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + ticks++ * 2000)
        try {
            const second = { ...repo, id: '124', name: 'second', fullName: `${repo.owner}/second`, cloneUrl: `https://github.com/${repo.owner}/second.git`, path: join(root, 'repositories', repo.owner, 'second') }
            const result = await workspace.inspectRepositories(root, [repo, second])
            expect(result.map(item => item.local.state)).toEqual(['unknown', 'unknown'])
        } finally { clock.mockRestore() }
    })
    it('rejects duplicate operations and does not expose authorization error text', async () => {
        let proceed!: () => void
        const pending = workspace.syncRepository(root, repo, 'clone', () => new Promise<void>(resolve => { proceed = resolve }))
        await expect(clone()).rejects.toMatchObject({ code: 'busy' })
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local).toMatchObject({ state: 'unknown', message: expect.stringContaining('bereits') })
        proceed()
        // The initial authorization resolves; subsequent checks must also be released.
        const interval = setInterval(() => proceed(), 5)
        try { await pending } finally { clearInterval(interval) }
        await expect(workspace.syncRepository(root, repo, 'pull', async () => { throw new Error('synthetic-secret-never-expose') })).rejects.toMatchObject({ message: expect.not.stringContaining('synthetic-secret') })
    })
})
