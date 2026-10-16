import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

function command(args: string[]): string {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'inherit' })
    if (result.exitCode !== 0) throw new Error(`Source packaging failed: ${args[0]}`)
    return result.stdout.toString().trim()
}

const output = process.env.SOURCE_BUNDLE_DIR
if (!output || !isAbsolute(output)) throw new Error('SOURCE_BUNDLE_DIR must be an absolute, new output directory')
// Refuse to mix artifacts from another invocation into this bundle.
mkdirSync(output, { recursive: false })
const commit = command(['git', 'rev-parse', '--verify', 'HEAD'])
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a full source commit')
const pkg = JSON.parse(command(['git', 'show', `${commit}:package.json`]))
if (pkg.version !== '0.1.0' || pkg.packageManager !== 'bun@1.3.14') {
    throw new Error('Review the preview workflow before changing its version or toolchain')
}
const stem = `hapi-evolved-${pkg.version}-preview-${commit.slice(0, 12)}`
const archive = `${stem}.tar`
command(['git', 'archive', '--format=tar', `--prefix=${stem}/`, `--output=${join(output, archive)}`, commit])
command(['gzip', '-n', join(output, archive)])
const manifest = {
    name: 'HAPI-eVolved',
    version: pkg.version,
    status: 'preview',
    commit,
    sourceOnly: true,
    archive: `${archive}.gz`,
    toolchain: pkg.packageManager,
    // This identifies the workflow and its required preceding steps. It does
    // not claim that standalone invocation ran tests or validated a deployment.
    validation: {
        workflow: '.github/workflows/evolved-preview.yml',
        precedingSteps: ['publication-policy', 'bun install --frozen-lockfile', 'bun typecheck', 'bun run build:web', 'node web/scripts/check-pwa-assets.mjs'],
        runUrl: process.env.GITHUB_ACTIONS === 'true'
            ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
            : null,
    },
}
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const checksums = [`${archive}.gz`, 'manifest.json'].map(name => {
    const digest = createHash('sha256').update(readFileSync(join(output, name))).digest('hex')
    return `${digest}  ${name}\n`
}).join('')
writeFileSync(join(output, 'SHA256SUMS'), checksums)
console.log(`Prepared source-only preview for ${commit}; no release or deployment was created.`)
