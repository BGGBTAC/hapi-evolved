import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { EVOLVED_DEVELOPMENT_CAPABILITY, defaultAndroidSettings, defaultDevelopmentSettings, defaultOdooSettings, type DevelopmentSettings } from '@hapi/protocol/evolvedDevelopment'
import {
    DevelopmentConfigVersionUnsupportedSchema, DevelopmentModuleCatalogResponseSchema, DevelopmentModuleContextSchema, DevelopmentModuleDoctorResponseSchema, DevelopmentModulesResponseSchema, DevelopmentModuleDetailResponseSchema, DevelopmentModuleKnowledgeResponseSchema,
    type DevelopmentModuleDefinitionInput, type DevelopmentModulesResponse,
} from '@hapi/protocol/developmentModules'
import type { PluginManifestInput } from '@hapi/protocol/pluginManifest'
import { createDevelopmentService, DevelopmentConfigInvalidError } from './development'
import { DevelopmentModuleRegistry } from './developmentModules'
import { parsePluginManifest } from './pluginManifest'
import { createEvolvedRoutes } from './api'
import { createAgentCatalogRoutes } from './agentCatalog'
import { PluginService, createPluginRoutes, type PluginPreview } from './plugins'
import { EvolvedError, EvolvedStore, hashToken, randomToken } from './store'
import { SESSION_COOKIE } from './security'
import type { VaultClient, VaultRequest } from './vault'
import type { RepositoryStartResolver } from './repositoryWorkflow'
import type { SyncEngine } from '../sync/syncEngine'

const stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const origin = 'https://modules.example.test'
const repo = { id: '123456', owner: 'acme', name: 'app', fullName: 'acme/app', permission: 'write' as const }
const commit = 'a'.repeat(40), nextCommit = 'b'.repeat(40)
const source = { title: 'Docs', url: 'https://example.com/docs', verifiedAt: '2026-10-17' }
const BODY_MARKER = 'HANDBOOK-BODY-MARKER-never-in-assignment'

/** A genuinely new scenario with a random identifier: nothing in the product knows it. */
function moduleDefinition(id: string, overrides: Partial<DevelopmentModuleDefinitionInput> = {}): DevelopmentModuleDefinitionInput {
    return {
        apiVersion: 1, id, title: `Scenario ${id}`, summary: 'A third-party development scenario', contentVersion: '1.0.0', brief: ['Projects keep sources under app/.'],
        fields: [
            { id: 'appDirectory', kind: 'repo_path', label: 'App directory', required: true, default: '.' },
            { id: 'channel', kind: 'select', label: 'Channel', required: true, default: 'stable', options: [{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }] },
            { id: 'retries', kind: 'number', label: 'Retries', min: 0, max: 5, default: 0 },
            { id: 'strict', kind: 'boolean', label: 'Strict', default: false },
            { id: 'extraRepository', kind: 'repository', label: 'Extra repository' },
        ],
        topics: [{ id: 'basics', title: 'Basics', summary: 'Basics summary', body: `Body ${BODY_MARKER}`, sources: [source] },
            { id: 'beta-notes', title: 'Beta notes', summary: 'Beta only', body: 'Beta.', sources: [source], when: { field: 'channel', in: ['beta'] } }],
        recipes: [{ id: 'test', title: 'Run tests', summary: 'Run the test suite', kind: 'test', effects: ['runs_project_code'], prerequisites: ['git'],
            steps: [{ title: 'Test', detail: 'Run tests.', argv: ['make', '-C', '{checkout}/{appDirectory}', 'test'] }] }],
        tasks: [
            { id: 'tests', title: 'Tests', description: 'Run tests', kind: 'test', specialist: 'builtin:tests', recipeIds: ['test'], topicIds: ['basics', 'beta-notes'], defaultTask: 'Run the tests.', requiresRepository: true },
            { id: 'plan', title: 'Plan', description: 'Plan work', kind: 'develop', specialist: 'planner', defaultTask: 'Plan it.', requiresRepository: false },
        ],
        doctor: { provider: { id: 'hapi.toolchain', version: 1 }, checks: [{ id: 'git', required: true }, { id: 'node' }] },
        inspect: { provider: { id: 'hapi.repository-inventory', version: 1 }, directoryField: 'appDirectory' },
        integrations: [{ id: 'status', title: 'GitHub status', kind: 'live_read', provider: 'github.commit-status', description: 'Commit status' },
            { id: 'console', title: 'Console', kind: 'manual', description: 'Open the vendor console.', links: [{ label: 'Console', url: 'https://console.example.com/' }] }],
        ...overrides,
    }
}
function manifestFor(modules: DevelopmentModuleDefinitionInput[], version = '1.0.0'): PluginManifestInput {
    return { schemaVersion: 2, id: 'scenario-plugin', name: 'Scenarios', description: 'Development scenarios', version,
        agents: [{ id: 'planner', name: 'Planner', description: 'Plans', instructions: 'Plan carefully.' }], developmentModules: modules }
}

function setup() {
    let now = Date.UTC(2026, 9, 17, 12)
    const store = new EvolvedStore(':memory:', { now: () => now }); stores.push(store)
    for (const [id, admin] of [['admin', 1], ['member', 0], ['viewer', 0]] as const) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, admin, now)
    const team = store.createTeam('admin', 'Team')
    store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    const project = store.createProject('admin', team.id, 'Project')
    const sessions = Object.fromEntries(['admin', 'member', 'viewer'].map(user => [user, store.createSession(user)]))
    // Plugin source (isolated fake GitHub).
    const localA = `mod-${randomUUID().slice(0, 8)}`, localB = `alt-${randomUUID().slice(0, 8)}`
    let manifest: PluginManifestInput = manifestFor([moduleDefinition(localA), moduleDefinition(localB, { fields: [{ id: 'target', kind: 'text', label: 'Target', format: 'identifier', default: 'all' }], inspect: null, recipes: [], tasks: [], topics: [] })])
    let sha = commit, fetchHook: ((url: string) => Promise<void>) | undefined
    const fetches: string[] = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); fetches.push(url); await fetchHook?.(url)
        if (url.startsWith('https://raw.githubusercontent.com/')) return new Response(JSON.stringify(manifest))
        if (url.includes('/commits/')) return new Headers(init?.headers).get('accept') === 'application/vnd.github.sha' ? new Response(`${sha}\n`) : new Response('', { status: 404 })
        return Response.json({ id: 777, full_name: 'owner/repo', private: false })
    }) as typeof fetch
    const plugins = new PluginService(store, fetcher), registry = new DevelopmentModuleRegistry(plugins)
    // Vault and runner fakes.
    const vaultCalls: VaultRequest[] = []
    let onVault: ((request: VaultRequest) => void | Promise<void>) | undefined
    const vault: VaultClient = { request: async request => {
        vaultCalls.push(request); await onVault?.(request)
        if (request.operation === 'github' && request.payload.action === 'status') return { connected: true, repositories: [repo, { ...repo, id: '999', name: 'extra', fullName: 'acme/extra' }] }
        return {}
    } }
    let capabilities: string[] = [EVOLVED_DEVELOPMENT_CAPABILITY, MACHINE_CAPABILITIES.AgentAvailability]
    const rpcCalls: any[] = []
    let rpc: (params: any) => unknown | Promise<unknown> = () => ({})
    const started: unknown[][] = [], archived: string[] = [], messages = new Map<string, Array<{ localId: string; text: string }>>(), known = new Set<string>()
    let onSpawn: (() => void | Promise<void>) | undefined, onReserved: (() => void) | undefined, onMessage: (() => void) | undefined
    const machine = () => ({ id: 'machine-0', active: true, metadata: { workspaceRoots: [project.rootPath], capabilities, host: 'runner' } })
    const engine = {
        getOnlineMachinesByNamespace: (namespace: string) => namespace === project.namespace ? [machine()] : [],
        getMachineByNamespace: (id: string, namespace: string) => id === 'machine-0' && namespace === project.namespace ? machine() : undefined,
        getSessionByNamespace: (id: string, namespace: string) => known.has(id) && namespace === project.namespace ? { id } : undefined,
        spawnSession: async (...args: unknown[]) => {
            started.push(args); const id = randomUUID()
            onReserved?.(); (args[18] as ((sessionId: string) => void) | undefined)?.(id)
            known.add(id); await onSpawn?.(); return { type: 'success', sessionId: id }
        },
        sendMessage: async (id: string, body: { localId: string; text: string }) => { messages.set(id, [body]); onMessage?.() },
        getMessagesPage: (id: string) => ({ messages: messages.get(id) ?? [] }),
        archiveSession: async (id: string) => { archived.push(id) },
        evolvedDevelopment: async (machineId: string, params: unknown) => { rpcCalls.push(params); return rpc(params) },
    }
    const repositoryStarts: string[] = []
    const repositoryStart: RepositoryStartResolver = async (_authority, repositoryId) => {
        repositoryStarts.push(repositoryId)
        return { directory: `${project.rootPath}/repositories/acme/app`, repositoryId, fullName: 'acme/app', recheck: async () => {}, onReserved: () => {} }
    }
    const service = createDevelopmentService({ store, vault, getEngine: () => engine as never, modules: registry })
    const app = new Hono()
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code, error: error.message }, error.status as 400) : c.json({ code: 'internal', error: String(error) }, 500))
    app.route('/api/evolved', createPluginRoutes(plugins, origin))
    app.route('/api/evolved', service.routes(origin))
    app.route('/api/evolved', createAgentCatalogRoutes({ store, plugins, origin, getSyncEngine: () => engine as unknown as SyncEngine, repositoryStart, development: service }))
    app.route('/api/evolved', createEvolvedRoutes({ store, vault, origin, developmentModules: registry }))
    const request = (path: string, options: { method?: string; user?: string; body?: unknown; token?: string } = {}) => app.request(`${origin}/api/evolved${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: { origin, 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : { cookie: `${SESSION_COOKIE}=${sessions[options.user ?? 'admin']}` }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const dev = (path: string, options: Parameters<typeof request>[1] = {}) => request(`/projects/${project.id}/development${path}`, options)
    const json = async (response: Response) => ({ status: response.status, ...(await response.json() as any) })
    const confirmation = (preview: PluginPreview) => ({ previewId: preview.previewId, commitSha: preview.commitSha, manifestSha256: preview.manifestSha256 })
    const install = async () => {
        const preview = (await json(await request('/plugins/preview', { body: { repository: 'owner/repo', ref: 'main' } }))).preview as PluginPreview & { developmentModules: Array<{ digest: string; id: string | null }> }
        const installed = await json(await request('/plugins', { body: confirmation(preview) }))
        expect(installed.status).toBe(201)
        // Preview and installed digests agree, so the reviewed module is the installed one.
        expect(installed.plugin.developmentModules.map((module: { digest: string }) => module.digest)).toEqual(preview.developmentModules.map(module => module.digest))
        expect(preview.developmentModules.every(module => module.id === null)).toBe(true)
        return installed.plugin.id as string
    }
    const update = async (pluginId: string) => {
        const preview = await json(await request(`/plugins/${pluginId}/preview-update`, { body: { ref: 'main' } }))
        if (preview.status !== 200) return preview
        return json(await request(`/plugins/${pluginId}/update`, { body: confirmation(preview.preview) }))
    }
    const modules = async (user = 'admin') => DevelopmentModulesResponseSchema.parse(await (await dev('/modules', { user })).json())
    const put = (expectedRevision: number, settings: unknown, user = 'admin') => dev('/modules', { method: 'PUT', user, body: { expectedRevision, settings } })
    const settingsWith = (current: DevelopmentModulesResponse, patch: Record<string, unknown>, entries: Record<string, { moduleDigest: string; values: Record<string, unknown> }> = {}) => {
        const kept = Object.fromEntries(Object.entries(current.config.settings.modules).map(([id, entry]) => [id, { moduleDigest: entry.moduleDigest, values: entry.values }]))
        const { modules: _modules, ...rest } = current.config.settings
        return { ...rest, modules: { ...kept, ...entries }, ...patch }
    }
    const activate = async (moduleId: string, values: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) => {
        const current = await modules(), entry = current.catalog.modules.find(module => module.id === moduleId)!
        return put(current.config.revision, settingsWith(current, { activeModuleId: moduleId, ...patch }, { [moduleId]: { moduleDigest: entry.digest, values } }))
    }
    const start = (agentId: string, body: Record<string, unknown>) => request(`/projects/${project.id}/agent-catalog/${agentId}/start`, { body: { operationId: randomUUID(), machineId: 'machine-0', task: 'Do the task.', ...body } })
    const capability = (scopes = ['runner:connect', 'git:read']) => {
        const leaseId = randomUUID()
        store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(leaseId, 'Runner', hashToken(randomToken()), 'admin', project.id, JSON.stringify(scopes), '[]', store.requireProject('admin', project.id).profile, Date.now(), null)
        return store.issueCapability('admin', project.id, scopes, [], 900, leaseId).token
    }
    return { app, store, project, team, plugins, registry, service, localA, localB, fetches, vaultCalls, rpcCalls, started, archived, messages, repositoryStarts, request, dev, json, install, update,
        modules, put, settingsWith, activate, start, capability,
        moduleId: (pluginId: string, local: string) => `plugin:${pluginId}:${local}`,
        setManifest: (value: PluginManifestInput, nextSha = nextCommit) => { manifest = value; sha = nextSha },
        setRpc: (value: typeof rpc) => { rpc = value }, setCapabilities: (value: string[]) => { capabilities = value },
        onVault: (value?: typeof onVault) => { onVault = value }, onSpawn: (value?: typeof onSpawn) => { onSpawn = value }, onReserved: (value?: typeof onReserved) => { onReserved = value }, onMessage: (value?: typeof onMessage) => { onMessage = value },
        fetchHook: (value?: typeof fetchHook) => { fetchHook = value }, advance: (ms: number) => { now += ms } }
}

describe('plugin development modules', () => {
    test('a plugin-only module with a random id installs, activates, exposes knowledge and starts a task through the existing catalog', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        // Installation alone activates nothing, contacts no Vault/runner and starts nothing.
        expect(t.vaultCalls).toHaveLength(0); expect(t.rpcCalls).toHaveLength(0); expect(t.started).toHaveLength(0)
        const catalog = await t.modules()
        expect(catalog.config.settings.activeModuleId).toBeNull()
        const entry = catalog.catalog.modules.find(module => module.id === moduleId)!
        expect(entry).toMatchObject({ origin: 'plugin', state: 'ready', updatePolicy: 'adopt', form: { kind: 'fields', fieldCount: 5 }, source: { kind: 'plugin', pluginId, commitSha: commit } })
        expect(catalog.catalog.modules.slice(0, 3).map(module => module.id)).toEqual(['builtin:odoo', 'builtin:ios', 'builtin:android'])
        expect(JSON.stringify(catalog)).not.toContain(BODY_MARKER)
        const detail = DevelopmentModuleDetailResponseSchema.parse(await (await t.dev(`/modules/${encodeURIComponent(moduleId)}`, { user: 'viewer' })).json())
        expect(detail.module.form.kind === 'fields' && detail.module.form.fields.map(field => field.id)).toEqual(['appDirectory', 'channel', 'retries', 'strict', 'extraRepository'])
        expect(detail.module.tasks.find(task => task.id === 'plan')!.specialist).toBe(`plugin:${pluginId}:planner`)
        expect(detail.module.tasks.find(task => task.id === 'tests')!.effects).toEqual(['runs_project_code'])

        const saved = await t.json(await t.activate(moduleId, { retries: 0, strict: false }, { repositoryId: repo.id }))
        expect(saved.status).toBe(200)
        expect(saved.config.active).toMatchObject({ moduleId, state: 'ready', installedDigest: entry.digest, adoptedDigest: entry.digest })
        expect(saved.config.settings.modules[moduleId]).toMatchObject({ moduleDigest: entry.digest, values: { appDirectory: '.', channel: 'stable', retries: 0, strict: false, extraRepository: null },
            adopted: { pluginId, commitSha: commit, pluginVersion: '1.0.0' } })
        expect(JSON.parse((t.store.db.query('SELECT settings FROM evolved_project_development').get() as { settings: string }).settings).schemaVersion).toBe(2)

        const context = DevelopmentModuleContextSchema.parse(await (await t.dev('/modules-context', { token: t.capability() })).json())
        expect(context.module).toMatchObject({ id: moduleId, digest: entry.digest })
        expect(context.module!.topics.map(topic => topic.id)).toEqual(['basics'])
        expect(context.integrations.map(item => [item.id, item.state])).toEqual([['status', 'configured'], ['console', 'manual']])
        const knowledge = DevelopmentModuleKnowledgeResponseSchema.parse(await (await t.dev('/modules-knowledge?topic=basics', { user: 'viewer' })).json())
        expect(knowledge.topic!.body).toContain(BODY_MARKER)
        expect((await t.dev('/modules-knowledge?topic=beta-notes')).status).toBe(404)

        const response = await t.json(await t.start('builtin:tests', { development: { contractVersion: 2, moduleId, moduleDigest: entry.digest, taskId: 'tests', revision: saved.config.revision } }))
        expect(response.status).toBe(201)
        expect(t.repositoryStarts).toEqual([repo.id])
        const prompt = t.messages.get(response.sessionId)![0]!.text
        const data = JSON.parse(prompt.split('\n').at(-1)!).development
        expect(data).toMatchObject({ module: { id: moduleId, digest: entry.digest, source: { commitSha: commit } }, task: { id: 'tests', effects: ['runs_project_code'], topicIds: ['basics'] }, settings: { channel: 'stable' } })
        expect(data.placeholders.helper).toBeUndefined()
        expect(prompt).not.toContain(BODY_MARKER)
        expect(prompt.indexOf('HAPI-Spezialistenauftrag')).toBe(0)
        // The plugin's own agent is the specialist for its task; another specialist is refused.
        expect((await t.json(await t.start('builtin:implementation', { development: { contractVersion: 2, moduleId, moduleDigest: entry.digest, taskId: 'plan', revision: saved.config.revision } }))).code).toBe('development_task_specialist_mismatch')
        expect((await t.json(await t.start(`plugin:${pluginId}:planner`, { development: { contractVersion: 2, moduleId, moduleDigest: entry.digest, taskId: 'plan', revision: saved.config.revision } }))).status).toBe(201)
    })

    test('values are validated server-side with field paths; CAS and permissions guard writes', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const invalid = await t.json(await t.activate(moduleId, { retries: 9, channel: 'nightly', bogus: 1 }))
        expect(invalid).toMatchObject({ status: 400, code: 'development_module_settings_invalid' })
        expect(invalid.issues.map((issue: { path: string[] }) => issue.path.at(-1)).sort()).toEqual(['bogus', 'channel', 'retries'])
        expect(invalid.issues[0].path.slice(0, 3)).toEqual(['modules', moduleId, 'values'])
        const current = await t.modules(), digest = current.catalog.modules.find(module => module.id === moduleId)!.digest
        const settings = t.settingsWith(current, { activeModuleId: moduleId }, { [moduleId]: { moduleDigest: digest, values: {} } })
        for (const user of ['member', 'viewer']) expect((await t.put(0, settings, user)).status).toBe(403)
        expect((await t.dev('/modules', { method: 'PUT', token: t.capability(['runner:connect', 'git:read', 'git:write']), body: { expectedRevision: 0, settings } })).status).toBe(403)
        expect((await t.put(0, { ...settings, modules: { [moduleId]: { moduleDigest: `sha256:${'0'.repeat(64)}`, values: {} } } })).status).toBe(409)
        expect((await t.put(0, settings)).status).toBe(200)
        const stale = await t.json(await t.put(0, settings))
        expect(stale).toMatchObject({ status: 409, code: 'development_revision_conflict', config: { revision: 1, active: { state: 'ready' } } })
        // A fresh repository reference in a module field needs a current project grant.
        const granted = await t.json(await t.put(1, t.settingsWith(await t.modules(), {}, { [moduleId]: { moduleDigest: digest, values: { extraRepository: '999' } } })))
        expect(granted.status).toBe(200)
        expect(t.vaultCalls.filter(call => call.payload.action === 'status')).toHaveLength(1)
        expect((await t.json(await t.put(2, t.settingsWith(await t.modules(), {}, { [moduleId]: { moduleDigest: digest, values: { extraRepository: '555' } } })))).code).toBe('development_repository_not_granted')
    })

    test('legacy v1 clients keep working for builtin modules, preserve plugin settings and get an explicit upgrade error otherwise', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const odoo: DevelopmentSettings = { ...defaultDevelopmentSettings('odoo'), odoo: defaultOdooSettings(19), android: { ...defaultAndroidSettings(), variant: 'freeDebug' } }
        expect((await t.dev('', { method: 'PUT', body: { expectedRevision: 0, settings: odoo } })).status).toBe(200)
        // Builtin-only configurations stay in the v1 storage format (older binaries can still read them).
        expect(JSON.parse((t.store.db.query('SELECT settings FROM evolved_project_development').get() as { settings: string }).settings)).toEqual(odoo)
        const v2 = await t.modules()
        expect(v2.config.settings).toMatchObject({ activeModuleId: 'builtin:odoo', odoo: { major: 19 }, android: { variant: 'freeDebug' }, modules: {} })
        // Keep Odoo active, add an inactive plugin configuration.
        const digest = v2.catalog.modules.find(module => module.id === moduleId)!.digest
        expect((await t.put(1, t.settingsWith(v2, {}, { [moduleId]: { moduleDigest: digest, values: { channel: 'beta' } } }))).status).toBe(200)
        const legacy = await t.json(await t.dev(''))
        expect(legacy).toMatchObject({ status: 200, config: { revision: 2, settings: { mode: 'odoo', odoo: { major: 19 } } } })
        expect(legacy.config.settings.modules).toBeUndefined()
        // A v1 PUT switching to iOS keeps the plugin entry (not representable in v1, so never dropped).
        expect((await t.dev('', { method: 'PUT', body: { expectedRevision: 2, settings: { ...legacy.config.settings, mode: 'ios', ios: { projectDirectory: '.', projectFile: null, scheme: null, bundleId: null, deploymentTarget: null, buildStrategy: 'undecided', xcodeCloudResourceId: null } } } })).status).toBe(200)
        const after = await t.modules()
        expect(after.config.settings).toMatchObject({ activeModuleId: 'builtin:ios', odoo: { major: 19 }, modules: { [moduleId]: { values: { channel: 'beta' } } } })
        // Activating the plugin module: every v1 surface refuses explicitly instead of reporting `none`.
        expect((await t.put(3, t.settingsWith(after, { activeModuleId: moduleId }))).status).toBe(200)
        for (const [path, method] of [['', 'GET'], ['/context', 'GET'], ['/knowledge', 'GET'], ['/doctor', 'POST'], ['/inspect', 'POST']] as const) {
            const response = await t.json(await t.dev(path, { method, ...(method === 'POST' ? { body: {} } : {}) }))
            expect(response).toMatchObject({ status: 409, code: 'development_client_upgrade_required', revision: 4 })
        }
        expect(await t.json(await t.dev('', { method: 'PUT', body: { expectedRevision: 4, settings: { ...legacy.config.settings, mode: 'none' } } }))).toMatchObject({ status: 409, code: 'development_client_upgrade_required' })
        expect(await t.json(await t.start('builtin:tests', { development: { taskId: 'tests', revision: 4 } }))).toMatchObject({ status: 409, code: 'development_client_upgrade_required', reserved: false })
        expect((await t.modules()).config.revision).toBe(4)
    })

    test('builtin modules work through the same v2 interface, including task digests and Android acknowledgement', async () => {
        const t = setup()
        const catalog = await t.modules(), android = catalog.catalog.modules.find(module => module.id === 'builtin:android')!
        expect(android).toMatchObject({ origin: 'builtin', updatePolicy: 'release', form: { kind: 'builtin', renderer: 'android' }, source: { kind: 'builtin' } })
        const settings = t.settingsWith(catalog, { activeModuleId: 'builtin:android', android: defaultAndroidSettings() })
        expect((await t.put(0, settings)).status).toBe(200)
        expect(await t.json(await t.start('builtin:implementation', { development: { contractVersion: 2, moduleId: 'builtin:android', moduleDigest: `sha256:${'1'.repeat(64)}`, taskId: 'android-setup-sdk', revision: 1 } })))
            .toMatchObject({ status: 409, code: 'development_module_changed', installedDigest: android.digest })
        expect(await t.json(await t.start('builtin:implementation', { development: { contractVersion: 2, moduleId: 'builtin:android', moduleDigest: android.digest, taskId: 'android-setup-sdk', revision: 1 } })))
            .toMatchObject({ status: 409, code: 'development_license_acknowledgement_required' })
        expect(t.started).toHaveLength(0)
        // Builtin context and knowledge through the generic routes keep the v1 version filter.
        const odooCatalog = await t.modules()
        expect((await t.put(1, t.settingsWith(odooCatalog, { activeModuleId: 'builtin:odoo', odoo: defaultOdooSettings(19) }))).status).toBe(200)
        const context = DevelopmentModuleContextSchema.parse(await (await t.dev('/modules-context')).json())
        expect(context.module!.topics.some(topic => topic.id === 'odoo-runtime-19')).toBe(true)
        expect(context.module!.topics.some(topic => topic.id === 'odoo-runtime-20')).toBe(false)
        expect((await t.dev('/modules-knowledge?topic=odoo-runtime-20')).status).toBe(404)
        expect(DevelopmentModuleKnowledgeResponseSchema.parse(await (await t.dev('/modules-knowledge?q=postgresql')).json()).results.length).toBeGreaterThan(0)
    })

    test('plugin update requires adoption; stale task cards and doctor bindings never run the new definition', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        await t.activate(moduleId, {}, { repositoryId: repo.id })
        const before = await t.modules(), oldDigest = before.config.active.adoptedDigest!
        const changed = moduleDefinition(t.localA, { tasks: [{ id: 'tests', title: 'Tests', description: 'Now pushes', kind: 'test', specialist: 'builtin:tests', recipeIds: [], defaultTask: 'Run and push.', effects: ['git_push_may_deploy'], requiresRepository: true }] })
        t.setManifest(manifestFor([changed, moduleDefinition(t.localB)], '2.0.0'))
        expect((await t.update(pluginId)).status).toBe(200)
        const after = await t.modules()
        expect(after.config.active).toMatchObject({ state: 'adoption_required', adoptedDigest: oldDigest })
        expect(after.config.active.installedDigest).not.toBe(oldDigest)
        expect(after.config.settings.modules[moduleId]!.adopted.commitSha).toBe(commit)
        const stale = await t.json(await t.start('builtin:tests', { development: { contractVersion: 2, moduleId, moduleDigest: oldDigest, taskId: 'tests', revision: after.config.revision } }))
        expect(stale).toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'adoption_required' })
        expect(await t.json(await t.dev('/modules-doctor', { body: { moduleId, moduleDigest: oldDigest } }))).toMatchObject({ status: 409, code: 'development_module_unavailable' })
        expect((await t.json(await t.dev('/modules-context'))).module).toBeNull()
        // Explicit adoption with the new digest; provenance follows the installed commit.
        const newDigest = after.config.active.installedDigest!
        const adopted = await t.json(await t.put(after.config.revision, t.settingsWith(after, {}, { [moduleId]: { moduleDigest: newDigest, values: after.config.settings.modules[moduleId]!.values } })))
        expect(adopted.config.active.state).toBe('ready')
        expect(adopted.config.settings.modules[moduleId].adopted).toMatchObject({ commitSha: nextCommit, pluginVersion: '2.0.0' })
        expect(t.started).toHaveLength(0)
    })

    test('disable and uninstall keep settings, refuse starts and never substitute a reinstalled module', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        await t.activate(moduleId, { channel: 'beta' }, { repositoryId: repo.id })
        expect((await t.request(`/plugins/${pluginId}`, { method: 'PUT', body: { enabled: false } })).status).toBe(200)
        let current = await t.modules()
        expect(current.config.active).toMatchObject({ moduleId, state: 'disabled' })
        expect(current.config.settings.modules[moduleId]!.values.channel).toBe('beta')
        // Other settings stay editable while the module is unavailable; activation of an unavailable module is refused.
        expect((await t.put(current.config.revision, t.settingsWith(current, { repositoryId: null }))).status).toBe(200)
        current = await t.modules()
        expect((await t.put(current.config.revision, t.settingsWith(current, { activeModuleId: null }))).status).toBe(200)
        current = await t.modules()
        expect(await t.json(await t.put(current.config.revision, t.settingsWith(current, { activeModuleId: moduleId })))).toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'disabled' })
        expect((await t.put(current.config.revision, t.settingsWith(current, { activeModuleId: 'builtin:odoo', odoo: defaultOdooSettings() }))).status).toBe(200)
        expect((await t.request(`/plugins/${pluginId}`, { method: 'PUT', body: { enabled: true } })).status).toBe(200)
        current = await t.modules()
        expect((await t.put(current.config.revision, t.settingsWith(current, { activeModuleId: moduleId }))).status).toBe(200)
        expect((await t.request(`/plugins/${pluginId}`, { method: 'DELETE' })).status).toBe(200)
        current = await t.modules()
        expect(current.config.active).toMatchObject({ moduleId, state: 'missing', installedDigest: null })
        expect(current.catalog.modules.some(module => module.id === moduleId)).toBe(false)
        // Reinstalling the same repository yields a new identity; the project keeps pointing at the missing module.
        const reinstalled = await t.install()
        expect(reinstalled).not.toBe(pluginId)
        expect((await t.modules()).config.active).toMatchObject({ moduleId, state: 'missing' })
        expect(await t.json(await t.start('builtin:tests', { development: { contractVersion: 2, moduleId, moduleDigest: current.config.settings.modules[moduleId]!.moduleDigest, taskId: 'tests', revision: current.config.revision } })))
            .toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'missing' })
        // Ordinary starts still use the configured default repository of the canonical configuration.
        expect(t.service.defaultRepository(t.project.id)).toBeNull()
    })

    test('an update removing an active module is refused; inactive configurations survive switching between modules', async () => {
        const t = setup(), pluginId = await t.install(), moduleA = t.moduleId(pluginId, t.localA), moduleB = t.moduleId(pluginId, t.localB)
        await t.activate(moduleA, { channel: 'beta', retries: 2 })
        expect((await t.json(await t.activate(moduleB, { target: 'web' }))).status).toBe(200)
        const current = await t.modules()
        expect(current.config.settings.activeModuleId).toBe(moduleB)
        expect(current.config.settings.modules[moduleA]!.values).toMatchObject({ channel: 'beta', retries: 2 })
        t.setManifest(manifestFor([moduleDefinition(t.localA)], '2.0.0'))
        expect(await t.update(pluginId)).toMatchObject({ status: 409, code: 'plugin_dependency' })
        expect((await t.modules()).config.active.state).toBe('ready')
    })
})

describe('asynchronous boundaries', () => {
    test('plugin disable or update during reservation, spawn or assignment aborts the start', async () => {
        for (const phase of ['reserved', 'spawn', 'assignment'] as const) for (const change of ['disable', 'update'] as const) {
            const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
            const saved = await t.json(await t.activate(moduleId, {}, { repositoryId: repo.id }))
            const mutate = () => change === 'disable' ? t.store.db.prepare('UPDATE evolved_plugins SET enabled=0 WHERE id=?').run(pluginId)
                : t.store.db.prepare('UPDATE evolved_plugins SET manifest=?,manifest_sha256=?,revision=revision+1 WHERE id=?').run(JSON.stringify(manifestFor([moduleDefinition(t.localA, { summary: 'Updated' }), moduleDefinition(t.localB)], '1.0.1')), 'e'.repeat(64), pluginId)
            if (phase === 'reserved') t.onReserved(mutate); else if (phase === 'spawn') t.onSpawn(async () => { mutate() }); else t.onMessage(mutate)
            const response = await t.json(await t.start('builtin:tests', { development: { contractVersion: 2, moduleId, moduleDigest: saved.config.active.installedDigest, taskId: 'tests', revision: saved.config.revision } }))
            expect({ phase, change, status: response.status, code: response.code }).toEqual({ phase, change, status: 409, code: 'agent_start_changed' })
            if (phase !== 'assignment') expect(t.messages.size).toBe(0)
            else expect(t.archived).toHaveLength(1)
        }
    })
    test('an update or disable while a module PUT awaits the Vault grant check is not written as adopted', async () => {
        for (const change of ['update', 'disable'] as const) {
            const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
            const current = await t.modules(), digest = current.catalog.modules.find(module => module.id === moduleId)!.digest
            t.onVault(async () => {
                if (change === 'disable') { t.store.db.prepare('UPDATE evolved_plugins SET enabled=0 WHERE id=?').run(pluginId); return }
                // Concurrent administrator update (same effect as the reviewed update route committing between the awaits).
                const raw = JSON.stringify(manifestFor([moduleDefinition(t.localA, { summary: 'Changed summary' }), moduleDefinition(t.localB)], '1.1.0'))
                t.store.db.prepare('UPDATE evolved_plugins SET manifest=?,manifest_sha256=?,commit_sha=?,revision=revision+1 WHERE id=?').run(raw, 'e'.repeat(64), nextCommit, pluginId)
            })
            const response = await t.json(await t.put(0, t.settingsWith(current, { activeModuleId: moduleId, repositoryId: repo.id }, { [moduleId]: { moduleDigest: digest, values: {} } })))
            expect(response).toMatchObject(change === 'disable' ? { status: 409, code: 'development_module_unavailable', state: 'disabled' } : { status: 409, code: 'development_module_changed' })
            if (change === 'update') expect(response.installedDigest).not.toBe(digest)
            expect((await t.modules()).config.revision).toBe(0)
        }
    })
    test('doctor: provider capability is negotiated, results are bound to module digest and discarded after a concurrent disable', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const saved = await t.json(await t.activate(moduleId, {}, { repositoryId: repo.id })), digest = saved.config.active.installedDigest
        const old = DevelopmentModuleDoctorResponseSchema.parse(await (await t.dev('/modules-doctor', { body: { moduleId, moduleDigest: digest } })).json())
        expect(old).toMatchObject({ runner: { status: 'upgrade_required', missingCapabilities: [MACHINE_CAPABILITIES.EvolvedDevelopmentToolchainProvider] }, result: null })
        expect(t.rpcCalls).toHaveLength(0)
        t.setCapabilities([EVOLVED_DEVELOPMENT_CAPABILITY, MACHINE_CAPABILITIES.EvolvedDevelopmentToolchainProvider])
        const result = (params: any) => ({ contractVersion: 2, moduleId: params.moduleId, moduleDigest: params.moduleDigest, provider: params.provider, observedAt: 1, durationMs: 3,
            host: { os: 'linux', arch: 'x64', image: null }, checks: [{ id: 'git', label: 'Git', category: 'toolchain', state: 'ready' }], truncated: false })
        t.setRpc(result)
        const ready = await t.json(await t.dev('/modules-doctor', { body: { moduleId, moduleDigest: digest } }))
        expect(ready).toMatchObject({ status: 200, runner: { status: 'ready' }, result: { moduleId, moduleDigest: digest, checks: [{ id: 'git', state: 'ready' }] } })
        expect(t.rpcCalls[0]).toEqual({ action: 'module_doctor', contractVersion: 2, projectId: t.project.id, revision: saved.config.revision, moduleId, moduleDigest: digest,
            provider: { id: 'hapi.toolchain', version: 1 }, checks: ['git', 'node'], repository: expect.objectContaining({ id: repo.id }) })
        expect(JSON.stringify(t.rpcCalls[0])).not.toContain('make')
        expect((await t.json(await t.dev('/modules-context'))).lastDoctor).toMatchObject({ moduleId, moduleDigest: digest, ready: 1 })
        // The cached summary belongs to one lifecycle generation of the plugin.
        t.store.db.transaction(() => { t.plugins.setEnabled(pluginId, false); t.plugins.setEnabled(pluginId, true) }).immediate()
        expect((await t.json(await t.dev('/modules-context'))).lastDoctor).toBeNull()
        t.setRpc(params => { t.store.db.prepare('UPDATE evolved_plugins SET enabled=0 WHERE id=?').run(pluginId); return result(params) })
        expect(await t.json(await t.dev('/modules-doctor', { body: { moduleId, moduleDigest: digest } }))).toMatchObject({ status: 409, code: 'development_changed' })
        // A result for another module digest is rejected.
        t.store.db.prepare('UPDATE evolved_plugins SET enabled=1 WHERE id=?').run(pluginId)
        t.setRpc(params => ({ ...result(params), moduleDigest: `sha256:${'f'.repeat(64)}` }))
        expect(await t.json(await t.dev('/modules-doctor', { body: { moduleId, moduleDigest: digest } }))).toMatchObject({ status: 502, code: 'invalid_runner_response' })
        expect(await t.json(await t.dev('/modules-doctor', { body: { moduleId: 'builtin:odoo', moduleDigest: digest } }))).toMatchObject({ status: 409, code: 'development_module_changed' })
    })
    test('builtin v2 doctor uses the existing v1 runner action and maps its result', async () => {
        const t = setup(), catalog = await t.modules(), odoo = catalog.catalog.modules.find(module => module.id === 'builtin:odoo')!
        await t.put(0, t.settingsWith(catalog, { activeModuleId: 'builtin:odoo', odoo: defaultOdooSettings(20) }))
        t.setRpc(params => ({ contractVersion: 1, mode: params.mode, observedAt: 1, durationMs: 1, host: { os: 'linux', arch: 'x64', image: null }, checks: [], truncated: false }))
        const response = await t.json(await t.dev('/modules-doctor', { body: { moduleId: 'builtin:odoo', moduleDigest: odoo.digest } }))
        expect(response).toMatchObject({ status: 200, result: { contractVersion: 2, moduleId: 'builtin:odoo', provider: { id: 'builtin.odoo', version: 1 } } })
        expect(t.rpcCalls[0]).toMatchObject({ action: 'doctor', mode: 'odoo', settings: { mode: 'odoo' } })
    })
})

describe('unsupported modules and repository resolution', () => {
    test('a module needing an unknown provider is listed honestly as unsupported and cannot be activated', async () => {
        const t = setup()
        t.setManifest(manifestFor([moduleDefinition(t.localA, { doctor: { provider: { id: 'acme.future-doctor', version: 4 }, checks: [{ id: 'flux' }] },
            recipes: [], tasks: [] })]), commit)
        const pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const catalog = await t.modules(), entry = catalog.catalog.modules.find(module => module.id === moduleId)!
        expect(entry).toMatchObject({ state: 'unsupported', providers: expect.arrayContaining([{ id: 'acme.future-doctor', version: 4, kind: 'doctor', supported: false }]) })
        expect(entry.reasons[0]).toContain('acme.future-doctor')
        expect(await t.json(await t.activate(moduleId))).toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'unsupported' })
    })
    test('the default repository follows the canonical configuration and an unreadable one fails instead of using the project root', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        await t.activate(moduleId, {}, { repositoryId: repo.id })
        const snapshot = t.service.defaultRepository(t.project.id)!
        expect(snapshot).toMatchObject({ repositoryId: repo.id, revision: 1 })
        t.store.db.prepare('UPDATE evolved_plugins SET enabled=0 WHERE id=?').run(pluginId)
        expect(() => snapshot.verify()).not.toThrow()
        expect(t.service.defaultRepository(t.project.id)?.repositoryId).toBe(repo.id)
        t.store.db.prepare("UPDATE evolved_project_development SET settings='{\"schemaVersion\":2,\"settings\":{}}'").run()
        expect(() => t.service.defaultRepository(t.project.id)).toThrow(DevelopmentConfigInvalidError)
        expect(() => snapshot.verify()).toThrow()
        expect((await t.json(await t.dev('/modules'))).code).toBe('development_config_invalid')
    })
    test('project creation accepts a v2 plugin module bound to its digest and rejects repository references', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const digest = (await t.modules()).catalog.modules.find(module => module.id === moduleId)!.digest
        const base = { activeModuleId: moduleId, repositoryId: null, odoo: null, ios: null, android: null }
        const create = (development: unknown) => t.request('/projects', { body: { teamId: t.team.id, name: `P${randomUUID().slice(0, 6)}`, development } })
        expect((await create({ contractVersion: 2, settings: { ...base, modules: { [moduleId]: { moduleDigest: `sha256:${'2'.repeat(64)}`, values: {} } } } })).status).toBe(409)
        expect((await create({ contractVersion: 2, settings: { ...base, modules: { [moduleId]: { moduleDigest: digest, values: { extraRepository: repo.id } } } } })).status).toBe(400)
        const created = await t.json(await create({ contractVersion: 2, settings: { ...base, modules: { [moduleId]: { moduleDigest: digest, values: { channel: 'beta' } } } } }))
        expect(created.status).toBe(201)
        const config = DevelopmentModulesResponseSchema.parse(await (await t.request(`/projects/${created.project.id}/development/modules`)).json()).config
        expect(config).toMatchObject({ revision: 1, active: { moduleId, state: 'ready' }, settings: { modules: { [moduleId]: { values: { channel: 'beta' } } } } })
    })
})

describe('project creation errors keep their typed details', () => {
    test('POST /projects returns field issues, module digests and states and persists nothing; other errors stay bounded', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const digest = (await t.modules()).catalog.modules.find(module => module.id === moduleId)!.digest
        const base = { activeModuleId: moduleId, repositoryId: null, odoo: null, ios: null, android: null }
        const persisted = () => ({
            projects: (t.store.db.query('SELECT COUNT(*) AS n FROM evolved_projects').get() as { n: number }).n,
            configs: (t.store.db.query('SELECT COUNT(*) AS n FROM evolved_project_development').get() as { n: number }).n,
            directories: readdirSync(t.store.managedWorkspaceRoot).length,
        })
        const before = persisted()
        const create = async (development: unknown, extra: Record<string, unknown> = {}) => t.json(await t.request('/projects', { body: { teamId: t.team.id, name: `P${randomUUID().slice(0, 6)}`, development, ...extra } }))
        const invalid = await create({ contractVersion: 2, settings: { ...base, modules: { [moduleId]: { moduleDigest: digest, values: { retries: 9, channel: 'nightly' } } } } })
        expect(invalid).toMatchObject({ status: 400, code: 'development_module_settings_invalid' })
        expect(invalid.issues.map((issue: { path: string[] }) => issue.path).sort()).toEqual([['modules', moduleId, 'values', 'channel'], ['modules', moduleId, 'values', 'retries']])
        expect(Object.keys(invalid).sort()).toEqual(['code', 'error', 'issues', 'status'])
        const stale = await create({ contractVersion: 2, settings: { ...base, modules: { [moduleId]: { moduleDigest: `sha256:${'2'.repeat(64)}`, values: {} } } } })
        expect(stale).toMatchObject({ status: 409, code: 'development_module_changed', moduleId, installedDigest: digest })
        t.store.db.transaction(() => t.plugins.setEnabled(pluginId, false)).immediate()
        expect(await create({ contractVersion: 2, settings: { ...base, modules: { [moduleId]: { moduleDigest: digest, values: {} } } } }))
            .toMatchObject({ status: 409, code: 'development_module_unavailable', moduleId, state: 'disabled' })
        expect(persisted()).toEqual(before)
        // Unrelated errors keep the plain bounded body.
        const unrelated = await create(undefined, { teamId: 'missing-team' })
        expect(unrelated.status).toBeGreaterThanOrEqual(400)
        expect(Object.keys(unrelated).sort()).toEqual(['code', 'error', 'status'])
        const notAdmin = await t.json(await t.request('/projects', { user: 'member', body: { teamId: t.team.id, name: 'P', rootPath: '/tmp' } }))
        expect(Object.keys(notAdmin).sort()).toEqual(['code', 'error', 'status'])
        expect(persisted()).toEqual(before)
    })
})

describe('core follow-up: lifecycle generation, digest scope, catalogue, quarantine, future data', () => {
    const disableEnable = (t: ReturnType<typeof setup>, pluginId: string) => t.store.db.transaction(() => { t.plugins.setEnabled(pluginId, false); t.plugins.setEnabled(pluginId, true) }).immediate()
    test('enable/disable advance the plugin revision only on effective changes', async () => {
        const t = setup(), pluginId = await t.install(), revision = () => t.plugins.get(pluginId).revision
        expect(revision()).toBe(1)
        expect((await t.request(`/plugins/${pluginId}`, { method: 'PUT', body: { enabled: true } })).status).toBe(200)
        expect(revision()).toBe(1)
        expect((await t.request(`/plugins/${pluginId}`, { method: 'PUT', body: { enabled: false } })).status).toBe(200)
        expect((await t.request(`/plugins/${pluginId}`, { method: 'PUT', body: { enabled: true } })).status).toBe(200)
        expect(revision()).toBe(3)
    })
    test('a disable/re-enable (same digest) during reservation, spawn or assignment aborts the start', async () => {
        for (const phase of ['reserved', 'spawn', 'assignment'] as const) {
            const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
            const saved = await t.json(await t.activate(moduleId, {}, { repositoryId: repo.id })), digest = saved.config.active.installedDigest
            const aba = () => disableEnable(t, pluginId)
            if (phase === 'reserved') t.onReserved(aba); else if (phase === 'spawn') t.onSpawn(async () => { aba() }); else t.onMessage(aba)
            const response = await t.json(await t.start('builtin:tests', { development: { contractVersion: 2, moduleId, moduleDigest: digest, taskId: 'tests', revision: saved.config.revision } }))
            expect({ phase, status: response.status, code: response.code }).toEqual({ phase, status: 409, code: 'agent_start_changed' })
            // Same digest afterwards: no re-adoption is needed for a routine enable/disable.
            expect((await t.modules()).config.active).toMatchObject({ state: 'ready', installedDigest: digest })
        }
    })
    test('a disable/re-enable during PUT, context, doctor or inspect awaits invalidates the in-flight snapshot', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const current = await t.modules(), digest = current.catalog.modules.find(module => module.id === moduleId)!.digest
        t.onVault(async () => disableEnable(t, pluginId))
        expect(await t.json(await t.put(0, t.settingsWith(current, { activeModuleId: moduleId, repositoryId: repo.id }, { [moduleId]: { moduleDigest: digest, values: {} } }))))
            .toMatchObject({ status: 409, code: 'development_module_changed', installedDigest: digest })
        expect((await t.modules()).config.revision).toBe(0)
        t.onVault(undefined)
        const saved = await t.json(await t.activate(moduleId, {}, { repositoryId: repo.id }))
        expect(saved.status).toBe(200)
        t.onVault(async () => disableEnable(t, pluginId))
        expect(await t.json(await t.dev('/modules-context'))).toMatchObject({ status: 409, code: 'development_changed' })
        // Inspect: even the early "runner upgrade required" answer is refused after an ABA during the grant lookup.
        expect(await t.json(await t.dev('/modules-inspect', { body: { moduleId, moduleDigest: digest } }))).toMatchObject({ status: 409, code: 'development_changed' })
        t.onVault(undefined)
        expect(await t.json(await t.dev('/modules-inspect', { body: { moduleId, moduleDigest: digest } }))).toMatchObject({ status: 200, runner: { status: 'upgrade_required' } })
        t.setCapabilities([EVOLVED_DEVELOPMENT_CAPABILITY, MACHINE_CAPABILITIES.EvolvedDevelopmentToolchainProvider])
        t.setRpc(params => { disableEnable(t, pluginId); return { contractVersion: 2, moduleId: params.moduleId, moduleDigest: params.moduleDigest, provider: params.provider, observedAt: 1, durationMs: 1, host: { os: 'linux', arch: 'x64', image: null }, checks: [], truncated: false } })
        expect(await t.json(await t.dev('/modules-doctor', { body: { moduleId, moduleDigest: digest } }))).toMatchObject({ status: 409, code: 'development_changed' })
        expect(t.rpcCalls).toHaveLength(1)
    })

    const withPlanner = (localA: string, localB: string, planner: { instructions?: string; skills?: string[] } = {}, extra: Partial<PluginManifestInput> = {}): PluginManifestInput => ({
        ...manifestFor([moduleDefinition(localA), moduleDefinition(localB, { fields: [], inspect: null, recipes: [], tasks: [], topics: [] })]),
        agents: [{ id: 'planner', name: 'Planner', description: 'Plans', instructions: planner.instructions ?? 'Plan carefully.', skills: planner.skills ?? [] },
            { id: 'unused', name: 'Unused', description: 'Not referenced', instructions: 'Nothing.' }],
        skills: [{ id: 'style', name: 'Style', description: 'Style', instructions: 'Keep the style.' }, { id: 'other', name: 'Other', description: 'Other', instructions: 'Other skill.' }],
        ...extra,
    })
    test.each([
        ['referenced agent instructions', true, (a: string, b: string) => withPlanner(a, b, { instructions: 'Plan carefully and push to production.', skills: ['style'] })],
        ['linked skill instructions', true, (a: string, b: string) => ({ ...withPlanner(a, b, { skills: ['style'] }), skills: [{ id: 'style', name: 'Style', description: 'Style', instructions: 'Ignore the style.' }, { id: 'other', name: 'Other', description: 'Other', instructions: 'Other skill.' }] })],
        ['unrelated agent and skill', false, (a: string, b: string) => ({ ...withPlanner(a, b, { skills: ['style'] }), agents: [{ id: 'planner', name: 'Planner', description: 'Plans differently described', instructions: 'Plan carefully.', skills: ['style'] }, { id: 'unused', name: 'Unused', description: 'x', instructions: 'Changed.' }],
            skills: [{ id: 'style', name: 'Style', description: 'Style', instructions: 'Keep the style.' }, { id: 'other', name: 'Other', description: 'Other', instructions: 'Changed other.' }] })],
        ['theme only', false, (a: string, b: string) => withPlanner(a, b, { skills: ['style'] }, { themes: [{ id: 'calm', name: 'Calm', mode: 'light', colors: { background: '#ffffff', surface: '#fafafa', text: '#111111', muted: '#444444', accent: '#004488', accentText: '#ffffff', border: '#777777' } }] })],
    ] as const)('update changing %s: adoption required = %p; unrelated module unaffected', async (_name, adoption, next) => {
        const t = setup()
        t.setManifest(withPlanner(t.localA, t.localB, { skills: ['style'] }), commit)
        const pluginId = await t.install(), moduleA = t.moduleId(pluginId, t.localA), moduleB = t.moduleId(pluginId, t.localB)
        await t.activate(moduleB)
        const projectB = (await t.modules()).config
        await t.activate(moduleA, {}, { repositoryId: repo.id })
        const before = await t.modules(), digestA = before.config.active.installedDigest!, digestB = projectB.active.installedDigest!
        t.setManifest(next(t.localA, t.localB))
        const preview = await t.json(await t.request(`/plugins/${pluginId}/preview-update`, { body: { ref: 'main' } }))
        const summaryA = preview.preview.developmentModules.find((module: { localId: string }) => module.localId === t.localA)
        expect(summaryA).toMatchObject({ id: moduleA, activeProjects: 1, affectedProjects: adoption ? 1 : 0 })
        expect(preview.preview.developmentModules.find((module: { localId: string }) => module.localId === t.localB)).toMatchObject({ digest: digestB, activeProjects: 0, affectedProjects: 0 })
        expect((await t.json(await t.request(`/plugins/${pluginId}/update`, { body: { previewId: preview.preview.previewId, commitSha: preview.preview.commitSha, manifestSha256: preview.preview.manifestSha256 } }))).status).toBe(200)
        const after = await t.modules()
        expect(after.catalog.modules.find(module => module.id === moduleB)!.digest).toBe(digestB)
        expect(after.config.active.state).toBe(adoption ? 'adoption_required' : 'ready')
        const start = await t.json(await t.start(`plugin:${pluginId}:planner`, { development: { contractVersion: 2, moduleId: moduleA, moduleDigest: digestA, taskId: 'plan', revision: after.config.revision } }))
        if (adoption) {
            expect(start).toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'adoption_required' })
            expect(t.started).toHaveLength(0)
        } else {
            expect(start.status).toBe(201)
            expect(t.messages.get(start.sessionId)![0]!.text).toContain('Plan carefully.')
        }
    })
    test('the project-independent catalogue serves signed-in people only, without runner capabilities or mixed credentials', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const outsider = t.store.createSession('viewer')
        const list = DevelopmentModuleCatalogResponseSchema.parse(await (await t.app.request(`${origin}/api/evolved/development-modules`, { headers: { origin, cookie: `${SESSION_COOKIE}=${outsider}` } })).json())
        expect(list.modules.map(module => module.id)).toEqual(['builtin:odoo', 'builtin:ios', 'builtin:android', moduleId, t.moduleId(pluginId, t.localB)])
        expect(JSON.stringify(list)).not.toContain(BODY_MARKER)
        const detail = DevelopmentModuleDetailResponseSchema.parse(await (await t.request(`/development-modules/${encodeURIComponent(moduleId)}`, { user: 'viewer' })).json())
        expect(detail.module).toMatchObject({ id: moduleId, form: { kind: 'fields' } })
        expect((await t.request('/development-modules/builtin:unknown')).status).toBe(404)
        expect((await t.request('/development-modules?all=1')).status).toBe(400)
        expect((await t.request('/development-modules', { token: t.capability() })).status).toBe(403)
        expect((await t.app.request(`${origin}/api/evolved/development-modules`, { headers: { origin, cookie: `${SESSION_COOKIE}=${outsider}`, authorization: `Bearer ${t.capability()}` } })).status).toBe(403)
        expect((await t.app.request(`${origin}/api/evolved/development-modules`, { headers: { origin } })).status).toBe(401)
        expect((await t.request('/development-modules', { method: 'PUT', body: {} })).status).toBe(404)
    })
    test('a quarantined (invalid) stored plugin reports invalid, keeps the configuration and discloses no stored content', async () => {
        const t = setup(), pluginId = await t.install(), moduleId = t.moduleId(pluginId, t.localA)
        const saved = await t.json(await t.activate(moduleId, { channel: 'beta' }))
        t.store.db.prepare('UPDATE evolved_plugins SET manifest=? WHERE id=?').run('{"schemaVersion":1,"secretMarker":"RAW-STORED-MARKER"}', pluginId)
        const current = await t.modules()
        expect(current.config.active).toMatchObject({ moduleId, state: 'invalid', installedDigest: null, adoptedDigest: saved.config.active.installedDigest })
        expect(current.config.settings.modules[moduleId]!.values.channel).toBe('beta')
        expect(JSON.stringify(current)).not.toContain('RAW-STORED-MARKER')
        expect(JSON.stringify(await t.json(await t.dev('/modules-context')))).not.toContain('RAW-STORED-MARKER')
        expect(await t.json(await t.dev('/modules-knowledge'))).toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'invalid' })
        expect(await t.json(await t.start('builtin:tests', { development: { contractVersion: 2, moduleId, moduleDigest: saved.config.active.installedDigest, taskId: 'tests', revision: current.config.revision } })))
            .toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'invalid' })
        expect((await t.put(current.config.revision, t.settingsWith(current, { activeModuleId: null }))).status).toBe(200)
        const after = await t.modules()
        expect(await t.json(await t.put(after.config.revision, t.settingsWith(after, { activeModuleId: moduleId })))).toMatchObject({ status: 409, code: 'development_module_unavailable', state: 'invalid' })
        expect((await t.modules()).config.settings.modules[moduleId]!.values.channel).toBe('beta')
    })
    test('a configuration written by a newer HAPI is reported and never overwritten, not even by the corrupt-record recovery', async () => {
        const t = setup()
        expect((await t.dev('', { method: 'PUT', body: { expectedRevision: 0, settings: { ...defaultDevelopmentSettings('odoo'), repositoryId: repo.id } } })).status).toBe(200)
        const raw = '{"schemaVersion":3,"settings":{"activeModuleId":"builtin:odoo","repositoryId":"123456","future":{"x":1}}}'
        t.store.db.prepare('UPDATE evolved_project_development SET settings=? WHERE project_id=?').run(raw, t.project.id)
        const row = () => t.store.db.query('SELECT revision,settings FROM evolved_project_development WHERE project_id=?').get(t.project.id)
        const expected = { status: 409, code: 'development_config_version_unsupported', revision: 1, schemaVersion: 3 }
        expect(DevelopmentConfigVersionUnsupportedSchema.safeParse((({ status: _status, ...body }) => body)(await t.json(await t.dev('/modules')))).success).toBe(true)
        for (const [path, method] of [['', 'GET'], ['/modules', 'GET'], ['/context', 'GET'], ['/modules-context', 'GET'], ['/modules-knowledge', 'GET']] as const) expect(await t.json(await t.dev(path, { method }))).toMatchObject(expected)
        expect(await t.json(await t.dev('', { method: 'PUT', body: { expectedRevision: 1, settings: defaultDevelopmentSettings() } }))).toMatchObject(expected)
        expect(await t.json(await t.put(1, { activeModuleId: null, repositoryId: null, odoo: null, ios: null, android: null, modules: {} }))).toMatchObject(expected)
        expect(await t.json(await t.start('builtin:tests', { development: { taskId: 'odoo-run-tests', revision: 1 } }))).toMatchObject({ status: 409, code: 'development_config_version_unsupported' })
        expect(() => t.service.defaultRepository(t.project.id)).toThrow()
        expect(row()).toEqual({ revision: 1, settings: raw })
    })
    test('the total project settings stay below the request limit: a write that would not round-trip is refused', async () => {
        const t = setup(), locals = Array.from({ length: 4 }, (_, index) => `big${index}-${randomUUID().slice(0, 6)}`)
        const fields = [{ id: 'items', kind: 'text_list' as const, label: 'Items', maxItems: 32, maxLength: 200 }, { id: 'note', kind: 'text' as const, label: 'Note', maxLength: 500 }]
        t.setManifest({ ...manifestFor(locals.map(local => moduleDefinition(local, { fields, recipes: [], tasks: [], topics: [], inspect: null }))), agents: [] }, commit)
        const pluginId = await t.install()
        const values = (seed: string) => ({ items: Array.from({ length: 32 }, (_, index) => `${seed}-${index}-`.padEnd(200, 'v')), note: 'n'.repeat(500) })
        let written = 0, refused: any = null
        for (const local of locals) {
            const response = await t.json(await t.activate(t.moduleId(pluginId, local), values(local)))
            if (response.status === 200) written++
            else { refused = response; break }
        }
        expect(written).toBeGreaterThan(0)
        expect(refused).toMatchObject({ status: 400, code: 'development_settings_too_large', limitBytes: 28 * 1024 })
        // What is stored can always be sent back unchanged.
        const current = await t.modules()
        const roundTrip = await t.put(current.config.revision, t.settingsWith(current, {}))
        expect(roundTrip.status).toBe(200)
        expect((await t.modules()).config.revision).toBe(written + 1)
    })
})


describe('invalid module manifests are explained in the plugin preview without leaking content', () => {
    const preview = async (t: ReturnType<typeof setup>, value: unknown) => {
        t.setManifest(value as PluginManifestInput, commit)
        return t.json(await t.request('/plugins/preview', { body: { repository: 'owner/repo', ref: 'main' } }))
    }
    test('budget and default errors name the module path and the reason', async () => {
        const t = setup(), local = `mod-${randomUUID().slice(0, 8)}`
        const big = (length: number, seed: string) => (seed + 'x'.repeat(length)).slice(0, length)
        const module = moduleDefinition(local, {
            recipes: [{ id: 'long', title: 'Long', summary: 'Long', kind: 'test', steps: Array.from({ length: 20 }, (_, index) => ({ title: `S${index}`, detail: big(1000, `d${index}`) })) }],
            tasks: [{ id: 'plan', title: 'Plan', description: 'Plan', kind: 'develop', specialist: 'planner', recipeIds: ['long'], defaultTask: 'Plan.', requiresRepository: false }],
            doctor: null, inspect: null,
        })
        ;(module.fields![2] as { default: number }).default = 99
        const response = await preview(t, { ...manifestFor([module]), agents: [{ id: 'planner', name: 'Planner', description: 'Plans', instructions: big(16_000, 'a'), skills: ['one', 'two'] }],
            skills: ['one', 'two'].map(id => ({ id, name: id, description: id, instructions: big(16_000, id) })) })
        expect(response).toMatchObject({ status: 400, code: 'plugin_manifest_invalid' })
        expect(response.error).toContain('developmentModules.0.fields.2.default: Invalid default')
        expect(response.error).toContain('developmentModules.0.tasks.0: Specialist, skills, task and recipes leave too little room')
        expect(response.error.length).toBeLessThan(3000)
        expect(response.error).not.toContain('xxxxxxxx')
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_plugin_previews').get()).toEqual({ n: 0 })
    })
    test('unknown keys, raw values and long input are never echoed; at most eight issues are listed', async () => {
        const t = setup(), local = `mod-${randomUUID().slice(0, 8)}`
        const secretKey = `SECRET_KEY_${'k'.repeat(5000)}`, secretValue = `SECRET-VALUE-${'v'.repeat(400)}`
        const module = structuredClone(moduleDefinition(local)) as Record<string, any>
        module[secretKey] = 'x'
        module.title = secretValue
        module.summary = 42
        module.fields[1].options[0].value = 'SECRET OPTION VALUE'
        module.topics[0].sources[0].url = 'https://user:SECRETPASS@example.com/'
        module.contentVersion = '!!SECRET-VERSION!!'
        module.tasks[0].kind = 'SECRET-KIND'
        module.recipes[0].steps[0].argv = ['{SECRETPLACEHOLDER}']
        module.integrations[0].provider = 'SECRET.PROVIDER'
        const response = await preview(t, { ...manifestFor([module as DevelopmentModuleDefinitionInput]), [`ROOT_${secretKey}`]: secretValue })
        expect(response).toMatchObject({ status: 400, code: 'plugin_manifest_invalid' })
        for (const leak of ['SECRET', 'kkkkkkkk', 'vvvvvvvv']) expect(response.error).not.toContain(leak)
        expect(response.error).toMatch(/more issues?\.$/)
        expect(response.error.split('; ').length).toBeLessThanOrEqual(9)
        expect(response.error.length).toBeLessThan(3000)
        const unknownOnly = await preview(t, { ...manifestFor([moduleDefinition(local)]), [`ROOT_${secretKey}`]: secretValue })
        expect(unknownOnly.error).toBe('Plugin manifest is invalid: (root): Unsupported field (1).')
    })
    test('size and JSON errors keep their existing messages', () => {
        expect(() => parsePluginManifest('{not json')).toThrow('Plugin manifest must be valid JSON.')
        expect(() => parsePluginManifest(' '.repeat(512 * 1024 + 1))).toThrow('Plugin manifest exceeds 512 KiB.')
        try { parsePluginManifest('[]') } catch (error) { expect(error).toMatchObject({ code: 'plugin_manifest_invalid', message: 'Plugin manifest is invalid: (root): Expected object.' }) }
    })
})
