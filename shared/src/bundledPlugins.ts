/**
 * Plugins bundled with HAPI-eVolved (browser-safe constants only).
 *
 * A bundled plugin is an ordinary schemaVersion-2 plugin manifest shipped in the HAPI release instead of fetched
 * from GitHub. It is immutable: it cannot be updated, disabled, uninstalled or replaced through the plugin routes,
 * it is never written to the plugin table and its development modules are activated per project like any plugin
 * module (explicit settings save, digest adoption). Its stable plugin id is a UUIDv5, so stored project
 * configuration keeps the ordinary `plugin:<uuid>:<module>` identity; a HAPI without the bundle reports that
 * module as missing instead of substituting anything.
 */

/** Exact upstream source of the vendored claude-ads assets (see vendor/claude-ads/PROVENANCE.json). */
export const CLAUDE_ADS_UPSTREAM = Object.freeze({
    repository: 'agricidaniel/claude-ads',
    displayRepository: 'AgriciDaniel/claude-ads',
    repositoryId: '1155383451',
    url: 'https://github.com/AgriciDaniel/claude-ads',
    commit: 'fc3908e786c318776df89a3a098333da377364be',
    license: 'MIT',
    skillVersion: '2.1.0',
    coreVersion: '2.0.0',
})

/** uuid5(NAMESPACE_URL, 'https://github.com/AgriciDaniel/claude-ads#hapi-evolved-bundled-plugin'). */
export const CLAUDE_ADS_BUNDLED_PLUGIN_ID = 'd6608d8c-e211-5d30-9735-6712fee7c5e9' as const
export const CLAUDE_ADS_MODULE_LOCAL_ID = 'ads' as const
export const CLAUDE_ADS_MODULE_ID = `plugin:${CLAUDE_ADS_BUNDLED_PLUGIN_ID}:${CLAUDE_ADS_MODULE_LOCAL_ID}` as const

export const BUNDLED_PLUGIN_IDS: readonly string[] = Object.freeze([CLAUDE_ADS_BUNDLED_PLUGIN_ID])
export function isBundledPluginId(id: string | null | undefined): boolean { return !!id && BUNDLED_PLUGIN_IDS.includes(id) }

/** Project-relative report root of the Ads module (below the shared artifacts directory). */
export const CLAUDE_ADS_ARTIFACTS_DIRECTORY = '.hapi/.cache/artifacts/ads' as const
/** Fixed offline helper (HAPI CLI, available in every runner image as `hapi`). */
export const CLAUDE_ADS_COMMAND = 'hapi evolved ads' as const
export const CLAUDE_ADS_PLATFORMS = ['google', 'meta', 'youtube', 'linkedin', 'tiktok', 'microsoft', 'apple', 'amazon', 'reddit', 'pinterest', 'snapchat', 'x'] as const
export type ClaudeAdsPlatform = typeof CLAUDE_ADS_PLATFORMS[number]
