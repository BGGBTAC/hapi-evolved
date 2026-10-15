import { z } from 'zod'
import { EvolvedError } from './store'

export const PLUGIN_MANIFEST_FILE = 'hapi-evolved.plugin.json'
export const PLUGIN_MAX_BYTES = 512 * 1024
const hiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/
const text = (maximum: number) => z.string().trim().min(1).max(maximum).refine(value => !hiddenControls.test(value), 'Unsupported control characters')
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const modelPreferenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/)
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
    return Buffer.byteLength(agentAssignment(agent, skills, '')) <= MAX_AGENT_PROMPT_BYTES - 8192
}
const skillSchema = z.object({ id: identifier, name: text(100), description: text(500), instructions: text(16_384) }).strict()
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
const themeSchema = z.object({ id: identifier, name: text(100), mode: z.enum(['light', 'dark']), colors: themeColorsSchema }).strict()
    .refine(({ colors }) => ['background', 'surface'].every(key => ['text', 'muted', 'accent'].every(foreground => colorContrast(colors[foreground as 'text' | 'muted' | 'accent'], colors[key as 'background' | 'surface']) >= 4.5))
        && colorContrast(colors.accentText, colors.accent) >= 4.5, 'Theme text contrast must be at least 4.5:1')
const pluginAgentSchema = z.object({ id: identifier, ...agentDefinitionSchema.shape }).strict()
export const pluginManifestSchema = z.object({
    schemaVersion: z.literal(1), id: identifier, name: text(100), description: text(500),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/).max(64),
    agents: z.array(pluginAgentSchema).max(32).default([]), skills: z.array(skillSchema).max(64).default([]), themes: z.array(themeSchema).max(16).default([]),
}).strict().superRefine((value, context) => {
    if (!value.agents.length && !value.skills.length && !value.themes.length) context.addIssue({ code: 'custom', message: 'Plugin has no extensions' })
    for (const kind of ['agents', 'skills', 'themes'] as const) {
        if (new Set(value[kind].map(item => item.id)).size !== value[kind].length) context.addIssue({ code: 'custom', path: [kind], message: 'Duplicate extension identifier' })
    }
    const skills = new Set(value.skills.map(skill => skill.id))
    for (const agent of value.agents) if (new Set(agent.skills).size !== agent.skills.length || agent.skills.some(id => !skills.has(id))) {
        context.addIssue({ code: 'custom', path: ['agents'], message: 'Agent skills must refer to unique skills in this manifest' })
    }
    for (const agent of value.agents) if (!agentInstructionsFit(agent, value.skills.filter(skill => agent.skills.includes(skill.id)))) {
        context.addIssue({ code: 'custom', path: ['agents'], message: 'Agent instructions and skills must leave at least 8 KiB for the assignment' })
    }
})
export type PluginManifest = z.infer<typeof pluginManifestSchema>

export function parsePluginManifest(source: string): PluginManifest {
    if (Buffer.byteLength(source) > PLUGIN_MAX_BYTES) throw new EvolvedError('plugin_manifest_invalid', 'Plugin manifest exceeds 512 KiB.')
    let value: unknown
    try { value = JSON.parse(source) } catch { throw new EvolvedError('plugin_manifest_invalid', 'Plugin manifest must be valid JSON.') }
    const parsed = pluginManifestSchema.safeParse(value)
    if (!parsed.success) throw new EvolvedError('plugin_manifest_invalid', 'Plugin manifest is invalid: check supported fields, references, limits and theme contrast.')
    return parsed.data
}
