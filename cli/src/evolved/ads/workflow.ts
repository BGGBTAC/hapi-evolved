/**
 * Deterministic offline Claude Ads workflow on top of the unchanged vendored core:
 * export → AccountSnapshot (ingest) → validated ReportBundle (prepare) → Markdown/HTML (report) → status.
 *
 * The core only ever sees private copies of the inputs inside a fresh temporary directory; results are written
 * exclusively below `<project>/.hapi/.cache/artifacts/ads/<folder>/<run>/` and never replace existing files.
 * Account health scores come solely from the vendored registry (all profiles are disabled upstream at fc3908e, so
 * bundles are unscored); nothing here computes, repairs or invents a score.
 */
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_ADS_ARTIFACTS_DIRECTORY, CLAUDE_ADS_PLATFORMS, type ClaudeAdsPlatform } from '@hapi/protocol/bundledPlugins'
import { requireAdsAssets, type AdsAssets } from './assets'
import { fail, inputPath, readInput, relativePath, statBelow, writeNew } from './files'
import { bridgeError, requireAdsPython, runBridge, withWorkDirectory, type AdsPython } from './python'

export const ADS_MAX_EXPORT_BYTES = 50 * 1024 * 1024
const MAX_JSON_BYTES = 16 * 1024 * 1024
const RUN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/
const FOLDER = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/
const CONTEXT_KEY = /^[a-z][a-z_]{0,39}$/
const CONTRACT = /^[a-z][a-z-]{2,40}$/
const PRIVACY = ['public', 'internal', 'confidential', 'restricted'] as const
export type AdsPrivacy = typeof PRIVACY[number]
export type AdsReportFormat = 'markdown' | 'html'
const EXTENSION: Record<AdsReportFormat, string> = { markdown: 'md', html: 'html' }

export type AdsRuntime = { projectRoot: string; workspace: string; assets?: AdsAssets; python?: AdsPython; env?: NodeJS.ProcessEnv }
type Ready = { projectRoot: string; workspace: string; assets: AdsAssets; python: AdsPython }
function ready(runtime: AdsRuntime): Ready {
    return { projectRoot: runtime.projectRoot, workspace: runtime.workspace, assets: runtime.assets ?? requireAdsAssets(), python: runtime.python ?? requireAdsPython(runtime.env) }
}

export function adsPlatform(value: string | undefined): ClaudeAdsPlatform {
    if (!value || !(CLAUDE_ADS_PLATFORMS as readonly string[]).includes(value)) return fail(`--platform must be one of ${CLAUDE_ADS_PLATFORMS.join(', ')}`)
    return value as ClaudeAdsPlatform
}
export function adsRunId(value: string | undefined, now = new Date()): string {
    if (value === undefined) {
        const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        return `ads-${stamp}-${randomBytes(2).toString('hex')}`
    }
    if (!RUN_ID.test(value)) fail('--run must match [a-z0-9][a-z0-9-]{2,63}')
    return value
}
export function adsFolder(value: string | undefined): string {
    const folder = value ?? 'runs'
    if (!FOLDER.test(folder)) fail('--folder must be an identifier ([A-Za-z_][A-Za-z0-9_-]{0,39})')
    return folder
}
/** Undefined = take the classification declared in data-lifecycle.json (upstream requires both to match). */
export function adsPrivacy(value: string | undefined): AdsPrivacy | null {
    if (value === undefined) return null
    if (!(PRIVACY as readonly string[]).includes(value)) fail(`--privacy must be one of ${PRIVACY.join(', ')}`)
    return value as AdsPrivacy
}
export function adsContext(entries: readonly string[]): Record<string, string> {
    const context: Record<string, string> = {}
    for (const entry of entries) {
        const index = entry.indexOf('=')
        const key = entry.slice(0, index), value = entry.slice(index + 1)
        if (index <= 0 || !CONTEXT_KEY.test(key) || Object.hasOwn(context, key)) fail('--context needs unique key=value pairs with lowercase keys')
        if (!value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail(`--context ${key} needs a single-line value of at most 200 characters`)
        context[key] = value
    }
    return context
}

/** Run directory relative to the project root. */
export function adsRunDirectory(folder: string, run: string): string { return `${CLAUDE_ADS_ARTIFACTS_DIRECTORY}/${folder}/${run}` }

function core(runtime: Ready, work: string, args: string[]): string {
    const result = runBridge(runtime.python, runtime.assets.upstream, args, work)
    if (result.status !== 0) fail(bridgeError(result))
    return result.stdout
}
function copyIn(work: string, name: string, data: Buffer): string { const path = join(work, name); writeFileSync(path, data, { mode: 0o600, flag: 'wx' }); return path }
function jsonOutput(stdout: string): unknown {
    try { return JSON.parse(stdout) } catch { return fail('Claude Ads core returned invalid JSON') }
}
function readRunFile(projectRoot: string, folder: string, run: string, name: string, maxBytes = MAX_JSON_BYTES): Buffer {
    return readInput(projectRoot, `${adsRunDirectory(folder, run)}/${name}`, maxBytes)
}
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

export type IngestOptions = { platform: ClaudeAdsPlatform; input: string; format: 'generic' | 'native'; context: Record<string, string>; run: string; folder: string }
export function adsIngest(runtime: AdsRuntime, options: IngestOptions) {
    const live = ready(runtime)
    if (options.format === 'generic' && Object.keys(options.context).length) fail('--context applies only to --format native')
    const source = inputPath(live.projectRoot, live.workspace, options.input, '--input')
    const data = readInput(source.base, source.rel, ADS_MAX_EXPORT_BYTES)
    const directory = adsRunDirectory(options.folder, options.run)
    if ((statBelow(live.projectRoot, `${directory}/snapshot.json`).kind !== 'missing')) fail(`Run ${options.run} already has a snapshot; choose a new --run`)
    const snapshot = withWorkDirectory(work => jsonOutput(core(live, work, ['ingest', options.platform, options.format, JSON.stringify(options.context), copyIn(work, 'export.csv', data)])))
    const record = { schemaVersion: 1, platform: options.platform, format: options.format, contextKeys: Object.keys(options.context).sort(), sourceSha256: sha256(data), sourceBytes: data.byteLength, createdAt: isoSeconds(new Date()) }
    writeNew(live.projectRoot, `${directory}/snapshot.json`, `${JSON.stringify(snapshot, null, 2)}\n`)
    writeNew(live.projectRoot, `${directory}/ingest.json`, `${JSON.stringify(record, null, 2)}\n`)
    const summary = snapshot as { account?: { platform?: string; account_id?: string }; window?: unknown; currency?: string; spend?: number; campaigns?: unknown[] }
    return { status: 'normalized', run: options.run, directory, snapshot: `${directory}/snapshot.json`, platform: summary.account?.platform, accountId: summary.account?.account_id,
        window: summary.window, currency: summary.currency, spend: summary.spend, campaigns: summary.campaigns?.length ?? 0, format: options.format, sourceSha256: record.sourceSha256 }
}

export type PrepareOptions = { run: string; folder: string; snapshot?: string; lifecycle: string; findings?: string; privacy: AdsPrivacy | null; scopes: string[]; complete: boolean }
export function adsPrepare(runtime: AdsRuntime, options: PrepareOptions) {
    const live = ready(runtime), directory = adsRunDirectory(options.folder, options.run)
    if ((statBelow(live.projectRoot, `${directory}/report-bundle.json`).kind !== 'missing')) fail(`Run ${options.run} already has a report bundle`)
    const read = (value: string, label: string) => { const path = inputPath(live.projectRoot, live.workspace, value, label); return readInput(path.base, path.rel, MAX_JSON_BYTES) }
    const snapshot = options.snapshot ? read(options.snapshot, '--snapshot') : readRunFile(live.projectRoot, options.folder, options.run, 'snapshot.json')
    const lifecycle = read(options.lifecycle, '--lifecycle')
    const findings = options.findings ? read(options.findings, '--findings') : null
    let ingest: { sourceSha256?: string; createdAt?: string; platform?: string } = {}
    if (!options.snapshot && (statBelow(live.projectRoot, `${directory}/ingest.json`).kind !== 'missing')) {
        try { ingest = JSON.parse(readRunFile(live.projectRoot, options.folder, options.run, 'ingest.json').toString('utf8')) } catch { fail('ingest.json of this run is unreadable') }
    }
    const scopes = [...new Set(options.scopes)]
    for (const scope of scopes) if (!/^[a-z][a-z0-9-]{1,39}$/.test(scope)) fail('--scope values are lowercase identifiers')
    const meta = {
        run_id: options.run, started_at: typeof ingest.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ingest.createdAt) ? ingest.createdAt : isoSeconds(new Date()),
        scopes: scopes.length ? scopes : ['export-review'], privacy_class: options.privacy, completeness: options.complete ? 'complete' : 'partial',
        // Lineage without local paths: digest of the normalized export (or of the supplied snapshot).
        sources: [ingest.sourceSha256 && /^[a-f0-9]{64}$/.test(ingest.sourceSha256) ? `export-sha256:${ingest.sourceSha256}` : `snapshot-sha256:${sha256(snapshot)}`],
    }
    const bundle = withWorkDirectory(work => jsonOutput(core(live, work, ['prepare', copyIn(work, 'snapshot.json', snapshot), findings ? copyIn(work, 'findings.json', findings) : '-',
        copyIn(work, 'lifecycle.json', lifecycle), copyIn(work, 'meta.json', Buffer.from(JSON.stringify(meta)))])))
    writeNew(live.projectRoot, `${directory}/report-bundle.json`, `${JSON.stringify(bundle, null, 2)}\n`)
    const scoring = (bundle as { scoring?: { health_score?: number | null; status?: string; evidence_coverage?: number } }).scoring
    return { status: 'prepared', run: options.run, bundle: `${directory}/report-bundle.json`, completeness: meta.completeness, findings: Array.isArray((bundle as { findings?: unknown }).findings) ? (bundle as { findings: unknown[] }).findings.length : 0,
        scoring: { healthScore: scoring?.health_score ?? null, status: scoring?.status, evidenceCoverage: scoring?.evidence_coverage } }
}

export function adsReport(runtime: AdsRuntime, options: { run: string; folder: string; format: string }) {
    if (options.format === 'pdf') fail('PDF reports are unavailable in HAPI: the optional WeasyPrint dependency is not provided and nothing is installed. Use --format markdown or html.')
    if (options.format !== 'markdown' && options.format !== 'html') fail('--format must be markdown or html')
    const format = options.format as AdsReportFormat, live = ready(runtime), directory = adsRunDirectory(options.folder, options.run), name = `report.${EXTENSION[format]}`
    if ((statBelow(live.projectRoot, `${directory}/${name}`).kind !== 'missing')) fail(`Refusing to overwrite existing file: ${directory}/${name}`)
    const bundle = readRunFile(live.projectRoot, options.folder, options.run, 'report-bundle.json')
    const rendered = withWorkDirectory(work => {
        const output = join(work, 'out')
        const result = jsonOutput(core(live, work, ['cli', 'render', copyIn(work, 'bundle.json', bundle), '--format', format, '--root', output, '--policy-root', live.assets.upstream, '--output', name])) as { status?: string }
        if (result.status !== 'rendered') fail('Claude Ads core did not confirm the rendering')
        return readInput(output, name, MAX_JSON_BYTES)
    })
    writeNew(live.projectRoot, `${directory}/${name}`, rendered)
    return { status: 'rendered', run: options.run, format, path: `${directory}/${name}`, bytes: rendered.byteLength }
}

export function adsStatus(runtime: AdsRuntime, options: { run: string; folder: string }) {
    const live = ready(runtime), bundle = readRunFile(live.projectRoot, options.folder, options.run, 'report-bundle.json')
    return withWorkDirectory(work => jsonOutput(core(live, work, ['cli', 'status', copyIn(work, 'bundle.json', bundle), '--policy-root', live.assets.upstream])))
}

export function adsValidate(runtime: AdsRuntime, options: { contract: string; file: string }) {
    if (!CONTRACT.test(options.contract)) fail('--contract must be a contract name such as audit-worker-result, finding, mutation-plan')
    const live = ready(runtime), source = inputPath(live.projectRoot, live.workspace, options.file, '--file')
    const data = readInput(source.base, source.rel, MAX_JSON_BYTES)
    const result = withWorkDirectory(work => jsonOutput(core(live, work, ['cli', 'validate', options.contract, copyIn(work, 'artifact.json', data)]))) as Record<string, unknown>
    return { ...result, path: options.file }
}

export function adsCapabilities(runtime: AdsRuntime) {
    const live = ready(runtime)
    return withWorkDirectory(work => jsonOutput(core(live, work, ['capabilities'])))
}

export function adsProductStatus(runtime: AdsRuntime, asOf: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) fail('--as-of must be YYYY-MM-DD')
    const live = ready(runtime)
    return withWorkDirectory(work => jsonOutput(core(live, work, ['cli', 'status', '--as-of', asOf, '--policy-root', live.assets.upstream])))
}

/** Settings of the Ads module as saved in the project (contract-v2 field values), validated again here. */
export type AdsModuleValues = {
    primaryPlatform: ClaudeAdsPlatform; evidencePaths: string[]; evidenceBase: 'project_root' | 'checkout'; exportFormat: 'generic' | 'native'
    currency: string | null; lifecyclePath: string | null; privacyClass: AdsPrivacy | null; reportFolder: string; reportFormats: AdsReportFormat[]
}
export function adsModuleValues(values: Readonly<Record<string, unknown>>): AdsModuleValues {
    const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : null
    const list = (key: string) => Array.isArray(values[key]) ? (values[key] as unknown[]).filter((item): item is string => typeof item === 'string') : []
    const platform = text('primaryPlatform')
    if (!platform) fail('Saved settings have no primary platform; choose one in the project development settings')
    const evidencePaths = list('evidencePaths').map(path => relativePath(path, 'evidence path'))
    if (!evidencePaths.length) fail('Saved settings name no export files (Exportdateien)')
    const currency = text('currency')
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) fail('Saved currency must be a three-letter uppercase ISO code')
    const formats = list('reportFormats').filter((item): item is AdsReportFormat => item === 'markdown' || item === 'html')
    return {
        primaryPlatform: adsPlatform(platform!), evidencePaths, evidenceBase: text('evidenceBase') === 'checkout' ? 'checkout' : 'project_root',
        exportFormat: text('exportFormat') === 'native' ? 'native' : 'generic', currency, lifecyclePath: text('lifecyclePath') ? relativePath(text('lifecyclePath')!, 'lifecycle path') : null,
        privacyClass: adsPrivacy(text('privacyClass') ?? undefined), reportFolder: adsFolder(text('reportFolder') ?? undefined), reportFormats: formats.length ? formats : ['markdown'],
    }
}

/** All saved export files: ingest → prepare → render each requested format. Continues after a failed file. */
export function adsRunFromSettings(runtime: AdsRuntime, values: AdsModuleValues, options: { run?: string; context: Record<string, string> }) {
    const live = ready(runtime), base = adsRunId(options.run), results: unknown[] = []
    if (!values.lifecyclePath) fail('Saved settings have no data-lifecycle.json path; the account intake task creates and validates one')
    const context = values.exportFormat === 'native' ? { ...(values.currency ? { currency: values.currency } : {}), ...options.context } : options.context
    values.evidencePaths.forEach((input, index) => {
        const run = values.evidencePaths.length === 1 ? base : `${base}-${index + 1}`
        const steps: Record<string, unknown> = {}
        try {
            steps.ingest = adsIngest(live, { platform: values.primaryPlatform, input, format: values.exportFormat, context, run, folder: values.reportFolder })
            steps.prepare = adsPrepare(live, { run, folder: values.reportFolder, lifecycle: values.lifecyclePath!, privacy: values.privacyClass, scopes: ['export-review'], complete: false })
            steps.reports = values.reportFormats.map(format => adsReport(live, { run, folder: values.reportFolder, format }))
            steps.status = adsStatus(live, { run, folder: values.reportFolder })
            results.push({ input, run, ok: true, ...steps })
        } catch (error) { results.push({ input, run, ok: false, error: (error as Error).message.slice(0, 1000), ...steps }) }
    })
    return { status: results.every(result => (result as { ok: boolean }).ok) ? 'completed' : 'partial', platform: values.primaryPlatform, format: values.exportFormat, runs: results }
}
