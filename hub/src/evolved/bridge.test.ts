import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
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
    const app = new Hono<WebAppEnv>()
    app.route('/api/evolved', createSessionTokenRoutes(store, secret, origin))
    app.use('/api/*', createProjectAuthMiddleware(store, secret, origin))
    app.get('/api/sessions', c => c.json({ ns: c.get('namespace') }))
    app.post('/api/sessions', c => c.json({ ok: true }))
    app.post('/api/machines/:id/list-directory', c => c.json({ ok: true }))
    app.post('/api/machines/:id/paths/exists', c => c.json({ ok: true }))
    app.post('/api/sessions/:id/codex/plan/implement', c => c.json({ ok: true }))
    app.route('/api', createMachinesRoutes(() => ({
        getMachine: () => ({ namespace: project.namespace, metadata: { capabilities: [MACHINE_CAPABILITIES.AgentAvailability] } }),
        spawnSession: async (...args: unknown[]) => ({ permissionMode: args[10] })
    }) as unknown as SyncEngine))
    const mint = async (session = cookie, id = project.id) => {
        const response = await app.request(`/api/evolved/session-token?projectId=${id}`, { headers: { cookie: `__Host-hapi-evolved=${session}` } })
        return { response, body: await response.json() as { token: string } }
    }
    return { store, team, project, second, cookie, secret, origin, app, mint }
}
describe('Evolved project boundary', () => {
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
