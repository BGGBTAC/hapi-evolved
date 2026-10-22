import { CLAUDE_ADS_MODULE_ID } from '@hapi/protocol/bundledPlugins'
import { DevelopmentModuleContextSchema } from '@hapi/protocol/developmentModules'
import type { EvolvedClient } from '../client'
import { requireAdsAssets } from './assets'
import { runAdsDoctor } from './doctor'
import { adsProjectRoot, adsSessionWorkspace, adsWorkspace, fail, inputPath, readInput } from './files'
import { ADS_SKILL_TARGETS, installAdsSkills, planAdsSkills, summarizePlan, type AdsSkillTarget } from './skills'
import {
    adsCapabilities, adsContext, adsFolder, adsIngest, adsModuleValues, adsPlatform, adsPrepare, adsPrivacy, adsProductStatus, adsReport, adsRunFromSettings,
    adsRunId, adsStatus, adsValidate, type AdsRuntime,
} from './workflow'

export const ADS_USAGE = `hapi evolved ads doctor [--workspace <dir>]
hapi evolved ads capabilities
hapi evolved ads skills-status [--target claude|codex|both] [--workspace <dir>]
hapi evolved ads install-skills [--target claude|codex|both] [--workspace <dir>] [--dry-run]
hapi evolved ads ingest --platform <p> --input <file.csv> [--format generic|native] [--context key=value]... [--run <id>] [--folder <name>]
hapi evolved ads validate --contract <name> --file <file.json>
hapi evolved ads prepare --run <id> --lifecycle <data-lifecycle.json> [--findings <findings.json>] [--snapshot <file>] [--privacy <class>] [--scope <id>]... [--complete] [--folder <name>]
hapi evolved ads report --run <id> --format markdown|html [--folder <name>]
hapi evolved ads status --run <id> [--folder <name>]
hapi evolved ads product-status --as-of <YYYY-MM-DD>
hapi evolved ads run --from-settings [--run <id>] [--context key=value]...
hapi evolved ads run --settings <values.json> [--run <id>] [--context key=value]...

Claude Ads (AgriciDaniel/claude-ads fc3908e, bundled with HAPI) offline: the unchanged deterministic core runs on
CPython 3.11/3.12 in isolated mode from the pinned vendor copy; nothing is fetched or installed. Every project option
is --project-root <dir> (default EVOLVED_RUNNER_ROOT). The workspace is --workspace (the project folder or a folder
inside it, e.g. a checkout), else the current directory when it lies inside the project, else the project folder.
Inputs are paths relative to the workspace; .hapi/.cache/artifacts/ads/... paths are project-relative.
Outputs go only to .hapi/.cache/artifacts/ads/<folder>/<run>/ and never replace existing files. No live account
reads or writes exist; health scoring is disabled upstream, so bundles are unscored. PDF is unavailable.
install-skills copies the unchanged skills for Claude (.claude/skills, .claude/agents) and Codex (.agents/skills)
into the workspace: it only creates missing files and adopts byte-identical ones; any differing file is a conflict
that aborts the whole call before any change (exit 3). It never replaces or deletes files or follows symlinks.`

type Flags = { values: Record<string, string>; lists: Record<string, string[]>; switches: Set<string> }
const LIST_FLAGS = new Set(['context', 'scope'])
const SWITCHES = new Set(['dry-run', 'complete', 'from-settings'])

function parse(args: readonly string[], allowed: readonly string[]): Flags {
    const flags: Flags = { values: {}, lists: {}, switches: new Set() }
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (!arg.startsWith('--')) fail(`Unexpected argument ${JSON.stringify(arg.slice(0, 40))}. Run hapi evolved ads --help`)
        const name = arg.slice(2)
        if (!allowed.includes(name)) fail(`Unknown option --${name.slice(0, 40)}. Run hapi evolved ads --help`)
        if (SWITCHES.has(name)) { if (flags.switches.has(name)) fail(`Repeated option --${name}`); flags.switches.add(name); continue }
        const value = args[++index]
        if (value === undefined || value.startsWith('--')) fail(`Option --${name} needs a value`)
        if (LIST_FLAGS.has(name)) (flags.lists[name] ??= []).push(value!)
        else if (Object.hasOwn(flags.values, name)) fail(`Repeated option --${name}`)
        else flags.values[name] = value!
    }
    return flags
}
const COMMON = ['project-root', 'workspace']

function runtime(flags: Flags, env: NodeJS.ProcessEnv, cwd: string): AdsRuntime & { workspaceSource: string } {
    const projectRoot = adsProjectRoot(flags.values['project-root'], env), workspace = adsSessionWorkspace(projectRoot, flags.values.workspace, cwd)
    return { projectRoot, workspace: workspace.path, workspaceSource: workspace.source, env }
}
function required(flags: Flags, name: string): string { return flags.values[name] ?? fail(`--${name} is required`) }
function targets(value: string | undefined): AdsSkillTarget[] {
    if (value === undefined || value === 'both') return [...ADS_SKILL_TARGETS]
    if (!(ADS_SKILL_TARGETS as readonly string[]).includes(value)) fail('--target must be claude, codex or both')
    return [value as AdsSkillTarget]
}

/** Saved module values from the Hub (bound to the active, ready Claude Ads module) plus the granted checkout path. */
async function hubSettings(client: EvolvedClient): Promise<{ values: Record<string, unknown>; checkout: string | null; moduleDigest: string; revision: number }> {
    const parsed = DevelopmentModuleContextSchema.safeParse(await client.developmentModulesContext())
    if (!parsed.success) fail('The Hub returned an unexpected development module context')
    const context = parsed.data!
    if (context.active.moduleId !== CLAUDE_ADS_MODULE_ID) fail('The Claude Ads module is not the active development module of this project')
    if (context.active.state !== 'ready' || !context.module) fail(`The Claude Ads module is not ready in this project (${context.active.state})`)
    return { values: context.settings.modules[CLAUDE_ADS_MODULE_ID]?.values ?? {}, checkout: context.repository.state === 'granted' ? context.repository.checkoutPath : null,
        moduleDigest: context.module!.digest, revision: context.revision }
}

export async function runAdsCommand(args: readonly string[], client: () => EvolvedClient, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<unknown> {
    const [command, ...rest] = args
    switch (command) {
        case 'doctor': {
            const flags = parse(rest, COMMON), live = runtime(flags, env, cwd)
            return { workspace: live.workspace, workspaceSource: live.workspaceSource,
                ...await runAdsDoctor({ projectRoot: live.projectRoot, checkout: live.workspace === live.projectRoot ? null : live.workspace, checks: [], env }) }
        }
        case 'capabilities': { const flags = parse(rest, COMMON); return adsCapabilities(runtime(flags, env, cwd)) }
        case 'skills-status':
        case 'install-skills': {
            const flags = parse(rest, command === 'install-skills' ? [...COMMON, 'target', 'dry-run'] : [...COMMON, 'target']), live = runtime(flags, env, cwd), assets = requireAdsAssets()
            const apply = command === 'install-skills' && !flags.switches.has('dry-run'), chosen = targets(flags.values.target)
            const outcome = apply ? installAdsSkills(assets, live.workspace, chosen) : { applied: false, plans: chosen.map(target => planAdsSkills(assets, live.workspace, target)) }
            if (apply && !outcome.applied) process.exitCode = 3
            return { workspace: live.workspace, workspaceSource: live.workspaceSource, upstreamCommit: assets.commit, applied: outcome.applied,
                results: outcome.plans.map(plan => summarizePlan(plan, outcome.applied)) }
        }
        case 'ingest': {
            const flags = parse(rest, [...COMMON, 'platform', 'input', 'format', 'context', 'run', 'folder'])
            const raw = flags.values.format ?? 'generic'
            if (raw !== 'generic' && raw !== 'native') fail('--format must be generic or native')
            const format = raw as 'generic' | 'native'
            return adsIngest(runtime(flags, env, cwd), { platform: adsPlatform(flags.values.platform), input: required(flags, 'input'), format, context: adsContext(flags.lists.context ?? []),
                run: adsRunId(flags.values.run), folder: adsFolder(flags.values.folder) })
        }
        case 'validate': { const flags = parse(rest, [...COMMON, 'contract', 'file']); return adsValidate(runtime(flags, env, cwd), { contract: required(flags, 'contract'), file: required(flags, 'file') }) }
        case 'prepare': {
            const flags = parse(rest, [...COMMON, 'run', 'folder', 'snapshot', 'lifecycle', 'findings', 'privacy', 'scope', 'complete'])
            return adsPrepare(runtime(flags, env, cwd), { run: adsRunId(required(flags, 'run')), folder: adsFolder(flags.values.folder), snapshot: flags.values.snapshot, lifecycle: required(flags, 'lifecycle'),
                findings: flags.values.findings, privacy: adsPrivacy(flags.values.privacy), scopes: flags.lists.scope ?? [], complete: flags.switches.has('complete') })
        }
        case 'report': { const flags = parse(rest, [...COMMON, 'run', 'folder', 'format']); return adsReport(runtime(flags, env, cwd), { run: adsRunId(required(flags, 'run')), folder: adsFolder(flags.values.folder), format: required(flags, 'format') }) }
        case 'status': { const flags = parse(rest, [...COMMON, 'run', 'folder']); return adsStatus(runtime(flags, env, cwd), { run: adsRunId(required(flags, 'run')), folder: adsFolder(flags.values.folder) }) }
        case 'product-status': { const flags = parse(rest, [...COMMON, 'as-of']); return adsProductStatus(runtime(flags, env, cwd), required(flags, 'as-of')) }
        case 'run': {
            const flags = parse(rest, ['project-root', 'from-settings', 'settings', 'run', 'context'])
            if (flags.switches.has('from-settings') === (flags.values.settings !== undefined)) fail('Use exactly one of --from-settings or --settings <values.json>')
            const projectRoot = adsProjectRoot(flags.values['project-root'], env)
            let values: Record<string, unknown>, checkout: string | null = null, binding: Record<string, unknown> = {}
            if (flags.switches.has('from-settings')) {
                const saved = await hubSettings(client())
                values = saved.values; checkout = saved.checkout; binding = { moduleId: CLAUDE_ADS_MODULE_ID, moduleDigest: saved.moduleDigest, configRevision: saved.revision }
            } else {
                const source = inputPath(projectRoot, projectRoot, flags.values.settings!, '--settings')
                try { values = JSON.parse(readInput(source.base, source.rel, 64 * 1024).toString('utf8')) } catch (error) { return fail(`--settings must be a JSON object of module values (${(error as Error).message.slice(0, 120)})`) }
                if (!values || typeof values !== 'object' || Array.isArray(values)) fail('--settings must be a JSON object of module values')
            }
            const parsed = adsModuleValues(values)
            if (parsed.evidenceBase === 'checkout' && !checkout) fail('Saved settings resolve export files in the project repository checkout, but no granted checkout is available')
            const workspace = parsed.evidenceBase === 'checkout' ? adsWorkspace(projectRoot, checkout!) : projectRoot
            return { ...binding, ...adsRunFromSettings({ projectRoot, workspace, env }, parsed, { run: flags.values.run, context: adsContext(flags.lists.context ?? []) }) }
        }
        default:
            return fail('Unknown ads command. Run hapi evolved ads --help')
    }
}
