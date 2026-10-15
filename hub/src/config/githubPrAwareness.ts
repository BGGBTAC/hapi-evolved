import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class FeaturePinnedError extends Error {}
export function githubPrFeature(dataDir: string, env = process.env.HAPI_GITHUB_PR_AWARENESS) {
    if (env !== undefined) return { enabled: env === '1', source: 'env' as const }
    const path = join(dataDir, 'features.json')
    if (existsSync(path)) {
        try {
            const value = JSON.parse(readFileSync(path, 'utf8')) as { githubPrAwareness?: unknown }
            if (typeof value.githubPrAwareness === 'boolean') return { enabled: value.githubPrAwareness, source: 'file' as const }
        } catch { /* Invalid settings fail closed. */ }
    }
    return { enabled: false, source: 'default' as const }
}
export function setGithubPrFeature(dataDir: string, enabled: boolean, env = process.env.HAPI_GITHUB_PR_AWARENESS): void {
    if (env !== undefined) throw new FeaturePinnedError('GitHub PR awareness is pinned by HAPI_GITHUB_PR_AWARENESS.')
    const path = join(dataDir, 'features.json'), temporary = `${path}.${randomUUID()}.tmp`
    try {
        writeFileSync(temporary, JSON.stringify({ githubPrAwareness: enabled })+'\n', { mode: 0o600, flag: 'wx' })
        renameSync(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
}
