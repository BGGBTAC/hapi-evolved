import { z } from 'zod'
import {
    AndroidSettingsSchema, DEVELOPMENT_EFFECTS, DEVELOPMENT_TASK_SPECIALISTS, DevelopmentDoctorCheckSchema, DevelopmentEffectSchema, DevelopmentIdSchema,
    DevelopmentRecipeSchema, DevelopmentRepositoryContextSchema, DevelopmentRevisionSchema, DevelopmentRpcRepositorySchema, DevelopmentRunnerStatusSchema,
    DevelopmentIntegrationStatusSchema, DoctorCheckCategorySchema, GitShaSchema, HttpsOutputUrlSchema, IosSettingsSchema, OdooSettingsSchema,
    RepoSubdirectorySchema, RepositoryIdSchema, GitBranchSchema, ResourceReferenceSchema, BuildFileInventorySchema, OdooModuleInventorySchema,
    type DevelopmentEffect, type DevelopmentMode, type DevelopmentSettings, type SpecializedDevelopmentMode,
} from './evolvedDevelopment'

/**
 * Development-scenario modules (contract v2): one registry for the bundled
 * Odoo/iOS/Android modules and declarative modules contributed by installed
 * HAPI GitHub plugins (`developmentModules` in `hapi-evolved.plugin.json`).
 *
 * A module is bounded *data*: settings form, handbook, recipes, task starters
 * and references to host-registered providers. It never carries code, regular
 * expressions, templates, executables, grants or permission changes, and none
 * of its text is ever used as a system/developer instruction.
 *
 * The v1 contract in `./evolvedDevelopment` stays unchanged for old clients; the
 * hub keeps one canonical configuration and projects it to v1 when possible.
 */

export const DEVELOPMENT_MODULE_CONTRACT_VERSION = 2 as const
export const DEVELOPMENT_MODULE_API_VERSION = 1 as const
export const DEVELOPMENT_MODULE_LIMITS = Object.freeze({
    modulesPerPlugin: 4, fields: 24, optionsPerField: 24, optionsPerModule: 96, topics: 64, recipes: 32, tasks: 24, pluginDoctorChecks: 32,
    integrations: 12, projectModuleEntries: 16, catalogEntries: 256, taskPayloadBytes: 24 * 1024, settingsIssues: 32,
    /** Serialized field values of one module (defaults included); keeps assignments and settings writes bounded. */
    valuesBytes: 8 * 1024,
    /** Serialized PUT-shaped project settings (all modules incl. inactive entries); stays below the 32 KiB request limit so a GET→PUT round trip always fits. */
    settingsBytes: 28 * 1024,
    /** Room a module task with a plugin specialist must leave in the 64 KiB assignment for the human task text and envelope. */
    assignmentReserveBytes: 8 * 1024,
})

// ---------------------------------------------------------------- identifiers

export const DevelopmentModuleLocalIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const BUILTIN_DEVELOPMENT_MODULE_IDS = ['builtin:odoo', 'builtin:ios', 'builtin:android'] as const
export const BuiltinDevelopmentModuleIdSchema = z.enum(BUILTIN_DEVELOPMENT_MODULE_IDS)
export type BuiltinDevelopmentModuleId = z.infer<typeof BuiltinDevelopmentModuleIdSchema>
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** `plugin:<installed plugin uuid>:<local module id>`; a reinstall gets a new uuid and therefore a new module identity. */
export const PluginDevelopmentModuleIdSchema = z.string().max(110).regex(new RegExp(`^plugin:${uuid}:[a-z][a-z0-9-]{0,63}$`))
export const DevelopmentModuleIdSchema = z.union([BuiltinDevelopmentModuleIdSchema, PluginDevelopmentModuleIdSchema])
export type DevelopmentModuleId = z.infer<typeof DevelopmentModuleIdSchema>
/** SHA-256 over the canonical resolved module definition (see `developmentModuleCanonicalJson`). */
export const DevelopmentModuleDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export function pluginDevelopmentModuleId(pluginId: string, localId: string): string { return `plugin:${pluginId}:${localId}` }
export function parseDevelopmentModuleId(id: string): { origin: 'builtin'; mode: SpecializedDevelopmentMode } | { origin: 'plugin'; pluginId: string; localId: string } | null {
    if (BuiltinDevelopmentModuleIdSchema.safeParse(id).success) return { origin: 'builtin', mode: id.slice('builtin:'.length) as SpecializedDevelopmentMode }
    if (!PluginDevelopmentModuleIdSchema.safeParse(id).success) return null
    const [, pluginId, localId] = id.split(':')
    return { origin: 'plugin', pluginId: pluginId!, localId: localId! }
}
export function builtinModuleIdForMode(mode: DevelopmentMode): BuiltinDevelopmentModuleId | null { return mode === 'none' ? null : `builtin:${mode}` }
export function modeForBuiltinModuleId(id: string | null): DevelopmentMode | null {
    if (id === null) return 'none'
    return BuiltinDevelopmentModuleIdSchema.safeParse(id).success ? id.slice('builtin:'.length) as SpecializedDevelopmentMode : null
}

// ---------------------------------------------------------------- bounded text

const hidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]|\p{Default_Ignorable_Code_Point}/u
const lineBreak = /[\n\r\t]/
const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength
/** UTF-8 size of a JSON value as sent on the wire. */
export function developmentModuleJsonBytes(value: unknown): number { return utf8Length(JSON.stringify(value)) }
/** Multi-line reviewed text (bodies, details). */
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !hidden.test(value), 'Unsupported control characters')
/** Single-line label. */
const line = (max: number) => text(max).refine(value => !lineBreak.test(value), 'Use a single line')
const tag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
const verifiedDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const sourceUrl = z.string().max(500).refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !hidden.test(value) } catch { return false }
}, 'Sources are https URLs without credentials')
export const DevelopmentModuleSourceRefSchema = z.object({
    title: line(200), url: sourceUrl, verifiedAt: verifiedDate, version: line(40).optional(),
}).strict()
export const DevelopmentModuleContentVersionSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/)

// ---------------------------------------------------------------- settings fields

export const DEVELOPMENT_MODULE_FIELD_KINDS = ['text', 'number', 'boolean', 'select', 'multi_select', 'text_list', 'repo_path', 'branch', 'repository', 'resource', 'https_url'] as const
export type DevelopmentModuleFieldKind = typeof DEVELOPMENT_MODULE_FIELD_KINDS[number]
export const DEVELOPMENT_MODULE_TEXT_FORMATS = ['plain', 'identifier', 'dotted_identifier', 'version'] as const
export const DevelopmentModuleTextFormatSchema = z.enum(DEVELOPMENT_MODULE_TEXT_FORMATS)
const TEXT_FORMATS: Record<z.infer<typeof DevelopmentModuleTextFormatSchema>, RegExp> = {
    plain: /^[^\n\r\t]*$/,
    identifier: /^[A-Za-z_][A-Za-z0-9_-]*$/,
    dotted_identifier: /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/,
    version: /^[0-9A-Za-z][0-9A-Za-z.+-]*$/,
}
export const DevelopmentModuleFieldIdSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/)
export const DevelopmentModuleOptionValueSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
const NUMBER_LIMIT = 1_000_000_000
const integer = z.number().int().min(-NUMBER_LIMIT).max(NUMBER_LIMIT)
const option = z.object({ value: DevelopmentModuleOptionValueSchema, label: line(80) }).strict()
const options = z.array(option).min(1).max(DEVELOPMENT_MODULE_LIMITS.optionsPerField)
const fieldBase = { id: DevelopmentModuleFieldIdSchema, label: line(80), help: text(300).optional(), required: z.boolean().default(false) }
export const DevelopmentModuleFieldSchema = z.discriminatedUnion('kind', [
    z.object({ ...fieldBase, kind: z.literal('text'), format: DevelopmentModuleTextFormatSchema.default('plain'), maxLength: z.number().int().min(1).max(500).default(200), default: z.string().max(500).nullable().default(null) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('number'), min: integer, max: integer, default: integer.nullable().default(null) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('boolean'), default: z.boolean().default(false) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('select'), options, default: DevelopmentModuleOptionValueSchema.nullable().default(null) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('multi_select'), options, maxItems: z.number().int().min(1).max(DEVELOPMENT_MODULE_LIMITS.optionsPerField), default: z.array(DevelopmentModuleOptionValueSchema).max(DEVELOPMENT_MODULE_LIMITS.optionsPerField).default([]) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('text_list'), format: DevelopmentModuleTextFormatSchema.default('plain'), maxItems: z.number().int().min(1).max(32), maxLength: z.number().int().min(1).max(200).default(100), default: z.array(z.string().max(200)).max(32).default([]) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('repo_path'), default: RepoSubdirectorySchema.nullable().default(null) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('branch'), default: z.null().default(null) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('repository'), default: z.null().default(null) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('resource'), default: z.null().default(null) }).strict(),
    z.object({ ...fieldBase, kind: z.literal('https_url'), default: z.null().default(null) }).strict(),
])
export type DevelopmentModuleField = z.infer<typeof DevelopmentModuleFieldSchema>
export type DevelopmentModuleFieldInput = z.input<typeof DevelopmentModuleFieldSchema>

export const DevelopmentModuleFieldValueSchema = z.union([z.string().max(500), integer, z.boolean(), z.array(z.string().max(200)).max(32), z.null()])
export type DevelopmentModuleFieldValue = z.infer<typeof DevelopmentModuleFieldValueSchema>
export const DevelopmentModuleValuesSchema = z.record(DevelopmentModuleFieldIdSchema, DevelopmentModuleFieldValueSchema)
    .refine(value => Object.keys(value).length <= DEVELOPMENT_MODULE_LIMITS.fields, 'Too many values')
export type DevelopmentModuleValues = z.infer<typeof DevelopmentModuleValuesSchema>

export type DevelopmentModuleValueIssue = { field: string; message: string }
function fieldValueIssue(field: DevelopmentModuleField, value: unknown): string | null {
    const blank = value === null || value === undefined
    if (field.kind === 'boolean') return typeof value === 'boolean' ? null : 'Expected true or false'
    if (field.kind === 'multi_select' || field.kind === 'text_list') {
        if (!Array.isArray(value)) return 'Expected a list'
        if (field.required && !value.length) return 'Required'
        if (value.length > field.maxItems) return `At most ${field.maxItems} entries`
        if (value.some(item => typeof item !== 'string')) return 'Expected text entries'
        if (new Set(value).size !== value.length) return 'Duplicate entries'
        if (field.kind === 'multi_select') return value.every(item => field.options.some(entry => entry.value === item)) ? null : 'Unknown option'
        for (const item of value as string[]) {
            if (!item.trim() || item !== item.trim()) return 'Entries must not be blank or padded'
            if (item.length > field.maxLength) return `Entries have at most ${field.maxLength} characters`
            if (hidden.test(item) || !TEXT_FORMATS[field.format].test(item)) return 'Invalid entry format'
        }
        return null
    }
    if (blank) return field.required ? 'Required' : null
    switch (field.kind) {
        case 'text':
            if (typeof value !== 'string') return 'Expected text'
            if (!value.trim()) return field.required ? 'Required' : 'Use null for an empty value'
            if (value !== value.trim()) return 'Remove leading or trailing spaces'
            if (value.length > field.maxLength) return `At most ${field.maxLength} characters`
            return hidden.test(value) || !TEXT_FORMATS[field.format].test(value) ? 'Invalid format' : null
        case 'number':
            if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'Expected a whole number'
            return value < field.min || value > field.max ? `Between ${field.min} and ${field.max}` : null
        case 'select': return typeof value === 'string' && field.options.some(entry => entry.value === value) ? null : 'Unknown option'
        case 'repo_path': return RepoSubdirectorySchema.safeParse(value).success ? null : 'Use a repository-relative path without traversal'
        case 'branch': return GitBranchSchema.safeParse(value).success ? null : 'Invalid branch name'
        case 'repository': return RepositoryIdSchema.safeParse(value).success ? null : 'Choose a granted repository'
        case 'resource': return ResourceReferenceSchema.safeParse(value).success ? null : 'Invalid resource reference'
        case 'https_url': return HttpsOutputUrlSchema.safeParse(value).success ? null : 'Use a canonical https URL without credentials, query or fragment'
    }
}
export function developmentModuleDefaults(fields: readonly DevelopmentModuleField[]): DevelopmentModuleValues {
    return Object.fromEntries(fields.map(field => [field.id, structuredClone(field.default) as DevelopmentModuleFieldValue]))
}
/**
 * Validate and normalise values against a module form. Missing keys take the field default; unknown keys are
 * rejected. Shared by hub (authoritative) and web (early feedback).
 */
export function validateDevelopmentModuleValues(fields: readonly DevelopmentModuleField[], input: unknown):
    { ok: true; values: DevelopmentModuleValues } | { ok: false; issues: DevelopmentModuleValueIssue[] } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, issues: [{ field: '', message: 'Expected an object of field values' }] }
    const record = input as Record<string, unknown>, issues: DevelopmentModuleValueIssue[] = []
    for (const key of Object.keys(record)) if (!fields.some(field => field.id === key)) issues.push({ field: key, message: 'Unknown field' })
    const values: DevelopmentModuleValues = {}
    for (const field of fields) {
        const value = Object.hasOwn(record, field.id) ? record[field.id] : structuredClone(field.default)
        const issue = fieldValueIssue(field, value)
        if (issue) issues.push({ field: field.id, message: issue })
        else values[field.id] = (value ?? null) as DevelopmentModuleFieldValue
    }
    if (!issues.length && utf8Length(JSON.stringify(values)) > DEVELOPMENT_MODULE_LIMITS.valuesBytes) issues.push({ field: '', message: `Values of a module may use at most ${DEVELOPMENT_MODULE_LIMITS.valuesBytes / 1024} KiB` })
    return issues.length ? { ok: false, issues: issues.slice(0, DEVELOPMENT_MODULE_LIMITS.settingsIssues) } : { ok: true, values }
}

/** Declarative applicability: the item applies when the field value is one of `in` (unset values apply, like v1). */
export const DevelopmentModuleConditionSchema = z.object({
    field: DevelopmentModuleFieldIdSchema,
    in: z.array(z.union([DevelopmentModuleOptionValueSchema, integer, z.boolean()])).min(1).max(16),
}).strict()
export type DevelopmentModuleCondition = z.infer<typeof DevelopmentModuleConditionSchema>
export function developmentModuleApplies(when: DevelopmentModuleCondition | null | undefined, values: Readonly<Record<string, unknown>> | null): boolean {
    if (!when) return true
    const value = values?.[when.field]
    return value === undefined || value === null || when.in.includes(value as string | number | boolean)
}

// ---------------------------------------------------------------- providers (host registry)

export const DevelopmentProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31}){1,3}$/)
export const DevelopmentProviderRefSchema = z.object({ id: DevelopmentProviderIdSchema, version: z.number().int().min(1).max(1000) }).strict()
export type DevelopmentProviderRef = z.infer<typeof DevelopmentProviderRefSchema>
type CheckLabel = { label: string; category: z.infer<typeof DoctorCheckCategorySchema> }
export type DevelopmentProviderSpec = {
    versions: readonly number[]
    kinds: ReadonlyArray<'doctor' | 'inspect' | 'integration'>
    /** Builtin providers read builtin settings sections and are not available to plugin modules. */
    pluginUsable: boolean
    /** Runner machine capability proving support; null = implemented in the hub. */
    capability: string | null
    checks?: Readonly<Record<string, CheckLabel>>
}
export function developmentProviderCapability(id: string, version: number): string { return `evolvedDevelopment.provider.${id}.v${version}` }
/** Generic, settings-independent toolchain probes (presence and version only). */
export const HAPI_TOOLCHAIN_CHECKS: Readonly<Record<string, CheckLabel>> = Object.freeze({
    'image.marker': { label: 'Runner-Image', category: 'image' },
    'repository.checkout': { label: 'Repository-Checkout', category: 'project' },
    git: { label: 'Git', category: 'toolchain' },
    python: { label: 'Python', category: 'toolchain' },
    node: { label: 'Node.js', category: 'toolchain' },
    java: { label: 'JDK', category: 'toolchain' },
    ssh: { label: 'SSH-Client', category: 'integration' },
    kvm: { label: 'KVM-Beschleunigung', category: 'device' },
})
/**
 * Read-only readiness of the bundled Claude Ads module (runner): pinned Python 3.11/3.12 runtime, vendored asset
 * provenance, ownership state of the native skill trees and the report directory. Never executes project files.
 */
export const HAPI_CLAUDE_ADS_CHECKS: Readonly<Record<string, CheckLabel>> = Object.freeze({
    'ads.python': { label: 'Python 3.11/3.12 für Claude Ads', category: 'runtime' },
    'ads.assets': { label: 'Claude-Ads-Assets (Provenienz)', category: 'image' },
    'ads.skills.claude': { label: 'Native Skills für Claude', category: 'project' },
    'ads.skills.codex': { label: 'Native Skills für Codex', category: 'project' },
    'ads.artifacts': { label: 'Berichtsablage', category: 'project' },
})
export const DEVELOPMENT_MODULE_PROVIDERS: Readonly<Record<string, DevelopmentProviderSpec>> = Object.freeze({
    'hapi.toolchain': { versions: [1], kinds: ['doctor'], pluginUsable: true, capability: developmentProviderCapability('hapi.toolchain', 1), checks: HAPI_TOOLCHAIN_CHECKS },
    'hapi.claude-ads': { versions: [1], kinds: ['doctor'], pluginUsable: true, capability: developmentProviderCapability('hapi.claude-ads', 1), checks: HAPI_CLAUDE_ADS_CHECKS },
    'hapi.repository-inventory': { versions: [1], kinds: ['inspect'], pluginUsable: true, capability: developmentProviderCapability('hapi.repository-inventory', 1) },
    'github.commit-status': { versions: [1], kinds: ['integration'], pluginUsable: true, capability: null },
    'builtin.odoo': { versions: [1], kinds: ['doctor', 'inspect'], pluginUsable: false, capability: 'evolved-development' },
    'builtin.ios': { versions: [1], kinds: ['doctor', 'inspect'], pluginUsable: false, capability: 'evolved-development' },
    'builtin.android': { versions: [1], kinds: ['doctor', 'inspect'], pluginUsable: false, capability: 'evolved-development' },
})
export function developmentProvider(ref: DevelopmentProviderRef, kind: 'doctor' | 'inspect' | 'integration'): DevelopmentProviderSpec | null {
    const spec = Object.hasOwn(DEVELOPMENT_MODULE_PROVIDERS, ref.id) ? DEVELOPMENT_MODULE_PROVIDERS[ref.id]! : null
    return spec && spec.kinds.includes(kind) && spec.versions.includes(ref.version) ? spec : null
}

// ---------------------------------------------------------------- module definition (plugin manifest input)

const when = DevelopmentModuleConditionSchema.nullable().default(null)
export const DevelopmentModuleTopicSchema = z.object({
    id: DevelopmentIdSchema, title: line(160), summary: text(600),
    /** Reference data shown to agents and people, never instructions. */
    body: text(8000), tags: z.array(tag).max(16).default([]), sources: z.array(DevelopmentModuleSourceRefSchema).min(1).max(8), when,
}).strict()
export type DevelopmentModuleTopic = z.infer<typeof DevelopmentModuleTopicSchema>
export const DevelopmentModuleTopicSummarySchema = DevelopmentModuleTopicSchema.omit({ body: true })
export const DevelopmentModuleRecipeSchema = z.object({
    id: DevelopmentIdSchema, title: line(160), summary: text(600), kind: DevelopmentRecipeSchema.shape.kind,
    effects: z.array(DevelopmentEffectSchema).max(10).default([]),
    /** Doctor check ids of this module that should be ready first. */
    prerequisites: z.array(DevelopmentIdSchema).max(16).default([]),
    steps: z.array(z.object({
        title: line(160), detail: text(1200),
        /** Example argv for the agent (never executed by HAPI). Placeholders: see DEVELOPMENT_MODULE_RECIPE_PLACEHOLDERS and field ids. */
        argv: z.array(line(300)).min(1).max(40).optional(),
    }).strict()).min(1).max(20),
    outputs: z.array(line(200)).max(8).default([]), guardrails: z.array(text(300)).max(10).default([]),
    sources: z.array(DevelopmentModuleSourceRefSchema).max(8).default([]), when,
}).strict()
export type DevelopmentModuleRecipe = z.infer<typeof DevelopmentModuleRecipeSchema>
export const DEVELOPMENT_TASK_PRECONDITIONS = ['android_sdk_license_acknowledged', 'android_debug_variant'] as const
export const DevelopmentModuleTaskSchema = z.object({
    id: DevelopmentIdSchema, title: line(120), description: text(600), kind: DevelopmentRecipeSchema.shape.kind,
    /** `builtin:implementation|tests|review|architecture` or the local id of an agent in the same plugin manifest (namespaced on install). */
    specialist: z.string().min(1).max(200),
    recipeIds: z.array(DevelopmentIdSchema).max(8).default([]), topicIds: z.array(DevelopmentIdSchema).max(12).default([]),
    defaultTask: text(2000), effects: z.array(DevelopmentEffectSchema).max(10).default([]), requiresRepository: z.boolean(),
    notes: z.array(text(300)).max(6).default([]),
    /** Server-enforced, builtin-only (plugins cannot create human acknowledgements). */
    preconditions: z.array(z.enum(DEVELOPMENT_TASK_PRECONDITIONS)).max(4).default([]), when,
}).strict()
export type DevelopmentModuleTask = z.infer<typeof DevelopmentModuleTaskSchema>
/**
 * Effects that change the project, its checkout, local services or remote state. A task whose effective effects
 * contain one of them needs a writable execution profile; a `restricted` project only allows read-only planning.
 */
export const DEVELOPMENT_CONSEQUENTIAL_EFFECTS: readonly DevelopmentEffect[] = Object.freeze([
    'writes_repository', 'network_download', 'installs_in_project', 'creates_local_database', 'runs_project_code', 'git_push_may_deploy', 'remote_cost',
] as DevelopmentEffect[])
/** Effective effects of a task: its own plus those of every referenced recipe, in DEVELOPMENT_EFFECTS order. */
export function developmentTaskEffects(task: { effects: readonly DevelopmentEffect[]; recipeIds: readonly string[] }, recipes: ReadonlyArray<{ id: string; effects: readonly DevelopmentEffect[] }>): DevelopmentEffect[] {
    const effects = new Set<DevelopmentEffect>(task.effects)
    for (const recipe of recipes) if (task.recipeIds.includes(recipe.id)) for (const effect of recipe.effects) effects.add(effect)
    return DEVELOPMENT_EFFECTS.filter(effect => effects.has(effect))
}
export function developmentTaskRequiresWritableProfile(effects: readonly DevelopmentEffect[]): boolean {
    return effects.some(effect => DEVELOPMENT_CONSEQUENTIAL_EFFECTS.includes(effect))
}
export const DevelopmentModuleDoctorInputSchema = z.object({
    provider: DevelopmentProviderRefSchema,
    checks: z.array(z.object({ id: DevelopmentIdSchema, required: z.boolean().default(false), when }).strict()).max(DEVELOPMENT_MODULE_LIMITS.pluginDoctorChecks),
}).strict()
export const DevelopmentModuleInspectSchema = z.object({
    provider: DevelopmentProviderRefSchema,
    /** A `repo_path` field naming the directory to inventory; null = repository root. */
    directoryField: DevelopmentModuleFieldIdSchema.nullable().default(null),
}).strict()
export const DevelopmentModuleIntegrationSchema = z.object({
    id: DevelopmentIdSchema, title: line(120), kind: z.enum(['live_read', 'reference', 'manual']),
    /** Required for `live_read`: the hub-implemented read. */
    provider: z.enum(['github.commit-status']).nullable().default(null),
    description: text(600), limits: z.array(text(300)).max(6).default([]), sources: z.array(DevelopmentModuleSourceRefSchema).max(6).default([]),
    links: z.array(z.object({ label: line(80), url: HttpsOutputUrlSchema }).strict()).max(6).default([]),
}).strict()
export type DevelopmentModuleIntegration = z.infer<typeof DevelopmentModuleIntegrationSchema>

/** Placeholders a plugin recipe argv may use besides its own field ids. */
export const DEVELOPMENT_MODULE_RECIPE_PLACEHOLDERS = ['checkout', 'toolchainDir', 'artifactsDir'] as const
const BUILTIN_SPECIALISTS: readonly string[] = DEVELOPMENT_TASK_SPECIALISTS
/** Null when `specialist` is a builtin specialist or an agent of the same manifest. */
export function developmentModuleSpecialistIssue(specialist: string, manifestAgents: ReadonlySet<string>): string | null {
    if (BUILTIN_SPECIALISTS.includes(specialist) || manifestAgents.has(specialist)) return null
    return 'Specialist must be a builtin specialist or an agent of this plugin'
}

export const DevelopmentModuleDefinitionSchema = z.object({
    apiVersion: z.literal(DEVELOPMENT_MODULE_API_VERSION),
    id: DevelopmentModuleLocalIdSchema,
    title: line(80), summary: text(600), contentVersion: DevelopmentModuleContentVersionSchema,
    /** Orientation shown in context; data, not instructions. */
    brief: z.array(text(400)).max(16).default([]), constraints: z.array(text(300)).max(16).default([]),
    fields: z.array(DevelopmentModuleFieldSchema).max(DEVELOPMENT_MODULE_LIMITS.fields).default([]),
    topics: z.array(DevelopmentModuleTopicSchema).max(DEVELOPMENT_MODULE_LIMITS.topics).default([]),
    recipes: z.array(DevelopmentModuleRecipeSchema).max(DEVELOPMENT_MODULE_LIMITS.recipes).default([]),
    tasks: z.array(DevelopmentModuleTaskSchema).max(DEVELOPMENT_MODULE_LIMITS.tasks).default([]),
    doctor: DevelopmentModuleDoctorInputSchema.nullable().default(null),
    inspect: DevelopmentModuleInspectSchema.nullable().default(null),
    integrations: z.array(DevelopmentModuleIntegrationSchema).max(DEVELOPMENT_MODULE_LIMITS.integrations).default([]),
}).strict().superRefine((value, context) => {
    const issue = (path: Array<string | number>, message: string) => context.addIssue({ code: 'custom', path, message })
    for (const kind of ['fields', 'topics', 'recipes', 'tasks', 'integrations'] as const) {
        if (new Set(value[kind].map(item => item.id)).size !== value[kind].length) issue([kind], 'Duplicate identifier')
    }
    const fields = new Map(value.fields.map(field => [field.id, field]))
    let optionCount = 0
    value.fields.forEach((field, index) => {
        if (field.kind === 'select' || field.kind === 'multi_select') {
            optionCount += field.options.length
            if (new Set(field.options.map(entry => entry.value)).size !== field.options.length) issue(['fields', index, 'options'], 'Duplicate option')
        }
        if (field.kind === 'number' && field.min > field.max) issue(['fields', index, 'max'], 'max must not be below min')
        const defaultIssue = field.default === null && field.required ? null : fieldValueIssue({ ...field, required: false } as DevelopmentModuleField, field.default)
        if (defaultIssue) issue(['fields', index, 'default'], `Invalid default: ${defaultIssue}`)
    })
    if (optionCount > DEVELOPMENT_MODULE_LIMITS.optionsPerModule) issue(['fields'], `At most ${DEVELOPMENT_MODULE_LIMITS.optionsPerModule} options per module`)
    if (utf8Length(JSON.stringify(Object.fromEntries(value.fields.map(field => [field.id, field.default])))) > DEVELOPMENT_MODULE_LIMITS.valuesBytes) issue(['fields'], `Default values may use at most ${DEVELOPMENT_MODULE_LIMITS.valuesBytes / 1024} KiB`)
    const checkWhen = (condition: DevelopmentModuleCondition | null, path: Array<string | number>) => {
        if (!condition) return
        const field = fields.get(condition.field)
        if (!field || !['select', 'boolean', 'number'].includes(field.kind)) return issue([...path, 'when'], 'Conditions refer to a select, boolean or number field')
        if (condition.in.some(entry => fieldValueIssue({ ...field, required: false } as DevelopmentModuleField, entry) !== null)) issue([...path, 'when'], 'Condition value does not fit the field')
    }
    const checkIds = new Set(value.doctor?.checks.map(check => check.id) ?? [])
    const placeholders = new Set<string>([...DEVELOPMENT_MODULE_RECIPE_PLACEHOLDERS, ...fields.keys()])
    value.topics.forEach((topic, index) => checkWhen(topic.when, ['topics', index]))
    value.recipes.forEach((recipe, index) => {
        checkWhen(recipe.when, ['recipes', index])
        if (recipe.prerequisites.some(id => !checkIds.has(id))) issue(['recipes', index, 'prerequisites'], 'Prerequisites must be doctor checks of this module')
        if (recipe.effects.includes('requires_license_acknowledgement')) issue(['recipes', index, 'effects'], 'Licence acknowledgements are reserved for builtin modules')
        recipe.steps.forEach((step, stepIndex) => step.argv?.forEach((arg, argIndex) => {
            for (const match of arg.matchAll(/\{([^{}]*)\}/g)) if (!placeholders.has(match[1]!)) issue(['recipes', index, 'steps', stepIndex, 'argv', argIndex], `Unknown placeholder {${match[1]}}`)
            if (/[{}]/.test(arg.replace(/\{[^{}]*\}/g, ''))) issue(['recipes', index, 'steps', stepIndex, 'argv', argIndex], 'Unbalanced braces')
        }))
    })
    const recipes = new Map(value.recipes.map(recipe => [recipe.id, recipe])), topics = new Set(value.topics.map(topic => topic.id))
    value.tasks.forEach((task, index) => {
        checkWhen(task.when, ['tasks', index])
        if (new Set(task.recipeIds).size !== task.recipeIds.length || task.recipeIds.some(id => !recipes.has(id))) issue(['tasks', index, 'recipeIds'], 'Tasks refer to unique recipes of this module')
        if (new Set(task.topicIds).size !== task.topicIds.length || task.topicIds.some(id => !topics.has(id))) issue(['tasks', index, 'topicIds'], 'Tasks refer to unique topics of this module')
        if (task.preconditions.length) issue(['tasks', index, 'preconditions'], 'Start preconditions are reserved for builtin modules')
        if (task.effects.includes('requires_license_acknowledgement')) issue(['tasks', index, 'effects'], 'Licence acknowledgements are reserved for builtin modules')
        const payload = JSON.stringify({ task, recipes: task.recipeIds.map(id => recipes.get(id)) })
        if (utf8Length(payload) > DEVELOPMENT_MODULE_LIMITS.taskPayloadBytes) issue(['tasks', index], 'Task with its recipes exceeds 24 KiB')
    })
    if (value.doctor) {
        const known = Object.hasOwn(DEVELOPMENT_MODULE_PROVIDERS, value.doctor.provider.id) ? DEVELOPMENT_MODULE_PROVIDERS[value.doctor.provider.id]! : null
        if (known && (!known.pluginUsable || !known.kinds.includes('doctor'))) issue(['doctor', 'provider'], 'This provider is not available to plugin doctor checks')
        if (new Set(value.doctor.checks.map(check => check.id)).size !== value.doctor.checks.length) issue(['doctor', 'checks'], 'Duplicate check')
        const provider = developmentProvider(value.doctor.provider, 'doctor')
        value.doctor.checks.forEach((check, index) => {
            checkWhen(check.when, ['doctor', 'checks', index])
            if (provider?.checks && !Object.hasOwn(provider.checks, check.id)) issue(['doctor', 'checks', index, 'id'], 'Check is not offered by this provider')
        })
    }
    if (value.inspect) {
        const known = Object.hasOwn(DEVELOPMENT_MODULE_PROVIDERS, value.inspect.provider.id) ? DEVELOPMENT_MODULE_PROVIDERS[value.inspect.provider.id]! : null
        if (known && (!known.pluginUsable || !known.kinds.includes('inspect'))) issue(['inspect', 'provider'], 'This provider is not available to plugin inspection')
        if (value.inspect.directoryField && fields.get(value.inspect.directoryField)?.kind !== 'repo_path') issue(['inspect', 'directoryField'], 'directoryField must be a repo_path field')
    }
    value.integrations.forEach((integration, index) => {
        if ((integration.kind === 'live_read') !== (integration.provider !== null)) issue(['integrations', index, 'provider'], 'live_read integrations need a provider; other kinds have none')
    })
})
export type DevelopmentModuleDefinition = z.infer<typeof DevelopmentModuleDefinitionSchema>
export type DevelopmentModuleDefinitionInput = z.input<typeof DevelopmentModuleDefinitionSchema>

/** Reasons a syntactically valid plugin module cannot run on this hub (unknown provider/version). Empty = supported. */
export function developmentModuleSupportIssues(definition: Pick<DevelopmentModuleDefinition, 'doctor' | 'inspect'>): string[] {
    const reasons: string[] = []
    if (definition.doctor && !developmentProvider(definition.doctor.provider, 'doctor')) reasons.push(`Doctor-Provider ${definition.doctor.provider.id} v${definition.doctor.provider.version} wird von diesem HAPI nicht unterstützt.`)
    if (definition.inspect && !developmentProvider(definition.inspect.provider, 'inspect')) reasons.push(`Inspect-Provider ${definition.inspect.provider.id} v${definition.inspect.provider.version} wird von diesem HAPI nicht unterstützt.`)
    return reasons
}

// ---------------------------------------------------------------- resolved module view (wire)

export const DevelopmentModuleFormSchema = z.discriminatedUnion('kind', [
    /** Builtin forms keep their reviewed typed settings sections and dedicated renderers. */
    z.object({ kind: z.literal('builtin'), renderer: z.enum(['odoo', 'ios', 'android']) }).strict(),
    z.object({ kind: z.literal('fields'), fields: z.array(DevelopmentModuleFieldSchema).max(DEVELOPMENT_MODULE_LIMITS.fields) }).strict(),
])
export const DevelopmentModuleResolvedTaskSchema = DevelopmentModuleTaskSchema.extend({
    /** Agent-catalog id (`builtin:*` or `plugin:<pluginUuid>:<agentId>`). */
    specialist: z.string().min(1).max(200),
})
export type DevelopmentModuleResolvedTask = z.infer<typeof DevelopmentModuleResolvedTaskSchema>
export const DevelopmentModuleResolvedCheckSchema = z.object({
    id: DevelopmentIdSchema, label: line(120), category: DoctorCheckCategorySchema, required: z.boolean(), when: DevelopmentModuleConditionSchema.nullable(),
}).strict()
export const DevelopmentModuleDoctorViewSchema = z.object({ provider: DevelopmentProviderRefSchema, checks: z.array(DevelopmentModuleResolvedCheckSchema).max(64) }).strict()
/** Full resolved module (hub-internal; digest input). Wire views omit topic bodies. */
export const DevelopmentModuleViewSchema = z.object({
    title: line(80), summary: text(600), contentVersion: DevelopmentModuleContentVersionSchema,
    brief: z.array(text(400)).max(16), constraints: z.array(text(300)).max(16),
    form: DevelopmentModuleFormSchema,
    topics: z.array(DevelopmentModuleTopicSchema).max(DEVELOPMENT_MODULE_LIMITS.topics),
    recipes: z.array(DevelopmentModuleRecipeSchema).max(DEVELOPMENT_MODULE_LIMITS.recipes),
    tasks: z.array(DevelopmentModuleResolvedTaskSchema).max(DEVELOPMENT_MODULE_LIMITS.tasks),
    doctor: DevelopmentModuleDoctorViewSchema.nullable(),
    inspect: DevelopmentModuleInspectSchema.nullable(),
    integrations: z.array(DevelopmentModuleIntegrationSchema).max(DEVELOPMENT_MODULE_LIMITS.integrations),
}).strict()
export type DevelopmentModuleView = z.infer<typeof DevelopmentModuleViewSchema>

export const DEVELOPMENT_MODULE_STATES = ['none', 'ready', 'adoption_required', 'disabled', 'missing', 'unsupported', 'invalid'] as const
export const DevelopmentModuleStateSchema = z.enum(DEVELOPMENT_MODULE_STATES)
export type DevelopmentModuleState = z.infer<typeof DevelopmentModuleStateSchema>
export const DevelopmentModuleSourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin') }).strict(),
    z.object({
        kind: z.literal('plugin'), pluginId: z.string().uuid(), pluginName: z.string().max(100), pluginVersion: z.string().max(64),
        repository: z.string().max(140), repositoryId: RepositoryIdSchema, commitSha: GitShaSchema, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
        enabled: z.boolean(),
    }).strict(),
])
export type DevelopmentModuleSource = z.infer<typeof DevelopmentModuleSourceSchema>
const reasons = z.array(z.string().max(300)).max(6)
export const DevelopmentModuleCatalogEntrySchema = z.object({
    id: DevelopmentModuleIdSchema, origin: z.enum(['builtin', 'plugin']), localId: DevelopmentModuleLocalIdSchema,
    title: z.string().max(80), summary: z.string().max(600), contentVersion: DevelopmentModuleContentVersionSchema,
    digest: DevelopmentModuleDigestSchema,
    /** Installation-level availability: `ready`, `disabled`, `unsupported` or `invalid`. */
    state: DevelopmentModuleStateSchema, reasons,
    /** `release`: builtin, updated with HAPI. `adopt`: a project admin adopts plugin updates explicitly. */
    updatePolicy: z.enum(['release', 'adopt']),
    source: DevelopmentModuleSourceSchema,
    form: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('builtin'), renderer: z.enum(['odoo', 'ios', 'android']) }).strict(),
        z.object({ kind: z.literal('fields'), fieldCount: z.number().int().nonnegative().max(DEVELOPMENT_MODULE_LIMITS.fields) }).strict(),
    ]),
    counts: z.object({ topics: z.number().int().nonnegative(), recipes: z.number().int().nonnegative(), tasks: z.number().int().nonnegative(), checks: z.number().int().nonnegative() }).strict(),
    providers: z.array(z.object({ id: DevelopmentProviderIdSchema, version: z.number().int(), kind: z.enum(['doctor', 'inspect', 'integration']), supported: z.boolean() }).strict()).max(16),
}).strict()
export type DevelopmentModuleCatalogEntry = z.infer<typeof DevelopmentModuleCatalogEntrySchema>
export const DevelopmentModuleDetailSchema = DevelopmentModuleCatalogEntrySchema.extend({
    form: DevelopmentModuleFormSchema,
    brief: DevelopmentModuleViewSchema.shape.brief, constraints: DevelopmentModuleViewSchema.shape.constraints,
    topics: z.array(DevelopmentModuleTopicSummarySchema).max(DEVELOPMENT_MODULE_LIMITS.topics),
    recipes: DevelopmentModuleViewSchema.shape.recipes, tasks: DevelopmentModuleViewSchema.shape.tasks,
    doctor: DevelopmentModuleViewSchema.shape.doctor, inspect: DevelopmentModuleViewSchema.shape.inspect, integrations: DevelopmentModuleViewSchema.shape.integrations,
}).strict()
export type DevelopmentModuleDetail = z.infer<typeof DevelopmentModuleDetailSchema>

// ---------------------------------------------------------------- canonical project configuration

export const PluginModuleSettingsEntrySchema = z.object({
    /** Digest the project adopted; differs from the installed digest after a plugin update until a project admin adopts it. */
    moduleDigest: DevelopmentModuleDigestSchema,
    settingsVersion: z.literal(1),
    values: DevelopmentModuleValuesSchema,
    /** Server-written provenance at adoption time. Never accepted from clients. */
    adopted: z.object({
        pluginId: z.string().uuid(), pluginVersion: z.string().max(64), repository: z.string().max(140), commitSha: GitShaSchema,
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().int().nonnegative(),
    }).strict(),
}).strict()
export type PluginModuleSettingsEntry = z.infer<typeof PluginModuleSettingsEntrySchema>
export const PluginModuleSettingsInputSchema = z.object({ moduleDigest: DevelopmentModuleDigestSchema, values: z.record(z.string().max(40), z.unknown()) }).strict()
    .refine(value => Object.keys(value.values).length <= DEVELOPMENT_MODULE_LIMITS.fields, 'Too many values')
export type PluginModuleSettingsInput = z.infer<typeof PluginModuleSettingsInputSchema>

const settingsShape = {
    /** The single active primary module; null = general development (v1 `none`). */
    activeModuleId: DevelopmentModuleIdSchema.nullable(),
    /** Existing granted GitHub repository used as default checkout (shared by all modules). */
    repositoryId: RepositoryIdSchema.nullable(),
    /** Builtin sections (v1 types); inactive sections are preserved. */
    odoo: OdooSettingsSchema.nullable(), ios: IosSettingsSchema.nullable(), android: AndroidSettingsSchema.nullable(),
}
function refineSettings(value: { activeModuleId: string | null; repositoryId: string | null; odoo: { enterpriseRepositoryId: string | null } | null; ios: unknown; android: unknown; modules: Record<string, unknown> }, context: z.RefinementCtx) {
    const builtin = value.activeModuleId ? parseDevelopmentModuleId(value.activeModuleId) : null
    if (builtin?.origin === 'builtin' && !value[builtin.mode]) context.addIssue({ code: 'custom', path: [builtin.mode], message: 'Settings for the selected module are required' })
    if (builtin?.origin === 'plugin' && !Object.hasOwn(value.modules, value.activeModuleId!)) context.addIssue({ code: 'custom', path: ['modules'], message: 'Settings for the selected module are required' })
    if (Object.keys(value.modules).length > DEVELOPMENT_MODULE_LIMITS.projectModuleEntries) context.addIssue({ code: 'custom', path: ['modules'], message: `At most ${DEVELOPMENT_MODULE_LIMITS.projectModuleEntries} module configurations` })
    if (Object.keys(value.modules).some(key => !PluginDevelopmentModuleIdSchema.safeParse(key).success)) context.addIssue({ code: 'custom', path: ['modules'], message: 'Only plugin modules are stored here' })
    if (value.odoo?.enterpriseRepositoryId && value.odoo.enterpriseRepositoryId === value.repositoryId) context.addIssue({ code: 'custom', path: ['odoo', 'enterpriseRepositoryId'], message: 'Enterprise addons must be a separate repository' })
}
/** Canonical per-project configuration (one CAS revision for all of it). */
export const DevelopmentModuleSettingsSchema = z.object({ ...settingsShape, modules: z.record(z.string().max(110), PluginModuleSettingsEntrySchema) }).strict().superRefine(refineSettings)
export type DevelopmentModuleSettings = z.infer<typeof DevelopmentModuleSettingsSchema>
/** PUT/creation input: plugin entries carry only the displayed digest and values. */
export const DevelopmentModuleSettingsInputSchema = z.object({ ...settingsShape, modules: z.record(z.string().max(110), PluginModuleSettingsInputSchema) }).strict().superRefine(refineSettings)
export type DevelopmentModuleSettingsInput = z.infer<typeof DevelopmentModuleSettingsInputSchema>

/** Legacy adapter: every v1 configuration maps losslessly (inactive sections, repository, acknowledgement flag). */
export function developmentSettingsToModuleSettings(settings: DevelopmentSettings): DevelopmentModuleSettings {
    return { activeModuleId: builtinModuleIdForMode(settings.mode), repositoryId: settings.repositoryId, odoo: settings.odoo, ios: settings.ios, android: settings.android, modules: {} }
}
/** v1 projection; null when a plugin module is active (v1 clients must get an explicit upgrade error, never `none`). Plugin entries are not part of v1 and are kept by the hub on v1 writes. */
export function moduleSettingsToDevelopmentSettings(settings: Pick<DevelopmentModuleSettings, 'activeModuleId' | 'repositoryId' | 'odoo' | 'ios' | 'android'>): DevelopmentSettings | null {
    const mode = modeForBuiltinModuleId(settings.activeModuleId)
    if (!mode) return null
    return { mode, repositoryId: settings.repositoryId, odoo: settings.odoo, ios: settings.ios, android: settings.android }
}

const actorSchema = z.object({ id: z.string().max(128), displayName: z.string().max(100) }).strict()
export const DevelopmentModuleStatusSchema = z.object({
    moduleId: DevelopmentModuleIdSchema.nullable(), state: DevelopmentModuleStateSchema, reasons,
    installedDigest: DevelopmentModuleDigestSchema.nullable(), adoptedDigest: DevelopmentModuleDigestSchema.nullable(),
}).strict()
export type DevelopmentModuleStatus = z.infer<typeof DevelopmentModuleStatusSchema>
export const ProjectDevelopmentModuleConfigSchema = z.object({
    projectId: z.string().min(1).max(128),
    revision: DevelopmentRevisionSchema,
    settings: DevelopmentModuleSettingsSchema,
    /** Builtin pack revision (fnv1a64) or plugin module digest of the active module at last save. */
    savedModuleDigest: z.string().max(80).nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    updatedBy: actorSchema.nullable(),
    androidSdkLicenseAcknowledgement: z.object({ at: z.number().int().nonnegative(), by: actorSchema }).strict().nullable(),
    active: DevelopmentModuleStatusSchema,
}).strict()
export type ProjectDevelopmentModuleConfig = z.infer<typeof ProjectDevelopmentModuleConfigSchema>

// ---------------------------------------------------------------- API

/** GET /api/evolved/projects/:id/development/modules */
export const DevelopmentModulesResponseSchema = z.object({
    contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION),
    config: ProjectDevelopmentModuleConfigSchema,
    catalog: z.object({ modules: z.array(DevelopmentModuleCatalogEntrySchema).max(DEVELOPMENT_MODULE_LIMITS.catalogEntries) }).strict(),
    canEdit: z.boolean(),
}).strict()
export type DevelopmentModulesResponse = z.infer<typeof DevelopmentModulesResponseSchema>
/**
 * GET /api/evolved/development-modules (any signed-in human, project-independent, e.g. for project creation).
 * Same bounded entries as the project catalogue; `state` is installation-level (`ready|disabled|unsupported`).
 * Detail: GET /api/evolved/development-modules/:moduleId → DevelopmentModuleDetailResponseSchema.
 */
export const DevelopmentModuleCatalogResponseSchema = z.object({
    contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION),
    modules: z.array(DevelopmentModuleCatalogEntrySchema).max(DEVELOPMENT_MODULE_LIMITS.catalogEntries),
}).strict()
export type DevelopmentModuleCatalogResponse = z.infer<typeof DevelopmentModuleCatalogResponseSchema>
/**
 * `developmentModules[]` item on plugin list, preview, install, update and enable responses. `id` is null in the
 * preview of a new installation. `activeProjects`: projects with this module active; `affectedProjects`: those of them
 * whose adopted digest differs from `digest` (after an update they need adoption by a project admin).
 */
export const DevelopmentModulePluginSummarySchema = z.object({
    id: PluginDevelopmentModuleIdSchema.nullable(), localId: DevelopmentModuleLocalIdSchema, title: z.string().max(80),
    contentVersion: DevelopmentModuleContentVersionSchema, digest: DevelopmentModuleDigestSchema,
    state: DevelopmentModuleStateSchema, reasons: z.array(z.string().max(300)).max(6),
    fieldCount: z.number().int().nonnegative(), tasks: z.number().int().nonnegative(), topics: z.number().int().nonnegative(),
    activeProjects: z.number().int().nonnegative(), affectedProjects: z.number().int().nonnegative(),
}).strict()
export type DevelopmentModulePluginSummary = z.infer<typeof DevelopmentModulePluginSummarySchema>
/** 409 when the stored configuration was written by a newer HAPI (unknown `schemaVersion`); the row is never overwritten. */
export const DevelopmentConfigVersionUnsupportedSchema = z.object({
    error: z.string(), code: z.literal('development_config_version_unsupported'), revision: DevelopmentRevisionSchema, schemaVersion: z.number().int(),
}).strict()
/** GET /api/evolved/projects/:id/development/modules/:moduleId (installed modules only; 404 `development_module_not_found`). */
export const DevelopmentModuleDetailResponseSchema = z.object({ module: DevelopmentModuleDetailSchema }).strict()
/** PUT /api/evolved/projects/:id/development/modules */
export const DevelopmentModuleUpdateSchema = z.object({ expectedRevision: DevelopmentRevisionSchema, settings: DevelopmentModuleSettingsInputSchema }).strict()
export type DevelopmentModuleUpdate = z.infer<typeof DevelopmentModuleUpdateSchema>
export const DevelopmentModuleUpdateResponseSchema = z.object({ config: ProjectDevelopmentModuleConfigSchema }).strict()
export const DevelopmentModuleConflictResponseSchema = z.object({ error: z.string(), code: z.literal('development_revision_conflict'), config: ProjectDevelopmentModuleConfigSchema }).strict()
export const DevelopmentModuleChangedResponseSchema = z.object({ error: z.string(), code: z.literal('development_module_changed'), moduleId: DevelopmentModuleIdSchema, installedDigest: DevelopmentModuleDigestSchema.nullable() }).strict()
export const DevelopmentModuleUnavailableResponseSchema = z.object({ error: z.string(), code: z.literal('development_module_unavailable'), moduleId: DevelopmentModuleIdSchema, state: DevelopmentModuleStateSchema }).strict()
export const DevelopmentModuleSettingsErrorSchema = z.object({
    error: z.string(), code: z.literal('development_module_settings_invalid'),
    issues: z.array(z.object({ path: z.array(z.string().max(120)).max(8), message: z.string().max(300) }).strict()).max(DEVELOPMENT_MODULE_LIMITS.settingsIssues),
}).strict()
/** v1 routes when a plugin module is active (old clients must not see `none` nor overwrite generic settings). */
export const DevelopmentClientUpgradeRequiredSchema = z.object({ error: z.string(), code: z.literal('development_client_upgrade_required'), revision: DevelopmentRevisionSchema }).strict()
/** Optional `development` of POST /api/evolved/projects in contract v2. */
export const DevelopmentModuleCreationSchema = z.object({ contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION), settings: DevelopmentModuleSettingsInputSchema }).strict()
    .refine(value => value.settings.repositoryId === null && (value.settings.odoo?.enterpriseRepositoryId ?? null) === null, 'A new project has no repository grants yet')

export const DevelopmentModuleViewSummarySchema = z.object({
    id: DevelopmentModuleIdSchema, origin: z.enum(['builtin', 'plugin']), title: z.string().max(80), digest: DevelopmentModuleDigestSchema,
    contentVersion: DevelopmentModuleContentVersionSchema, source: DevelopmentModuleSourceSchema,
    brief: DevelopmentModuleViewSchema.shape.brief, constraints: DevelopmentModuleViewSchema.shape.constraints,
    /** Items applicable to the saved values. Topic bodies via modules-knowledge?topic=. */
    topics: z.array(DevelopmentModuleTopicSummarySchema).max(DEVELOPMENT_MODULE_LIMITS.topics),
    recipes: DevelopmentModuleViewSchema.shape.recipes, tasks: DevelopmentModuleViewSchema.shape.tasks,
    doctor: DevelopmentModuleViewSchema.shape.doctor, inspect: DevelopmentModuleViewSchema.shape.inspect,
}).strict()
/** GET /api/evolved/projects/:id/development/modules-context (human viewer or exact-project runner lease). */
export const DevelopmentModuleContextSchema = z.object({
    contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION),
    projectId: z.string().max(128), revision: DevelopmentRevisionSchema, observedAt: z.number().int().nonnegative(),
    dataNotice: z.string().max(400),
    active: DevelopmentModuleStatusSchema,
    /** Present only when `active.state === 'ready'`. */
    module: DevelopmentModuleViewSummarySchema.nullable(),
    settings: DevelopmentModuleSettingsSchema,
    repository: DevelopmentRepositoryContextSchema,
    integrations: z.array(DevelopmentIntegrationStatusSchema).max(DEVELOPMENT_MODULE_LIMITS.integrations),
    lastDoctor: z.object({
        observedAt: z.number().int().nonnegative(), revision: DevelopmentRevisionSchema, moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema,
        ready: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(), warning: z.number().int().nonnegative(),
        /** Required checks of that run that were not `ready`, with their remedy kind (hub process memory only). */
        missingRequired: z.array(z.object({
            id: DevelopmentIdSchema, state: z.enum(['missing', 'unsupported', 'unknown', 'warning']),
            remedyKind: z.enum(['recipe', 'operator', 'manual', 'docs']).nullable(), recipeId: DevelopmentIdSchema.nullable(),
        }).strict()).max(64).optional(),
    }).strict().nullable(),
}).strict()
export type DevelopmentModuleContext = z.infer<typeof DevelopmentModuleContextSchema>
/** GET .../development/modules-knowledge (same query as v1: topic | q, limit). */
export const DevelopmentModuleKnowledgeResponseSchema = z.object({
    projectId: z.string().max(128), revision: DevelopmentRevisionSchema,
    moduleId: DevelopmentModuleIdSchema.nullable(), moduleDigest: DevelopmentModuleDigestSchema.nullable(),
    topic: DevelopmentModuleTopicSchema.nullable(),
    results: z.array(DevelopmentModuleTopicSummarySchema.extend({ score: z.number().nonnegative().optional(), excerpt: z.string().max(400).optional() }).strict()).max(64),
    total: z.number().int().nonnegative(), truncated: z.boolean(), dataNotice: z.string().max(400),
}).strict()
export type DevelopmentModuleKnowledgeResponse = z.infer<typeof DevelopmentModuleKnowledgeResponseSchema>
/** Body of POST .../modules-doctor and .../modules-inspect: binds the module the user saw. */
export const DevelopmentModuleActionBodySchema = z.object({ moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema }).strict()
export type DevelopmentModuleActionBody = z.infer<typeof DevelopmentModuleActionBodySchema>
export const DevelopmentModuleRunnerSchema = z.object({
    status: z.union([DevelopmentRunnerStatusSchema, z.literal('unsupported')]), machineId: z.string().max(200).nullable(),
    missingCapabilities: z.array(z.string().max(120)).max(8),
}).strict()

// ---------------------------------------------------------------- runner RPC (actions on `evolved-development`)

const boundedText = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Control characters')
const rpcBase = { contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION), projectId: z.string().min(1).max(128), revision: DevelopmentRevisionSchema, moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema, provider: DevelopmentProviderRefSchema }
/** Hub → runner. Sent only when the machine advertises the provider capability. No commands or settings are sent. */
export const DevelopmentModuleRpcRequestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('module_doctor'), ...rpcBase, checks: z.array(DevelopmentIdSchema).max(DEVELOPMENT_MODULE_LIMITS.pluginDoctorChecks), repository: DevelopmentRpcRepositorySchema.nullable() }).strict(),
    z.object({ action: z.literal('module_inspect'), ...rpcBase, subdirectory: RepoSubdirectorySchema, repository: DevelopmentRpcRepositorySchema }).strict(),
])
export type DevelopmentModuleRpcRequest = z.infer<typeof DevelopmentModuleRpcRequestSchema>
export const DevelopmentModuleDoctorResultSchema = z.object({
    contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION), moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema, provider: DevelopmentProviderRefSchema,
    observedAt: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative().max(120_000),
    host: z.object({ os: boundedText(40), arch: boundedText(40), image: boundedText(120).nullable() }).strict(),
    checks: z.array(DevelopmentDoctorCheckSchema).max(64), truncated: z.boolean(),
}).strict()
export type DevelopmentModuleDoctorResult = z.infer<typeof DevelopmentModuleDoctorResultSchema>
export const DevelopmentModuleInspectResultSchema = z.object({
    contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION), moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema, provider: DevelopmentProviderRefSchema,
    repositoryId: RepositoryIdSchema, observedAt: z.number().int().nonnegative(), head: GitShaSchema.nullable(), branch: boundedText(255).nullable(),
    state: z.enum(['ready', 'missing', 'blocked']), message: boundedText(500).optional(),
    /** Only builtin.odoo fills this. */
    odooModules: z.array(OdooModuleInventorySchema).max(500),
    buildFiles: z.array(BuildFileInventorySchema).max(500),
    warnings: z.array(boundedText(300)).max(50),
    scanned: z.object({ files: z.number().int().nonnegative(), directories: z.number().int().nonnegative(), limitReached: z.boolean() }).strict(),
}).strict()
export type DevelopmentModuleInspectResult = z.infer<typeof DevelopmentModuleInspectResultSchema>
/** POST .../modules-doctor response. `result` null when the runner is not ready. */
export const DevelopmentModuleDoctorResponseSchema = z.object({
    projectId: z.string().max(128), revision: DevelopmentRevisionSchema, moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema,
    runner: DevelopmentModuleRunnerSchema, result: DevelopmentModuleDoctorResultSchema.nullable(), message: z.string().max(500).optional(),
}).strict()
export type DevelopmentModuleDoctorResponse = z.infer<typeof DevelopmentModuleDoctorResponseSchema>
/** POST .../modules-inspect response. */
export const DevelopmentModuleInspectResponseSchema = z.object({
    projectId: z.string().max(128), revision: DevelopmentRevisionSchema, moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema,
    runner: DevelopmentModuleRunnerSchema, repository: DevelopmentRepositoryContextSchema, result: DevelopmentModuleInspectResultSchema.nullable(), message: z.string().max(500).optional(),
}).strict()
export type DevelopmentModuleInspectResponse = z.infer<typeof DevelopmentModuleInspectResponseSchema>

// ---------------------------------------------------------------- session start

/**
 * Contract-v2 `development` field of POST /api/evolved/projects/:id/agent-catalog/:agentId/start.
 * `moduleId`/`moduleDigest` are what the user saw; `revision` the config revision. `agentId` must equal the task specialist.
 */
export const DevelopmentModuleTaskStartSchema = z.object({
    contractVersion: z.literal(DEVELOPMENT_MODULE_CONTRACT_VERSION), moduleId: DevelopmentModuleIdSchema, moduleDigest: DevelopmentModuleDigestSchema,
    taskId: DevelopmentIdSchema, revision: DevelopmentRevisionSchema,
}).strict()
export type DevelopmentModuleTaskStart = z.infer<typeof DevelopmentModuleTaskStartSchema>

// ---------------------------------------------------------------- helpers

/** Deterministic JSON (sorted keys, undefined dropped); the hub hashes it with SHA-256 for module digests. */
export function developmentModuleCanonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(developmentModuleCanonicalJson).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${developmentModuleCanonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
    return JSON.stringify(value)
}
/** Items applicable to the saved values; task topic references are filtered the same way. */
export function applicableModuleItems(view: Pick<DevelopmentModuleView, 'topics' | 'recipes' | 'tasks' | 'doctor'>, values: Readonly<Record<string, unknown>> | null) {
    const fits = (item: { when: DevelopmentModuleCondition | null }) => developmentModuleApplies(item.when, values)
    const topics = view.topics.filter(fits), topicIds = new Set(topics.map(topic => topic.id))
    const recipes = view.recipes.filter(fits), recipeIds = new Set(recipes.map(recipe => recipe.id))
    const tasks = view.tasks.filter(fits).map(task => ({ ...task, topicIds: task.topicIds.filter(id => topicIds.has(id)), recipeIds: task.recipeIds.filter(id => recipeIds.has(id)) }))
    return { topics, recipes, tasks, checks: view.doctor?.checks.filter(fits) ?? [] }
}
/** Host-computed task effects: own effects plus every effect of the referenced recipes (never reducible by module data). */
export function aggregateTaskEffects<T extends { effects: readonly string[]; recipeIds: readonly string[] }>(task: T, recipes: ReadonlyArray<{ id: string; effects: readonly string[] }>): T & { effects: Array<typeof DEVELOPMENT_EFFECTS[number]> } {
    const used = recipes.filter(recipe => task.recipeIds.includes(recipe.id))
    return { ...task, effects: DEVELOPMENT_EFFECTS.filter(effect => task.effects.includes(effect) || used.some(recipe => recipe.effects.includes(effect))) }
}
