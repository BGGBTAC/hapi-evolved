import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolvedStore } from './store'
import { createReadinessRoutes } from './readiness'
import type { ProjectReadiness } from '@hapi/protocol/evolvedWorkspace'
import { CURRENT_MACHINE_CAPABILITIES, MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { SyncEngine } from '../sync/syncEngine'
import { createProviderRoutes } from './providers'
import { randomUUID } from 'node:crypto'
import { createDevelopmentService } from './development'
import { defaultDevelopmentSettings } from '@hapi/protocol/evolvedDevelopment'
import { developmentSettingsToModuleSettings } from '@hapi/protocol/developmentModules'

type LocalState = 'ready' | 'missing' | 'blocked' | 'unknown'
const repository = (root: string, id: string, name: string, state: LocalState, job?: 'running' | 'succeeded' | 'failed') => ({
    id, owner: 'acme', name, fullName: `acme/${name}`, permission: 'write', path: `${root}/repositories/acme/${name}`, cloneUrl: `https://github.com/acme/${name}.git`,
    local: { state, branch: state === 'ready' ? 'main' : null, dirty: state === 'ready' ? false : null, ...(state === 'blocked' ? { message: 'Lokaler Branch folgt einem anderen Upstream.' } : {}) },
    ...(job ? { job: { id: `job-${id}`, state: job } } : {}),
})
const catalogOf = (root: string, repositories: unknown[]) => ({ connected: true, rootPath: root, canSync: true, canPush: true, runner: { status: 'ready' }, repositories })

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function setup(providerMode?: 'unconfigured' | 'managed') {
    const root = mkdtempSync(join(tmpdir(), 'evolved-readiness-')), store = new EvolvedStore(':memory:')
    cleanups.push(() => store.close(), () => rmSync(root, { recursive: true, force: true }))
    for (const id of ['alice', 'bob']) store.db.query('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, 0, Date.now())
    const team = store.createTeam('alice', 'A'), project = store.createProject('alice', team.id, 'A')
    store.db.query("UPDATE evolved_projects SET root_path=?,profile='workspace' WHERE id=?").run(root, project.id)
    const machine = { id: 'machine', active: true, metadata: { workspaceRoots: [root], capabilities: [...CURRENT_MACHINE_CAPABILITIES] } }
    let probeFails = false, revoked = false, online = true, providerReads = 0, graphReads = 0
    const rpcCalls: unknown[] = []
    let repoReply: () => { status: number; body: unknown } = () => ({ status: 200, body: catalogOf(root, [repository(root, '101', 'one', 'ready')]) })
    let onRepositories: (() => void | Promise<void>) | undefined
    const development = createDevelopmentService({ store, vault: { request: async () => { throw new Error('Readiness must not call the Vault for development data') } }, getEngine: () => null })
    const controlCalls: string[] = []
    const providers = createProviderRoutes(store, { control: { async request(request) {
        controlCalls.push(request.action)
        if (request.action !== 'status') throw new Error('Readiness must never provision or discover models')
        return { providers: ['claude', 'codex'].map(provider => ({ provider, status: 'connected', method: 'subscription', checkedAt: Date.now() })) }
    } } })
    if (providerMode === 'managed') {
        const lease = randomUUID()
        store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(lease, 'Synthetic managed service', 'c'.repeat(64), 'alice', project.id, '["runner:connect"]', '[]', 'workspace', Date.now(), null)
        store.db.prepare('INSERT INTO evolved_managed_runners VALUES(?,?,1)').run(project.id, lease)
    }
    const engine = {
        getOnlineMachinesByNamespace: () => online ? [machine] : [],
        evolvedRepositories: async (_id: string, request: unknown) => { rpcCalls.push(request); if (probeFails) throw new Error('RPC target missing'); return [] },
        getAgentAvailability: async () => ({ agents: [{ agent: 'claude', available: true }] }),
    } as unknown as Pick<SyncEngine, 'getOnlineMachinesByNamespace' | 'evolvedRepositories' | 'getAgentAvailability'>
    const app = new Hono().route('/api/evolved', createReadinessRoutes({ store, origin: 'https://hapi.test', getEngine: () => engine,
        memoryAvailable: async () => false,
        graphStatus: () => { graphReads++; return { rootPath: root, checkedAt: Date.now(), status: 200, result: { state: 'ready', available: true } } },
        readResource: async (_request, _id, resource) => {
            if (revoked) { store.setMember('alice', team.id, 'bob', 'admin'); store.setMember('bob', team.id, 'alice', null) }
            if (resource === 'providers' && providerMode) {
                providerReads++
                const response = await providers.request(`https://hapi.test/projects/${project.id}/providers`, { headers: _request.headers })
                return { status: response.status, body: await response.json() }
            }
            if (resource === 'providers') { providerReads++; return { status: 200, body: { providers: [{ provider: 'claude', status: 'connected' }, { provider: 'codex', status: 'disconnected' }] } } }
            await onRepositories?.()
            return repoReply()
        },
        development: id => development.readinessSnapshot(id),
    }))
    const token = store.createSession('alice')
    const request = () => app.request(`https://hapi.test/api/evolved/projects/${project.id}/readiness`, { headers: { cookie: `__Host-hapi-evolved=${token}` } })
    let revision = 0
    /** Stores a v3 configuration exactly as the hub writes it (or a raw value) at the next revision. */
    const configure = (settings: unknown, raw = false) => {
        const value = raw ? String(settings) : JSON.stringify({ schemaVersion: 3, settings })
        if (revision === 0) store.db.prepare('INSERT INTO evolved_project_development VALUES(?,?,?,?,?,?,?,?)').run(project.id, ++revision, value, null, 'alice', Date.now(), null, null)
        else store.db.prepare('UPDATE evolved_project_development SET revision=?,settings=? WHERE project_id=?').run(++revision, value, project.id)
    }
    const bound = (repositoryId: string | null, mode: 'none' | 'odoo' = 'odoo') => developmentSettingsToModuleSettings({ ...defaultDevelopmentSettings(mode), repositoryId })
    return { store, team, project, request, rpcCalls, controlCalls, machine, root, configure, bound,
        setRepositories: (value: unknown[], status = 200) => { repoReply = () => ({ status, body: catalogOf(root, value) }) }, setRepoReply: (value: typeof repoReply) => { repoReply = value },
        onRepositories: (value?: typeof onRepositories) => { onRepositories = value }, setProbeFails: () => { probeFails = true }, revoke: () => { revoked = true }, offline: () => { online = false }, counts: () => ({ providerReads, graphReads }) }
}
describe('project readiness without provisioning', () => {
    test('the real provider GET performs only status on an existing lease and never prepares a missing runner', async () => {
        const absent = setup('unconfigured')
        const missing = await (await absent.request()).json() as ProjectReadiness
        expect(missing.items.find(item => item.key === 'providers')?.reasonCode).toBe('provider_unconfigured')
        expect(absent.controlCalls).toEqual([])
        expect(absent.store.db.query('SELECT COUNT(*) AS n FROM evolved_runner_leases').get()).toEqual({ n: 0 })
        const managed = setup('managed')
        const ready = await (await managed.request()).json() as ProjectReadiness
        expect(ready.items.find(item => item.key === 'providers')?.state).toBe('ok')
        expect(managed.controlCalls).toEqual(['status'])
        expect(managed.store.db.query('SELECT COUNT(*) AS n FROM evolved_runner_leases').get()).toEqual({ n: 1 })
        expect(managed.counts().graphReads).toBe(1) // Cache callback only; no worker request exists on this route.
    })
    test('an older runner keeps session readiness while the optional worktree view needs an upgrade', async () => {
        const f = setup()
        f.machine.metadata.capabilities = f.machine.metadata.capabilities.filter(capability => capability !== MACHINE_CAPABILITIES.EvolvedRepositoryWorktree)
        const response = await f.request(), body = await response.json() as ProjectReadiness
        expect(response.status).toBe(200)
        expect(body.purposes).toEqual({ plan: 'ok', code: 'ok', module: null })
        expect(body.items.find(item => item.key === 'runner')?.state).toBe('ok')
        expect(body.items.find(item => item.key === 'rpc')?.state).toBe('ok')
        expect(body.items.find(item => item.key === 'worktree')).toMatchObject({ state: 'stale', reasonCode: 'runner_upgrade_required' })
        expect(f.rpcCalls).toHaveLength(1)
    })
    test('uses an empty read-only RPC probe and cached graph state; optional graph memory is independent', async () => {
        const f = setup(), response = await f.request(), body = await response.json() as ProjectReadiness
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(f.rpcCalls).toEqual([{ action: 'status', projectId: f.project.id, repositories: [] }])
        expect(body.purposes).toEqual({ plan: 'ok', code: 'ok', module: null })
        expect(body.items.find(item => item.key === 'memory')?.reasonCode).toBe('memory_ledger_ready')
        expect(f.counts()).toEqual({ providerReads: 1, graphReads: 1 })
        const cached = await (await f.request()).json() as ProjectReadiness
        expect(cached.checkedAt).toBe(body.checkedAt)
        expect(f.counts()).toEqual({ providerReads: 1, graphReads: 1 })
        f.store.setMember('alice', f.team.id, 'bob', 'admin'); f.store.setMember('bob', f.team.id, 'alice', null)
        expect((await f.request()).status).toBe(403)
    })
    test('active socket with missing RPC is stale, offline is missing, neither is ready', async () => {
        const f = setup(); f.setProbeFails()
        const body = await (await f.request()).json() as ProjectReadiness
        expect(body.items.find(item => item.key === 'rpc')?.state).toBe('stale')
        expect(body.purposes.plan).toBe('stale')
        f.offline()
        const offline = await (await f.request()).json() as ProjectReadiness
        expect(offline.items.find(item => item.key === 'runner')?.state).toBe('missing')
        expect(offline.purposes.plan).toBe('missing')
    })
    test('viewers can read diagnostics but never cause an admin provider read', async () => {
        const f = setup()
        f.store.setMember('alice', f.team.id, 'bob', 'admin'); f.store.setMember('bob', f.team.id, 'alice', 'viewer')
        const body = await (await f.request()).json() as ProjectReadiness
        expect(body.items.find(item => item.key === 'providers')?.state).toBe('denied')
        expect(body.items.find(item => item.key === 'agents')?.state).toBe('denied')
        expect(f.counts().providerReads).toBe(0)
    })
    test('authority revoked while diagnostics await prevents every partial response', async () => {
        const f = setup(); f.revoke()
        expect((await f.request()).status).toBe(403)
    })
})

describe('code readiness follows the configured default repository', () => {
    const item = (body: ProjectReadiness, key: string) => body.items.find(entry => entry.key === key)
    test('a blocked or missing bound repository is never green because another checkout is ready', async () => {
        for (const [state, reason] of [['blocked', 'default_checkout_blocked'], ['missing', 'default_checkout_missing']] as const) {
            const f = setup()
            f.configure(f.bound('101'))
            f.setRepositories([repository(f.root, '101', 'one', state), repository(f.root, '202', 'two', 'ready')])
            const body = await (await f.request()).json() as ProjectReadiness
            expect(item(body, 'repositories')).toMatchObject({ state: 'missing', reasonCode: reason })
            expect(body.purposes).toEqual({ plan: 'ok', code: 'missing', module: 'missing' })
            expect(item(body, 'development')).toMatchObject({ state: 'ok', reasonCode: 'module_ready' })
            expect(body.configRevision).toBe(1)
        }
    })
    test('the bound repository absent from the grants, a running job or an unknown local state are distinct and not ready', async () => {
        const cases: Array<[unknown[], ProjectReadiness['purposes']['code'], string]> = [
            [[repository('', '202', 'two', 'ready')], 'missing', 'default_repository_not_listed'],
            [[repository('', '101', 'one', 'ready', 'running')], 'stale', 'default_checkout_job_running'],
            [[repository('', '101', 'one', 'unknown')], 'stale', 'default_checkout_unconfirmed'],
        ]
        for (const [repositories, state, reasonCode] of cases) {
            const f = setup()
            f.configure(f.bound('101'))
            f.setRepositories((repositories as any[]).map(repo => ({ ...repo, path: `${f.root}/repositories/${repo.fullName}` })))
            const body = await (await f.request()).json() as ProjectReadiness
            expect(item(body, 'repositories')).toMatchObject({ state, reasonCode })
            expect(body.purposes.code).toBe(state)
        }
    })
    test('malformed or failed repository catalogues are unknown, never ready', async () => {
        const replies = [() => ({ status: 200, body: { connected: true, repositories: [{ id: '101', local: { state: 'ready' } }] } }), () => ({ status: 500, body: null }), () => ({ status: 200, body: 'x' })]
        for (const bound of ['101', null]) for (const reply of replies) {
            const f = setup()
            f.configure(f.bound(bound))
            f.setRepoReply(reply)
            const body = await (await f.request()).json() as ProjectReadiness
            expect(item(body, 'repositories')!.state).toBe('unknown')
            expect(body.purposes.code).toBe('unknown')
        }
    })
    test('switching the bound repository within the cache TTL is visible immediately, both ways; an unchanged config reuses the cache', async () => {
        const f = setup()
        f.setRepositories([repository(f.root, '101', 'one', 'ready')])
        f.configure(f.bound('101'))
        const first = await (await f.request()).json() as ProjectReadiness
        expect(first.purposes.code).toBe('ok')
        const reads = f.counts().providerReads
        expect((await (await f.request()).json() as ProjectReadiness).checkedAt).toBe(first.checkedAt)
        expect(f.counts().providerReads).toBe(reads)
        f.configure(f.bound('202'))
        const switched = await (await f.request()).json() as ProjectReadiness
        expect(switched).toMatchObject({ configRevision: 2, purposes: { code: 'missing' } })
        expect(item(switched, 'repositories')!.reasonCode).toBe('default_repository_not_listed')
        f.configure(f.bound('101'))
        expect((await (await f.request()).json() as ProjectReadiness)).toMatchObject({ configRevision: 3, purposes: { code: 'ok' } })
    })
    test('a configuration change while the probes await marks the result stale and does not cache it', async () => {
        const f = setup()
        f.configure(f.bound('101'))
        f.onRepositories(() => { f.onRepositories(); f.configure(f.bound('202')) })
        const body = await (await f.request()).json() as ProjectReadiness
        expect(item(body, 'repositories')).toMatchObject({ state: 'stale', reasonCode: 'development_changed' })
        expect(body.purposes.code).toBe('stale')
        const next = await (await f.request()).json() as ProjectReadiness
        expect(next).toMatchObject({ configRevision: 2, purposes: { code: 'missing' } })
    })
    test('unreadable or newer configurations and unavailable modules never become ready', async () => {
        const f = setup()
        f.configure('{"schemaVersion":3,"settings":{"broken":true}}', true)
        const invalid = await (await f.request()).json() as ProjectReadiness
        expect(item(invalid, 'repositories')).toMatchObject({ state: 'unknown', reasonCode: 'development_config_unreadable' })
        expect(item(invalid, 'development')).toMatchObject({ state: 'unknown', reasonCode: 'development_config_invalid' })
        expect(invalid.purposes).toMatchObject({ code: 'unknown', module: 'unknown' })
        f.configure('{"schemaVersion":9,"settings":{}}', true)
        const future = await (await f.request()).json() as ProjectReadiness
        expect(item(future, 'development')!.reasonCode).toBe('development_config_version_unsupported')
        expect(future.purposes.code).toBe('unknown')
        const plugin = `plugin:${randomUUID()}:missing`
        f.configure({ ...f.bound('101', 'none'), activeModuleId: plugin, modules: { [plugin]: { moduleDigest: `sha256:${'a'.repeat(64)}`, settingsVersion: 1, values: {},
            adopted: { pluginId: plugin.split(':')[1], pluginVersion: '1.0.0', repository: 'acme/plugin', commitSha: 'b'.repeat(40), manifestSha256: 'c'.repeat(64), at: 1 } } } })
        const missing = await (await f.request()).json() as ProjectReadiness
        expect(item(missing, 'development')).toMatchObject({ state: 'missing', reasonCode: 'module_missing' })
        // Ordinary code work in the bound checkout stays possible; module work is reported separately.
        expect(missing.purposes).toMatchObject({ code: 'ok', module: 'missing' })
    })
    test('without a bound repository any ready checkout keeps the general code purpose, and no module means module=null', async () => {
        const f = setup()
        f.configure(f.bound(null, 'none'))
        f.setRepositories([repository(f.root, '101', 'one', 'missing'), repository(f.root, '202', 'two', 'ready')])
        const body = await (await f.request()).json() as ProjectReadiness
        expect(item(body, 'repositories')!.reasonCode).toBe('checkout_ready')
        expect(item(body, 'development')).toBeUndefined()
        expect(body.purposes).toEqual({ plan: 'ok', code: 'ok', module: null })
    })
})
