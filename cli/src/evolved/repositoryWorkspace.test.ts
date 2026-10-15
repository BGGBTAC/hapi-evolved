import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRepositoryWorkspace, RepositoryWorkspaceError, type WorkspaceRepository } from './repositoryWorkspace'
import { RepoDiffSchema, RepoWorktreeSchema } from '@hapi/protocol/evolvedWorkspace'

const cleanEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C' }
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let directory: string, root: string, source: string, bare: string, server: Server, repo: WorkspaceRepository
let workspace: ReturnType<typeof createRepositoryWorkspace>, origin: string
let requests: string[], beforeResponse: (() => Promise<void>) | undefined
const authorize = async () => {}
async function observeIndex(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const info = await handle.stat({ bigint: true })
        expect(info.isFile()).toBe(true)
        return { bytes: await handle.readFile(), identity: [info.dev, info.ino, info.mtimeNs] }
    } finally { await handle.close() }
}

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

describe('read-only project worktree and diff', () => {
    const observe = () => workspace.readRepositoryWorktree(root, repo)
    const diff = async (path: string, side: 'staged' | 'unstaged' = 'unstaged', snapshotId?: string) => {
        const snapshot = snapshotId ?? (await observe()).snapshotId
        expect(snapshot).toMatch(/^[a-f0-9]{64}$/)
        const reply = await workspace.readRepositoryDiff(root, repo, { path, side, snapshotId: snapshot! })
        expect(RepoDiffSchema.safeParse(reply).success).toBe(true)
        return reply
    }
    it('observes a clean checkout without changing the index, HEAD, config or contacting a remote', async () => {
        await clone(); requests.length = 0
        const index = join(repo.path, '.git/index'), config = join(repo.path, '.git/config')
        const before = { index: await observeIndex(index), config: await readFile(config), head: git(repo.path, 'rev-parse', 'HEAD') }
        const first = await observe(), second = await observe()
        expect(RepoWorktreeSchema.safeParse(first).success).toBe(true)
        expect(first).toMatchObject({ state: 'ready', branch: 'main', detached: false, head: before.head, files: [], truncated: false, upstream: { name: 'origin/main', ahead: 0, behind: 0 } })
        expect(second.snapshotId).toBe(first.snapshotId)
        expect(await observeIndex(index)).toEqual(before.index)
        expect(await readFile(config)).toEqual(before.config)
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(before.head); expect(requests).toHaveLength(0)
    })
    it('separates staged and unstaged patches and retains index contents and timestamps', async () => {
        await clone(); requests.length = 0
        await writeFile(join(repo.path, 'README.md'), 'staged change\n'); git(repo.path, 'add', '--', 'README.md')
        await writeFile(join(repo.path, 'README.md'), 'unstaged change\n')
        const index = join(repo.path, '.git/index'), original = await observeIndex(index)
        const worktree = await observe()
        expect(worktree.files).toEqual([{ path: 'README.md', index: 'M', worktree: 'M', kind: 'file' }])
        const staged = await diff('README.md', 'staged', worktree.snapshotId!)
        expect(staged.patch).toContain('-initial\n+staged change'); expect(staged.patch).not.toContain('unstaged change')
        const unstaged = await diff('README.md', 'unstaged', worktree.snapshotId!)
        expect(unstaged.patch).toContain('-staged change\n+unstaged change')
        expect(await observeIndex(index)).toEqual(original)
        expect(requests).toHaveLength(0)
    })
    it('keeps inspection ready during concurrent reads and rejects mutation until all readers finish', async () => {
        await clone(); await writeFile(join(repo.path, 'README.md'), 'concurrent read fixture\n')
        const snapshot = (await observe()).snapshotId!
        const pendingDiff = workspace.readRepositoryDiff(root, repo, { path: 'README.md', side: 'unstaged', snapshotId: snapshot })
        const pendingInspection = workspace.inspectRepositories(root, [repo])
        const pendingRead = observe()
        // A fast missing-repository read must release only its own reader count.
        const missingRepo = { ...repo, id: '124', name: 'missing', fullName: `${repo.owner}/missing`, cloneUrl: `https://github.com/${repo.owner}/missing.git`, path: join(root, 'repositories', repo.owner, 'missing') }
        expect(await workspace.readRepositoryWorktree(root, missingRepo)).toMatchObject({ state: 'missing' })
        await expect(pull()).rejects.toMatchObject({ code: 'busy' })
        expect((await pendingDiff).patch).toContain('+concurrent read fixture')
        expect((await pendingInspection)[0]?.local).toMatchObject({ state: 'ready', dirty: true })
        expect(await pendingRead).toMatchObject({ state: 'ready' })
        // The read guards are now all released; Git's dirty-worktree check applies.
        await expect(pull()).rejects.toMatchObject({ code: 'dirty' })
    })
    it('does not leak a reader reservation after a failed diff', async () => {
        await clone(); await writeFile(join(repo.path, 'README.md'), 'change\n')
        await expect(diff('README.md', 'unstaged', 'a'.repeat(64))).rejects.toMatchObject({ code: 'changed' })
        const invalid = { ...repo, path: `${repo.path}/invalid` }
        expect((await workspace.inspectRepositories(root, [invalid]))[0]?.local.state).toBe('blocked')
        await expect(pull()).rejects.toMatchObject({ code: 'dirty' })
    })
    it('allows actual fast-forward sync while a catalog inspection is still pending', async () => {
        await clone(); await upstream()
        let completed = false
        const inspection = workspace.inspectRepositories(root, [repo, repo, repo]).finally(() => { completed = true })
        expect(completed).toBe(false)
        const result = await pull()
        expect(result).toMatchObject({ state: 'ready', branch: 'main', dirty: false })
        expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(git(source, 'rev-parse', 'HEAD'))
        expect(await inspection).toHaveLength(3)
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local).toMatchObject({ state: 'ready', dirty: false })
    })
    it('reads detached and unborn worktrees while keeping mutation restrictions separate', async () => {
        await clone(); git(repo.path, 'checkout', '--detach')
        await writeFile(join(repo.path, 'README.md'), 'detached change\n')
        expect(await observe()).toMatchObject({ state: 'ready', branch: null, detached: true, head: expect.stringMatching(/^[a-f0-9]{40}$/) })
        expect((await diff('README.md')).patch).toContain('+detached change')
        await rm(repo.path, { recursive: true }); await rm(bare, { recursive: true }); git(directory, 'init', '--bare', '--initial-branch=main', bare)
        await clone(); await writeFile(join(repo.path, 'first.txt'), 'first staged\n'); git(repo.path, 'add', '--', 'first.txt')
        expect(await observe()).toMatchObject({ state: 'ready', branch: git(repo.path, 'symbolic-ref', '--short', 'HEAD'), detached: false, head: null, files: [{ path: 'first.txt', index: 'A' }] })
        expect((await diff('first.txt', 'staged')).patch).toContain('+first staged')
    })
    it('preserves spaces, Unicode and literal Git pathspec characters', async () => {
        await clone()
        for (const path of ['a[1].txt', 'a1.txt', ':(glob)*.txt', '-option.txt', 'Größe space.txt']) {
            await writeFile(join(repo.path, path), `first ${path}\n`)
            git(repo.path, '--literal-pathspecs', 'add', '--', path)
        }
        git(repo.path, 'commit', '-m', 'literal paths')
        for (const path of ['a[1].txt', 'a1.txt', ':(glob)*.txt', '-option.txt', 'Größe space.txt']) await writeFile(join(repo.path, path), `changed ${path}\n`)
        const state = await observe()
        expect(state.files.map(file => file.path)).toEqual(expect.arrayContaining(['a[1].txt', 'a1.txt', ':(glob)*.txt', '-option.txt', 'Größe space.txt']))
        expect((await diff('a[1].txt')).patch).toContain('+changed a[1].txt')
        expect((await diff('a[1].txt')).patch).not.toContain('changed a1.txt')
        expect((await diff(':(glob)*.txt')).patch).not.toContain('changed a1.txt')
        expect((await diff('-option.txt')).patch).toContain('+changed -option.txt')
    })
    it('lists renames and checks the old path for sensitive material too', async () => {
        await clone(); git(repo.path, 'mv', '--', 'README.md', 'renamed document.md')
        expect((await observe()).files).toEqual([{ path: 'renamed document.md', oldPath: 'README.md', index: 'R', worktree: ' ', kind: 'file' }])
        expect((await diff('renamed document.md', 'staged')).patch).toContain('rename from README.md')
        git(repo.path, 'commit', '-m', 'rename'); await writeFile(join(repo.path, '.env.example'), 'synthetic harmless fixture\n')
        git(repo.path, 'add', '-f', '--', '.env.example'); git(repo.path, 'commit', '-m', 'sensitive source fixture')
        git(repo.path, 'mv', '--', '.env.example', 'public.txt')
        expect((await observe()).files).toContainEqual(expect.objectContaining({ path: 'public.txt', oldPath: '.env.example', excluded: 'sensitive_path' }))
        expect(await diff('public.txt', 'staged')).toMatchObject({ patch: null, withheld: 'sensitive_path' })
    })
    it('never previews untracked files or excluded paths', async () => {
        await clone(); await writeFile(join(repo.path, 'untracked.txt'), 'must not be returned')
        await writeFile(join(repo.path, '.ENV.local'), 'must not be returned')
        expect(await diff('untracked.txt')).toMatchObject({ patch: null, withheld: 'untracked' })
        expect(await diff('.ENV.local')).toMatchObject({ patch: null, withheld: 'sensitive_path' })
        git(repo.path, 'add', '-f', '--', '.ENV.local')
        expect(await diff('.ENV.local', 'staged')).toMatchObject({ patch: null, withheld: 'sensitive_path' })
    })
    it('withholds the whole patch if either removed or added lines contain credential patterns', async () => {
        await clone()
        const marker = `ghp_${'SyntheticCredential'.repeat(2)}`
        await writeFile(join(repo.path, 'README.md'), `ordinary context\n${marker}\n`)
        expect(await diff('README.md')).toMatchObject({ patch: null, withheld: 'credential_pattern', truncated: false })
        git(repo.path, 'add', '--', 'README.md'); git(repo.path, 'commit', '-m', 'synthetic removed-line fixture')
        await writeFile(join(repo.path, 'README.md'), 'ordinary replacement\n')
        expect(await diff('README.md')).toMatchObject({ patch: null, withheld: 'credential_pattern' })
    })
    it('returns binary metadata without a payload and withholds oversized UTF-8 patches entirely', async () => {
        await clone(); await writeFile(join(repo.path, 'image.bin'), Buffer.from([1, 0, 2, 3])); git(repo.path, 'add', '--', 'image.bin')
        expect(await diff('image.bin', 'staged')).toMatchObject({ patch: null, binary: true, truncated: false })
        await writeFile(join(repo.path, 'README.md'), `${'é'.repeat(140000)}\n`)
        expect(await diff('README.md')).toMatchObject({ patch: null, binary: false, truncated: true })
    })
    it('reads only a symlink target name and never its target contents', async () => {
        await clone(); const outside = join(directory, 'outside-private-fixture.txt')
        await writeFile(outside, 'SYNTHETIC_TARGET_CONTENT_NEVER_RETURN')
        await symlink(outside, join(repo.path, 'link.txt')); git(repo.path, 'add', '--', 'link.txt')
        expect((await observe()).files).toContainEqual(expect.objectContaining({ path: 'link.txt', kind: 'symlink' }))
        const reply = await diff('link.txt', 'staged')
        expect(reply.patch).toContain(outside); expect(reply.patch).not.toContain('SYNTHETIC_TARGET_CONTENT_NEVER_RETURN')
    })
    it('redacts raw filenames that cannot be safely rendered and keeps distinct opaque references', async () => {
        await clone()
        const badNames = [Buffer.from('line\nbreak.txt'), Buffer.from('bidi\u202ename.txt'), Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74])]
        for (const name of badNames) await writeFile(Buffer.concat([Buffer.from(`${repo.path}/`), name]), 'untracked fixture')
        const state = await observe()
        expect(state.state).toBe('ready'); expect(state.files).toHaveLength(3)
        for (const file of state.files) expect(file).toMatchObject({ path: '', kind: 'unknown', excluded: 'unrepresentable', pathRef: expect.stringMatching(/^[a-f0-9]{64}$/) })
        expect(new Set(state.files.map(file => file.pathRef)).size).toBe(3)
        expect(JSON.stringify(state)).not.toContain('bidi')
    })
    it('rejects changed file observations even if Git status remains the same', async () => {
        await clone(); await writeFile(join(repo.path, 'README.md'), 'change one\n')
        const first = await observe(); await writeFile(join(repo.path, 'README.md'), 'change two\n')
        await expect(diff('README.md', 'unstaged', first.snapshotId!)).rejects.toMatchObject({ code: 'changed' })
        expect((await observe()).snapshotId).not.toBe(first.snapshotId)
    })
    it('does not report unavailable or unsafe roots as missing and never recreates them', async () => {
        expect(await observe()).toMatchObject({ state: 'missing', snapshotId: null })
        await expect(stat(join(root, 'repositories'))).rejects.toMatchObject({ code: 'ENOENT' })
        await rm(root, { recursive: true })
        expect(await observe()).toMatchObject({ state: 'unknown', snapshotId: null })
        await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('rejects a FIFO config promptly without blocking on an absent writer', async () => {
        await clone(); await rm(join(repo.path, '.git/config')); execFileSync('/usr/bin/mkfifo', [join(repo.path, '.git/config')])
        const started = Date.now()
        expect(await observe()).toMatchObject({ state: 'blocked', snapshotId: null })
        expect(Date.now() - started).toBeLessThan(1500)
    })
    it('blocks unsafe Git config and submodules without executing a nested repository command', async () => {
        await clone(); requests.length = 0
        git(repo.path, 'update-index', '--add', '--cacheinfo', '160000', git(repo.path, 'rev-parse', 'HEAD'), 'nested')
        // --ignore-submodules=all omits even staged gitlinks, without opening a nested Git repository.
        const state = await observe()
        expect(state).toMatchObject({ state: 'ready', files: [] })
        await expect(diff('nested', 'staged', state.snapshotId!)).rejects.toMatchObject({ code: 'changed' })
        git(repo.path, 'config', '--local', 'diff.external', '/synthetic/never-execute')
        expect(await observe()).toMatchObject({ state: 'blocked', snapshotId: null })
        expect(requests).toHaveLength(0)
    })
    it('fails closed on traversal, invalid snapshots and paths not in the observation', async () => {
        await clone(); await writeFile(join(repo.path, 'README.md'), 'change\n'); const state = await observe()
        for (const path of ['../outside', '/etc/passwd', 'src/../README.md', 'README.md\0tail']) {
            await expect(workspace.readRepositoryDiff(root, repo, { path, side: 'unstaged', snapshotId: state.snapshotId! })).rejects.toMatchObject({ code: 'invalid_repository' })
        }
        await expect(diff('missing.txt', 'unstaged', state.snapshotId!)).rejects.toMatchObject({ code: 'changed' })
        await expect(diff('README.md', 'unstaged', 'a'.repeat(64))).rejects.toMatchObject({ code: 'changed' })
    })
    it('bounds a large status listing and never permits a path omitted from its snapshot', async () => {
        await clone()
        await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(join(repo.path, `untracked-${String(i).padStart(4, '0')}.txt`), 'fixture')))
        const state = await observe()
        expect(state).toMatchObject({ state: 'ready', totalFiles: 2001, truncated: true })
        expect(state.files).toHaveLength(2000)
        expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(1_048_576)
        expect(RepoWorktreeSchema.safeParse(state).success).toBe(true)
        await expect(diff('untracked-2000.txt', 'unstaged', state.snapshotId!)).rejects.toMatchObject({ code: 'changed' })
    })
    it('bounds open descriptors when changed files span more than a thousand directories', async () => {
        await clone()
        for (let i = 0; i < 1100; i++) {
            const parent = join(repo.path, `directory-${i}`, 'nested')
            await mkdir(parent, { recursive: true }); await writeFile(join(parent, 'file.txt'), 'fixture')
        }
        const initial = (await readdir('/proc/self/fd')).length
        let peak = initial, sampling = false
        const timer = setInterval(() => {
            if (sampling) return
            sampling = true
            void readdir('/proc/self/fd').then(files => { peak = Math.max(peak, files.length) }).finally(() => { sampling = false })
        }, 2)
        try {
            const state = await observe()
            expect(state).toMatchObject({ state: 'ready', totalFiles: 1100, truncated: false })
            expect(peak - initial).toBeLessThan(32)
        } finally { clearInterval(timer) }
        expect((await readdir('/proc/self/fd')).length).toBeLessThan(initial + 4)
    }, 20_000)
    it.each(['symlink', 'hardlink', 'fifo'] as const)('rejects a %s hidden inside a loose-object directory before Git reads it', async kind => {
        await clone()
        const outside = join(directory, 'outside-object')
        await writeFile(outside, 'synthetic external object fixture')
        const object = join(repo.path, '.git/objects/aa', 'b'.repeat(38))
        await mkdir(dirname(object), { recursive: true })
        if (kind === 'symlink') await symlink(outside, object)
        else if (kind === 'hardlink') await link(outside, object)
        else execFileSync('/usr/bin/mkfifo', [object])
        expect(await observe()).toMatchObject({ state: 'blocked', snapshotId: null })
        expect(await readFile(outside, 'utf8')).toBe('synthetic external object fixture')
    })
    it('represents unmerged files without generating a combined conflict patch', async () => {
        await clone(); git(repo.path, 'checkout', '-b', 'side')
        await writeFile(join(repo.path, 'README.md'), 'side version\n'); git(repo.path, 'add', '--', 'README.md'); git(repo.path, 'commit', '-m', 'side')
        git(repo.path, 'checkout', 'main'); await writeFile(join(repo.path, 'README.md'), 'main version\n'); git(repo.path, 'add', '--', 'README.md'); git(repo.path, 'commit', '-m', 'main')
        expect(() => git(repo.path, 'merge', 'side')).toThrow()
        expect((await observe()).files).toEqual([{ path: 'README.md', index: 'U', worktree: 'U', kind: 'file' }])
        expect(await diff('README.md')).toMatchObject({ patch: null, withheld: 'unsupported' })
    })
    it('shows deletions on each side without attempting to read the deleted path', async () => {
        await clone(); await rm(join(repo.path, 'README.md'))
        expect((await observe()).files).toEqual([{ path: 'README.md', index: ' ', worktree: 'D', kind: 'file' }])
        expect((await diff('README.md')).patch).toContain('-initial')
        git(repo.path, 'add', '--', 'README.md')
        expect((await observe()).files).toEqual([{ path: 'README.md', index: 'D', worktree: ' ', kind: 'file' }])
        expect((await diff('README.md', 'staged')).patch).toContain('-initial')
    })
})

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
        expect((await workspace.inspectRepositories(root, [repo]))[0]?.local).toMatchObject({ state: 'ready', branch: null, dirty: false })
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
