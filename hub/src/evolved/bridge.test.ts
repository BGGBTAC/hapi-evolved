import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SignJWT } from 'jose'
import { EvolvedStore } from './store'
import { authenticateRunner, createProjectAuthMiddleware, createSessionTokenRoutes, permissionAllowed, verifyProjectToken } from './bridge'
import type { WebAppEnv } from '../web/middleware/auth'
import { createMachinesRoutes } from '../web/routes/machines'
import type { SyncEngine } from '../sync/syncEngine'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'

const stores: EvolvedStore[] = []
const directories: string[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
    const root = mkdtempSync(join(tmpdir(), 'evolved-bridge-')); directories.push(root)
    const store = new EvolvedStore(':memory:'); stores.push(store)
    for (const id of ['alice', 'bob', 'charlie']) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, id === 'alice' ? 1 : 0, Date.now())
    const team = store.createTeam('alice', 'Alpha'), other = store.createTeam('bob', 'Beta')
    store.setMember('alice', team.id, 'charlie', 'viewer')
    const project = store.createProject('alice', team.id, 'A', root), second = store.createProject('bob', other.id, 'B')
    const cookie = store.createSession('alice'), secret = new Uint8Array(32).fill(7), origin = 'https://evolved.test'
    const spawnCalls: Parameters<SyncEngine['spawnSession']>[] = []
    const machineNamespaces = new Map<string, string>()
    let afterSpawnBodyRead: (() => void) | undefined
    const app = new Hono<WebAppEnv>()
    app.route('/api/evolved', createSessionTokenRoutes(store, secret, origin))
    app.use('/api/*', createProjectAuthMiddleware(store, secret, origin))
    app.get('/api/sessions', c => c.json({ ns: c.get('namespace') }))
    app.post('/api/sessions', c => c.json({ ok: true }))
    app.post('/api/sessions/content-search', c => c.json({ results: [] }))
    app.get('/api/claude/sessions', c => c.json({ shouldNeverExposeHostHome: true }))
    app.post('/api/machines/:id/list-directory', c => c.json({ ok: true }))
    app.post('/api/machines/:id/paths/exists', c => c.json({ ok: true }))
    app.post('/api/sessions/:id/codex/plan/implement', c => c.json({ ok: true }))
    app.use('/api/machines/:id/spawn', async (c, next) => {
        const read = c.req.json.bind(c.req)
        c.req.json = async <T>() => { const value = await read<T>(); afterSpawnBodyRead?.(); return value }
        await next()
    })
    app.route('/api', createMachinesRoutes(() => ({
        getMachine: (id: string) => ({ namespace: machineNamespaces.get(id) ?? project.namespace, metadata: { capabilities: [MACHINE_CAPABILITIES.AgentAvailability] } }),
        spawnSession: async (...args: Parameters<SyncEngine['spawnSession']>) => { spawnCalls.push(args); return { permissionMode: args[10] } }
    }) as unknown as SyncEngine))
    const mint = async (session = cookie, id = project.id) => {
        const response = await app.request(`/api/evolved/session-token?projectId=${id}`, { headers: { cookie: `__Host-hapi-evolved=${session}` } })
        return { response, body: await response.json() as { token: string } }
    }
    return { store, team, project, second, cookie, secret, origin, app, mint, spawnCalls, machineNamespaces,
        duringSpawnBodyRead: (callback: () => void) => { afterSpawnBodyRead = callback } }
}
describe('Evolved project boundary', () => {
    test('restricted and workspace profiles reject Codex autoReview explicitly', () => {
        const t = setup()
        expect(permissionAllowed(t.project, 'autoReview')).toBe(false)
        expect(permissionAllowed({ ...t.project, profile: 'workspace' }, 'autoReview')).toBe(false)
        expect(permissionAllowed({ ...t.project, profile: 'extended' }, 'autoReview')).toBe(true)
    })
    test('native import cannot expose Hub HOME and Cursor cannot be spawned even by an admin', async () => {
        const t = setup(), { body } = await t.mint()
        const headers = { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }
        for (const path of ['/api/claude/sessions', '/api/cursor/sessions', '/api/codex/sessions', '/api/machines/m/claude-discover']) {
            expect((await t.app.request(path, { headers })).status).toBe(403)
        }
        expect((await t.app.request('/api/machines/m/spawn', { method: 'POST', headers, body: JSON.stringify({ agent: 'cursor', directory: t.project.rootPath }) })).status).toBe(400)
    })
    test('viewer can use exact POST content-search without acquiring mutation rights', async () => {
        const t = setup(), { body } = await t.mint(t.store.createSession('charlie'))
        const headers = { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }
        expect((await t.app.request('/api/sessions/content-search', { method: 'POST', headers, body: '{}' })).status).toBe(200)
        expect((await t.app.request('/api/sessions', { method: 'POST', headers, body: '{}' })).status).toBe(401)
    })
    test('derives namespace from current membership and rejects project substitution', async () => {
        const t = setup(), { body } = await t.mint()
        const access = await verifyProjectToken(body.token, t.secret, t.store)
        expect(access.project.namespace).toBe(`evolved-${t.project.id}`)
        expect((await t.mint(t.cookie, t.second.id)).response.status).toBe(403)
        expect((await t.app.request('/api/sessions', { headers: { authorization: `Bearer ${body.token}`, 'x-hapi-project-id': t.second.id } })).status).toBe(403)
    })
    test('logout invalidates derived JWTs and active stream authorization immediately', async () => {
        const t = setup(), { body } = await t.mint(), access = await verifyProjectToken(body.token, t.secret, t.store)
        expect(access.valid()).toBe(true)
        t.store.revokeSession(t.cookie)
        expect(access.valid()).toBe(false)
        await expect(verifyProjectToken(body.token, t.secret, t.store)).rejects.toThrow('Session revoked')
    })
    test('membership revocation invalidates an existing JWT', async () => {
        const t = setup(), session = t.store.createSession('charlie'), { body } = await t.mint(session)
        const access = await verifyProjectToken(body.token, t.secret, t.store)
        t.store.setMember('alice', t.team.id, 'charlie', null)
        expect(access.valid()).toBe(false)
    })
    test('viewer cannot mutate and browser writes require exact origin', async () => {
        const t = setup(), own = await t.mint(), viewer = await t.mint(t.store.createSession('charlie'))
        expect((await t.app.request('/api/sessions', { method: 'POST', headers: { authorization: `Bearer ${viewer.body.token}`, origin: t.origin } })).status).toBe(401)
        expect((await t.app.request('/api/sessions', { method: 'POST', headers: { authorization: `Bearer ${own.body.token}`, origin: 'https://evil.test' } })).status).toBe(403)
        expect((await t.app.request('/api/sessions', { method: 'POST', headers: { authorization: `Bearer ${own.body.token}`, origin: t.origin } })).status).toBe(200)
    })
    test('legacy signed JWTs cannot authenticate in Evolved', async () => {
        const t = setup(), token = await new SignJWT({ uid: 1, ns: t.project.namespace }).setProtectedHeader({ alg: 'HS256' }).sign(t.secret)
        expect((await t.app.request('/api/sessions', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
    })
    test('runner capability is bounded to its project and revoked by profile changes', () => {
        const t = setup(), grant = t.store.issueCapability('alice', t.project.id, ['runner:connect'], [], 900)
        expect(authenticateRunner(grant.token, t.store)?.project.id).toBe(t.project.id)
        expect(authenticateRunner(`${grant.token}:other`, t.store)).toBeNull()
        expect(authenticateRunner(t.cookie, t.store)).toBeNull()
        t.store.setProfile('alice', t.project.id, 'workspace')
        expect(authenticateRunner(grant.token, t.store)).toBeNull()
    })
    test('read-only capabilities cannot connect as a runner', () => {
        const t = setup(), cap = t.store.issueCapability('alice', t.project.id, ['memory:read'], [], 900)
        expect(authenticateRunner(cap.token, t.store)).toBeNull()
        expect(permissionAllowed(t.project, 'bypassPermissions')).toBe(false)
        expect(permissionAllowed({ ...t.project, profile: 'workspace' }, 'danger-full-access')).toBe(false)
    })
    test('restricted spawn defaults are read-only and contradictory fields cannot bypass the profile', async () => {
        const t = setup(), { body } = await t.mint()
        const post = (path: string, value: unknown) => t.app.request(path, { method: 'POST', headers: { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }, body: JSON.stringify(value) })
        expect(await (await post('/api/machines/x/spawn', { directory: t.project.rootPath })).json()).toMatchObject({ permissionMode: 'plan' })
        expect(await (await post('/api/machines/x/spawn', { directory: t.project.rootPath, agent: 'codex' })).json()).toMatchObject({ permissionMode: 'read-only' })
        expect((await post('/api/machines/x/spawn', { directory: t.project.rootPath, mode: 'plan', permissionMode: 'danger-full-access' })).status).toBe(403)
        expect((await post('/api/machines/x/spawn', { directory: t.project.rootPath, permissionMode: 'default' })).status).toBe(403)
        expect((await post('/api/sessions/x/codex/plan/implement', { planId: 'plan' })).status).toBe(403)
        t.store.setProfile('alice', t.project.id, 'workspace')
        expect(await (await post('/api/machines/x/spawn', { directory: t.project.rootPath, agent: 'codex' })).json()).toMatchObject({ permissionMode: 'default' })
    })
    test('fresh project spawns pass the saved canonical root and policy to the engine without a client directory', async () => {
        const t = setup(), { body } = await t.mint()
        const headers = { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }
        for (const directory of [undefined, '', '  ', t.project.rootPath, `${t.project.rootPath}/`]) {
            const response = await t.app.request('/api/machines/x/spawn', { method: 'POST', headers, body: JSON.stringify({ directory, agent: 'codex', model: 'selected-model', sessionType: 'simple' }) })
            expect(response.status).toBe(200)
            const args = t.spawnCalls.at(-1)!
            expect(args[0]).toBe('x')
            expect(args[1]).toBe(t.project.rootPath)
            expect(args[2]).toBe('codex')
            expect(args[3]).toBe('selected-model')
            expect(args[6]).toBe('simple')
            expect(args[10]).toBe('read-only')
            expect(args[16]).toBe(t.project.namespace)
            expect(args[17]).toBe(false)
        }
        expect(t.spawnCalls).toHaveLength(5)
    })
    test('explicit outside, nested, traversal and symlink paths never silently fall back to the project root', async () => {
        const t = setup(), { body } = await t.mint()
        mkdirSync(join(t.project.rootPath, 'child'))
        symlinkSync(t.project.rootPath, join(t.project.rootPath, 'alias'))
        const headers = { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }
        for (const directory of [tmpdir(), t.second.rootPath, join(t.project.rootPath, 'child'), `${t.project.rootPath}/child/..`, join(t.project.rootPath, 'alias'), 'relative']) {
            const response = await t.app.request('/api/machines/x/spawn', { method: 'POST', headers, body: JSON.stringify({ directory }) })
            expect(response.status).toBe(403)
            expect(await response.json()).toMatchObject({ code: 'project_directory_mismatch' })
        }
        expect(t.spawnCalls).toHaveLength(0)
    })
    test('switching projects changes the authoritative root and never carries the previous path or machine across', async () => {
        const t = setup()
        const next = t.store.createProject('alice', t.team.id, 'Next')
        t.machineNamespaces.set('next-machine', next.namespace)
        const previousToken = (await t.mint()).body.token, nextToken = (await t.mint(t.cookie, next.id)).body.token
        const post = (token: string, machine: string, value: unknown, selected = next.id) => t.app.request(`/api/machines/${machine}/spawn`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, origin: t.origin, 'content-type': 'application/json', 'x-hapi-project-id': selected }, body: JSON.stringify(value)
        })
        expect((await post(previousToken, 'x', {})).status).toBe(403)
        expect((await post(nextToken, 'next-machine', { directory: t.project.rootPath })).status).toBe(403)
        expect((await post(nextToken, 'x', {})).status).toBe(403)
        expect(t.spawnCalls).toHaveLength(0)
        expect((await post(nextToken, 'next-machine', {})).status).toBe(200)
        expect(t.spawnCalls[0]?.[1]).toBe(next.rootPath)
        expect(t.spawnCalls[0]?.[16]).toBe(next.namespace)
    })
    test('missing, non-directory, unset or symlink-replaced stored roots return a conflict before dispatch', async () => {
        for (const state of ['missing', 'file', 'unset', 'symlink']) {
            const t = setup(), { body } = await t.mint()
            if (state === 'unset') t.store.db.prepare('UPDATE evolved_projects SET root_path=? WHERE id=?').run('', t.project.id)
            else if (state === 'symlink') {
                const moved = `${t.project.rootPath}-previous`
                renameSync(t.project.rootPath, moved); directories.push(moved)
                symlinkSync(moved, t.project.rootPath)
            } else {
                rmSync(t.project.rootPath, { recursive: true })
                if (state === 'file') writeFileSync(t.project.rootPath, 'not a directory')
            }
            const response = await t.app.request('/api/machines/x/spawn', {
                method: 'POST', headers: { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }, body: '{}'
            })
            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({ code: 'project_root_unavailable' })
            expect(t.spawnCalls).toHaveLength(0)
        }
    })
    test('project worktree requests are rejected even for extended profiles before invoking the runner', async () => {
        const t = setup(), { body } = await t.mint()
        t.store.setProfile('alice', t.project.id, 'extended')
        for (const extra of [{ sessionType: 'worktree' }, { sessionType: 'simple', worktreeName: 'sibling' }, { worktreeName: '' }]) {
            const response = await t.app.request('/api/machines/x/spawn', {
                method: 'POST', headers: { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }, body: JSON.stringify(extra)
            })
            expect(response.status).toBe(400)
            expect(await response.json()).toMatchObject({ code: 'project_worktree_unavailable' })
        }
        expect(t.spawnCalls).toHaveLength(0)
    })
    test('rechecks session, project policy and machine authority after asynchronous body parsing', async () => {
        for (const change of ['logout', 'profile', 'root', 'machine']) {
            const t = setup()
            if (change === 'profile') t.store.setProfile('alice', t.project.id, 'workspace')
            const { body } = await t.mint()
            t.duringSpawnBodyRead(() => {
                if (change === 'logout') t.store.revokeSession(t.cookie)
                if (change === 'profile') t.store.setProfile('alice', t.project.id, 'restricted')
                if (change === 'root') t.store.db.prepare('UPDATE evolved_projects SET root_path=? WHERE id=?').run(t.second.rootPath, t.project.id)
                if (change === 'machine') t.machineNamespaces.set('x', t.second.namespace)
            })
            const response = await t.app.request('/api/machines/x/spawn', {
                method: 'POST', headers: { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' },
                body: JSON.stringify(change === 'profile' ? { agent: 'codex', permissionMode: 'default' } : {})
            })
            expect(response.status).toBe(change === 'machine' ? 403 : 401)
            expect(t.spawnCalls).toHaveLength(0)
        }
    })
    test('rechecks the root filesystem before engine dispatch even when the saved path has not changed', async () => {
        const t = setup(), { body } = await t.mint()
        t.duringSpawnBodyRead(() => rmSync(t.project.rootPath, { recursive: true }))
        const response = await t.app.request('/api/machines/x/spawn', {
            method: 'POST', headers: { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }, body: '{}'
        })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'project_root_unavailable' })
        expect(t.spawnCalls).toHaveLength(0)
    })
    test('runner directory discovery cannot cross the canonical project root', async () => {
        const t = setup(), { body } = await t.mint()
        symlinkSync(tmpdir(), join(t.project.rootPath, 'outside'))
        const post = (path: string, value: unknown) => t.app.request(path, { method: 'POST', headers: { authorization: `Bearer ${body.token}`, origin: t.origin, 'content-type': 'application/json' }, body: JSON.stringify(value) })
        expect((await post('/api/machines/x/list-directory', { path: t.project.rootPath })).status).toBe(200)
        for (const path of [tmpdir(), join(t.project.rootPath, 'outside'), '/etc', '']) expect((await post('/api/machines/x/list-directory', { path })).status).toBe(403)
        expect((await post('/api/machines/x/paths/exists', { paths: [join(t.project.rootPath, 'not-yet-created')] })).status).toBe(200)
        expect((await post('/api/machines/x/paths/exists', { paths: [join(t.project.rootPath, 'outside', 'not-yet-created')] })).status).toBe(403)
    })
})
