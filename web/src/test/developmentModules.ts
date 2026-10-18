// Test fixtures for the contract-v2 development module API. Every value is built with the shared
// helpers and parsed with the shared schemas, so a fixture can never drift from the wire contract.
import {
    DevelopmentModuleCatalogEntrySchema, DevelopmentModuleContextSchema, DevelopmentModuleDefinitionSchema, DevelopmentModuleDetailSchema,
    HAPI_TOOLCHAIN_CHECKS, ProjectDevelopmentModuleConfigSchema, aggregateTaskEffects, applicableModuleItems, pluginDevelopmentModuleId,
    type DevelopmentModuleCatalogEntry, type DevelopmentModuleContext, type DevelopmentModuleDefinitionInput, type DevelopmentModuleDetail,
    type DevelopmentModuleSettings, type DevelopmentModuleState, type DevelopmentModuleStatus, type DevelopmentModuleView, type ProjectDevelopmentModuleConfig,
} from '@hapi/protocol/developmentModules'
import { builtinDevelopmentModuleView } from '@hapi/protocol/developmentModuleBuiltins'
import { DEVELOPMENT_DATA_NOTICE, type SpecializedDevelopmentMode } from '@hapi/protocol/evolvedDevelopment'

export type FixtureModule = { entry: DevelopmentModuleCatalogEntry; detail: DevelopmentModuleDetail; view: DevelopmentModuleView }
export const digestOf = (seed: string) => `sha256:${Array.from({ length: 64 }, (_, index) => '0123456789abcdef'[(seed.charCodeAt(index % seed.length) + index) % 16]).join('')}`

function counts(view: DevelopmentModuleView) {
    return { topics: view.topics.length, recipes: view.recipes.length, tasks: view.tasks.length, checks: view.doctor?.checks.length ?? 0 }
}
function detailOf(entry: DevelopmentModuleCatalogEntry, view: DevelopmentModuleView): DevelopmentModuleDetail {
    return DevelopmentModuleDetailSchema.parse({ ...entry, form: view.form, brief: view.brief, constraints: view.constraints, topics: view.topics.map(({ body: _body, ...topic }) => topic),
        recipes: view.recipes, tasks: view.tasks, doctor: view.doctor, inspect: view.inspect, integrations: view.integrations })
}

export function builtinModule(mode: SpecializedDevelopmentMode): FixtureModule {
    const view = builtinDevelopmentModuleView(mode)
    const entry = DevelopmentModuleCatalogEntrySchema.parse({
        id: `builtin:${mode}`, origin: 'builtin', localId: mode, title: view.title, summary: view.summary, contentVersion: view.contentVersion, digest: digestOf(`builtin-${mode}`),
        state: 'ready', reasons: [], updatePolicy: 'release', source: { kind: 'builtin' }, form: view.form, counts: counts(view),
        providers: [{ id: `builtin.${mode}`, version: 1, kind: 'doctor', supported: true }, { id: `builtin.${mode}`, version: 1, kind: 'inspect', supported: true }],
    })
    return { entry, detail: detailOf(entry, view), view }
}

export type PluginFixtureOptions = {
    pluginId?: string; pluginName?: string; pluginVersion?: string; commitSha?: string; enabled?: boolean; state?: DevelopmentModuleState; reasons?: string[]; digestSeed?: string
}
export function pluginModule(definition: DevelopmentModuleDefinitionInput, options: PluginFixtureOptions = {}): FixtureModule {
    const parsed = DevelopmentModuleDefinitionSchema.parse(definition)
    const pluginId = options.pluginId ?? '00000000-0000-4000-8000-0000000000a1'
    const view: DevelopmentModuleView = {
        title: parsed.title, summary: parsed.summary, contentVersion: parsed.contentVersion, brief: parsed.brief, constraints: parsed.constraints,
        form: { kind: 'fields', fields: parsed.fields }, topics: parsed.topics, recipes: parsed.recipes,
        tasks: parsed.tasks.map(task => aggregateTaskEffects({ ...task, specialist: task.specialist.startsWith('builtin:') ? task.specialist : `plugin:${pluginId}:${task.specialist}` }, parsed.recipes)),
        doctor: parsed.doctor ? { provider: parsed.doctor.provider, checks: parsed.doctor.checks.map(check => ({ id: check.id, label: HAPI_TOOLCHAIN_CHECKS[check.id]?.label ?? check.id, category: HAPI_TOOLCHAIN_CHECKS[check.id]?.category ?? 'runtime', required: check.required, when: check.when })) } : null,
        inspect: parsed.inspect, integrations: parsed.integrations,
    }
    const enabled = options.enabled ?? true
    const entry = DevelopmentModuleCatalogEntrySchema.parse({
        id: pluginDevelopmentModuleId(pluginId, parsed.id), origin: 'plugin', localId: parsed.id, title: parsed.title, summary: parsed.summary, contentVersion: parsed.contentVersion,
        digest: digestOf(options.digestSeed ?? `${pluginId}-${parsed.id}-${parsed.contentVersion}`), state: options.state ?? (enabled ? 'ready' : 'disabled'), reasons: options.reasons ?? (enabled ? [] : ['Das Plugin ist deaktiviert.']),
        updatePolicy: 'adopt', source: { kind: 'plugin', pluginId, pluginName: options.pluginName ?? 'Beispiel-Plugin', pluginVersion: options.pluginVersion ?? '1.0.0', repository: 'acme/hapi-modules', repositoryId: '4242',
            commitSha: options.commitSha ?? 'c'.repeat(40), manifestSha256: 'd'.repeat(64), enabled },
        form: { kind: 'fields', fieldCount: parsed.fields.length }, counts: counts(view),
        providers: [...(parsed.doctor ? [{ ...parsed.doctor.provider, kind: 'doctor', supported: true }] : []), ...(parsed.inspect ? [{ ...parsed.inspect.provider, kind: 'inspect', supported: true }] : [])],
    })
    return { entry, detail: detailOf(entry, view), view }
}

export function emptySettings(extra: Partial<DevelopmentModuleSettings> = {}): DevelopmentModuleSettings {
    return { activeModuleId: null, repositoryId: null, odoo: null, ios: null, android: null, modules: {}, ...extra }
}
/** Project status of the active module as the hub derives it from the catalog. */
export function statusFor(settings: DevelopmentModuleSettings, catalog: readonly DevelopmentModuleCatalogEntry[]): DevelopmentModuleStatus {
    const id = settings.activeModuleId
    if (!id) return { moduleId: null, state: 'none', reasons: [], installedDigest: null, adoptedDigest: null }
    const entry = catalog.find(item => item.id === id), stored = settings.modules[id]
    if (!entry) return { moduleId: id, state: 'missing', reasons: ['Das Modul ist nicht mehr installiert. Die Einstellungen bleiben erhalten.'], installedDigest: null, adoptedDigest: stored?.moduleDigest ?? null }
    if (entry.origin === 'builtin') return { moduleId: id, state: 'ready', reasons: [], installedDigest: entry.digest, adoptedDigest: entry.digest }
    if (entry.state !== 'ready') return { moduleId: id, state: entry.state, reasons: entry.reasons, installedDigest: entry.digest, adoptedDigest: stored?.moduleDigest ?? null }
    if (stored?.moduleDigest !== entry.digest) return { moduleId: id, state: 'adoption_required', reasons: ['Eine neue Modulfassung ist installiert.'], installedDigest: entry.digest, adoptedDigest: stored?.moduleDigest ?? null }
    return { moduleId: id, state: 'ready', reasons: [], installedDigest: entry.digest, adoptedDigest: entry.digest }
}
export function moduleConfig(revision: number, settings: DevelopmentModuleSettings, catalog: readonly DevelopmentModuleCatalogEntry[], projectId = 'p1', extra: Partial<ProjectDevelopmentModuleConfig> = {}): ProjectDevelopmentModuleConfig {
    return ProjectDevelopmentModuleConfigSchema.parse({
        projectId, revision, settings, savedModuleDigest: null, updatedAt: revision ? 1_760_000_000_000 : null, updatedBy: revision ? { id: 'user-2', displayName: 'Alex' } : null,
        androidSdkLicenseAcknowledgement: null, active: statusFor(settings, catalog), ...extra,
    })
}
/** Adopted entry for a plugin module (server-written provenance). */
export function adoptedEntry(module: FixtureModule, values: Record<string, unknown>, digest = module.entry.digest) {
    const source = module.entry.source
    if (source.kind !== 'plugin') throw new Error('plugin module expected')
    return { moduleDigest: digest, settingsVersion: 1 as const, values: values as never, adopted: { pluginId: source.pluginId, pluginVersion: source.pluginVersion, repository: source.repository, commitSha: source.commitSha, manifestSha256: source.manifestSha256, at: 1_760_000_000_000 } }
}
export function moduleContext(config: ProjectDevelopmentModuleConfig, modules: readonly FixtureModule[], repositoryState: DevelopmentModuleContext['repository']['state'] = 'granted'): DevelopmentModuleContext {
    const module = modules.find(item => item.entry.id === config.active.moduleId)
    const ready = config.active.state === 'ready' && module
    const settings = config.settings
    const values = !module ? null : module.entry.origin === 'builtin' ? settings[module.entry.localId as SpecializedDevelopmentMode] as Record<string, unknown> | null : settings.modules[module.entry.id]?.values ?? null
    const items = ready ? applicableModuleItems(module.view, values) : null
    return DevelopmentModuleContextSchema.parse({
        contractVersion: 2, projectId: config.projectId, revision: config.revision, observedAt: 1_760_000_100_000, dataNotice: DEVELOPMENT_DATA_NOTICE, active: config.active,
        module: ready && items ? { id: module.entry.id, origin: module.entry.origin, title: module.view.title, digest: module.entry.digest, contentVersion: module.view.contentVersion, source: module.entry.source,
            brief: module.view.brief, constraints: module.view.constraints, topics: items.topics.map(({ body: _body, ...topic }) => topic), recipes: items.recipes, tasks: items.tasks,
            doctor: module.view.doctor ? { provider: module.view.doctor.provider, checks: items.checks } : null, inspect: module.view.inspect } : null,
        settings, repository: { state: repositoryState, repositoryId: settings.repositoryId, fullName: settings.repositoryId ? 'acme/odoo-addons' : null, permission: 'write', checkoutPath: null, relativePath: null },
        integrations: [], lastDoctor: null,
    })
}

/** A plugin module definition exercising every field kind, false/0 defaults and a task with a plugin-local specialist. */
export function flutterDefinition(overrides: Partial<DevelopmentModuleDefinitionInput> = {}): DevelopmentModuleDefinitionInput {
    return {
        apiVersion: 1, id: 'flutter', title: 'Flutter', summary: 'Flutter- und Dart-Apps.', contentVersion: '2026.10.17-1',
        brief: ['Flutter-Projekte nutzen pubspec.yaml.'], constraints: ['Keine iOS-Builds auf Linux-Runnern.'],
        fields: [
            { id: 'appDirectory', kind: 'repo_path', label: 'App-Verzeichnis', required: true, default: '.' },
            { id: 'channel', kind: 'select', label: 'Kanal', required: true, default: 'stable', options: [{ value: 'stable', label: 'Stabil' }, { value: 'beta', label: 'Beta' }] },
            { id: 'minSdk', kind: 'number', label: 'Android minSdk', min: 0, max: 99, default: 0, help: 'Null ist erlaubt.' },
            { id: 'web', kind: 'boolean', label: 'Web-Ziel', default: false },
            { id: 'flavors', kind: 'text_list', label: 'Flavors', format: 'identifier', maxItems: 8, maxLength: 64, default: [] },
            { id: 'platforms', kind: 'multi_select', label: 'Plattformen', maxItems: 3, options: [{ value: 'android', label: 'Android' }, { value: 'web', label: 'Web' }], default: [] },
            { id: 'notes', kind: 'text', label: 'Hinweis für Übergaben', maxLength: 300, default: null },
            { id: 'docs', kind: 'https_url', label: 'Dokumentation' },
            { id: 'branch', kind: 'branch', label: 'Arbeits-Branch' },
            { id: 'assets', kind: 'repository', label: 'Asset-Repository' },
            { id: 'signing', kind: 'resource', label: 'Signatur-Ressource' },
        ],
        topics: [{ id: 'pub-get', title: 'Abhängigkeiten mit pub get', summary: 'pub get lädt Pakete.', body: 'Ausführlicher Text zu pub get.', tags: ['deps'], sources: [{ title: 'pub get', url: 'https://dart.dev/tools/pub/cmd/pub-get', verifiedAt: '2026-10-17' }] }],
        recipes: [{ id: 'test', title: 'Tests ausführen', summary: 'flutter test', kind: 'test', effects: ['runs_project_code'], prerequisites: ['git'],
            steps: [{ title: 'Test', detail: 'Tests im App-Verzeichnis.', argv: ['flutter', 'test', '{checkout}/{appDirectory}'] }] }],
        tasks: [{ id: 'tests', title: 'Flutter-Tests ausführen', description: 'Führt die Tests aus.', kind: 'test', specialist: 'builtin:tests', recipeIds: ['test'], topicIds: ['pub-get'], defaultTask: 'Führe die Flutter-Tests aus.', requiresRepository: true }],
        doctor: { provider: { id: 'hapi.toolchain', version: 1 }, checks: [{ id: 'git', required: true }, { id: 'java', required: false }] },
        inspect: { provider: { id: 'hapi.repository-inventory', version: 1 }, directoryField: 'appDirectory' },
        ...overrides,
    }
}
