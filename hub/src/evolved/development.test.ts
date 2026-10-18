import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import {
    DevelopmentBuildStatusResponseSchema, DevelopmentConfigResponseSchema, DevelopmentContextSchema, DevelopmentDoctorResponseSchema, DevelopmentInspectResponseSchema,
    DevelopmentIntegrationStatusSchema, DevelopmentKnowledgeResponseSchema, DevelopmentSettingsSchema, EVOLVED_DEVELOPMENT_CAPABILITY, defaultAndroidSettings, defaultDevelopmentSettings, defaultOdooSettings, type DevelopmentSettings,
} from '@hapi/protocol/evolvedDevelopment'
import { createDevelopmentService, developmentIntegrations } from './development'
import { createEvolvedRoutes } from './api'
import { createAgentCatalogRoutes } from './agentCatalog'
import { PluginService } from './plugins'
import { EvolvedError, EvolvedStore, hashToken, randomToken } from './store'
import { SESSION_COOKIE } from './security'
import type { VaultClient, VaultRequest } from './vault'
import type { RepositoryStartResolver } from './repositoryWorkflow'
import type { SyncEngine } from '../sync/syncEngine'
import { createMachinesRoutes } from '../web/routes/machines'
import type { EvolvedAccess } from './bridge'

const stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const origin = 'https://evolved.example.test'
const repo = { id: '123456', owner: 'acme', name: 'addons', fullName: 'acme/addons', permission: 'write' as const }
const sha = 'd'.repeat(40)

function doctorResult(mode = 'odoo', overrides: Record<string, unknown> = {}) {
    return { contractVersion: 1, mode, observedAt: Date.now(), durationMs: 12, host: { os: 'linux', arch: 'x64', image: 'hapi-evolved-runner-development:0.1.0' }, truncated: false,
        checks: [{ id: 'python', label: 'Python', category: 'runtime', state: 'ready', version: 'Python 3.13.5' }, { id: 'odoo.source', label: 'Odoo source', category: 'toolchain', state: 'missing', remedy: { kind: 'recipe', recipeId: 'odoo-source', text: 'Run setup.' } }], ...overrides }
}
function inspectResult(overrides: Record<string, unknown> = {}) {
    return { contractVersion: 1, mode: 'odoo', repositoryId: repo.id, observedAt: Date.now(), head: sha, branch: 'main', state: 'ready', odooModules: [], buildFiles: [], warnings: [], scanned: { files: 3, directories: 1, limitReached: false }, ...overrides }
}

function setup() {
    let now = Date.now()
    const store = new EvolvedStore(':memory:', { now: () => now }); stores.push(store)
    for (const [id, admin] of [['admin', 1], ['member', 0], ['viewer', 0], ['outsider', 0]] as const) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, admin, Date.now())
    const team = store.createTeam('admin', 'Team')
    store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    const project = store.createProject('admin', team.id, 'Project'), other = store.createProject('admin', team.id, 'Other')
    store.db.prepare("UPDATE evolved_projects SET profile='workspace' WHERE id=?").run(project.id)
    const sessions = Object.fromEntries(['admin', 'member', 'viewer', 'outsider'].map(user => [user, store.createSession(user)]))
    let repositories = [repo], connected = true, vaultFails = false
    let statusResult: (request: VaultRequest) => unknown = request => ({ state: 'success', repositoryId: String(request.payload.repositoryId), fullName: repo.fullName, ref: String(request.payload.ref ?? 'main'), sha, observedAt: 1, totalCount: 1, truncated: false, statuses: [{ context: 'ci', state: 'success', description: null, targetUrl: null, updatedAt: null }] })
    const vaultCalls: VaultRequest[] = []
    let onVault: ((request: VaultRequest) => void | Promise<void>) | undefined
    const vault: VaultClient = { request: async request => {
        vaultCalls.push(request); await onVault?.(request)
        if (vaultFails) throw new EvolvedError('vault_unavailable', 'down', 503)
        if (request.operation === 'github' && request.payload.action === 'status') return { connected, repositories }
        if (request.operation === 'github' && request.payload.action === 'commitStatus') return statusResult(request)
        return {}
    } }
    let capabilities: string[] = [EVOLVED_DEVELOPMENT_CAPABILITY, MACHINE_CAPABILITIES.AgentAvailability], machines = 1
    const rpcCalls: Array<{ machineId: string; params: any; timeout?: number }> = []
    let rpc: (params: any) => unknown | Promise<unknown> = params => params.action === 'doctor' ? doctorResult(params.mode) : inspectResult()
    const engine = {
        getOnlineMachinesByNamespace: (namespace: string) => namespace === project.namespace ? Array.from({ length: machines }, (_, index) => ({ id: `machine-${index}`, active: true, metadata: { workspaceRoots: [project.rootPath], capabilities } })) : [],
        evolvedDevelopment: async (machineId: string, params: unknown, timeout?: number) => { rpcCalls.push({ machineId, params, timeout }); return rpc(params) },
    }
    const service = createDevelopmentService({ store, vault, getEngine: () => engine as never })
    const app = new Hono()
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code, error: error.message }, error.status as 400) : c.json({ code: 'internal', error: String(error) }, 500))
    app.route('/api/evolved', service.routes(origin))
    app.route('/api/evolved', createEvolvedRoutes({ store, vault, origin }))
    const call = (path: string, options: { method?: string; user?: string; token?: string; body?: unknown; origin?: string; projectId?: string; cookieAndBearer?: boolean } = {}) =>
        app.request(`${origin}/api/evolved/projects/${options.projectId ?? project.id}/development${path}`, {
            method: options.method ?? 'GET',
            headers: { origin: options.origin ?? origin, 'content-type': 'application/json',
                ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(!options.token || options.cookieAndBearer ? { cookie: `${SESSION_COOKIE}=${sessions[options.user ?? 'admin']}` } : {}) },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        })
    const capability = (scopes = ['runner:connect', 'git:read'], options: { lease?: boolean; projectId?: string } = {}) => {
        const projectId = options.projectId ?? project.id, leaseId = randomUUID()
        if (options.lease !== false) store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(leaseId, 'Runner', hashToken(randomToken()), 'admin', projectId, JSON.stringify(scopes), '[]', store.requireProject('admin', projectId).profile, Date.now(), null)
        return store.issueCapability('admin', projectId, scopes, [], 900, options.lease === false ? null : leaseId).token
    }
    const odoo = (patch: Partial<DevelopmentSettings> = {}, odooPatch: Partial<NonNullable<DevelopmentSettings['odoo']>> = {}): DevelopmentSettings => ({ ...defaultDevelopmentSettings('odoo'), ...patch, odoo: { ...defaultOdooSettings(20), ...odooPatch } })
    const save = async (settings: DevelopmentSettings, expectedRevision?: number, user = 'admin') => {
        const revision = expectedRevision ?? (await (await call('', { user: 'admin' })).json() as any).config.revision
        return call('', { method: 'PUT', user, body: { expectedRevision: revision, settings } })
    }
    return { store, project, other, team, sessions, call, capability, save, odoo, service, engine, vaultCalls, rpcCalls, app,
        setRepositories: (value: typeof repositories) => { repositories = value }, disconnect: () => { connected = false }, failVault: (value: boolean) => { vaultFails = value },
        setRpc: (value: typeof rpc) => { rpc = value }, setCapabilities: (value: string[]) => { capabilities = value }, setMachines: (value: number) => { machines = value },
        setStatus: (value: typeof statusResult) => { statusResult = value }, onVault: (value?: typeof onVault) => { onVault = value }, advance: (ms: number) => { now += ms } }
}

describe('development configuration', () => {
    test('defaults to mode none with revision 0 and returns the bundled catalog', async () => {
        const t = setup(), response = await t.call('', { user: 'viewer' })
        expect(response.status).toBe(200)
        const body = DevelopmentConfigResponseSchema.parse(await response.json())
        expect(body.config).toMatchObject({ revision: 0, settings: { mode: 'none', repositoryId: null }, updatedBy: null })
        expect(body.canEdit).toBe(false)
        expect(body.catalog.modes.map(mode => mode.mode)).toEqual(['odoo', 'ios', 'android'])
    })
    test('compare-and-set rejects stale tabs with the current config and never changes the execution profile or grants', async () => {
        const t = setup()
        const first = await t.save(t.odoo({ repositoryId: repo.id }), 0)
        expect(first.status).toBe(200)
        const saved = (await first.json() as any).config
        expect(saved).toMatchObject({ revision: 1, settings: { mode: 'odoo', repositoryId: repo.id }, updatedBy: { id: 'admin' } })
        expect(saved.savedPackRevision).toMatch(/^fnv1a64:/)
        const stale = await t.save(t.odoo({}, { major: 19 }), 0)
        expect(stale.status).toBe(409)
        const conflict = await stale.json() as any
        expect(conflict.code).toBe('development_revision_conflict')
        expect(conflict.config.revision).toBe(1)
        expect(conflict.config.settings.odoo.major).toBe(20)
        expect((await t.save(t.odoo({ repositoryId: repo.id }, { major: 19 }), 1)).status).toBe(200)
        expect(t.store.requireProject('admin', t.project.id).profile).toBe('workspace')
        expect(t.vaultCalls.every(call => call.payload.action === 'status')).toBe(true)
    })
    test('only human project admins with the right origin can change it', async () => {
        const t = setup(), settings = t.odoo()
        expect((await t.save(settings, 0, 'member')).status).toBe(403)
        expect((await t.save(settings, 0, 'viewer')).status).toBe(403)
        expect((await t.save(settings, 0, 'outsider')).status).toBe(403)
        expect((await t.call('', { method: 'PUT', origin: 'https://evil.test', body: { expectedRevision: 0, settings } })).status).toBe(403)
        expect((await t.call('', { method: 'PUT', token: t.capability(['runner:connect', 'git:read', 'git:write']), body: { expectedRevision: 0, settings } })).status).toBe(403)
        expect((await t.call('', { method: 'PUT', body: { expectedRevision: 0, settings, profile: 'extended' } })).status).toBe(400)
        expect((await (await t.call('', { user: 'admin' })).json() as any).config.revision).toBe(0)
    })
    test('rejects injected values in settings', async () => {
        const t = setup()
        for (const odooPatch of [{ developmentBranch: '-c core.sshCommand=evil' }, { modules: ['sale;rm -rf /'] }, { addonsPaths: ['../outside'] }, { addonsPaths: ['/etc'] },
            { hosting: 'odoo_sh' as const, odooSh: { dashboardUrl: 'https://user:pw@www.odoo.sh/project/x', buildId: null, buildHost: null, sshResourceId: null } },
            { hosting: 'odoo_sh' as const, odooSh: { dashboardUrl: null, buildId: '1', buildHost: 'evil.example.com', sshResourceId: null } }, { testDatabaseSlug: 'prod; DROP' }]) {
            expect((await t.save(t.odoo({}, odooPatch as never), 0)).status).toBe(400)
        }
        const android = { ...defaultDevelopmentSettings('android') }
        android.android = { ...android.android!, module: ':app && curl evil', variant: 'debug' }
        expect((await t.save(android, 0)).status).toBe(400)
        const ios = { ...defaultDevelopmentSettings('ios') }
        ios.ios = { ...ios.ios!, scheme: '$(touch /tmp/x)' }
        expect((await t.save(ios, 0)).status).toBe(400)
    })
    test('newly referenced repositories must be current grants; unchanged stale references stay and are reported', async () => {
        const t = setup()
        expect((await t.save(t.odoo({ repositoryId: '999' }), 0)).status).toBe(409)
        t.failVault(true)
        const unverified = await t.save(t.odoo({ repositoryId: repo.id }), 0)
        expect(unverified.status).toBe(503)
        t.failVault(false)
        expect((await t.save(t.odoo({ repositoryId: repo.id }), 0)).status).toBe(200)
        t.setRepositories([])
        expect((await t.save(t.odoo({ repositoryId: repo.id }, { major: 19 }), 1)).status).toBe(200)
        const context = DevelopmentContextSchema.parse(await (await t.call('/context', { user: 'viewer' })).json())
        expect(context.repository.state).toBe('not_granted')
    })
    test('access revoked during the grant lookup cannot save', async () => {
        const t = setup()
        t.onVault(() => { t.store.db.prepare("INSERT INTO evolved_project_roles VALUES(?,?,?)").run(t.project.id, 'admin', 'viewer') })
        expect((await t.save(t.odoo({ repositoryId: repo.id }), 0)).status).toBe(403)
        t.onVault()
        expect(t.store.db.query('SELECT 1 FROM evolved_project_development').get()).toBeNull()
    })
    test('android licence acknowledgement is recorded by the human admin and cleared when withdrawn', async () => {
        const t = setup(), settings = defaultDevelopmentSettings('android')
        settings.android!.sdkLicensesAcknowledged = true
        const saved = (await (await t.save(settings, 0)).json() as any).config
        expect(saved.androidSdkLicenseAcknowledgement).toMatchObject({ by: { id: 'admin' } })
        const again = (await (await t.save(settings, 1)).json() as any).config
        expect(again.androidSdkLicenseAcknowledgement.at).toBe(saved.androidSdkLicenseAcknowledgement.at)
        settings.android!.sdkLicensesAcknowledged = false
        expect((await (await t.save(settings, 2)).json() as any).config.androidSdkLicenseAcknowledgement).toBeNull()
    })
    test('creation mode is validated before the project exists and stored atomically', async () => {
        const t = setup()
        const create = (development: unknown) => t.app.request(`${origin}/api/evolved/projects`, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${t.sessions.admin}` }, body: JSON.stringify({ teamId: t.team.id, name: `P ${randomUUID()}`, development }) })
        const count = () => (t.store.db.query('SELECT COUNT(*) AS n FROM evolved_projects').get() as { n: number }).n
        const before = count()
        expect((await create({ settings: t.odoo({ repositoryId: repo.id }) })).status).toBe(400)
        expect((await create({ settings: { mode: 'odoo', repositoryId: null, odoo: null, ios: null, android: null } })).status).toBe(400)
        expect(count()).toBe(before)
        const created = await create({ settings: t.odoo({}, { major: 19 }) })
        expect(created.status).toBe(201)
        const id = (await created.json() as any).project.id
        const config = (await (await t.call('', { projectId: id })).json() as any).config
        expect(config).toMatchObject({ revision: 1, settings: { mode: 'odoo', odoo: { major: 19 } } })
        const plain = await create(undefined)
        expect((await (await t.call('', { projectId: (await plain.json() as any).project.id })).json() as any).config.revision).toBe(0)
    })
})

describe('development context and knowledge', () => {
    test('human viewers and exact-project runner leases read context; standalone, foreign and query variants are denied', async () => {
        const t = setup()
        expect((await t.save(t.odoo({ repositoryId: repo.id }, { hosting: 'odoo_sh', developmentBranch: 'dev', odooSh: { dashboardUrl: 'https://www.odoo.sh/project/acme', unassigned: null,
            staging: { branch: 'staging', buildId: '4242', buildHost: 'acme-staging-4242.dev.odoo.com', sshResourceId: 'ssh-shared', applicationResourceId: null },
            production: { branch: 'main', buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: 'erp-prod' } } }), 0)).status).toBe(200)
        const human = DevelopmentContextSchema.parse(await (await t.call('/context', { user: 'viewer' })).json())
        expect(human.repository).toMatchObject({ state: 'granted', fullName: repo.fullName, relativePath: 'repositories/acme/addons' })
        expect(human.pack!.topics.some(topic => topic.id === 'odoo-runtime-20')).toBe(true)
        expect(human.pack!.topics.some(topic => topic.id === 'odoo-runtime-19')).toBe(false)
        const staging = human.integrations.find(item => item.id === 'odoo-sh-staging')!, production = human.integrations.find(item => item.id === 'odoo-sh-production')!
        expect(staging).toMatchObject({ environment: 'staging', branch: 'staging', state: 'configured', command: ['ssh', '4242@acme-staging-4242.dev.odoo.com'] })
        expect(staging.links.map(link => link.url)).toEqual(['https://acme-staging-4242.dev.odoo.com/', 'https://acme-staging-4242.dev.odoo.com/odoo-sh/editor'])
        // Production never borrows the staging build, links or SSH command; its own references stay its own.
        expect(production).toMatchObject({ environment: 'production', branch: 'main', state: 'configured', links: [] })
        expect(production.command).toBeUndefined()
        expect(production.detail).toContain('erp-prod')
        expect(production.detail).not.toContain('ssh-shared')
        expect(human.integrations.find(item => item.id === 'odoo-sh-project')!.links.map(link => link.url)).toEqual(['https://www.odoo.sh/project/acme'])
        expect(human.integrations.find(item => item.id === 'odoo-sh-unassigned')!.state).toBe('not_configured')
        expect(human.integrations.some(item => item.id === 'odoo-sh-ssh' || item.id === 'odoo-sh-dashboard')).toBe(false)
        const runner = DevelopmentContextSchema.parse(await (await t.call('/context', { token: t.capability() })).json())
        expect(runner.revision).toBe(1)
        const noGit = DevelopmentContextSchema.parse(await (await t.call('/context', { token: t.capability(['runner:connect']) })).json())
        expect(noGit.repository.state).toBe('hidden')
        expect((await t.call('/context', { token: t.capability(['runner:connect'], { lease: false }) })).status).toBe(403)
        expect((await t.call('/context', { token: t.capability(['git:read']) })).status).toBe(403)
        expect((await t.call('/context', { token: t.capability(['runner:connect'], { projectId: t.other.id }) })).status).toBe(403)
        expect((await t.call('/context', { token: t.capability(), cookieAndBearer: true })).status).toBe(403)
        expect((await t.call('/context', { user: 'outsider' })).status).toBe(403)
        expect((await t.call('/context?x=1', { user: 'viewer' })).status).toBe(400)
    })
    test('context reflects disconnected GitHub and Vault outages honestly', async () => {
        const t = setup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        t.failVault(true)
        expect(DevelopmentContextSchema.parse(await (await t.call('/context')).json()).repository.state).toBe('unknown')
        t.failVault(false); t.disconnect()
        expect(DevelopmentContextSchema.parse(await (await t.call('/context')).json()).repository.state).toBe('github_disconnected')
    })
    test('knowledge is local, version-specific and bounded; graph/memory are not involved', async () => {
        const t = setup()
        const none = DevelopmentKnowledgeResponseSchema.parse(await (await t.call('/knowledge?q=odoo')).json())
        expect(none).toMatchObject({ packId: null, results: [] })
        await t.save(t.odoo({}, { major: 19 }), 0)
        const list = DevelopmentKnowledgeResponseSchema.parse(await (await t.call('/knowledge', { token: t.capability(['runner:connect']) })).json())
        expect(list.results.length).toBeGreaterThanOrEqual(6)
        expect(list.results.some(topic => topic.id === 'odoo-runtime-20')).toBe(false)
        const search = DevelopmentKnowledgeResponseSchema.parse(await (await t.call('/knowledge?q=XML-RPC%20removal&limit=3')).json())
        expect(search.results[0]!.id).toBe('odoo-external-api')
        expect(search.results.length).toBeLessThanOrEqual(3)
        const topic = DevelopmentKnowledgeResponseSchema.parse(await (await t.call('/knowledge?topic=odoo-external-api')).json())
        expect(topic.topic!.body).toContain('Odoo 22')
        expect(topic.topic!.sources.every(source => source.url.startsWith('https://') && source.verifiedAt === '2026-10-17')).toBe(true)
        expect((await t.call('/knowledge?topic=odoo-runtime-20')).status).toBe(404)
        for (const query of ['?topic=a&q=b', '?q=a&q=b', '?path=/etc/passwd', '?url=https://evil.test', '?limit=999', `?q=${'x'.repeat(201)}`, '?topic=../x']) expect((await t.call(`/knowledge${query}`)).status).toBe(400)
        expect(t.vaultCalls.filter(call => call.operation !== 'github')).toEqual([])
    })
})

describe('development doctor and inspect', () => {
    test('calls the fixed RPC on exactly the project runner and validates the result', async () => {
        const t = setup()
        expect((await t.call('/doctor', { method: 'POST', body: {} })).status).toBe(409)
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        const response = await t.call('/doctor', { method: 'POST', user: 'member', body: {} })
        expect(response.status).toBe(200)
        const body = DevelopmentDoctorResponseSchema.parse(await response.json())
        expect(body.runner).toEqual({ status: 'ready', machineId: 'machine-0' })
        expect(body.result!.checks.map(check => check.state)).toEqual(['ready', 'missing'])
        const sent = t.rpcCalls[0]!
        expect(sent).toMatchObject({ machineId: 'machine-0', timeout: 30_000, params: { action: 'doctor', projectId: t.project.id, revision: 1, mode: 'odoo', repository: { id: repo.id, path: `${t.project.rootPath}/repositories/acme/addons` } } })
        expect(sent.params.checks).toContain('postgresql.server')
        const context = DevelopmentContextSchema.parse(await (await t.call('/context')).json())
        expect(context.lastDoctor).toMatchObject({ revision: 1, ready: 1, missing: 1 })
        expect((await t.call('/doctor', { method: 'POST', user: 'viewer', body: {} })).status).toBe(403)
        expect((await t.call('/doctor', { method: 'POST', body: { command: 'id' } })).status).toBe(400)
        expect((await t.call('/doctor', { method: 'POST', token: t.capability(['runner:connect']), body: {} })).status).toBe(200)
    })
    test('old, missing and ambiguous runners are reported honestly without RPC', async () => {
        const t = setup()
        await t.save(t.odoo(), 0)
        t.setCapabilities([MACHINE_CAPABILITIES.AgentAvailability])
        expect(DevelopmentDoctorResponseSchema.parse(await (await t.call('/doctor', { method: 'POST', body: {} })).json())).toMatchObject({ runner: { status: 'upgrade_required' }, result: null })
        t.setMachines(0)
        expect(DevelopmentDoctorResponseSchema.parse(await (await t.call('/doctor', { method: 'POST', body: {} })).json())).toMatchObject({ runner: { status: 'offline' }, result: null })
        t.setMachines(2)
        expect(DevelopmentDoctorResponseSchema.parse(await (await t.call('/doctor', { method: 'POST', body: {} })).json())).toMatchObject({ runner: { status: 'ambiguous' }, result: null })
        expect(t.rpcCalls).toEqual([])
    })
    test('invalid, failing and oversized runner payloads are rejected', async () => {
        const t = setup()
        await t.save(t.odoo(), 0)
        t.setRpc(() => doctorResult('android'))
        expect((await t.call('/doctor', { method: 'POST', body: {} })).status).toBe(502)
        t.setRpc(() => doctorResult('odoo', { checks: Array.from({ length: 65 }, (_, index) => ({ id: `c${index}`, label: 'x', category: 'runtime', state: 'ready' })) }))
        expect((await t.call('/doctor', { method: 'POST', body: {} })).status).toBe(502)
        t.setRpc(() => doctorResult('odoo', { checks: [{ id: 'python', label: 'Python', category: 'runtime', state: 'ready', detail: 'TOKEN=\u0007' }] }))
        expect((await t.call('/doctor', { method: 'POST', body: {} })).status).toBe(502)
        t.setRpc(() => ({ error: { code: 'boom', message: 'x'.repeat(5000) } }))
        const failed = await t.call('/doctor', { method: 'POST', body: {} })
        expect(failed.status).toBe(502)
        expect(((await failed.json()) as any).error.length).toBeLessThan(400)
        t.setRpc(() => { throw new Error('RPC timed out') })
        expect((await t.call('/doctor', { method: 'POST', body: {} })).status).toBe(504)
    })
    test('config or access changes during the RPC discard the result', async () => {
        const t = setup()
        await t.save(t.odoo(), 0)
        t.setRpc(async params => { await t.save(t.odoo({}, { major: 19 }), 1); return doctorResult(params.mode) })
        expect(((await (await t.call('/doctor', { method: 'POST', body: {} })).json()) as any).code).toBe('development_changed')
        t.setRpc(async params => { t.store.db.prepare("INSERT INTO evolved_project_roles VALUES(?,?,?)").run(t.project.id, 'member', 'viewer'); return doctorResult(params.mode) })
        expect((await t.call('/doctor', { method: 'POST', user: 'member', body: {} })).status).toBe(403)
    })
    test('inspect needs the bound granted repository and checks its identity after the RPC', async () => {
        const t = setup()
        await t.save(t.odoo(), 0)
        expect(((await (await t.call('/inspect', { method: 'POST', body: {} })).json()) as any).code).toBe('development_repository_unavailable')
        await t.save(t.odoo({ repositoryId: repo.id }), 1)
        const ok = DevelopmentInspectResponseSchema.parse(await (await t.call('/inspect', { method: 'POST', body: {} })).json())
        expect(ok.result!.repositoryId).toBe(repo.id)
        expect(t.rpcCalls.at(-1)).toMatchObject({ timeout: 45_000, params: { action: 'inspect', repository: { id: repo.id } } })
        expect((await t.call('/inspect', { method: 'POST', token: t.capability(['runner:connect']), body: {} })).status).toBe(403)
        t.setRpc(() => { t.setRepositories([]); return inspectResult() })
        expect(((await (await t.call('/inspect', { method: 'POST', body: {} })).json()) as any).code).toBe('development_changed')
        t.setRepositories([repo])
        t.setRpc(() => inspectResult({ repositoryId: '1' }))
        expect((await t.call('/inspect', { method: 'POST', body: {} })).status).toBe(502)
    })
    test('a configuration change during the final grant lookup discards the inspect result', async () => {
        const t = setup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        let calls = 0
        t.onVault(async request => {
            if (request.payload.action !== 'status' || t.rpcCalls.length === 0 || calls++) return
            // A real PUT while the hub awaits the post-RPC grant lookup.
            t.onVault()
            expect((await t.save(t.odoo({ repositoryId: repo.id }, { major: 19 }), 1)).status).toBe(200)
        })
        const response = await t.call('/inspect', { method: 'POST', body: {} })
        expect(response.status).toBe(409)
        expect(((await response.json()) as any).code).toBe('development_changed')
        expect((await (await t.call('')).json() as any).config.revision).toBe(2)
    })
    test('unreadable stored settings are reported, never silently reset, and can be overwritten at their revision', async () => {
        const t = setup()
        await t.save(t.odoo({}, { developmentBranch: 'main' }), 0)
        t.store.db.prepare("UPDATE evolved_project_development SET settings='{\"mode\":\"odoo\"}' WHERE project_id=?").run(t.project.id)
        const broken = await t.call('')
        expect(broken.status).toBe(500)
        expect(await broken.json()).toMatchObject({ code: 'development_config_invalid', revision: 1 })
        expect((await t.call('/context')).status).toBe(500)
        expect(t.service.defaultRepository.bind(null, t.project.id)).toThrow()
        expect((await t.call('', { method: 'PUT', body: { expectedRevision: 0, settings: t.odoo() } })).status).toBe(500)
        const fixed = await t.call('', { method: 'PUT', body: { expectedRevision: 1, settings: t.odoo() } })
        expect(fixed.status).toBe(200)
        expect(((await fixed.json()) as any).config.revision).toBe(2)
    })
    test('one action per project at a time', async () => {
        const t = setup()
        await t.save(t.odoo(), 0)
        let release!: () => void
        t.setRpc(params => new Promise(resolve => { release = () => resolve(doctorResult(params.mode)) }))
        const first = t.call('/doctor', { method: 'POST', body: {} })
        await new Promise(resolve => setTimeout(resolve, 10))
        expect((await t.call('/doctor', { method: 'POST', body: {} })).status).toBe(429)
        release()
        expect((await first).status).toBe(200)
    })
})

describe('development build status', () => {
    test('reads only the bound repository through the broker and keeps unknown distinct from success', async () => {
        const t = setup()
        expect(DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?ref=main')).json()).state).toBe('unbound')
        await t.save(t.odoo({ repositoryId: repo.id }, { hosting: 'odoo_sh', developmentBranch: 'odoo-dev' }), 0)
        const ok = DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?ref=odoo-dev', { user: 'viewer' })).json())
        expect(ok).toMatchObject({ state: 'success', sha, repositoryId: repo.id, ref: 'odoo-dev', environment: null })
        const statusCall = t.vaultCalls.find(call => call.payload.action === 'commitStatus')!
        expect(statusCall.payload).toEqual({ action: 'commitStatus', repositoryId: repo.id, ref: 'odoo-dev' })
        const reads = () => t.vaultCalls.filter(call => call.payload.action === 'commitStatus').length
        await t.call('/build-status?ref=odoo-dev')
        // No cache: each read goes through the Vault grant check.
        expect(reads()).toBe(2)
        t.setStatus(request => ({ state: 'no_status', repositoryId: String(request.payload.repositoryId), fullName: repo.fullName, ref: sha, sha, observedAt: 1, totalCount: 0, truncated: false, statuses: [] }))
        const none = DevelopmentBuildStatusResponseSchema.parse(await (await t.call(`/build-status?ref=${sha}`, { token: t.capability() })).json())
        expect(none.state).toBe('no_status')
        expect(none.message).toContain('Odoo.sh')
        t.setStatus(() => { throw new EvolvedError('github_repository_changed', 'changed', 409) })
        expect(DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?ref=main')).json()).state).toBe('not_granted')
        t.setStatus(() => ({ state: 'success', repositoryId: '1', fullName: 'other/repo', ref: 'x', sha, observedAt: 1, totalCount: 1, truncated: false, statuses: [] }))
        expect(DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?ref=main')).json()).state).toBe('unavailable')
        // A broker answer for another ref than requested is not reported as this ref.
        t.setStatus(request => ({ state: 'success', repositoryId: String(request.payload.repositoryId), fullName: repo.fullName, ref: 'other', sha, observedAt: 1, totalCount: 1, truncated: false, statuses: [] }))
        expect(DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?ref=main')).json()).state).toBe('unavailable')
        expect((await t.call('/build-status?ref=main', { token: t.capability(['runner:connect']) })).status).toBe(403)
        for (const query of ['?ref=-x', '?ref=a..b', '?url=https://evil.test', '?ref=a&ref=b', '?repositoryId=1', '?environment=development', '?environment=staging&environment=production']) expect((await t.call(`/build-status${query}`)).status).toBe(400)
    })
    test('no implicit target: environment reads use exactly the declared branch of that stage and echo it', async () => {
        const t = setup()
        const before = t.vaultCalls.length
        // Neither the working branch nor GitHub's default branch nor production is inferred.
        expect(await (await t.call('/build-status')).json()).toMatchObject({ code: 'development_status_target_required' })
        expect(await (await t.call('/build-status?environment=staging')).json()).toMatchObject({ code: 'development_environment_unavailable' })
        const env = (branch: string | null) => ({ branch, buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: null })
        await t.save(t.odoo({ repositoryId: repo.id }, { hosting: 'odoo_sh', developmentBranch: 'work', odooSh: { dashboardUrl: null, staging: env('staging'), production: env(null), unassigned: null } }), 0)
        expect(await (await t.call('/build-status?environment=production')).json()).toMatchObject({ code: 'development_environment_undeclared' })
        expect(await (await t.call('/build-status?environment=staging&ref=main')).json()).toMatchObject({ code: 'development_environment_ref_conflict' })
        expect(t.vaultCalls.filter(call => call.payload.action === 'commitStatus')).toHaveLength(0)
        const staging = DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?environment=staging', { token: t.capability() })).json())
        expect(staging).toMatchObject({ environment: 'staging', ref: 'staging', revision: 1, state: 'success' })
        expect(DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?environment=staging&ref=staging')).json()).environment).toBe('staging')
        expect(t.vaultCalls.slice(before).filter(call => call.payload.action === 'commitStatus').map(call => call.payload.ref)).toEqual(['staging', 'staging'])
        // Hosting switched away: stored stages are kept but no longer readable as environments.
        await t.save(t.odoo({ repositoryId: repo.id }, { hosting: 'local', developmentBranch: 'work', odooSh: { dashboardUrl: null, staging: env('staging'), production: env(null), unassigned: null } }))
        expect(await (await t.call('/build-status?environment=staging')).json()).toMatchObject({ code: 'development_environment_unavailable' })
    })
    test('a stage switch during the status read discards the result instead of labelling it with the new branch', async () => {
        const t = setup()
        const env = (branch: string | null) => ({ branch, buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: null })
        const settings = (branch: string) => t.odoo({ repositoryId: repo.id }, { hosting: 'odoo_sh', odooSh: { dashboardUrl: null, staging: env(branch), production: env('main'), unassigned: null } })
        await t.save(settings('staging'), 0)
        t.onVault(async request => { if (request.payload.action === 'commitStatus') { t.onVault(); expect((await t.save(settings('staging-2'), 1)).status).toBe(200) } })
        expect(await (await t.call('/build-status?environment=staging')).json()).toMatchObject({ code: 'development_changed' })
        const fresh = DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?environment=staging')).json())
        expect(fresh).toMatchObject({ environment: 'staging', ref: 'staging-2', revision: 2 })
    })
    test('a revoked repository grant takes effect on the very next status read (no cached private status)', async () => {
        const t = setup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        expect(DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?ref=main')).json())).toMatchObject({ state: 'success', statuses: [{ context: 'ci' }] })
        t.setStatus(() => { throw new EvolvedError('github_revoked', 'revoked', 403) })
        const after = DevelopmentBuildStatusResponseSchema.parse(await (await t.call('/build-status?ref=main')).json())
        expect(after).toMatchObject({ state: 'not_granted', sha: null, statuses: [], fullName: null })
        expect(t.vaultCalls.filter(call => call.payload.action === 'commitStatus')).toHaveLength(2)
    })
})

describe('development task starts reuse the specialist start', () => {
    function startSetup() {
        const t = setup()
        const plugins = new PluginService(t.store)
        const started: unknown[][] = [], messages = new Map<string, Array<{ localId: string; text: string }>>(), known = new Set<string>(), archived: string[] = []
        let onSpawn: (() => void | Promise<void>) | undefined
        const machine = () => ({ id: 'machine-0', active: true, metadata: { host: 'runner', workspaceRoots: [t.project.rootPath], capabilities: [MACHINE_CAPABILITIES.AgentAvailability, EVOLVED_DEVELOPMENT_CAPABILITY] } })
        const engine = {
            getMachineByNamespace: (id: string, namespace: string) => id === 'machine-0' && namespace === t.project.namespace ? machine() : undefined,
            getOnlineMachinesByNamespace: (namespace: string) => namespace === t.project.namespace ? [machine()] : [],
            getSessionByNamespace: (id: string, namespace: string) => known.has(id) && namespace === t.project.namespace ? { id } : undefined,
            spawnSession: async (...args: unknown[]) => {
                started.push(args); const id = randomUUID()
                const onReserved = args[18] as ((id: string) => void) | undefined
                onReserved?.(id)
                known.add(id); await onSpawn?.(); return { type: 'success', sessionId: id }
            },
            sendMessage: async (id: string, body: { localId: string; text: string }) => { messages.set(id, [body]) },
            getMessagesPage: (id: string) => ({ messages: messages.get(id) ?? [] }),
            archiveSession: async (id: string) => { archived.push(id) },
        } as unknown as SyncEngine
        const repositoryStarts: string[] = [], reserved: string[] = []
        const repositoryStart: RepositoryStartResolver = async (_authority, repositoryId) => {
            repositoryStarts.push(repositoryId)
            const name = repositoryId === repo.id ? 'addons' : 'other'
            return { directory: `${t.project.rootPath}/repositories/acme/${name}`, repositoryId, fullName: `acme/${name}`, recheck: async () => {}, onReserved: id => { reserved.push(id) } }
        }
        t.app.route('/api/evolved', createAgentCatalogRoutes({ store: t.store, plugins, origin, getSyncEngine: () => engine, repositoryStart, development: t.service }))
        const start = (agentId: string, body: Record<string, unknown>) => t.app.request(`${origin}/api/evolved/projects/${t.project.id}/agent-catalog/${agentId}/start`, {
            method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${t.sessions.admin}` }, body: JSON.stringify(body) })
        return { ...t, started, messages, archived, repositoryStarts, reserved, start, spawnHook: (value?: typeof onSpawn) => { onSpawn = value } }
    }
    test('a task start resolves the static recipe into the assignment and defaults to the bound repository', async () => {
        const t = startSetup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        const operationId = randomUUID(), body = { operationId, machineId: 'machine-0', task: 'Run the tests.', development: { taskId: 'odoo-run-tests', revision: 1 } }
        const response = await t.start('builtin:tests', body)
        expect(response.status).toBe(201)
        const { sessionId } = await response.json() as { sessionId: string }
        expect(t.repositoryStarts).toEqual([repo.id])
        expect(t.reserved).toHaveLength(1)
        expect(t.started[0]![1]).toBe(`${t.project.rootPath}/repositories/acme/addons`)
        const prompt = t.messages.get(sessionId)![0]!.text
        expect(prompt).toContain('HAPI-Entwicklungsaufgabe')
        expect(prompt).toContain('"id":"odoo-test-module"')
        expect(prompt).toContain('"configRevision":1')
        const repeated = await t.start('builtin:tests', body)
        expect(repeated.status).toBe(200)
        expect(((await repeated.json()) as any).sessionId).toBe(sessionId)
        const conflicting = await t.start('builtin:tests', { ...body, task: 'Something else.' })
        expect(conflicting.status).toBe(409)
        expect(((await conflicting.json()) as any).code).toBe('agent_operation_conflict')
        expect(t.started).toHaveLength(1)
    })
    test('a restricted profile refuses consequential tasks (recipe effects included) before reserving, but keeps read-only planning', async () => {
        const t = startSetup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        t.store.db.prepare("UPDATE evolved_projects SET profile='restricted' WHERE id=?").run(t.project.id)
        const refused = await t.start('builtin:implementation', { operationId: randomUUID(), machineId: 'machine-0', task: 'Set up.', development: { taskId: 'odoo-setup-runtime', revision: 1 } })
        expect(await refused.json()).toMatchObject({ code: 'development_profile_required', reserved: false, requiredProfiles: ['workspace', 'extended'], effects: expect.arrayContaining(['network_download', 'installs_in_project']) })
        expect(refused.status).toBe(409)
        expect(t.started).toHaveLength(0)
        expect(t.repositoryStarts).toHaveLength(0)
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_agent_starts').get()).toEqual({ n: 0 })
        // A reviewing task whose effects (own and recipe) only read stays available as an explicit plan-mode session.
        const review = await t.start('builtin:review', { operationId: randomUUID(), machineId: 'machine-0', task: 'Check staging.', development: { taskId: 'odoo-sh-build', revision: 1 } })
        expect(review.status).toBe(201)
        expect(t.started[0]![10]).toBe('plan')
        const { sessionId } = await review.json() as { sessionId: string }
        expect(t.messages.get(sessionId)![0]!.text).toContain('"effectiveEffects":["reads_repository","manual_handoff"]')
    })
    test('a profile downgrade during spawn aborts a consequential start', async () => {
        const t = startSetup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        t.spawnHook(() => { t.store.db.prepare("UPDATE evolved_projects SET profile='restricted' WHERE id=?").run(t.project.id) })
        const response = await t.start('builtin:implementation', { operationId: randomUUID(), machineId: 'machine-0', task: 'Set up.', development: { taskId: 'odoo-setup-runtime', revision: 1 } })
        expect(response.status).toBe(409)
        expect(((await response.json()) as any).code).toBe('agent_start_changed')
        expect(t.messages.size).toBe(0)
    })
    test('stale revisions, wrong specialists, foreign versions and missing repositories create no session', async () => {
        const t = startSetup()
        await t.save(t.odoo({}, { major: 19 }), 0)
        const base = { machineId: 'machine-0', task: 'Do it.' }
        const code = async (agentId: string, development: unknown) => { const response = await t.start(agentId, { ...base, operationId: randomUUID(), development }); return { status: response.status, ...(await response.json() as any) } }
        expect(await code('builtin:tests', { taskId: 'odoo-run-tests', revision: 0 })).toMatchObject({ status: 409, code: 'development_revision_conflict', reserved: false })
        expect(await code('builtin:implementation', { taskId: 'odoo-run-tests', revision: 1 })).toMatchObject({ status: 400, code: 'development_task_specialist_mismatch' })
        expect(await code('builtin:architecture', { taskId: 'odoo-upgrade-20', revision: 1 })).toMatchObject({ status: 404, code: 'development_task_not_found' })
        expect(await code('builtin:tests', { taskId: 'odoo-run-tests', revision: 1 })).toMatchObject({ status: 409, code: 'development_repository_required' })
        expect(await code('builtin:tests', { taskId: 'odoo-run-tests; rm', revision: 1 })).toMatchObject({ status: 400 })
        expect(t.started).toHaveLength(0)
    })
    test('a config change during spawn aborts the start and archives the session', async () => {
        const t = startSetup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        t.spawnHook(async () => { await t.save(t.odoo({ repositoryId: repo.id }, { major: 19 }), 1) })
        const response = await t.start('builtin:implementation', { operationId: randomUUID(), machineId: 'machine-0', task: 'Set up.', development: { taskId: 'odoo-setup-runtime', revision: 1 } })
        expect(response.status).toBe(409)
        expect(((await response.json()) as any).code).toBe('agent_start_changed')
        expect(t.archived).toHaveLength(1)
        expect(t.messages.size).toBe(0)
    })
    test('setup tasks without a repository start in the project root', async () => {
        const t = startSetup()
        await t.save(t.odoo(), 0)
        const response = await t.start('builtin:implementation', { operationId: randomUUID(), machineId: 'machine-0', task: 'Set up.', development: { taskId: 'odoo-setup-runtime', revision: 1 } })
        expect(response.status).toBe(201)
        expect(t.repositoryStarts).toEqual([])
        expect(t.started[0]![1]).toBe(t.project.rootPath)
        const data = JSON.parse(t.messages.get(((await response.json()) as any).sessionId)![0]!.text.split('\n').at(-1)!)
        expect(data.development.repository).toMatchObject({ source: 'project_root', repositoryId: null, checkout: null })
        // Version-filtered topics only: an Odoo 20 project never receives the 19-only runtime topic.
        expect(data.development.task.topicIds).toEqual(['odoo-versions', 'odoo-runtime-20'])
        expect(data.development.placeholders.toolchainDir).toBe(`${t.project.rootPath}/.hapi/.cache/toolchain`)
    })
    test('an explicit alternate granted repository is allowed and named as the effective checkout', async () => {
        const t = startSetup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        const response = await t.start('builtin:implementation', { operationId: randomUUID(), machineId: 'machine-0', task: 'Change it.', repositoryId: '456', development: { taskId: 'odoo-develop-module', revision: 1 } })
        expect(response.status).toBe(201)
        expect(t.repositoryStarts).toEqual(['456'])
        expect(t.started[0]![1]).toBe(`${t.project.rootPath}/repositories/acme/other`)
        const data = JSON.parse(t.messages.get(((await response.json()) as any).sessionId)![0]!.text.split('\n').at(-1)!)
        expect(data.development.repository).toMatchObject({ source: 'explicit_selection', repositoryId: '456', fullName: 'acme/other', checkout: `${t.project.rootPath}/repositories/acme/other`, configuredDefaultRepositoryId: repo.id })
        expect(data.development.repository.note).toContain('differs from the configured project repository')
        expect(data.development.placeholders.checkout).toBe(`${t.project.rootPath}/repositories/acme/other`)
        const defaulted = await t.start('builtin:implementation', { operationId: randomUUID(), machineId: 'machine-0', task: 'Change it.', development: { taskId: 'odoo-develop-module', revision: 1 } })
        const second = JSON.parse(t.messages.get(((await defaulted.json()) as any).sessionId)![0]!.text.split('\n').at(-1)!)
        expect(second.development.repository).toMatchObject({ source: 'configured_default', repositoryId: repo.id, fullName: 'acme/addons' })
        expect(second.development.repository.note).toBeUndefined()
    })
    test('SDK setup needs a persisted human licence acknowledgement; planning tasks do not', async () => {
        const t = startSetup()
        const android = defaultDevelopmentSettings('android')
        android.repositoryId = repo.id
        await t.save(android, 0)
        const start = (taskId: string, specialist: string, revision: number) => t.start(specialist, { operationId: randomUUID(), machineId: 'machine-0', task: 'Go.', development: { taskId, revision } })
        const refused = await start('android-setup-sdk', 'builtin:implementation', 1)
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({ code: 'development_license_acknowledgement_required', reserved: false })
        expect(t.started).toHaveLength(0)
        expect((await start('android-review', 'builtin:review', 1)).status).toBe(201)
        android.android!.sdkLicensesAcknowledged = true
        await t.save(android, 1)
        expect((await start('android-setup-sdk', 'builtin:implementation', 2)).status).toBe(201)
        // A deleted acknowledging user does not leave a valid acknowledgement behind.
        t.store.db.prepare("INSERT INTO evolved_users VALUES('temp','temp',0,?)").run(Date.now())
        t.store.db.prepare("UPDATE evolved_project_development SET android_ack_by='temp' WHERE project_id=?").run(t.project.id)
        t.store.db.prepare("DELETE FROM evolved_users WHERE id='temp'").run()
        const config = (await (await t.call('')).json() as any).config
        expect(config.androidSdkLicenseAcknowledgement).toBeNull()
        expect(config.settings.android.sdkLicensesAcknowledged).toBe(false)
        expect(((await (await start('android-setup-sdk', 'builtin:implementation', 2)).json()) as any).code).toBe('development_license_acknowledgement_required')
    })
    test('acknowledgement removed during the start aborts before the assignment', async () => {
        const t = startSetup()
        const android = defaultDevelopmentSettings('android')
        android.android!.sdkLicensesAcknowledged = true
        await t.save(android, 0)
        t.spawnHook(async () => { t.spawnHook(); android.android!.sdkLicensesAcknowledged = false; await t.save(android, 1) })
        const response = await t.start('builtin:implementation', { operationId: randomUUID(), machineId: 'machine-0', task: 'Go.', development: { taskId: 'android-setup-sdk', revision: 1 } })
        expect(response.status).toBe(409)
        expect(t.archived).toHaveLength(1)
        expect(t.messages.size).toBe(0)
    })
    test('debug APK task refuses release variants before any session exists', async () => {
        const t = startSetup()
        const android = defaultDevelopmentSettings('android')
        android.repositoryId = repo.id
        android.android!.variant = 'productionRelease'
        await t.save(android, 0)
        const refused = await t.start('builtin:tests', { operationId: randomUUID(), machineId: 'machine-0', task: 'Build.', development: { taskId: 'android-debug-apk', revision: 1 } })
        expect(await refused.json()).toMatchObject({ code: 'development_debug_variant_required', reserved: false })
        expect(t.started).toHaveLength(0)
        android.android!.variant = 'freeDebug'
        await t.save(android, 1)
        expect((await t.start('builtin:tests', { operationId: randomUUID(), machineId: 'machine-0', task: 'Build.', development: { taskId: 'android-debug-apk', revision: 2 } })).status).toBe(201)
    })
})

describe('ordinary project spawns default to the bound repository', () => {
    function spawnSetup() {
        const t = setup()
        const spawned: Array<{ directory: string; onReserved?: unknown }> = [], archived: string[] = []
        let onSpawn: (() => Promise<void>) | undefined
        const machine = () => ({ id: 'machine-0', active: true, namespace: t.project.namespace, metadata: { capabilities: [MACHINE_CAPABILITIES.AgentAvailability], workspaceRoots: [t.project.rootPath] } })
        const engine = {
            getMachine: machine, getMachineByNamespace: machine,
            spawnSession: async (_machine: string, directory: string, ...rest: unknown[]) => {
                const onReserved = rest[16] as ((id: string) => void) | undefined
                onReserved?.('session-1')
                spawned.push({ directory, onReserved }); await onSpawn?.(); return { type: 'success', sessionId: 'session-1' }
            },
            archiveSession: async (id: string) => { archived.push(id) },
        } as unknown as SyncEngine
        let resolveMode: 'ok' | 'missing' = 'ok', onResolve: (() => Promise<void>) | undefined
        const starts: string[] = []
        const repositoryStart: RepositoryStartResolver = async (_authority, repositoryId) => {
            starts.push(repositoryId); await onResolve?.()
            if (resolveMode === 'missing') throw new EvolvedError('repository_checkout_unavailable', 'clone first', 409)
            return { directory: `${t.project.rootPath}/repositories/acme/${repositoryId}`, repositoryId, fullName: repo.fullName, recheck: async () => {}, onReserved: () => {} }
        }
        const app = new Hono<any>()
        app.use('*', async (c, next) => {
            const project = t.store.requireProject('admin', t.project.id)
            const access: EvolvedAccess = { principal: t.store.getPrincipal('admin')!, project, userId: 1, valid: () => true }
            c.set('evolvedAccess', access); c.set('namespace', project.namespace); return next()
        })
        app.route('/api', createMachinesRoutes(() => engine, { repositoryStart, developmentRepository: projectId => t.service.defaultRepository(projectId) }))
        const spawn = async (body: Record<string, unknown>) => { const response = await app.request('/api/machines/machine-0/spawn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', ...body }) }); return { status: response.status, ...(await response.json() as any) } }
        return { ...t, spawn, spawned, starts, archived, missing: () => { resolveMode = 'missing' }, resolveHook: (value?: typeof onResolve) => { onResolve = value }, spawnHook: (value?: typeof onSpawn) => { onSpawn = value } }
    }
    test('no repository/directory → configured checkout; explicit choices win', async () => {
        const t = spawnSetup()
        expect((await t.spawn({})).development).toBeUndefined()
        expect(t.spawned.at(-1)!.directory).toBe(t.project.rootPath)
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        expect((await t.spawn({})).development).toEqual({ defaultRepository: 'applied', repositoryId: repo.id })
        expect(t.spawned.at(-1)!.directory).toBe(`${t.project.rootPath}/repositories/acme/${repo.id}`)
        expect(typeof t.spawned.at(-1)!.onReserved).toBe('function')
        expect((await t.spawn({ directory: t.project.rootPath })).development).toBeUndefined()
        expect(t.spawned.at(-1)!.directory).toBe(t.project.rootPath)
        await t.spawn({ repositoryId: '777' })
        expect(t.starts.at(-1)).toBe('777')
        expect(t.spawned.at(-1)!.directory).toBe(`${t.project.rootPath}/repositories/acme/777`)
    })
    test('an unavailable default fails clearly instead of falling back to the project root', async () => {
        const t = spawnSetup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        t.missing()
        const before = t.spawned.length
        expect(await t.spawn({})).toMatchObject({ status: 409, code: 'development_default_repository_unavailable', reason: 'repository_checkout_unavailable', repositoryId: repo.id })
        expect(t.spawned.length).toBe(before)
        // The explicit project folder remains a deliberate choice.
        expect((await t.spawn({ directory: t.project.rootPath })).status).toBe(200)
        expect(t.spawned.at(-1)!.directory).toBe(t.project.rootPath)
    })
    test('a default changed while its checkout is resolved never starts the stale repository', async () => {
        const t = spawnSetup()
        const other = { ...repo, id: '456', name: 'other', fullName: 'acme/other' }
        t.setRepositories([repo, other])
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        t.resolveHook(async () => { t.resolveHook(); await t.save(t.odoo({ repositoryId: other.id }), 1) })
        expect(await t.spawn({})).toMatchObject({ status: 409, code: 'development_default_changed' })
        expect(t.spawned).toHaveLength(0)
        // The next start uses the current default.
        expect((await t.spawn({})).development).toEqual({ defaultRepository: 'applied', repositoryId: other.id })
        expect(t.spawned.at(-1)!.directory).toBe(`${t.project.rootPath}/repositories/acme/${other.id}`)
    })
    test('a default changed while the runner starts archives the session and reports the change', async () => {
        const t = spawnSetup()
        await t.save(t.odoo({ repositoryId: repo.id }), 0)
        t.spawnHook(async () => { t.spawnHook(); await t.save(t.odoo({ repositoryId: null }), 1) })
        expect(await t.spawn({})).toMatchObject({ status: 409, code: 'development_default_changed', sessionId: 'session-1', archived: true })
        expect(t.archived).toEqual(['session-1'])
    })
})

describe('Odoo.sh environments: legacy storage, CAS and retention', () => {
    const write = (t: ReturnType<typeof setup>, raw: unknown, revision = 3) => t.store.db.prepare('INSERT INTO evolved_project_development VALUES(?,?,?,?,?,?,?,?)').run(t.project.id, revision, JSON.stringify(raw), null, 'admin', Date.now(), null, null)
    const row = (t: ReturnType<typeof setup>) => t.store.db.query('SELECT revision,settings FROM evolved_project_development WHERE project_id=?').get(t.project.id) as { revision: number; settings: string }
    const legacyOdoo = (patch: Record<string, unknown> = {}, sh: Record<string, unknown> = {}) => ({ major: 20, edition: 'community', hosting: 'odoo_sh', addonsPaths: ['.'], modules: [], developmentBranch: 'main', stage: null,
        enterpriseRepositoryId: null, testDatabaseSlug: 'dev', odooSh: { dashboardUrl: 'https://www.odoo.sh/project/acme', buildId: '77', buildHost: 'acme-main-77.dev.odoo.com', sshResourceId: 'ssh-77', ...sh }, applicationResourceId: 'erp', ...patch })
    const v1 = (odoo: unknown) => ({ mode: 'odoo', repositoryId: repo.id, odoo, ios: null, android: null })
    test('explicit legacy stages map only to that environment; the working branch is preserved; reads never write', async () => {
        for (const [stage, target, other] of [['staging', 'staging', 'production'], ['production', 'production', 'staging']] as const) {
            const t = setup()
            write(t, v1(legacyOdoo({ stage })))
            const before = row(t)
            const settings = (await (await t.call('')).json() as any).config.settings
            expect(settings.odoo.developmentBranch).toBe('main')
            expect(settings.odoo.odooSh[target]).toEqual({ branch: 'main', buildId: '77', buildHost: 'acme-main-77.dev.odoo.com', sshResourceId: 'ssh-77', applicationResourceId: null })
            expect(settings.odoo.odooSh[other]).toEqual({ branch: null, buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: null })
            // The application resource never had a stage: it stays unassigned instead of being guessed.
            expect(settings.odoo.odooSh.unassigned).toEqual({ declaredStage: null, branch: null, buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: 'erp' })
            expect(settings.odoo.odooSh.dashboardUrl).toBe('https://www.odoo.sh/project/acme')
            expect(row(t)).toEqual(before)
        }
    })
    test('development or undeclared legacy builds stay exactly unassigned (v1 and v2 envelopes)', async () => {
        for (const stage of ['development', null] as const) for (const envelope of ['v1', 'v2'] as const) {
            const t = setup()
            const odoo = legacyOdoo({ stage, hosting: 'odoo_sh' })
            write(t, envelope === 'v1' ? v1(odoo) : { schemaVersion: 2, settings: { activeModuleId: 'builtin:odoo', repositoryId: repo.id, odoo, ios: null, android: null, modules: {} } })
            const settings = (await (await t.call('/modules')).json() as any).config.settings
            expect(settings.odoo.developmentBranch).toBe('main')
            expect(settings.odoo.odooSh.staging.branch).toBeNull()
            expect(settings.odoo.odooSh.production.branch).toBeNull()
            expect(settings.odoo.odooSh.unassigned).toEqual({ declaredStage: stage, branch: 'main', buildId: '77', buildHost: 'acme-main-77.dev.odoo.com', sshResourceId: 'ssh-77', applicationResourceId: 'erp' })
            const context = DevelopmentContextSchema.parse(await (await t.call('/context')).json())
            const unassigned = context.integrations.find(item => item.id === 'odoo-sh-unassigned')!
            expect(unassigned).toMatchObject({ state: 'manual', links: [] })
            expect(unassigned.command).toBeUndefined()
            expect(context.integrations.find(item => item.id === 'odoo-sh-staging')!.command).toBeUndefined()
            expect(await (await t.call('/build-status?environment=production')).json()).toMatchObject({ code: 'development_environment_undeclared' })
        }
    })
    test('legacy local hosting keeps its application resource top-level and is written back as v3 only by an explicit save', async () => {
        const t = setup()
        write(t, v1(legacyOdoo({ hosting: 'local', stage: null }, { dashboardUrl: null, buildId: null, buildHost: null, sshResourceId: null })))
        const config = (await (await t.call('')).json() as any).config
        expect(config.settings.odoo).toMatchObject({ applicationResourceId: 'erp', developmentBranch: 'main', odooSh: { unassigned: null } })
        expect(JSON.parse(row(t).settings).schemaVersion).toBeUndefined()
        expect((await t.save(config.settings, 3)).status).toBe(200)
        expect(JSON.parse(row(t).settings)).toMatchObject({ schemaVersion: 3, settings: { odoo: { applicationResourceId: 'erp' } } })
    })
    test('unassigned legacy details can only be kept unchanged or removed', async () => {
        const t = setup()
        write(t, v1(legacyOdoo({ stage: 'development' })))
        const settings = (await (await t.call('')).json() as any).config.settings
        const edited = structuredClone(settings); edited.odoo.odooSh.unassigned.sshResourceId = 'other'
        expect(await (await t.save(edited, 3)).json()).toMatchObject({ code: 'development_module_settings_invalid', issues: [{ path: ['odoo', 'odooSh', 'unassigned'] }] })
        expect(row(t).revision).toBe(3)
        expect((await t.save(settings, 3)).status).toBe(200)
        // Explicit mapping: the human enters the staging stage and drops the legacy slot in the same CAS write.
        const mapped = structuredClone(settings)
        mapped.odoo.odooSh.staging = { branch: 'main', buildId: '77', buildHost: 'acme-main-77.dev.odoo.com', sshResourceId: 'ssh-77', applicationResourceId: null }
        mapped.odoo.odooSh.unassigned = null
        expect((await t.save(mapped, 4)).status).toBe(200)
        const fresh = setup()
        const created = await fresh.app.request(`${origin}/api/evolved/projects`, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fresh.sessions.admin}` },
            body: JSON.stringify({ teamId: fresh.team.id, name: 'New', development: { settings: { ...settings, repositoryId: null } } }) })
        expect({ status: created.status, ...(await created.json() as any) }).toMatchObject({ status: 400, code: 'development_module_settings_invalid' })
    })
    test('switching modules with odoo:null (v1 and v2 routes) keeps the stored environments as inactive data', async () => {
        const t = setup()
        const env = (branch: string, buildId: string) => ({ branch, buildId, buildHost: `acme-${branch}-${buildId}.dev.odoo.com`, sshResourceId: 'ssh', applicationResourceId: null })
        const odoo = t.odoo({ repositoryId: repo.id }, { hosting: 'odoo_sh', odooSh: { dashboardUrl: null, staging: env('staging', '1'), production: env('main', '2'), unassigned: null } })
        expect((await t.save(odoo, 0)).status).toBe(200)
        expect((await t.save({ ...defaultDevelopmentSettings('ios'), repositoryId: repo.id, odoo: null }, 1)).status).toBe(200)
        const v2 = (await (await t.call('/modules')).json() as any).config
        expect(v2.settings).toMatchObject({ activeModuleId: 'builtin:ios', odoo: { odooSh: { production: { branch: 'main', buildId: '2' } } } })
        expect((await t.call('/modules', { method: 'PUT', body: { expectedRevision: 2, settings: { ...v2.settings, activeModuleId: 'builtin:android', android: defaultAndroidSettings(), odoo: null } } })).status).toBe(200)
        const after = (await (await t.call('/modules')).json() as any).config.settings
        expect(after.odoo.odooSh.staging).toEqual(env('staging', '1'))
        expect(after.activeModuleId).toBe('builtin:android')
        // Switching back restores both stages.
        expect((await t.save({ ...odoo, odoo: after.odoo }, 3)).status).toBe(200)
    })
    test('a pre-environment Odoo shape is refused on write instead of being stored', async () => {
        const t = setup()
        expect((await t.save(v1(legacyOdoo({ stage: 'staging' })) as never, 0)).status).toBe(400)
        expect(row(t)).toBeNull()
    })
})

describe('Odoo.sh integration details at the length boundary', () => {
    test('maximum-length branches and references never truncate the qualification or the stage warnings', () => {
        const settings = defaultDevelopmentSettings('odoo'), branch = 'a'.repeat(200)
        settings.odoo = { ...settings.odoo!, hosting: 'odoo_sh', developmentBranch: branch, odooSh: { dashboardUrl: null, unassigned: { declaredStage: 'development', branch: 'u'.repeat(200), buildId: '999999999998', buildHost: `${'h'.repeat(63)}.dev.odoo.com`, sshResourceId: 'x'.repeat(128), applicationResourceId: 'y'.repeat(128) },
            staging: { branch: 'b'.repeat(200), buildId: '999999999998', buildHost: 'synthetic-999999999998.dev.odoo.com', sshResourceId: 's'.repeat(128), applicationResourceId: 'j'.repeat(128) },
            production: { branch, buildId: '999999999999', buildHost: 'synthetic-999999999999.dev.odoo.com', sshResourceId: 's'.repeat(128), applicationResourceId: 'j'.repeat(128) } } }
        const rows = developmentIntegrations(DevelopmentSettingsSchema.parse(settings), { state: 'unbound', repositoryId: null, fullName: null, permission: null, checkoutPath: null, relativePath: null })
        const detail = (id: string) => DevelopmentIntegrationStatusSchema.parse(rows.find(row => row.id === id)).detail
        const production = detail('odoo-sh-production'), staging = detail('odoo-sh-staging'), unassigned = detail('odoo-sh-unassigned')
        for (const text of [production, staging, unassigned]) expect(text.length).toBeLessThanOrEqual(500)
        expect(production).toContain('Nur gespeicherte Angaben; HAPI öffnet keine Verbindung und startet keinen Build.')
        expect(production).toContain('Live-Datenbank')
        expect(production).toContain('Achtung: Der lokale Arbeitsbranch ist dieser Produktion-Branch')
        expect(production).toContain('…')
        expect(staging).toContain('neutralisierte Kopie')
        expect(staging).not.toContain('Arbeitsbranch')
        expect(unassigned).toContain('weder für Staging noch Produktion verwendet')
    })
})
