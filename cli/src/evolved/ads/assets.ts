/**
 * Pinned Claude Ads assets shipped with this HAPI release (vendor/claude-ads). Before anything is executed or
 * copied, the provenance inventory must match its generated digest and every listed upstream file its SHA-256;
 * files that are not listed are not used. Nothing is fetched.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_ADS_UPSTREAM } from '@hapi/protocol/bundledPlugins'
import { CLAUDE_ADS_ADAPTER_SHA256, CLAUDE_ADS_PROVENANCE_SHA256 } from './assets.generated'

export const ADS_VENDOR_ROOT = fileURLToPath(new URL('../../../../vendor/claude-ads', import.meta.url))
export const ADS_BRIDGE = fileURLToPath(new URL('./bridge.py', import.meta.url))
/**
 * Supported delivery: the source CLI under /app (managed runner images run `bun /app/cli/src/index.ts` via
 * /usr/local/bin/hapi and contain /app/vendor/claude-ads and this bridge). A standalone compiled `hapi` executable
 * does not ship these files and reports the Ads assets as unavailable instead of extracting anything.
 */
export const ADS_STANDALONE_EXECUTABLE = import.meta.url.includes('$bunfs') || import.meta.url.includes('/~BUN/')

export type AdsProvenanceFile = { path: string; sha256: string; bytes: number }
export type AdsAssets = { root: string; upstream: string; files: readonly AdsProvenanceFile[]; adapter: Readonly<Record<string, string>>; commit: string }
export type AdsAssetsResult = { ok: true; assets: AdsAssets } | { ok: false; state: 'missing' | 'invalid'; reason: string }

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const verified = new Map<string, AdsAssetsResult>()

function regular(path: string): Buffer {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file')
    return readFileSync(path)
}

/** Verifies the vendored tree once per process (results are cached by root). */
export function verifyAdsAssets(root: string = ADS_VENDOR_ROOT): AdsAssetsResult {
    const cached = verified.get(root)
    if (cached) return cached
    const result = ((): AdsAssetsResult => {
        if (ADS_STANDALONE_EXECUTABLE && root === ADS_VENDOR_ROOT) return { ok: false, state: 'missing', reason: 'This standalone hapi executable does not ship the Claude Ads assets; use the managed runner image or the source CLI (bun cli/src/index.ts).' }
        try { regular(ADS_BRIDGE) } catch { return { ok: false, state: 'missing', reason: 'The HAPI Claude Ads bridge (cli/src/evolved/ads/bridge.py) is not available in this installation' } }
        let raw: Buffer
        try { raw = regular(join(root, 'PROVENANCE.json')) } catch { return { ok: false, state: 'missing', reason: 'vendor/claude-ads/PROVENANCE.json is not available in this installation' } }
        if (sha256(raw) !== CLAUDE_ADS_PROVENANCE_SHA256) return { ok: false, state: 'invalid', reason: 'PROVENANCE.json does not match the digest pinned in this release' }
        let provenance: { upstream?: { commit?: string }; files?: AdsProvenanceFile[] }
        try { provenance = JSON.parse(raw.toString('utf8')) } catch { return { ok: false, state: 'invalid', reason: 'PROVENANCE.json is not valid JSON' } }
        if (provenance.upstream?.commit !== CLAUDE_ADS_UPSTREAM.commit || !Array.isArray(provenance.files)) return { ok: false, state: 'invalid', reason: 'Provenance does not name the pinned upstream commit' }
        const upstream = join(root, 'upstream')
        for (const file of provenance.files) {
            if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(file.path) || file.path.split('/').includes('..')) return { ok: false, state: 'invalid', reason: 'Provenance lists an unsafe path' }
            let data: Buffer
            try {
                let current = upstream
                for (const segment of file.path.split('/')) { current = join(current, segment); if (lstatSync(current).isSymbolicLink()) throw new Error('symlink') }
                data = regular(current)
            } catch { return { ok: false, state: 'invalid', reason: `Vendored file missing or replaced: ${file.path}` } }
            if (data.byteLength !== file.bytes || sha256(data) !== file.sha256) return { ok: false, state: 'invalid', reason: `Vendored file changed: ${file.path}` }
        }
        for (const [path, digest] of Object.entries(CLAUDE_ADS_ADAPTER_SHA256)) {
            try { if (sha256(regular(join(root, path))) !== digest) throw new Error('digest') } catch { return { ok: false, state: 'invalid', reason: `HAPI adapter file missing or changed: ${path}` } }
        }
        return { ok: true, assets: { root, upstream, files: Object.freeze(provenance.files.map(file => Object.freeze({ ...file }))), adapter: CLAUDE_ADS_ADAPTER_SHA256, commit: CLAUDE_ADS_UPSTREAM.commit } }
    })()
    verified.set(root, result)
    return result
}

export function requireAdsAssets(root?: string): AdsAssets {
    const result = verifyAdsAssets(root)
    if (!result.ok) throw new Error(`Claude Ads assets unavailable: ${result.reason}`)
    return result.assets
}
