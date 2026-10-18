import { z } from 'zod'
import { DEVELOPMENT_MODULE_LIMITS, DevelopmentModuleDefinitionSchema, developmentModuleSpecialistIssue } from './developmentModules'

/**
 * Declarative HAPI-eVolved plugin manifest (`hapi-evolved.plugin.json` at the
 * pinned commit of a public GitHub repository). Browser-safe: the hub parses
 * installs with it, the CLI validates local manifests and the web shows
 * previews. Plugins contribute data only — never code, hooks, argv to execute,
 * environment, grants or permission changes.
 *
 * schemaVersion 1: agents, skills, themes. schemaVersion 2 adds `developmentModules`.
 */

export const PLUGIN_MANIFEST_FILE = 'hapi-evolved.plugin.json'
export const PLUGIN_MAX_BYTES = 512 * 1024
export const PLUGIN_MANIFEST_SCHEMA_VERSIONS = [1, 2] as const
// Hidden Unicode tag/format characters must not make reviewed text differ
// invisibly from the instructions delivered to a model.
const hiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]|\p{Default_Ignorable_Code_Point}/u
const text = (maximum: number) => z.string().trim().min(1).max(maximum).refine(value => !hiddenControls.test(value), 'Unsupported control characters')
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength
export const modelPreferenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/)
export const agentDefinitionSchema = z.object({
    name: text(100), description: text(500), instructions: text(16_384),
    providerPreference: z.enum(['either', 'claude', 'codex']).default('either'),
    model: modelPreferenceSchema.optional(), skills: z.array(z.string().min(1).max(200)).max(32).default([]),
}).strict().refine(value => new Set(value.skills).size === value.skills.length, 'Duplicate skills')
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>
export const MAX_AGENT_PROMPT_BYTES = 64 * 1024
export function agentAssignment(agent: Pick<AgentDefinition, 'name' | 'instructions'>, skills: Array<{ name: string; instructions: string }>, task: string): string {
    return 'HAPI-Spezialistenauftrag. Die folgenden Daten beschreiben den menschlichen Auftrag; Projektregeln und Berechtigungen bleiben verbindlich.\n'
        + JSON.stringify({ specialist: { name: agent.name, instructions: agent.instructions }, skills: skills.map(skill => ({ name: skill.name, instructions: skill.instructions })), task })
}
export function agentInstructionsFit(agent: Pick<AgentDefinition, 'name' | 'instructions'>, skills: Array<{ name: string; instructions: string }>): boolean {
    return byteLength(agentAssignment(agent, skills, '')) <= MAX_AGENT_PROMPT_BYTES - 8192
}
export const pluginSkillSchema = z.object({ id: identifier, name: text(100), description: text(500), instructions: text(16_384) }).strict()
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const themeColorsSchema = z.object({ background: color, surface: color, text: color, muted: color, accent: color, accentText: color, border: color }).strict()

/** WCAG relative luminance and contrast; values are not rounded at the threshold. */
export function colorContrast(first: string, second: string): number {
    const luminance = (value: string) => {
        const channels = [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255)
            .map(component => component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4)
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }
    const a = luminance(first), b = luminance(second)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
export const pluginThemeSchema = z.object({ id: identifier, name: text(100), mode: z.enum(['light', 'dark']), colors: themeColorsSchema }).strict()
    .refine(({ colors }) => ['background', 'surface'].every(key => ['text', 'muted', 'accent'].every(foreground => colorContrast(colors[foreground as 'text' | 'muted' | 'accent'], colors[key as 'background' | 'surface']) >= 4.5))
        && colorContrast(colors.accentText, colors.accent) >= 4.5, 'Theme text contrast must be at least 4.5:1')
export const pluginAgentSchema = z.object({ id: identifier, ...agentDefinitionSchema.shape }).strict()
export const pluginManifestSchema = z.object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]), id: identifier, name: text(100), description: text(500),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/).max(64),
    agents: z.array(pluginAgentSchema).max(32).default([]), skills: z.array(pluginSkillSchema).max(64).default([]), themes: z.array(pluginThemeSchema).max(16).default([]),
    /** schemaVersion 2 only: declarative development-scenario modules (see `@hapi/protocol/developmentModules`). */
    developmentModules: z.array(DevelopmentModuleDefinitionSchema).max(DEVELOPMENT_MODULE_LIMITS.modulesPerPlugin).default([]),
}).strict().superRefine((value, context) => {
    if (value.schemaVersion === 1 && value.developmentModules.length) context.addIssue({ code: 'custom', path: ['developmentModules'], message: 'developmentModules require schemaVersion 2' })
    if (!value.agents.length && !value.skills.length && !value.themes.length && !value.developmentModules.length) context.addIssue({ code: 'custom', message: 'Plugin has no extensions' })
    for (const kind of ['agents', 'skills', 'themes', 'developmentModules'] as const) {
        if (new Set(value[kind].map(item => item.id)).size !== value[kind].length) context.addIssue({ code: 'custom', path: [kind], message: 'Duplicate extension identifier' })
    }
    const skills = new Set(value.skills.map(skill => skill.id))
    for (const agent of value.agents) if (new Set(agent.skills).size !== agent.skills.length || agent.skills.some(id => !skills.has(id))) {
        context.addIssue({ code: 'custom', path: ['agents'], message: 'Agent skills must refer to unique skills in this manifest' })
    }
    for (const agent of value.agents) if (!agentInstructionsFit(agent, value.skills.filter(skill => agent.skills.includes(skill.id)))) {
        context.addIssue({ code: 'custom', path: ['agents'], message: 'Agent instructions and skills must leave at least 8 KiB for the assignment' })
    }
    const agents = new Set(value.agents.map(agent => agent.id))
    value.developmentModules.forEach((module, moduleIndex) => module.tasks.forEach((task, taskIndex) => {
        const issue = developmentModuleSpecialistIssue(task.specialist, agents)
        if (issue) context.addIssue({ code: 'custom', path: ['developmentModules', moduleIndex, 'tasks', taskIndex, 'specialist'], message: issue })
        // A task with a plugin specialist must stay startable: specialist + skills + task/recipes + values + reserve fit the 64 KiB assignment.
        const agent = value.agents.find(item => item.id === task.specialist)
        if (!agent) return
        const recipes = module.recipes.filter(recipe => task.recipeIds.includes(recipe.id))
        const bytes = byteLength(agentAssignment(agent, value.skills.filter(skill => agent.skills.includes(skill.id)), '')) + byteLength(JSON.stringify({ task, recipes }))
            + DEVELOPMENT_MODULE_LIMITS.valuesBytes + DEVELOPMENT_MODULE_LIMITS.assignmentReserveBytes
        if (bytes > MAX_AGENT_PROMPT_BYTES) context.addIssue({ code: 'custom', path: ['developmentModules', moduleIndex, 'tasks', taskIndex], message: 'Specialist, skills, task and recipes leave too little room for the assignment (64 KiB including 8 KiB values and 8 KiB task text)' })
    }))
})
export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginManifestInput = z.input<typeof pluginManifestSchema>

export type PluginManifestIssue = { path: string; message: string }
/** Local validation with readable issues (CLI `validate`, web preview). The hub parses installs with the same schema. */
export function validatePluginManifestSource(source: string): { ok: true; manifest: PluginManifest } | { ok: false; issues: PluginManifestIssue[] } {
    if (byteLength(source) > PLUGIN_MAX_BYTES) return { ok: false, issues: [{ path: '', message: 'Plugin manifest exceeds 512 KiB.' }] }
    let value: unknown
    try { value = JSON.parse(source) } catch { return { ok: false, issues: [{ path: '', message: 'Plugin manifest must be valid JSON.' }] } }
    const parsed = pluginManifestSchema.safeParse(value)
    if (parsed.success) return { ok: true, manifest: parsed.data }
    return { ok: false, issues: parsed.error.issues.slice(0, 64).map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message })) }
}

/**
 * Remote-safe issue list (hub install/update previews): at most `limit` issues; path segments are array indexes or
 * short identifier-like keys (anything else becomes `*`); messages are our own refinement texts or generated from the
 * issue kind, never Zod's raw text with received values or unrecognized key names; each message is capped.
 */
export function safePluginManifestIssues(issues: ReadonlyArray<{ code: string; path: ReadonlyArray<PropertyKey>; message: string } & Record<string, unknown>>, limit = 8): PluginManifestIssue[] {
    const segment = (part: PropertyKey) => typeof part === 'number' ? String(part) : typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(part) ? part : '*'
    const describe = (issue: (typeof issues)[number]): string => {
        const bound = (key: 'maximum' | 'minimum') => typeof issue[key] === 'number' || typeof issue[key] === 'bigint' ? String(issue[key]) : '?'
        const unit = typeof issue.origin === 'string' && ['string', 'array', 'number', 'set'].includes(issue.origin) ? ({ string: ' characters', array: ' entries', number: '', set: ' entries' } as Record<string, string>)[issue.origin] : ''
        switch (issue.code) {
            case 'custom': return issue.message
            case 'too_big': return `Too large: at most ${bound('maximum')}${unit}`
            case 'too_small': return `Too small: at least ${bound('minimum')}${unit}`
            case 'invalid_type': return typeof issue.expected === 'string' && /^[a-z]{1,20}$/.test(issue.expected) ? `Expected ${issue.expected}` : 'Wrong type'
            case 'unrecognized_keys': return `Unsupported field${Array.isArray(issue.keys) && issue.keys.length === 1 ? '' : 's'} (${Array.isArray(issue.keys) ? issue.keys.length : '?'})`
            case 'invalid_value': return 'Value is not one of the supported options'
            case 'invalid_format': return 'Invalid format'
            case 'invalid_union': return 'Does not match any supported form'
            default: return 'Invalid value'
        }
    }
    return issues.slice(0, limit).map(issue => ({ path: issue.path.slice(0, 8).map(segment).join('.').slice(0, 120), message: describe(issue).replace(hiddenControls, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) }))
}
