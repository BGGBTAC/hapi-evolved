import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { EVOLVED_DEVELOPMENT_CAPABILITY } from '@hapi/protocol/evolvedDevelopment'
import { CLAUDE_ADS_BUNDLED_PLUGIN_ID, CLAUDE_ADS_MODULE_ID, CLAUDE_ADS_UPSTREAM } from '@hapi/protocol/bundledPlugins'
import { DevelopmentModuleDetailResponseSchema, DevelopmentModulesResponseSchema, developmentProviderCapability } from '@hapi/protocol/developmentModules'
import { MAX_AGENT_PROMPT_BYTES } from '@hapi/protocol/pluginManifest'
import { createDevelopmentService, serializeDevelopmentSettings } from './development'
import { DevelopmentModuleRegistry } from './developmentModules'
import { createAgentCatalogRoutes } from './agentCatalog'
import { BUNDLED_PLUGIN_SOURCES, loadBundledPlugins } from './bundledPlugins'
import { CLAUDE_ADS_PLUGIN_MANIFEST_SOURCE } from './bundled/claudeAdsPlugin.generated'
import { PluginService, createPluginRoutes } from './plugins'
import { EvolvedError, EvolvedStore } from './store'
import { SESSION_COOKIE } from './security'
import type { VaultClient } from './vault'
import type { SyncEngine } from '../sync/syncEngine'

const REPO = join(import.meta.dir, '..', '..', '..')
const VENDOR = join(REPO, 'vendor', 'claude-ads')
const stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const origin = 'https://ads.example.test'

function setup(bundled = loadBundledPlugins()) {
    const store = new EvolvedStore(':memory:'); stores.push(store)
    for (const [id, admin] of [['admin', 1], ['member', 0]] as const) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, admin, Date.now())
    const team = store.createTeam('admin', 'Team')
    store.setMember('admin', team.id, 'member', 'member')
    const project = store.createProject('admin', team.id, 'Ads')
    store.db.prepare("UPDATE evolved_projects SET profile='workspace' WHERE id=?").run(project.id)
    const sessions = Object.fromEntries(['admin', 'member'].map(user => [user, store.createSession(user)]))
    const fetches: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
        const url = String(input); fetches.push(url)
        if (url.startsWith('https://raw.githubusercontent.com/')) return new Response(JSON.stringify({ schemaVersion: 1, id: 'claude-ads', name: 'Impostor', description: 'Collides', version: '9.9.9', skills: [{ id: 'x', name: 'x', description: 'x', instructions: 'x' }] }))
        if (url.includes('/commits/')) return new Response(`${'c'.repeat(40)}\n`)
        return Response.json({ id: 4242, full_name: 'someone/ads-fork', private: false })
    }) as typeof fetch
    const plugins = new PluginService(store, fetcher, bundled), registry = new DevelopmentModuleRegistry(plugins)
    const vault: VaultClient = { request: async () => ({}) }
    const rpcCalls: any[] = [], messages = new Map<string, Array<{ localId: string; text: string }>>(), known = new Set<string>(), started: unknown[][] = []
    const capabilities = [EVOLVED_DEVELOPMENT_CAPABILITY, MACHINE_CAPABILITIES.AgentAvailability, developmentProviderCapability('hapi.claude-ads', 1)]
    const machine = () => ({ id: 'machine-0', active: true, metadata: { workspaceRoots: [project.rootPath], capabilities, host: 'runner' } })
    const engine = {
        getOnlineMachinesByNamespace: (namespace: string) => namespace === project.namespace ? [machine()] : [],
        getMachineByNamespace: (id: string, namespace: string) => id === 'machine-0' && namespace === project.namespace ? machine() : undefined,
        getSessionByNamespace: (id: string, namespace: string) => known.has(id) && namespace === project.namespace ? { id } : undefined,
        spawnSession: async (...args: unknown[]) => { started.push(args); const id = randomUUID(); (args[18] as ((sessionId: string) => void) | undefined)?.(id); known.add(id); return { type: 'success', sessionId: id } },
        sendMessage: async (id: string, body: { localId: string; text: string }) => { messages.set(id, [body]) },
        getMessagesPage: (id: string) => ({ messages: messages.get(id) ?? [] }),
        archiveSession: async () => {},
        evolvedDevelopment: async (_machineId: string, params: any) => {
            rpcCalls.push(params)
            return { contractVersion: 2, moduleId: params.moduleId, moduleDigest: params.moduleDigest, provider: params.provider, observedAt: 1, durationMs: 1, host: { os: 'linux', arch: 'x64', image: null },
                checks: params.checks.map((id: string) => ({ id, label: id, category: 'runtime', state: 'ready' })), truncated: false }
        },
    }
    const service = createDevelopmentService({ store, vault, getEngine: () => engine as never, modules: registry })
    const app = new Hono()
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code, error: error.message }, error.status as 400) : c.json({ code: 'internal', error: String(error) }, 500))
    app.route('/api/evolved', createPluginRoutes(plugins, origin))
    app.route('/api/evolved', service.routes(origin))
    app.route('/api/evolved', createAgentCatalogRoutes({ store, plugins, origin, getSyncEngine: () => engine as unknown as SyncEngine, development: service }))
    const request = async (path: string, options: { method?: string; user?: string; body?: unknown } = {}) => {
        const response = await app.request(`${origin}/api/evolved${path}`, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
            headers: { origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${sessions[options.user ?? 'admin']}` }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
        return { status: response.status, ...(await response.json() as any) }
    }
    const dev = (path: string, options: Parameters<typeof request>[1] = {}) => request(`/projects/${project.id}/development${path}`, options)
    const modules = async () => DevelopmentModulesResponseSchema.parse(await dev('/modules').then(({ status: _status, ...rest }) => rest))
    return { store, project, plugins, registry, fetches, rpcCalls, messages, started, request, dev, modules }
}

const VALUES = { client: 'Synthetic Shop', primaryPlatform: 'google', platforms: ['google', 'meta'], accounts: ['google: 123-456-7890'], currency: 'EUR', timezone: 'Europe/Berlin',
    evidencePaths: ['exports/google.csv'], lifecyclePath: 'ops/data-lifecycle.json', vaultResource: 'vault:ads-readonly' }

describe('bundled plugin registry', () => {
    test('the generated manifest is a valid schemaVersion-2 plugin built from unchanged vendored files', () => {
        expect(BUNDLED_PLUGIN_SOURCES.map(source => source.id)).toEqual([CLAUDE_ADS_BUNDLED_PLUGIN_ID])
        const [plugin] = loadBundledPlugins()
        expect(plugin).toMatchObject({ id: CLAUDE_ADS_BUNDLED_PLUGIN_ID, bundled: true, enabled: true, repository: 'agricidaniel/claude-ads', repositoryId: CLAUDE_ADS_UPSTREAM.repositoryId, commitSha: CLAUDE_ADS_UPSTREAM.commit,
            manifest: { schemaVersion: 2, id: 'claude-ads', version: '2.1.0+hapi.1' } })
        expect(readFileSync(join(VENDOR, 'hapi-evolved.plugin.json'), 'utf8')).toBe(CLAUDE_ADS_PLUGIN_MANIFEST_SOURCE)
        const manifest = plugin!.manifest, upstream = (path: string) => readFileSync(join(VENDOR, 'upstream', path), 'utf8')
        // Lossless split of the 19 831-byte main skill: part1 + blank line + part2 + final newline.
        const skill = (id: string) => manifest.skills.find(item => item.id === id)!.instructions
        expect(`${skill('ads-main-1')}\n\n${skill('ads-main-2')}\n`).toBe(upstream('ads/SKILL.md'))
        expect(Math.max(skill('ads-main-1').length, skill('ads-main-2').length)).toBeLessThanOrEqual(16_384)
        for (const item of manifest.skills.filter(entry => /^ads-(?!main-)/.test(entry.id))) expect(item.instructions).toBe(upstream(`skills/${item.id}/SKILL.md`).trim())
        const upstreamAgents = manifest.agents.filter(agent => !agent.id.startsWith('hapi-ads-'))
        expect(upstreamAgents).toHaveLength(25)
        for (const agent of upstreamAgents) {
            expect(agent.instructions).toBe(upstream(`agents/${agent.id}.md`).trim())
            expect(agent.providerPreference).toBe('either'); expect(agent.model).toBeUndefined()
        }
        expect(manifest.skills).toHaveLength(36)
        const [module] = manifest.developmentModules
        expect(module).toMatchObject({ id: 'ads', doctor: { provider: { id: 'hapi.claude-ads', version: 1 } } })
        expect(module!.tasks).toHaveLength(24)
        expect(module!.fields.every(field => !/token|secret|password|api[_-]?key/i.test(field.id))).toBe(true)
        expect(module!.integrations.every(integration => integration.kind !== 'live_read')).toBe(true)
    })
    test('the importer check reproduces the generated files from the pinned inventory', () => {
        const result = spawnSync(process.execPath, [join(REPO, 'scripts/claude-ads/vendor.ts'), 'check'], { encoding: 'utf8', cwd: REPO })
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
    })
    test('a source that fails its digest is left out (fail closed)', () => {
        const [source] = BUNDLED_PLUGIN_SOURCES
        const original = console.error; console.error = () => {}
        try { expect(loadBundledPlugins([{ ...source!, source: source!.source.replace('Claude Ads', 'Claude Adz') }])).toEqual([]) } finally { console.error = original }
    })
    test('plugin routes list it as bundled and never update, disable, uninstall or replace it', async () => {
        const t = setup()
        const list = await t.request('/plugins')
        expect(list.plugins.map((plugin: any) => [plugin.id, plugin.bundled, plugin.enabled])).toEqual([[CLAUDE_ADS_BUNDLED_PLUGIN_ID, true, true]])
        expect(list.plugins[0].developmentModules).toEqual([expect.objectContaining({ id: CLAUDE_ADS_MODULE_ID, state: 'ready', activeProjects: 0, tasks: 24 })])
        for (const [path, options] of [[`/plugins/${CLAUDE_ADS_BUNDLED_PLUGIN_ID}`, { method: 'PUT', body: { enabled: false } }], [`/plugins/${CLAUDE_ADS_BUNDLED_PLUGIN_ID}`, { method: 'DELETE' }],
            [`/plugins/${CLAUDE_ADS_BUNDLED_PLUGIN_ID}/preview-update`, { body: { ref: 'main' } }], [`/plugins/${CLAUDE_ADS_BUNDLED_PLUGIN_ID}/update`, { body: { previewId: randomUUID(), commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) } }],
            ['/plugins/preview', { body: { repository: 'AgriciDaniel/claude-ads' } }]] as const)
            expect(await t.request(path, options as never)).toMatchObject({ status: 409, code: 'plugin_bundled' })
        expect(t.fetches).toEqual([])
        // A different repository whose manifest reuses the bundled id is refused at preview time.
        expect(await t.request('/plugins/preview', { body: { repository: 'someone/ads-fork' } })).toMatchObject({ status: 409, code: 'plugin_bundled' })
        expect((t.store.db.query('SELECT COUNT(*) AS n FROM evolved_plugins').get() as { n: number }).n).toBe(0)
        expect(t.plugins.find(CLAUDE_ADS_BUNDLED_PLUGIN_ID)?.enabled).toBe(true)
    })
    test('activation is an explicit per-project save; reading never seeds settings', async () => {
        const t = setup()
        const catalog = await t.modules()
        expect(catalog.config.settings.activeModuleId).toBeNull()
        const entry = catalog.catalog.modules.find(module => module.id === CLAUDE_ADS_MODULE_ID)!
        expect(entry).toMatchObject({ origin: 'plugin', state: 'ready', updatePolicy: 'adopt', form: { kind: 'fields', fieldCount: 20 }, source: { kind: 'plugin', pluginId: CLAUDE_ADS_BUNDLED_PLUGIN_ID, commitSha: CLAUDE_ADS_UPSTREAM.commit } })
        expect((t.store.db.query('SELECT COUNT(*) AS n FROM evolved_project_development').get() as { n: number }).n).toBe(0)
        const detail = DevelopmentModuleDetailResponseSchema.parse(await t.dev(`/modules/${encodeURIComponent(CLAUDE_ADS_MODULE_ID)}`).then(({ status: _status, ...rest }) => rest))
        expect(detail.module.form.kind === 'fields' && detail.module.form.fields.map(field => field.kind)).toContain('resource')
        // Secrets-shaped or unknown values are rejected by the generic validator; nothing is stored.
        const { modules: _modules, ...rest } = catalog.config.settings
        const bad = await t.dev('/modules', { method: 'PUT', body: { expectedRevision: 0, settings: { ...rest, activeModuleId: CLAUDE_ADS_MODULE_ID, modules: { [CLAUDE_ADS_MODULE_ID]: { moduleDigest: entry.digest, values: { ...VALUES, apiToken: 'x' } } } } } })
        expect(bad).toMatchObject({ status: 400, code: 'development_module_settings_invalid' })
        expect(await t.dev('/modules', { method: 'PUT', user: 'member', body: { expectedRevision: 0, settings: { ...rest, activeModuleId: CLAUDE_ADS_MODULE_ID, modules: { [CLAUDE_ADS_MODULE_ID]: { moduleDigest: entry.digest, values: VALUES } } } } })).toMatchObject({ status: 403 })
        const saved = await t.dev('/modules', { method: 'PUT', body: { expectedRevision: 0, settings: { ...rest, activeModuleId: CLAUDE_ADS_MODULE_ID, modules: { [CLAUDE_ADS_MODULE_ID]: { moduleDigest: entry.digest, values: VALUES } } } } })
        expect(saved).toMatchObject({ status: 200, config: { active: { moduleId: CLAUDE_ADS_MODULE_ID, state: 'ready' }, settings: { modules: { [CLAUDE_ADS_MODULE_ID]: { adopted: { pluginId: CLAUDE_ADS_BUNDLED_PLUGIN_ID, commitSha: CLAUDE_ADS_UPSTREAM.commit } } } } } })
        expect(JSON.parse((t.store.db.query('SELECT settings FROM evolved_project_development').get() as { settings: string }).settings).schemaVersion).toBe(3)
        expect(t.rpcCalls).toEqual([]); expect(t.started).toEqual([])
    })
    test('tasks start the unchanged upstream specialist with the bound config revision and digest; the doctor uses the Ads provider', async () => {
        const t = setup()
        const catalog = await t.modules(), entry = catalog.catalog.modules.find(module => module.id === CLAUDE_ADS_MODULE_ID)!
        const { modules: _modules, ...rest } = catalog.config.settings
        const saved = await t.dev('/modules', { method: 'PUT', body: { expectedRevision: 0, settings: { ...rest, activeModuleId: CLAUDE_ADS_MODULE_ID, modules: { [CLAUDE_ADS_MODULE_ID]: { moduleDigest: entry.digest, values: VALUES } } } } })
        const development = (taskId: string) => ({ contractVersion: 2, moduleId: CLAUDE_ADS_MODULE_ID, moduleDigest: entry.digest, taskId, revision: saved.config.revision })
        const start = (agent: string, taskId: string) => t.request(`/projects/${t.project.id}/agent-catalog/${encodeURIComponent(`plugin:${CLAUDE_ADS_BUNDLED_PLUGIN_ID}:${agent}`)}/start`,
            { body: { operationId: randomUUID(), machineId: 'machine-0', task: 'Audit the June export.', development: development(taskId) } })
        const response = await start('audit-google', 'audit-google')
        expect(response.status).toBe(201)
        const prompt = t.messages.get(response.sessionId)![0]!.text
        expect(Buffer.byteLength(prompt)).toBeLessThan(MAX_AGENT_PROMPT_BYTES)
        expect(prompt).toContain('You own only the Google Ads slice assigned by the Claude Ads conductor.')
        expect(prompt).toContain('# Google Ads Audit')
        expect(prompt).toContain('Claude Ads in HAPI-eVolved (adapter)')
        const data = JSON.parse(prompt.split('\n').at(-1)!).development
        expect(data).toMatchObject({ module: { id: CLAUDE_ADS_MODULE_ID, digest: entry.digest, source: { commitSha: CLAUDE_ADS_UPSTREAM.commit } }, configRevision: saved.config.revision,
            task: { id: 'audit-google', effectiveEffects: ['reads_repository', 'installs_in_project'] }, settings: { primaryPlatform: 'google', vaultResource: 'vault:ads-readonly' } })
        expect(t.started[0]![4]).toBeUndefined()
        expect(await start('hapi-ads-audit', 'audit-google')).toMatchObject({ status: 400, code: 'development_task_specialist_mismatch' })
        expect(await t.request(`/projects/${t.project.id}/agent-catalog/${encodeURIComponent(`plugin:${CLAUDE_ADS_BUNDLED_PLUGIN_ID}:hapi-ads-setup`)}/start`,
            { body: { operationId: randomUUID(), machineId: 'machine-0', task: 'x', development: { ...development('setup-native-skills'), revision: saved.config.revision - 1 } } })).toMatchObject({ status: 409, code: 'development_revision_conflict' })
        // A read-only project may review guidance but cannot run setup or write tasks.
        t.store.db.prepare("UPDATE evolved_projects SET profile='restricted' WHERE id=?").run(t.project.id)
        expect(await start('hapi-ads-setup', 'setup-native-skills')).toMatchObject({ status: 409, code: 'development_profile_required' })
        expect((await start('hapi-ads-audit', 'guidance-review')).status).toBe(201)
        t.store.db.prepare("UPDATE evolved_projects SET profile='workspace' WHERE id=?").run(t.project.id)
        const doctor = await t.dev('/modules-doctor', { body: { moduleId: CLAUDE_ADS_MODULE_ID, moduleDigest: entry.digest } })
        expect(doctor.status).toBe(200)
        expect(t.rpcCalls).toEqual([expect.objectContaining({ action: 'module_doctor', provider: { id: 'hapi.claude-ads', version: 1 }, checks: ['ads.python', 'ads.assets', 'ads.skills.claude', 'ads.skills.codex', 'ads.artifacts'] })])
        expect(JSON.stringify(t.rpcCalls)).not.toContain('Synthetic Shop')
    })
    test('a HAPI without the bundle keeps the stored configuration and reports the module missing', async () => {
        const t = setup()
        const catalog = await t.modules(), entry = catalog.catalog.modules.find(module => module.id === CLAUDE_ADS_MODULE_ID)!
        const { modules: _modules, ...rest } = catalog.config.settings
        await t.dev('/modules', { method: 'PUT', body: { expectedRevision: 0, settings: { ...rest, activeModuleId: CLAUDE_ADS_MODULE_ID, modules: { [CLAUDE_ADS_MODULE_ID]: { moduleDigest: entry.digest, values: VALUES } } } } })
        const stored = (t.store.db.query('SELECT settings FROM evolved_project_development').get() as { settings: string }).settings
        const older = new DevelopmentModuleRegistry(new PluginService(t.store, fetch, []))
        const settings = JSON.parse(stored).settings
        expect(serializeDevelopmentSettings(settings)).toBe(stored)
        expect(older.status(settings).status).toMatchObject({ moduleId: CLAUDE_ADS_MODULE_ID, state: 'missing', installedDigest: null, adoptedDigest: entry.digest })
        expect(older.list().some(module => module.id === CLAUDE_ADS_MODULE_ID)).toBe(false)
    })
})
