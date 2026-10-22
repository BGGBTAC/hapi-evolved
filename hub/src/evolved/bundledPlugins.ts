import { createHash } from 'node:crypto'
import { CLAUDE_ADS_BUNDLED_PLUGIN_ID, CLAUDE_ADS_UPSTREAM } from '@hapi/protocol/bundledPlugins'
import { CLAUDE_ADS_PLUGIN_MANIFEST_SHA256, CLAUDE_ADS_PLUGIN_MANIFEST_SOURCE } from './bundled/claudeAdsPlugin.generated'
import { parsePluginManifest } from './pluginManifest'
import type { InstalledPlugin } from './plugins'

/**
 * Immutable plugins shipped with this HAPI release (generic registry; see `@hapi/protocol/bundledPlugins`).
 *
 * Each entry is an ordinary schemaVersion-2 manifest parsed with the same schema as GitHub installs. It has a stable
 * UUIDv5 id and pinned provenance (upstream repository, commit, manifest SHA-256), lives only in memory, is always
 * enabled at installation level and is never written to the plugin table. Its modules still need an explicit,
 * per-project activation and digest adoption. A source that fails its digest or schema check is left out, so
 * projects using it report the module as missing (fail closed) instead of falling back to anything else.
 */
export type BundledPluginSource = { id: string; repository: string; repositoryId: string; commitSha: string; source: string; sha256: string }

export const BUNDLED_PLUGIN_SOURCES: readonly BundledPluginSource[] = Object.freeze([{
    id: CLAUDE_ADS_BUNDLED_PLUGIN_ID, repository: CLAUDE_ADS_UPSTREAM.repository, repositoryId: CLAUDE_ADS_UPSTREAM.repositoryId, commitSha: CLAUDE_ADS_UPSTREAM.commit,
    source: CLAUDE_ADS_PLUGIN_MANIFEST_SOURCE, sha256: CLAUDE_ADS_PLUGIN_MANIFEST_SHA256,
}])

export function loadBundledPlugins(sources: readonly BundledPluginSource[] = BUNDLED_PLUGIN_SOURCES): readonly InstalledPlugin[] {
    const plugins: InstalledPlugin[] = []
    for (const entry of sources) {
        const manifestSha256 = createHash('sha256').update(entry.source).digest('hex')
        try {
            if (manifestSha256 !== entry.sha256) throw new Error('digest mismatch')
            const manifest = parsePluginManifest(entry.source)
            if (plugins.some(plugin => plugin.id === entry.id || plugin.repositoryId === entry.repositoryId || plugin.manifest.id === manifest.id)) throw new Error('duplicate bundled plugin')
            plugins.push(Object.freeze({ id: entry.id, repository: entry.repository, repositoryId: entry.repositoryId, commitSha: entry.commitSha, manifestSha256, manifest,
                enabled: true, installedAt: 0, updatedAt: 0, revision: 1, bundled: true as const }))
        } catch (error) {
            console.error(`[evolved] bundled plugin ${entry.id} unavailable: ${(error as Error).message.slice(0, 200)}`)
        }
    }
    return Object.freeze(plugins)
}
