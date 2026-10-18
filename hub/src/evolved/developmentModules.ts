import { createHash } from 'node:crypto'
import {
    BUILTIN_DEVELOPMENT_MODULE_IDS, DEVELOPMENT_MODULE_API_VERSION, HAPI_TOOLCHAIN_CHECKS, aggregateTaskEffects, developmentModuleCanonicalJson, developmentModuleSupportIssues,
    developmentProvider, parseDevelopmentModuleId, pluginDevelopmentModuleId,
    type DevelopmentModuleCatalogEntry, type DevelopmentModuleDefinition, type DevelopmentModuleDetail, type DevelopmentModuleId, type DevelopmentModuleSettings,
    type DevelopmentModulePluginSummary, type DevelopmentModuleSource, type DevelopmentModuleState, type DevelopmentModuleStatus, type DevelopmentModuleView,
} from '@hapi/protocol/developmentModules'
import { builtinDevelopmentModuleView } from '@hapi/protocol/developmentModuleBuiltins'
import type { SpecializedDevelopmentMode } from '@hapi/protocol/evolvedDevelopment'
import { z } from 'zod'
import type { InstalledPlugin, PluginService } from './plugins'
import type { PluginManifest } from './pluginManifest'
import type { EvolvedStore } from './store'

/**
 * Development module registry: bundled modules and declarative modules of
 * installed plugins, resolved through the same view, digest and status rules.
 * Plugin modules are data only; providers are host implementations looked up
 * by id/version. Nothing here executes module content or grants anything.
 */

export type RegisteredDevelopmentModule = {
    id: DevelopmentModuleId
    origin: 'builtin' | 'plugin'
    localId: string
    /** Builtin mode for builtin modules (typed settings section, v1 runner provider). */
    mode: SpecializedDevelopmentMode | null
    view: DevelopmentModuleView
    digest: string
    /** Installation-level availability (project adoption is evaluated separately). */
    state: Extract<DevelopmentModuleState, 'ready' | 'disabled' | 'unsupported'>
    reasons: string[]
    source: DevelopmentModuleSource
    /**
     * Plugin lifecycle generation (installed plugin `revision`, incremented by every update, enable and disable; 0 for
     * builtins). In-flight snapshots compare it after each await, so a disable/re-enable (ABA) invalidates them even when
     * the digest is unchanged.
     */
    generation: number
    plugin: Pick<InstalledPlugin, 'id' | 'repository' | 'repositoryId' | 'commitSha' | 'manifestSha256' | 'enabled'> & { name: string; version: string } | null
}

/** Builtins hash their resolved view; plugin modules hash their parsed definition plus executable dependencies, so preview and installed digests agree. */
export function developmentModuleDigest(localId: string, content: DevelopmentModuleView | DevelopmentModuleDefinition, dependencies?: unknown): string {
    return `sha256:${createHash('sha256').update(developmentModuleCanonicalJson({ apiVersion: DEVELOPMENT_MODULE_API_VERSION, id: localId, content, ...(dependencies === undefined ? {} : { dependencies }) })).digest('hex')}`
}
/**
 * Same-plugin agents referenced by the module's tasks and the skills those agents use: they shape the assignment of a
 * module task, so a change to them changes the module digest (explicit adoption). Display-only text (descriptions),
 * themes and unrelated agents/skills are excluded to avoid needless re-adoption.
 */
export function pluginModuleDependencies(manifest: Pick<PluginManifest, 'agents' | 'skills'>, definition: Pick<DevelopmentModuleDefinition, 'tasks'>) {
    const referenced = new Set(definition.tasks.map(task => task.specialist).filter(id => !id.startsWith('builtin:')))
    const agents = manifest.agents.filter(agent => referenced.has(agent.id)).sort((a, b) => a.id.localeCompare(b.id))
    const skillIds = new Set(agents.flatMap(agent => agent.skills))
    return {
        agents: agents.map(agent => ({ id: agent.id, name: agent.name, instructions: agent.instructions, providerPreference: agent.providerPreference, model: agent.model ?? null, skills: agent.skills })),
        skills: manifest.skills.filter(skill => skillIds.has(skill.id)).sort((a, b) => a.id.localeCompare(b.id)).map(skill => ({ id: skill.id, name: skill.name, instructions: skill.instructions })),
    }
}

const BUILTINS: readonly RegisteredDevelopmentModule[] = BUILTIN_DEVELOPMENT_MODULE_IDS.map(id => {
    const mode = id.slice('builtin:'.length) as SpecializedDevelopmentMode, view = builtinDevelopmentModuleView(mode)
    return { id, origin: 'builtin' as const, localId: mode, mode, view, digest: developmentModuleDigest(mode, view), state: 'ready' as const, reasons: [], source: { kind: 'builtin' as const }, generation: 0, plugin: null }
})

type PluginInput = { id: string | null; enabled: boolean; manifest: PluginManifest; repository: string; repositoryId: string; commitSha: string; manifestSha256: string; revision?: number }
/** Host-resolved view of one plugin module definition: namespaced specialists, aggregated effects, provider labels. */
export function resolvePluginModuleView(pluginId: string | null, definition: DevelopmentModuleDefinition): DevelopmentModuleView {
    const builtinSpecialist = (id: string) => id.startsWith('builtin:')
    const doctorProvider = definition.doctor ? developmentProvider(definition.doctor.provider, 'doctor') : null
    return {
        title: definition.title, summary: definition.summary, contentVersion: definition.contentVersion, brief: definition.brief, constraints: definition.constraints,
        form: { kind: 'fields', fields: definition.fields },
        topics: definition.topics, recipes: definition.recipes,
        tasks: definition.tasks.map(task => aggregateTaskEffects({ ...task, specialist: builtinSpecialist(task.specialist) ? task.specialist : `plugin:${pluginId ?? '<pending>'}:${task.specialist}` }, definition.recipes)),
        doctor: definition.doctor ? { provider: definition.doctor.provider, checks: definition.doctor.checks.map(check => {
            const label = doctorProvider?.checks?.[check.id] ?? (definition.doctor!.provider.id === 'hapi.toolchain' ? HAPI_TOOLCHAIN_CHECKS[check.id] : undefined)
            return { id: check.id, label: label?.label ?? check.id, category: label?.category ?? 'runtime', required: check.required, when: check.when }
        }) } : null,
        inspect: definition.inspect, integrations: definition.integrations,
    }
}
export function resolvePluginModules(plugin: PluginInput): Array<RegisteredDevelopmentModule & { id: DevelopmentModuleId }> {
    return plugin.manifest.developmentModules.map(definition => {
        const view = resolvePluginModuleView(plugin.id, definition), reasons = developmentModuleSupportIssues(definition)
        const state = !plugin.enabled ? 'disabled' as const : reasons.length ? 'unsupported' as const : 'ready' as const
        return {
            id: pluginDevelopmentModuleId(plugin.id ?? '00000000-0000-0000-0000-000000000000', definition.id) as DevelopmentModuleId, origin: 'plugin' as const, localId: definition.id, mode: null,
            view, digest: developmentModuleDigest(definition.id, definition, pluginModuleDependencies(plugin.manifest, definition)), state, generation: plugin.revision ?? 0,
            reasons: !plugin.enabled ? ['Das Plugin ist deaktiviert.', ...reasons] : reasons,
            source: { kind: 'plugin' as const, pluginId: plugin.id ?? '00000000-0000-0000-0000-000000000000', pluginName: plugin.manifest.name, pluginVersion: plugin.manifest.version,
                repository: plugin.repository, repositoryId: plugin.repositoryId, commitSha: plugin.commitSha, manifestSha256: plugin.manifestSha256, enabled: plugin.enabled },
            plugin: { id: plugin.id ?? '', repository: plugin.repository, repositoryId: plugin.repositoryId, commitSha: plugin.commitSha, manifestSha256: plugin.manifestSha256, enabled: plugin.enabled, name: plugin.manifest.name, version: plugin.manifest.version },
        }
    })
}
/** Per module id: projects with it active and their adopted digests (installation-wide counts only, no project details). */
export type DevelopmentModuleUsage = Map<string, { active: number; adoptedDigests: string[] }>
export function developmentModuleUsage(store: EvolvedStore): DevelopmentModuleUsage {
    const usage: DevelopmentModuleUsage = new Map()
    for (const row of store.db.query('SELECT settings FROM evolved_project_development').all() as Array<{ settings: string }>) {
        let value: unknown; try { value = JSON.parse(row.settings) } catch { continue }
        // Envelopes v2 and v3 (current) carry plugin module entries; v1 JSON never does.
        const parsed = value && typeof value === 'object' && 'schemaVersion' in value && (value.schemaVersion === 2 || value.schemaVersion === 3) ? StoredUsageSchema.safeParse(value) : null
        const active = parsed?.success ? parsed.data.settings.activeModuleId : null
        if (!active) continue
        const entry = usage.get(active) ?? { active: 0, adoptedDigests: [] }
        entry.active++; entry.adoptedDigests.push(parsed!.data!.settings.modules[active]?.moduleDigest ?? '')
        usage.set(active, entry)
    }
    return usage
}
const StoredUsageSchema = z.object({ schemaVersion: z.union([z.literal(2), z.literal(3)]), settings: z.object({ activeModuleId: z.string().max(110).nullable(), modules: z.record(z.string(), z.object({ moduleDigest: z.string().max(80) }).passthrough()) }).passthrough() }).passthrough()
/**
 * Bounded per-plugin summary for plugin list and preview responses. `activeProjects` counts projects with the module
 * active; `affectedProjects` those whose adopted digest differs from this digest (they need adoption after the update).
 */
export function pluginModuleSummaries(plugin: PluginInput, usage?: DevelopmentModuleUsage, installedPluginId: string | null = plugin.id): DevelopmentModulePluginSummary[] {
    return resolvePluginModules(plugin).map(module => {
        const used = installedPluginId ? usage?.get(pluginDevelopmentModuleId(installedPluginId, module.localId)) : undefined
        return { id: plugin.id ? module.id : null, localId: module.localId, title: module.view.title, contentVersion: module.view.contentVersion,
            digest: module.digest, state: module.state, reasons: module.reasons.slice(0, 6), fieldCount: module.view.form.kind === 'fields' ? module.view.form.fields.length : 0,
            tasks: module.view.tasks.length, topics: module.view.topics.length,
            activeProjects: used?.active ?? 0, affectedProjects: used?.adoptedDigests.filter(digest => digest !== module.digest).length ?? 0 }
    })
}

export class DevelopmentModuleRegistry {
    private readonly cache = new Map<string, { key: string; modules: RegisteredDevelopmentModule[] }>()
    constructor(private readonly plugins: Pick<PluginService, 'versions' | 'find'> | null = null) {}

    private pluginModules(pluginId: string): RegisteredDevelopmentModule[] | null {
        const plugin = this.plugins?.find(pluginId)
        if (!plugin) { this.cache.delete(pluginId); return null }
        const key = `${plugin.revision}:${plugin.manifestSha256}:${plugin.enabled}:${plugin.invalid ? 1 : 0}`, cached = this.cache.get(pluginId)
        if (cached?.key === key) return cached.modules
        const modules = plugin.invalid ? [] : resolvePluginModules(plugin)
        this.cache.set(pluginId, { key, modules })
        return modules
    }
    list(): RegisteredDevelopmentModule[] {
        const modules = [...BUILTINS], seen = new Set<string>()
        for (const version of this.plugins?.versions() ?? []) {
            seen.add(version.id)
            modules.push(...this.pluginModules(version.id) ?? [])
        }
        for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id)
        return modules
    }
    /** Live lookup (one row read; parsed manifests are cached by revision/hash/enabled). */
    get(id: string): RegisteredDevelopmentModule | null {
        const parsed = parseDevelopmentModuleId(id)
        if (!parsed) return null
        if (parsed.origin === 'builtin') return BUILTINS.find(module => module.id === id) ?? null
        return this.pluginModules(parsed.pluginId)?.find(module => module.localId === parsed.localId) ?? null
    }
    builtin(mode: SpecializedDevelopmentMode): RegisteredDevelopmentModule { return BUILTINS.find(module => module.mode === mode)! }
    /** Why a module id does not resolve: its plugin's stored definition is quarantined (`invalid`) or it is not installed (`missing`). */
    unavailableState(id: string): 'invalid' | 'missing' {
        const parsed = parseDevelopmentModuleId(id)
        return parsed?.origin === 'plugin' && this.plugins?.find(parsed.pluginId)?.invalid ? 'invalid' : 'missing'
    }
    /** Snapshot identity for in-flight checks: same module id, digest, availability and lifecycle generation. */
    same(a: RegisteredDevelopmentModule | null, b: RegisteredDevelopmentModule | null): boolean {
        return !!a && !!b && a.id === b.id && a.digest === b.digest && a.state === b.state && a.generation === b.generation
    }

    /** Project-level status of the active module. Plugin modules must match the adopted digest; nothing falls back to another module. */
    status(settings: Pick<DevelopmentModuleSettings, 'activeModuleId' | 'modules'>): { status: DevelopmentModuleStatus; module: RegisteredDevelopmentModule | null } {
        const id = settings.activeModuleId
        if (!id) return { status: { moduleId: null, state: 'none', reasons: [], installedDigest: null, adoptedDigest: null }, module: null }
        const module = this.get(id), entry = settings.modules[id]
        if (!module) {
            const state = this.unavailableState(id)
            return { status: { moduleId: id as DevelopmentModuleId, state, installedDigest: null, adoptedDigest: entry?.moduleDigest ?? null,
                reasons: [state === 'invalid' ? 'Die gespeicherte Plugin-Definition ist ungültig und unter Quarantäne. Die Einstellungen bleiben erhalten; das Plugin muss entfernt oder neu geprüft werden.' : 'Das Modul ist nicht mehr installiert. Die Einstellungen bleiben erhalten.'] }, module: null }
        }
        if (module.origin === 'builtin') return { status: { moduleId: module.id, state: 'ready', reasons: [], installedDigest: module.digest, adoptedDigest: module.digest }, module }
        const base = { moduleId: module.id, installedDigest: module.digest, adoptedDigest: entry?.moduleDigest ?? null }
        if (module.state !== 'ready') return { status: { ...base, state: module.state, reasons: module.reasons.slice(0, 6) }, module }
        if (!entry || entry.moduleDigest !== module.digest) return { status: { ...base, state: 'adoption_required', reasons: ['Eine neue Modulfassung ist installiert. Ein Projektadmin muss sie in den Entwicklungseinstellungen übernehmen.'] }, module }
        return { status: { ...base, state: 'ready', reasons: [] }, module }
    }
}

function providers(view: DevelopmentModuleView): DevelopmentModuleCatalogEntry['providers'] {
    const result: DevelopmentModuleCatalogEntry['providers'] = []
    if (view.doctor) result.push({ ...view.doctor.provider, kind: 'doctor', supported: !!developmentProvider(view.doctor.provider, 'doctor') })
    if (view.inspect) result.push({ ...view.inspect.provider, kind: 'inspect', supported: !!developmentProvider(view.inspect.provider, 'inspect') })
    for (const integration of view.integrations) if (integration.provider && !result.some(entry => entry.id === integration.provider)) result.push({ id: integration.provider, version: 1, kind: 'integration', supported: true })
    return result
}
export function developmentModuleCatalogEntry(module: RegisteredDevelopmentModule): DevelopmentModuleCatalogEntry {
    const { view } = module
    return {
        id: module.id, origin: module.origin, localId: module.localId, title: view.title, summary: view.summary, contentVersion: view.contentVersion, digest: module.digest,
        state: module.state, reasons: module.reasons.slice(0, 6), updatePolicy: module.origin === 'builtin' ? 'release' : 'adopt', source: module.source,
        form: view.form.kind === 'builtin' ? view.form : { kind: 'fields', fieldCount: view.form.fields.length },
        counts: { topics: view.topics.length, recipes: view.recipes.length, tasks: view.tasks.length, checks: view.doctor?.checks.length ?? 0 },
        providers: providers(view),
    }
}
export function developmentModuleDetail(module: RegisteredDevelopmentModule): DevelopmentModuleDetail {
    const { view } = module
    return { ...developmentModuleCatalogEntry(module), form: view.form, brief: view.brief, constraints: view.constraints,
        topics: view.topics.map(({ body: _body, ...topic }) => topic), recipes: view.recipes, tasks: view.tasks, doctor: view.doctor, inspect: view.inspect, integrations: view.integrations }
}
