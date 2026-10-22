/**
 * Reproducible importer and generator for the bundled Claude Ads plugin.
 *
 *   bun scripts/claude-ads/vendor.ts import <upstream-checkout>   copy the pinned, allowlisted upstream files
 *   bun scripts/claude-ads/vendor.ts generate                     write the HAPI plugin manifest from vendored files
 *   bun scripts/claude-ads/vendor.ts check                        verify inventory and generated files (CI/tests)
 *
 * Upstream files are treated as untrusted data: nothing from the checkout is executed (the commit is read with
 * `git rev-parse`), symlinks and unexpected file types are refused, and every file is recorded with its SHA-256.
 * Vendored files under vendor/claude-ads/upstream are byte-identical copies; the HAPI adapter lives in
 * vendor/claude-ads/hapi and the generated outputs are labelled as generated.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { CLAUDE_ADS_UPSTREAM } from '../../shared/src/bundledPlugins'
import { validatePluginManifestSource } from '../../shared/src/pluginManifest'
import { buildClaudeAdsManifest } from '../../vendor/claude-ads/hapi/manifest'

const REPO = join(import.meta.dir, '..', '..')
export const VENDOR = join(REPO, 'vendor', 'claude-ads')
export const UPSTREAM = join(VENDOR, 'upstream')
const PROVENANCE = join(VENDOR, 'PROVENANCE.json')
const MANIFEST_JSON = join(VENDOR, 'hapi-evolved.plugin.json')
const MANIFEST_TS = join(REPO, 'hub', 'src', 'evolved', 'bundled', 'claudeAdsPlugin.generated.ts')
const ASSETS_TS = join(REPO, 'cli', 'src', 'evolved', 'ads', 'assets.generated.ts')
/** HAPI adapter files the CLI materializes next to the upstream skills (pinned by digest like upstream files). */
export const ADAPTER_FILES = ['hapi/hapi-ads/SKILL.md'] as const
const MAX_FILE_BYTES = 512 * 1024

/** Allowlist relative to the upstream root. Directory rules copy matching regular files of exactly that directory. */
const FILE_RULES: ReadonlyArray<{ dir: string; pattern: RegExp; recurse?: false } | { file: string }> = [
    { file: 'LICENSE' }, { file: 'THIRD_PARTY_NOTICES.md' }, { file: 'README.md' }, { file: 'pyproject.toml' },
    { file: 'ads/SKILL.md' }, { dir: 'ads/references', pattern: /\.md$/ }, { dir: 'ads/agents', pattern: /\.yaml$/ },
    { dir: 'agents', pattern: /\.md$/ },
    { dir: 'claude_ads_core', pattern: /\.py$/ }, { dir: 'claude_ads_core/adapters', pattern: /\.py$/ }, { dir: 'claude_ads_core/schemas/v1', pattern: /\.json$/ },
    { file: 'control-plane/runtime-resources.txt' },
    // Public sanitized samples used by the HAPI fixture tests (generic and native export shapes, one report bundle).
    { dir: 'tests/fixtures/exports', pattern: /\.csv$/ }, { dir: 'tests/fixtures/native_exports', pattern: /\.csv$/ },
    { file: 'tests/fixtures/reports/sanitized-report-bundle.json' },
]

export type ProvenanceFile = { path: string; sha256: string; bytes: number }
export type Provenance = {
    schemaVersion: 1
    upstream: typeof CLAUDE_ADS_UPSTREAM
    importedBy: string
    excluded: string[]
    files: ProvenanceFile[]
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const posix = (path: string) => path.split(sep).join('/')
const SAFE_REL = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/

function regularFile(root: string, rel: string): void {
    if (!SAFE_REL.test(rel) || rel.split('/').some(part => part === '..')) throw new Error(`Unsafe upstream path: ${rel}`)
    let current = root
    for (const part of rel.split('/')) {
        current = join(current, part)
        const stat = lstatSync(current)
        if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${rel}`)
    }
    const stat = lstatSync(current)
    if (!stat.isFile()) throw new Error(`Not a regular file: ${rel}`)
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Upstream file too large (${stat.size} bytes): ${rel}`)
}

/** Allowlisted relative paths of an upstream tree (sorted). Runtime resources come from upstream's explicit list. */
export function upstreamFiles(root: string): string[] {
    const files = new Set<string>()
    const add = (rel: string) => { regularFile(root, rel); files.add(rel) }
    for (const rule of FILE_RULES) {
        if ('file' in rule) { add(rule.file); continue }
        const dir = join(root, rule.dir)
        if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(`Missing or symlinked directory: ${rule.dir}`)
        for (const name of readdirSync(dir)) if (rule.pattern.test(name) && lstatSync(join(dir, name)).isFile()) add(`${rule.dir}/${name}`)
    }
    for (const entry of readdirSync(join(root, 'skills')).sort()) {
        const base = `skills/${entry}`
        if (!/^ads-[a-z0-9-]+$/.test(entry)) throw new Error(`Unexpected skill directory: ${entry}`)
        add(`${base}/SKILL.md`)
        const assets = join(root, base, 'assets')
        if (existsSync(assets)) {
            if (lstatSync(assets).isSymbolicLink()) throw new Error(`Symlinked assets: ${base}`)
            for (const name of readdirSync(assets)) if (name.endsWith('.md')) add(`${base}/assets/${name}`)
        }
    }
    for (const line of readFileSync(join(root, 'control-plane/runtime-resources.txt'), 'utf8').split('\n')) {
        const rel = line.trim()
        if (!rel || rel.startsWith('#')) continue
        if (!rel.startsWith('control-plane/')) throw new Error(`Runtime resource outside control-plane: ${rel}`)
        add(rel)
    }
    return [...files].sort()
}

function gitHead(checkout: string): string {
    const result = spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' } })
    if (result.status !== 0) throw new Error('Cannot read the upstream commit')
    return result.stdout.trim()
}

export function readProvenance(): Provenance { return JSON.parse(readFileSync(PROVENANCE, 'utf8')) as Provenance }

function importUpstream(checkout: string) {
    const head = gitHead(checkout)
    if (head !== CLAUDE_ADS_UPSTREAM.commit) throw new Error(`Upstream checkout is at ${head}, expected pinned ${CLAUDE_ADS_UPSTREAM.commit}`)
    const dirty = spawnSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' } })
    if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('Upstream checkout has modified tracked files')
    const files = upstreamFiles(checkout)
    if (existsSync(UPSTREAM) && readdirSync(UPSTREAM).length) throw new Error(`${posix(relative(REPO, UPSTREAM))} already exists; remove it deliberately before re-importing`)
    const inventory: ProvenanceFile[] = []
    for (const rel of files) {
        const from = join(checkout, rel), to = join(UPSTREAM, rel)
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
        const data = readFileSync(to)
        if (sha256(data) !== sha256(readFileSync(from))) throw new Error(`Copy mismatch: ${rel}`)
        inventory.push({ path: rel, sha256: sha256(data), bytes: data.byteLength })
    }
    const provenance: Provenance = {
        schemaVersion: 1, upstream: CLAUDE_ADS_UPSTREAM, importedBy: 'scripts/claude-ads/vendor.ts import',
        excluded: ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'scripts/ (network fetch, screenshot, image and release helpers)', 'mods/ (optional Cockpit companion)',
            'evals/', 'docs/', 'tests/ except the listed public fixtures', 'control-plane files outside runtime-resources.txt (reviews, evidence, migrations, dependency evidence)', 'assets/', '.git history'],
        files: inventory,
    }
    writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`)
    console.log(`Imported ${inventory.length} files from ${head}`)
}

/** Verifies every vendored file against PROVENANCE.json and that no unlisted file exists. Returns issues. */
export function verifyVendored(root = UPSTREAM, provenance = readProvenance()): string[] {
    const issues: string[] = []
    if (provenance.upstream.commit !== CLAUDE_ADS_UPSTREAM.commit) issues.push('PROVENANCE commit differs from the pinned commit')
    const listed = new Set(provenance.files.map(file => file.path))
    for (const file of provenance.files) {
        try {
            regularFile(root, file.path)
            const data = readFileSync(join(root, file.path))
            if (data.byteLength !== file.bytes || sha256(data) !== file.sha256) issues.push(`Changed: ${file.path}`)
        } catch (error) { issues.push(`${file.path}: ${(error as Error).message}`) }
    }
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name), rel = posix(relative(root, path)), stat = lstatSync(path)
            if (stat.isDirectory()) walk(path)
            else if (!listed.has(rel)) issues.push(`Unlisted file: ${rel}`)
        }
    }
    if (existsSync(root)) walk(root)
    return issues
}

export function generatedOutputs(): { json: string; ts: string; assets: string } {
    const json = `${JSON.stringify(buildClaudeAdsManifest(UPSTREAM, readProvenance()), null, 2)}\n`
    const validated = validatePluginManifestSource(json)
    if (!validated.ok) throw new Error(`Generated manifest is invalid:\n${validated.issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')}`)
    const ts = `// GENERATED by scripts/claude-ads/vendor.ts generate — do not edit.\n`
        + `// HAPI-eVolved plugin manifest (schemaVersion 2) built from the unchanged vendored claude-ads files; see vendor/claude-ads/README.md.\n`
        + `export const CLAUDE_ADS_PLUGIN_MANIFEST_SOURCE: string = ${JSON.stringify(json)}\n`
        + `export const CLAUDE_ADS_PLUGIN_MANIFEST_SHA256 = '${sha256(json)}' as const\n`
    const adapter = Object.fromEntries(ADAPTER_FILES.map(path => [path, sha256(readFileSync(join(VENDOR, path)))]))
    const assets = `// GENERATED by scripts/claude-ads/vendor.ts generate — do not edit.\n`
        + `/** SHA-256 of vendor/claude-ads/PROVENANCE.json (which pins every upstream file) and of the HAPI adapter files. */\n`
        + `export const CLAUDE_ADS_PROVENANCE_SHA256 = '${sha256(readFileSync(PROVENANCE))}' as const\n`
        + `export const CLAUDE_ADS_ADAPTER_SHA256: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(adapter)})\n`
    return { json, ts, assets }
}

function generate() {
    const issues = verifyVendored()
    if (issues.length) throw new Error(`Vendored files do not match PROVENANCE.json:\n${issues.join('\n')}`)
    const { json, ts, assets } = generatedOutputs()
    mkdirSync(dirname(MANIFEST_TS), { recursive: true })
    writeFileSync(MANIFEST_JSON, json)
    writeFileSync(MANIFEST_TS, ts)
    writeFileSync(ASSETS_TS, assets)
    console.log(`Generated manifest (${Buffer.byteLength(json)} bytes, sha256 ${sha256(json)})`)
}

export function checkAll(): string[] {
    const issues = verifyVendored()
    if (issues.length) return issues
    const { json, ts, assets } = generatedOutputs()
    if (!existsSync(ASSETS_TS) || readFileSync(ASSETS_TS, 'utf8') !== assets) issues.push('cli/src/evolved/ads/assets.generated.ts is stale; run generate')
    if (!existsSync(MANIFEST_JSON) || readFileSync(MANIFEST_JSON, 'utf8') !== json) issues.push('vendor/claude-ads/hapi-evolved.plugin.json is stale; run generate')
    if (!existsSync(MANIFEST_TS) || readFileSync(MANIFEST_TS, 'utf8') !== ts) issues.push('hub/src/evolved/bundled/claudeAdsPlugin.generated.ts is stale; run generate')
    return issues
}

if (import.meta.main) {
    const [command, argument] = process.argv.slice(2)
    try {
        if (command === 'import' && argument) importUpstream(argument)
        else if (command === 'generate' && !argument) generate()
        else if (command === 'check' && !argument) {
            const issues = checkAll()
            if (issues.length) { console.error(issues.join('\n')); process.exit(1) }
            console.log('Vendored claude-ads files and generated manifest are consistent.')
        } else { console.error('Usage: bun scripts/claude-ads/vendor.ts import <checkout> | generate | check'); process.exit(2) }
    } catch (error) { console.error((error as Error).message); process.exit(1) }
}
