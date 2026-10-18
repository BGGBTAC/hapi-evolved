import { pluginManifestSchema, safePluginManifestIssues, PLUGIN_MAX_BYTES, type PluginManifest } from '@hapi/protocol/pluginManifest'
import { EvolvedError } from './store'

// The declarative manifest contract lives in the shared protocol so the CLI can validate locally and the web can render previews.
export {
    PLUGIN_MANIFEST_FILE, PLUGIN_MAX_BYTES, MAX_AGENT_PROMPT_BYTES, agentAssignment, agentDefinitionSchema, agentInstructionsFit, colorContrast,
    modelPreferenceSchema, pluginManifestSchema, themeColorsSchema, type AgentDefinition, type PluginManifest,
} from '@hapi/protocol/pluginManifest'

export function parsePluginManifest(source: string): PluginManifest {
    if (Buffer.byteLength(source) > PLUGIN_MAX_BYTES) throw new EvolvedError('plugin_manifest_invalid', 'Plugin manifest exceeds 512 KiB.')
    let value: unknown
    try { value = JSON.parse(source) } catch { throw new EvolvedError('plugin_manifest_invalid', 'Plugin manifest must be valid JSON.') }
    const parsed = pluginManifestSchema.safeParse(value)
    if (!parsed.success) {
        // Same wire shape ({ error, code }) so existing previews show it; bounded paths and reasons, never raw values or keys.
        const issues = safePluginManifestIssues(parsed.error.issues as never), more = parsed.error.issues.length - issues.length
        const details = issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ')
        throw new EvolvedError('plugin_manifest_invalid', `Plugin manifest is invalid: ${details}${more > 0 ? `; ${more} more issue${more === 1 ? '' : 's'}` : ''}.`)
    }
    return parsed.data
}
