import { afterEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { EvolvedStore } from './store'
import { createEvolvedRoutes } from './api'
import { SESSION_COOKIE } from './security'
import { allocateWorkspace, assertManagedWorkspaceSeparation, canonicalWorkspace, hasNestedWorkspaceMount, openManagedWorkspaceRoot, workspaceBindingsOverlap } from './workspaces'

const dirs: string[] = [], stores: EvolvedStore[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-project-folders-')); dirs.push(directory)
    const managedWorkspaceRoot = join(directory, 'managed'), manualRoot = join(directory, 'manual')
    mkdirSync(manualRoot)
    const dbPath = join(directory, 'state.db'), store = new EvolvedStore(dbPath, { managedWorkspaceRoot }); stores.push(store)
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,1,?)').run('operator', 'Operator', Date.now())
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run('member', 'Member', Date.now())
    const operatorTeam = store.createTeam('operator', 'Operator team'), team = store.createTeam('member', 'Member team')
    const origin = 'https://workspace.example.test'
    const app = new Hono().route('/api/evolved', createEvolvedRoutes({ store, origin, allowedWorkspaceRoots: [manualRoot], vault: { request: async () => ({ ok: true }) } }))
    const call = (user: string | null, path: string, body?: unknown, bearer?: string) => app.request(`${origin}/api/evolved${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : user ? { cookie: `${SESSION_COOKIE}=${store.createSession(user)}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { directory, managedWorkspaceRoot, manualRoot, dbPath, store, operatorTeam, team, call }
}
describe('automatic project workspaces', () => {
    test('managed root cannot overlap operator state or credentials, except its dedicated default child', () => {
        const f = fixture(), state = join(f.directory, 'state'), keys = join(f.directory, 'credentials')
        const check = (root: string) => assertManagedWorkspaceSeparation(root, state, join(state, 'db.sqlite'), join(state, 'bootstrap.token'), [join(keys, 'key.pem')])
        for (const root of [state, f.directory, join(state, 'other'), keys, join(keys, 'child')]) expect(() => check(root)).toThrow()
        expect(() => check(join(state, 'project-workspaces'))).not.toThrow()
        expect(() => check(f.managedWorkspaceRoot)).not.toThrow()
        expect(() => assertManagedWorkspaceSeparation(join(state, 'project-workspaces'), state, join(state, 'db.sqlite'), join(state, 'bootstrap.token'), [join(state, 'key.pem')])).not.toThrow()
        mkdirSync(state); mkdirSync(keys)
        const alias = join(f.directory, 'state-alias'); symlinkSync(state, alias)
        expect(() => assertManagedWorkspaceSeparation(state, alias, join(alias, 'db.sqlite'), join(alias, 'bootstrap.token'), [])).toThrow()
        const keyAlias = join(f.directory, 'keys-alias'); symlinkSync(keys, keyAlias)
        expect(() => assertManagedWorkspaceSeparation(keys, state, join(state, 'db.sqlite'), join(state, 'bootstrap.token'), [join(keyAlias, 'new-key.pem')])).toThrow()
    })
    test('Linux mount snapshots reject nested bind mounts, including escaped names, without confusing siblings or a root mount', () => {
        const info = '31 20 8:1 / /workspaces/a rw - ext4 /dev/test rw\n32 31 8:1 /other-project /workspaces/a/vendor\\040copy rw - ext4 /dev/test rw\n'
        expect(hasNestedWorkspaceMount('/workspaces/a', info)).toBe(true)
        expect(hasNestedWorkspaceMount('/workspaces/a/vendor copy', info)).toBe(false)
        expect(hasNestedWorkspaceMount('/workspaces/ab', info)).toBe(false)
        expect(hasNestedWorkspaceMount('/workspaces/a', info.split('\n')[0])).toBe(false)
    })
    test('team administrators receive separate private persistent UUID directories by default', async () => {
        const f = fixture()
        const response = await f.call('member', '/projects', { teamId: f.team.id, name: '../../same user name' })
        expect(response.status).toBe(201)
        const { project } = await response.json() as { project: { id: string; rootPath: string; root: string; profile: string } }
        expect(project.rootPath).toBe(join(f.managedWorkspaceRoot, project.id)); expect(project.root).toBe(project.rootPath)
        expect(project.profile).toBe('restricted'); expect(statSync(project.rootPath).mode & 0o777).toBe(0o700)
        const second = f.store.createProject('member', f.team.id, 'Same user name')
        expect(second.rootPath).not.toBe(project.rootPath)
        writeFileSync(join(project.rootPath, 'saved.txt'), 'persistent content')
        const reopened = new EvolvedStore(f.dbPath, { managedWorkspaceRoot: f.managedWorkspaceRoot }); stores.push(reopened)
        expect(reopened.requireProject('member', project.id).rootPath).toBe(project.rootPath)
        expect(readFileSync(join(project.rootPath, 'saved.txt'), 'utf8')).toBe('persistent content')
    })
    test('blank root aliases create folders, conflicting aliases fail and capabilities cannot create', async () => {
        const f = fixture()
        expect((await f.call('member', '/projects', { teamId: f.team.id, name: 'Empty', rootPath: '' })).status).toBe(201)
        expect((await f.call('operator', '/projects', { teamId: f.operatorTeam.id, name: 'Ambiguous', rootPath: '', root: f.manualRoot })).status).toBe(400)
        const p = f.store.createProject('member', f.team.id, 'Capability')
        const cap = f.store.issueCapability('member', p.id, ['runner:connect'], [], 60)
        expect((await f.call(null, '/projects', { teamId: f.team.id, name: 'Agent' }, cap.token)).status).toBe(403)
    })
    test('manual binds require an operator and prevent same, parent, child and managed bindings', async () => {
        const f = fixture(), child = join(f.manualRoot, 'project'), nested = join(child, 'nested'); mkdirSync(nested, { recursive: true })
        expect((await f.call('member', '/projects', { teamId: f.team.id, name: 'Forbidden', rootPath: child })).status).toBe(403)
        const input = { teamId: f.operatorTeam.id, name: 'Manual', rootPath: child }
        const results = await Promise.all([f.call('operator', '/projects', input), f.call('operator', '/projects', input)])
        expect(results.map(r => r.status).sort()).toEqual([201, 409])
        for (const root of [nested, f.manualRoot]) expect((await f.call('operator', '/projects', { ...input, rootPath: root })).status).toBe(409)
        const managed = f.store.createProject('member', f.team.id, 'Managed')
        expect(() => f.store.createProject('operator', f.operatorTeam.id, 'Steal managed', managed.rootPath)).toThrow('cannot be attached manually')
    })
    test('manual binds still require a recent passkey', async () => {
        const f = fixture(), target = join(f.manualRoot, 'fresh'); mkdirSync(target)
        const token = f.store.createSession('operator', 'recovery')
        const app = new Hono().route('/api/evolved', createEvolvedRoutes({ store: f.store, origin: 'https://workspace.example.test', allowedWorkspaceRoots: [f.manualRoot], vault: { request: async () => ({}) } }))
        const response = await app.request('/api/evolved/projects', { method: 'POST', headers: { origin: 'https://workspace.example.test', cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ teamId: f.operatorTeam.id, name: 'Manual', rootPath: target }) })
        expect(response.status).toBe(403); expect(await response.json()).toHaveProperty('code', 'step_up_required')
    })
    test('manual symlinks, traversal and missing paths fail closed', () => {
        const f = fixture(), real = join(f.manualRoot, 'real'), link = join(f.manualRoot, 'link'); mkdirSync(real); symlinkSync(real, link)
        for (const path of [link, `${real}/../real`, join(f.manualRoot, 'missing')]) expect(() => canonicalWorkspace(path, [f.manualRoot])).toThrow()
        expect(() => canonicalWorkspace(f.directory, [f.manualRoot])).toThrow('outside')
        expect(canonicalWorkspace(real, [join(f.directory, 'absent-root'), f.manualRoot])).toBe(real)
    })
    test('typing a protected directory cannot bypass the administrator browser filter', async () => {
        const f = fixture()
        for (const name of ['.git', '.ssh', '.env', '.credentials', 'secrets', 'credentials', 'node_modules']) {
            const path = join(f.manualRoot, name, 'nested'); mkdirSync(path, { recursive: true })
            expect((await f.call('operator', '/projects', { teamId: f.operatorTeam.id, name: 'Protected', rootPath: path })).status).toBe(403)
        }
    })
    test('failed DB writes remove only the freshly allocated empty folder', () => {
        const f = fixture()
        f.store.db.exec("CREATE TRIGGER fail_project BEFORE INSERT ON evolved_projects BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;")
        expect(() => f.store.createProject('member', f.team.id, 'Failure')).toThrow('synthetic failure')
        expect(readdirSync(f.managedWorkspaceRoot)).toEqual([])
        expect(f.store.listProjects('member')).toEqual([])
    })
    test('rollback keeps nonempty directories and replacement inodes', () => {
        const f = fixture(), root = openManagedWorkspaceRoot(f.managedWorkspaceRoot)
        try {
            const full = allocateWorkspace(root, randomUUID()); writeFileSync(join(full.path, 'content'), 'keep'); full.rollback(); expect(existsSync(full.path)).toBe(true)
            const replaced = allocateWorkspace(root, randomUUID()); renameSync(replaced.path, `${replaced.path}-old`); mkdirSync(replaced.path); replaced.rollback(); expect(existsSync(replaced.path)).toBe(true)
        } finally { closeSync(root.fd) }
    })
    test('managed root rejects symlinks, permissive ownership modes and existing child paths', () => {
        const f = fixture(), outside = join(f.directory, 'outside'); mkdirSync(outside); symlinkSync(outside, f.managedWorkspaceRoot)
        expect(() => f.store.createProject('member', f.team.id, 'Symlink')).toThrow('symbolic')
        expect(readdirSync(outside)).toEqual([])
        expect(() => openManagedWorkspaceRoot(join(f.managedWorkspaceRoot, 'must-not-exist'))).toThrow()
        expect(readdirSync(outside)).toEqual([])
        expect(() => openManagedWorkspaceRoot(f.manualRoot)).toThrow('private')
        rmSync(f.managedWorkspaceRoot)
        const root = openManagedWorkspaceRoot(f.managedWorkspaceRoot), id = randomUUID(); mkdirSync(join(root.path, id))
        try { expect(() => allocateWorkspace(root, id)).toThrow(); expect(existsSync(join(root.path, id))).toBe(true) } finally { closeSync(root.fd) }
    })
    test('deleting a project keeps workspace content and deleting projects still reserve their path', async () => {
        const f = fixture(), p = f.store.createProject('member', f.team.id, 'Keep files')
        writeFileSync(join(p.rootPath, 'keep'), 'source')
        const app = new Hono().route('/api/evolved', createEvolvedRoutes({ store: f.store, origin: 'https://workspace.example.test', vault: { request: async () => ({}) } }))
        expect((await app.request(`/api/evolved/projects/${p.id}`, { method: 'DELETE', headers: { origin: 'https://workspace.example.test', cookie: `${SESSION_COOKIE}=${f.store.createSession('member')}` } })).status).toBe(200)
        expect(readFileSync(join(p.rootPath, 'keep'), 'utf8')).toBe('source')
        const manual = f.store.createProject('operator', f.operatorTeam.id, 'Deleting', f.manualRoot)
        f.store.db.prepare('UPDATE evolved_projects SET deleting_at=1 WHERE id=?').run(manual.id)
        expect(() => f.store.createProject('operator', f.operatorTeam.id, 'Race', f.manualRoot)).toThrow('overlaps')
    })
    test('folder browser is operator-only, bounded and hides links, sensitive and assigned directories', async () => {
        const f = fixture()
        for (const name of ['a', 'b', '.git', 'credentials', 'assigned']) mkdirSync(join(f.manualRoot, name))
        symlinkSync(join(f.manualRoot, 'a'), join(f.manualRoot, 'link'))
        f.store.createProject('operator', f.operatorTeam.id, 'Bound', join(f.manualRoot, 'assigned'))
        expect((await f.call(null, '/workspaces')).status).toBe(401)
        expect((await f.call('member', '/workspaces')).status).toBe(403)
        const root = await (await f.call('operator', '/workspaces')).json() as { roots: Array<{ path: string; name: string; selectable: boolean }> }
        expect(root.roots).toEqual([{ name: 'manual', path: f.manualRoot, selectable: false }])
        const result = await (await f.call('operator', `/workspaces?path=${encodeURIComponent(f.manualRoot)}`)).json() as { directories: Array<{ name: string }> }
        expect(result.directories.map(d => d.name).sort()).toEqual(['a', 'b'])
        expect((await f.call('operator', `/workspaces?path=${encodeURIComponent(join(f.manualRoot, '.git'))}`)).status).toBe(403)
        expect((await f.call('operator', '/workspaces?limit=101')).status).toBe(400)
        expect((await f.call('operator', '/workspaces?offset=10001')).status).toBe(400)
        expect(workspaceBindingsOverlap(f.manualRoot, join(f.manualRoot, 'a'))).toBe(true)
        expect(workspaceBindingsOverlap(join(f.manualRoot, 'a'), join(f.manualRoot, 'b'))).toBe(false)
    })
})
