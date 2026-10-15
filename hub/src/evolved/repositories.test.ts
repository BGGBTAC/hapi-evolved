import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { createRepositoryRoutes } from './repositories'
import { createEvolvedRoutes } from './api'
import { EvolvedError, EvolvedStore, hashToken, randomToken } from './store'
import { SESSION_COOKIE } from './security'
import type { VaultClient } from './vault'
import type { SyncEngine } from '../sync/syncEngine'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const repo = { id: '123456', owner: 'example-owner', name: 'project-repo', fullName: 'example-owner/project-repo', permission: 'read' as const }
const ready = { state: 'ready', branch: 'main', dirty: false }
function setup() {
    const store = new EvolvedStore(':memory:')
    for (const user of ['admin', 'member', 'viewer']) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(user, user, user === 'admin' ? 1 : 0, Date.now())
    const team = store.createTeam('admin', 'Team')
    store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    const created = store.createProject('admin', team.id, 'Project')
    store.db.prepare('UPDATE evolved_projects SET root_path=?,profile=? WHERE id=?').run(`/managed-workspaces/${created.id}`, 'workspace', created.id)
    const project = store.requireProject('admin', created.id), other = store.createProject('admin', team.id, 'Other')
    const sessions = Object.fromEntries(['admin', 'member', 'viewer'].map(user => [user, store.createSession(user)]))
    let granted = true, machineState: 'ready' | 'offline' | 'upgrade' | 'ambiguous' = 'ready'
    const calls: unknown[] = [], vaultCalls: string[] = []
    let run: (params: any) => Promise<unknown> = async params => params.action === 'status' ? [{ id: repo.id, local: ready }] : { local: ready }
    const engine = {
        getOnlineMachinesByNamespace: (namespace: string) => {
            expect(namespace).toBe(project.namespace)
            if (machineState === 'offline') return []
            return Array.from({ length: machineState === 'ambiguous' ? 2 : 1 }, (_, index) => ({ id: `machine-${index}`, metadata: { workspaceRoots: [project.rootPath], capabilities: machineState === 'upgrade' ? [] : [MACHINE_CAPABILITIES.EvolvedRepositories] } }))
        },
        evolvedRepositories: async (_id: string, params: any) => { calls.push(params); return run(params) }
    } as unknown as Pick<SyncEngine, 'getOnlineMachinesByNamespace' | 'evolvedRepositories'>
    const vault: VaultClient = { request: async request => {
        vaultCalls.push(request.operation)
        return request.operation === 'github' ? { connected: true, repositories: granted ? [repo] : [] } : { resources: [{ id: 'secret-action' }] }
    } }
    const origin = 'https://evolved.example.test', routes = createRepositoryRoutes({ store, vault, origin, getEngine: () => engine })
    const app = new Hono()
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code, error: error.message }, error.status as 400) : c.json({ code: 'internal_error' }, 500))
    app.route('/api/evolved', routes.routes)
    app.route('/api/evolved', createEvolvedRoutes({ store, vault, origin, repositoryDiscovery: routes.discovery }))
    const request = (suffix = '/repositories', options: { user?: string; token?: string; method?: string; body?: unknown; projectId?: string; origin?: string } = {}) => app.request(`${origin}/api/evolved/projects/${options.projectId ?? project.id}${suffix}`, {
        method: options.method ?? 'GET', headers: { origin: options.origin ?? origin, 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : { cookie: `${SESSION_COOKIE}=${sessions[options.user ?? 'member']}` }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
    const capability = (scopes = ['runner:connect', 'git:read'], lease = true) => {
        const leaseId = randomUUID(), token = randomToken()
        if (lease) store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(leaseId, 'Runner', hashToken(token), 'admin', project.id, JSON.stringify(scopes), '[]', store.requireProject('admin', project.id).profile, Date.now(), Date.now() + 3600_000)
        return store.issueCapability('admin', project.id, scopes, [], 900, lease ? leaseId : null)
    }
    const sync = (options: Parameters<typeof request>[1] = {}, action = 'clone', requestId = randomUUID()) => request(`/repositories/${repo.id}/sync`, { ...options, method: 'POST', body: { action, requestId } })
    const waitJob = async (jobId: string) => {
        for (let i = 0; i < 50; i++) {
            const response = await request(`/repository-jobs/${jobId}`), body = await response.json() as any
            if (body.job?.state !== 'running') return body.job
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        throw new Error('Job did not settle')
    }
    cleanups.push(() => { routes.close(); store.close() })
    return { store, project, other, sessions, request, sync, waitJob, capability, calls, vaultCalls, routes, vault,
        setGranted: (value: boolean) => { granted = value }, setMachine: (value: typeof machineState) => { machineState = value }, setRun: (value: typeof run) => { run = value } }
}

describe('project repository discovery', () => {
    test('returns exact authorized metadata and a deterministic path without GitHub login or resource scopes', async () => {
        const s = setup(), token = s.capability().token
        const body = await (await s.request('/repositories?workspace=0', { token })).json() as any
        expect(body.repositories[0]).toEqual({ ...repo, canPush: false, cloneUrl: 'https://github.com/example-owner/project-repo.git', path: `${s.project.rootPath}/repositories/example-owner/project-repo`, local: { state: 'unknown', branch: null, dirty: null } })
        expect(body.canSync).toBe(true); expect(body.canPush).toBe(false); expect(s.calls).toHaveLength(0)
        const resources = await (await s.request('/resources', { token })).json() as any
        expect(resources.resources).toEqual([]); expect(resources.repositories[0].fullName).toBe(repo.fullName)
        expect(resources.git.instructions).toContain('never guess'); expect(s.vaultCalls).not.toContain('resources')
    })
    test('rejects standalone, missing-scope, cross-project capabilities and hostile origins', async () => {
        const s = setup()
        for (const token of [s.capability(['git:read']).token, s.capability(['runner:connect']).token, s.capability(undefined, false).token]) expect((await s.request('/repositories', { token })).status).toBe(403)
        expect((await s.request('/repositories', { token: s.capability().token, projectId: s.other.id })).status).toBe(403)
        expect((await s.sync({ origin: 'https://evil.example.test' })).status).toBe(403)
    })
    test('resource discovery rejects a foreign project before any Vault request', async () => {
        const s = setup(), token = s.capability(['runner:connect', 'git:read', 'resource:execute']).token
        expect((await s.request('/resources', { token, projectId: s.other.id })).status).toBe(403)
        expect(s.vaultCalls).toEqual([])
    })
    test('an unavailable optional Git catalog does not hide independently granted resource actions', async () => {
        const s = setup()
        s.vault.request = async request => {
            if (request.operation === 'github') throw new EvolvedError('service_unavailable', 'Internal synthetic detail', 503)
            return { resources: [{ id: 'authorized-action' }] }
        }
        const response = await s.request('/resources'), body = await response.json() as any
        expect(response.status).toBe(200); expect(body.resources).toEqual([{ id: 'authorized-action' }])
        expect(body.git.error).toContain('vorübergehend'); expect(JSON.stringify(body)).not.toContain('Internal synthetic detail')
        expect((await s.request('/resources', { token: s.capability().token })).status).toBe(503)
    })
    test('concurrent local inspections share one RPC and a short result cache', async () => {
        const s = setup()
        let release!: () => void
        s.setRun(async () => { await new Promise<void>(resolve => { release = resolve }); return [{ id: repo.id, local: ready }] })
        const one = s.request(), two = s.request()
        for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
        expect(s.calls).toHaveLength(1); release()
        expect((await one).status).toBe(200); expect((await two).status).toBe(200)
        expect((await s.request()).status).toBe(200); expect(s.calls).toHaveLength(1)
    })
    test('viewer can read the catalog but cannot mutate; restricted profiles do not silently elevate', async () => {
        const s = setup()
        expect((await s.request('/repositories', { user: 'viewer' })).status).toBe(200)
        expect((await s.sync({ user: 'viewer' })).status).toBe(403)
        s.store.setProfile('admin', s.project.id, 'restricted')
        expect((await s.sync()).status).toBe(403)
        expect(s.store.requireProject('admin', s.project.id).profile).toBe('restricted')
    })
    test('offline, old and ambiguous runners do not hide grants or invent an empty checkout', async () => {
        const s = setup()
        for (const state of ['offline', 'upgrade', 'ambiguous'] as const) {
            s.setMachine(state)
            const body = await (await s.request()).json() as any
            expect(body.repositories[0].fullName).toBe(repo.fullName); expect(body.repositories[0].local.state).toBe('unknown'); expect(body.canSync).toBe(false)
            expect((await s.sync()).status).toBe(409)
        }
        s.setMachine('ready'); s.setRun(async () => { throw new Error('private internal text') })
        const body = await (await s.request()).json() as any
        expect(body.repositories[0].local.state).toBe('unknown'); expect(JSON.stringify(body)).not.toContain('private')
    })
    test('rechecks the current session after a delayed catalog read', async () => {
        const s = setup()
        s.vault.request = async () => { s.store.revokeSession(s.sessions.member!); return { connected: true, repositories: [repo] } }
        const response = await s.request()
        expect(response.status).toBe(401); expect(await response.text()).not.toContain(repo.fullName)
    })
})

describe('repository sync jobs', () => {
    test('rejects a naturally expiring initiating capability before creating any job', async () => {
        const s = setup(), capability = s.capability()
        s.store.db.prepare('UPDATE evolved_capabilities SET expires_at=? WHERE id=?').run(Date.now() + 120_000, capability.id)
        const response = await s.sync({ token: capability.token })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'repository_capability_refresh_required' })
        expect(s.calls).toHaveLength(0)
        expect(s.store.db.prepare('SELECT COUNT(*) AS count FROM evolved_repository_jobs').get()).toEqual({ count: 0 })
    })
    test('a member can clone a read grant and repeated request IDs cannot start duplicate work', async () => {
        const s = setup(), requestId = randomUUID()
        const response = await s.sync({}, 'clone', requestId), body = await response.json() as any
        expect(response.status).toBe(202)
        expect((await s.waitJob(body.job.id)).state).toBe('succeeded')
        expect(await (await s.sync({}, 'clone', requestId)).json()).toEqual({ job: expect.objectContaining({ id: body.job.id, state: 'succeeded' }) })
        expect(s.calls).toHaveLength(1)
        expect((await s.sync({}, 'pull', requestId)).status).toBe(409)
        expect((await s.request(`/repository-jobs/${body.job.id}`, { projectId: s.other.id })).status).toBe(404)
    })
    test('runner authorization is bound to the job, repository and live user permission', async () => {
        const s = setup(), token = s.capability().token
        let release!: () => void
        s.setRun(async () => { await new Promise<void>(resolve => { release = resolve }); return { local: ready } })
        const { job } = await (await s.sync()).json() as any
        for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
        const path = `/repositories/${repo.id}/authorization?jobId=${job.id}`
        expect((await s.request(path, { token })).status).toBe(200)
        expect((await s.request(path)).status).toBe(403)
        expect((await s.request(`/repositories/999/authorization?jobId=${job.id}`, { token })).status).toBe(403)
        expect((await s.sync()).status).toBe(409)
        s.store.revokeSession(s.sessions.member!)
        expect((await s.request(path, { token })).status).toBe(401)
        release()
        await new Promise(resolve => setTimeout(resolve, 10))
        const status = await (await s.request(`/repository-jobs/${job.id}`, { user: 'admin' })).json() as any
        expect(status.job.state).toBe('failed')
    })
    test('revoked repositories cannot complete a running job successfully', async () => {
        const s = setup()
        s.setRun(async () => { s.setGranted(false); return { local: ready } })
        const { job } = await (await s.sync()).json() as any
        expect((await s.waitJob(job.id)).state).toBe('failed')
        expect((await s.sync()).status).toBe(403)
    })
    test.each(['profile', 'root', 'role'] as const)('a changed %s invalidates the pending operation', async change => {
        const s = setup()
        s.setRun(async () => {
            if (change === 'profile') s.store.setProfile('admin', s.project.id, 'extended')
            else if (change === 'root') s.store.db.prepare('UPDATE evolved_projects SET root_path=? WHERE id=?').run('/workspaces/replaced', s.project.id)
            else s.store.setMember('admin', s.project.teamId, 'member', 'viewer')
            return { local: ready }
        })
        const { job } = await (await s.sync()).json() as any
        expect((await s.waitJob(job.id)).state).toBe('failed')
    })
    test('blocked local work returns a useful fixed error and cannot be reported as success', async () => {
        const s = setup()
        s.setRun(async () => ({ local: { state: 'blocked', branch: 'main', dirty: true, message: 'Lokale Änderungen zuerst committen.' } }))
        const { job } = await (await s.sync({}, 'pull')).json() as any
        expect(await s.waitJob(job.id)).toMatchObject({ state: 'failed', message: 'Lokale Änderungen zuerst committen.' })
    })
    test('invalid or arbitrary payloads never execute RPCs', async () => {
        const s = setup()
        for (const body of [{ action: 'reset', requestId: randomUUID() }, { action: 'clone', requestId: randomUUID(), path: '/tmp/elsewhere' }, { action: 'clone', requestId: 'not-a-uuid' }]) {
            expect((await s.request(`/repositories/${repo.id}/sync`, { method: 'POST', body })).status).toBe(400)
        }
        expect(s.calls).toHaveLength(0)
    })
})
