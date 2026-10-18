import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import {
    defaultDevelopmentSettings,
    DevelopmentContextSchema,
    DevelopmentSettingsSchema,
    OdooMajorSchema, OdooShEnvironmentIdSchema,
    RepoSubdirectorySchema,
    SpecializedDevelopmentModeSchema,
    type DevelopmentSettings,
    type SpecializedDevelopmentMode,
} from '@hapi/protocol/evolvedDevelopment'
import {
    DEVELOPMENT_MODULE_CONTRACT_VERSION,
    developmentModuleApplies,
    developmentModuleDefaults,
    DevelopmentModuleContextSchema,
    moduleSettingsToDevelopmentSettings,
    parseDevelopmentModuleId,
    type DevelopmentModuleContext,
    type DevelopmentModuleDefinition,
} from '@hapi/protocol/developmentModules'
import type { EvolvedClient } from '../client'
import { runDevelopmentDoctor, runToolchainDoctor } from './doctor'
import { inspectRepository } from './inspect'
import { inventoryRepository } from './inventory'
import { odooToolchain } from './layout'
import { boundModule, developmentAction, developmentContext, developmentKnowledge, isRouteUnavailable } from './moduleAdapter'
import { loadLocalModule, pluginModuleDigest } from './pluginValidate'
import { runnerDevelopmentProvider } from './providers'

export const DEVELOPMENT_USAGE = `hapi evolved development context
hapi evolved development knowledge [--topic <id> | <search words>] [--limit <1-20>]
hapi evolved development build-status [<branch-or-sha>] [--environment staging|production]   (at least one; nothing is inferred)
hapi evolved development doctor [--local [--mode odoo|ios|android] [--odoo-major 19|20] [--project-root <dir>] [--checkout <dir>]]
hapi evolved development inspect [--local --checkout <dir> [--mode odoo|ios|android] [--odoo-major 19|20] [--addons <path,...>]]
hapi evolved development doctor --local --definition <plugin-dir-or-manifest> [--module <id>] [--project-root <dir>] [--checkout <dir>]
hapi evolved development inspect --local --definition <plugin-dir-or-manifest> [--module <id>] --checkout <dir> [--subdirectory <path>]

context, knowledge, doctor and inspect use the project's active development module (bundled builtin:odoo|ios|android
or an installed plugin module), bound to the module id and digest the Hub reports. Only state=ready has content.
Without --local, doctor/inspect ask the Hub, which runs the fixed checks on this project's runner with the saved settings.
With --local, the same read-only checks run in this process: without --mode/--definition the active module is read from
the Hub; --mode runs a bundled module offline; --definition runs a local plugin module definition offline (doctor:
its hapi.toolchain checks; inspect: hapi.repository-inventory in --checkout, directory from --subdirectory or the
field default). Validate a plugin manifest with hapi evolved plugin validate.
Results are data; nothing here installs, builds, deletes or changes configuration.`

type Flags = Record<string, string | true>

function parseFlags(args: string[], allowed: readonly string[]): { flags: Flags; rest: string[] } {
    const flags: Flags = {}, rest: string[] = []
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (!arg.startsWith('--')) { rest.push(arg); continue }
        const name = arg.slice(2)
        if (!allowed.includes(name) || Object.hasOwn(flags, name)) throw new Error(`Unknown or repeated option ${arg.slice(0, 40)}. Run hapi evolved development --help`)
        if (name === 'local') { flags.local = true; continue }
        const value = args[++index]
        if (value === undefined || value.startsWith('--')) throw new Error(`Option ${arg} needs a value`)
        flags[name] = value
    }
    return { flags, rest }
}

function directory(value: string | true | undefined, fallback: string | undefined): string | null {
    const raw = typeof value === 'string' ? value : fallback
    if (!raw) return null
    try { return realpathSync(resolve(raw)) } catch { return resolve(raw) }
}

/** Applies explicit --odoo-major/--addons to the given (local default or Hub) settings and revalidates. */
function applyOverrides(mode: SpecializedDevelopmentMode, base: DevelopmentSettings, flags: Flags): DevelopmentSettings {
    const settings = structuredClone(base)
    if (flags['odoo-major'] === undefined && flags.addons === undefined) return settings
    if (mode !== 'odoo' || !settings.odoo) throw new Error('--odoo-major and --addons apply only to the odoo mode')
    if (typeof flags['odoo-major'] === 'string') settings.odoo.major = OdooMajorSchema.parse(Number(flags['odoo-major']))
    if (typeof flags.addons === 'string') settings.odoo.addonsPaths = flags.addons.split(',').slice(0, 16).map(path => RepoSubdirectorySchema.parse(path))
    return DevelopmentSettingsSchema.parse(settings)
}

function localSettings(flags: Flags): { mode: SpecializedDevelopmentMode; settings: DevelopmentSettings } {
    const mode = SpecializedDevelopmentModeSchema.parse(flags.mode)
    return { mode, settings: applyOverrides(mode, defaultDevelopmentSettings(mode), flags) }
}

type HubModule =
    | { kind: 'builtin'; mode: SpecializedDevelopmentMode; settings: DevelopmentSettings; checkout: string | null; repositoryId: string | null }
    | { kind: 'plugin'; module: NonNullable<DevelopmentModuleContext['module']>; values: Record<string, unknown>; checkout: string | null; repositoryId: string | null }

/** v1 Hub (no modules routes): builtin modes only. */
async function legacyHubSettings(client: EvolvedClient): Promise<HubModule> {
    const parsed = DevelopmentContextSchema.safeParse(await client.developmentContext())
    if (!parsed.success) throw new Error('The Hub returned an unexpected development context')
    if (parsed.data.mode === 'none') throw new Error('This project has no development mode. Use --mode for a local check.')
    return { kind: 'builtin', mode: parsed.data.mode, settings: parsed.data.settings, checkout: parsed.data.repository.state === 'granted' ? parsed.data.repository.checkoutPath : null, repositoryId: parsed.data.repository.repositoryId }
}

/** Active module from the Hub (contract v2); only a ready module is used, never a fallback to another module. */
async function hubModule(client: EvolvedClient, action: 'doctor' | 'inspect'): Promise<HubModule> {
    let raw: unknown
    try { raw = await client.developmentModulesContext() } catch (error) {
        if (isRouteUnavailable(error)) return legacyHubSettings(client)
        throw error
    }
    const parsed = DevelopmentModuleContextSchema.safeParse(raw)
    if (!parsed.success) throw new Error('The Hub returned an unexpected development module context')
    const context = parsed.data
    if (context.active.state === 'none') throw new Error('This project has no development module. Use --mode or --definition for a local check.')
    const { moduleId } = boundModule(context, action)
    const module = context.module!, origin = parseDevelopmentModuleId(moduleId)
    const checkout = context.repository.state === 'granted' ? context.repository.checkoutPath : null, repositoryId = context.repository.repositoryId
    if (origin?.origin === 'builtin') {
        const settings = moduleSettingsToDevelopmentSettings(context.settings)
        if (!settings) throw new Error('The Hub returned inconsistent builtin module settings')
        return { kind: 'builtin', mode: origin.mode, settings, checkout, repositoryId }
    }
    return { kind: 'plugin', module, values: context.settings.modules[moduleId]?.values ?? {}, checkout, repositoryId }
}

type LocalModule = {
    doctor: DevelopmentModuleDefinition['doctor'] | NonNullable<DevelopmentModuleContext['module']>['doctor']
    inspect: DevelopmentModuleDefinition['inspect']
    values: Record<string, unknown>
    provenance: (provider: { id: string; version: number }) => Record<string, unknown>
}

function subdirectoryFor(module: LocalModule, flags: Flags): string {
    const field = module.inspect?.directoryField
    const value = typeof flags.subdirectory === 'string' ? flags.subdirectory : field && typeof module.values[field] === 'string' ? module.values[field] as string : '.'
    const parsed = RepoSubdirectorySchema.safeParse(value)
    if (!parsed.success) throw new Error('--subdirectory must be "." or a repository-relative path without traversal')
    return parsed.data
}

/** Runs the runner's fixed providers for a plugin module in this process. */
async function runLocalModule(command: 'doctor' | 'inspect', module: LocalModule, flags: Flags, checkout: string | null, projectRoot: string | null, repositoryId: string) {
    if (command === 'doctor') {
        if (!module.doctor) throw new Error('This module defines no doctor checks')
        if (!runnerDevelopmentProvider(module.doctor.provider, 'module_doctor')) throw new Error(`Doctor provider ${module.doctor.provider.id} v${module.doctor.provider.version} is not implemented by this runner`)
        const checks = module.doctor.checks.filter(check => developmentModuleApplies(check.when, module.values)).map(check => check.id)
        return { ...module.provenance(module.doctor.provider), ...await runToolchainDoctor({ projectRoot, checkout, checks }) }
    }
    if (!module.inspect) throw new Error('This module defines no repository inspection')
    if (!runnerDevelopmentProvider(module.inspect.provider, 'module_inspect')) throw new Error(`Inspect provider ${module.inspect.provider.id} v${module.inspect.provider.version} is not implemented by this runner`)
    if (!checkout) throw new Error('inspect --local needs --checkout <dir> (or a cloned bound repository)')
    return { ...module.provenance(module.inspect.provider), ...await inventoryRepository({ checkout, repositoryId, subdirectory: subdirectoryFor(module, flags) }) }
}

export async function runDevelopmentCommand(args: string[], client: () => EvolvedClient): Promise<unknown> {
    const [command, ...rest] = args
    if (command === 'context' && rest.length === 0) return developmentContext(client())
    if (command === 'knowledge') {
        const { flags, rest: words } = parseFlags(rest, ['topic', 'limit'])
        const limit = typeof flags.limit === 'string' ? Number(flags.limit) : undefined
        if (typeof flags.topic === 'string' && words.length) throw new Error('Use either --topic or search words')
        return developmentKnowledge(client(), { topic: typeof flags.topic === 'string' ? flags.topic : undefined, q: words.length ? words.join(' ') : undefined, limit })
    }
    if (command === 'build-status') {
        const { flags, rest: refs } = parseFlags(rest, ['environment'])
        if (refs.length > 1 || flags.environment === true) throw new Error('Usage: hapi evolved development build-status [<branch-or-sha>] [--environment staging|production]')
        const environment = typeof flags.environment === 'string' ? OdooShEnvironmentIdSchema.parse(flags.environment) : undefined
        return client().developmentBuildStatus({ ref: refs[0], environment })
    }
    if (command === 'doctor' || command === 'inspect') {
        const { flags, rest: extra } = parseFlags(rest, ['local', 'mode', 'odoo-major', 'project-root', 'checkout', 'addons', 'definition', 'module', 'subdirectory'])
        if (extra.length) throw new Error('Unexpected argument. Run hapi evolved development --help')
        if (!flags.local) {
            if (Object.keys(flags).length) throw new Error('Options other than --local need --local')
            return developmentAction(client(), command)
        }
        if (flags.definition !== undefined && flags.mode !== undefined) throw new Error('Use either --mode or --definition')
        if (flags.module !== undefined && flags.definition === undefined) throw new Error('--module needs --definition')
        const projectRoot = directory(flags['project-root'], process.env.EVOLVED_RUNNER_ROOT ?? process.cwd())
        if (typeof flags.definition === 'string') {
            if (flags['odoo-major'] !== undefined || flags.addons !== undefined) throw new Error('--odoo-major and --addons apply only to the odoo mode')
            const local = loadLocalModule(flags.definition, typeof flags.module === 'string' ? flags.module : undefined)
            const digest = pluginModuleDigest(local.manifest, local.definition)
            return runLocalModule(command, { doctor: local.definition.doctor, inspect: local.definition.inspect, values: developmentModuleDefaults(local.definition.fields),
                provenance: provider => ({ source: { kind: 'local-definition', file: local.file, pluginId: local.manifest.id, pluginVersion: local.manifest.version, moduleLocalId: local.definition.id, moduleDigest: digest }, provider }) },
            flags, directory(flags.checkout, undefined), projectRoot, 'local')
        }
        const fromHub = flags.mode === undefined ? await hubModule(client(), command) : null
        if (fromHub?.kind === 'plugin') {
            if (flags['odoo-major'] !== undefined || flags.addons !== undefined) throw new Error('--odoo-major and --addons apply only to the odoo mode')
            const { module } = fromHub
            return runLocalModule(command, { doctor: module.doctor, inspect: module.inspect, values: fromHub.values,
                provenance: provider => ({ contractVersion: DEVELOPMENT_MODULE_CONTRACT_VERSION, moduleId: module.id, moduleDigest: module.digest, provider }) },
            flags, directory(flags.checkout, fromHub.checkout ?? undefined), projectRoot, fromHub.repositoryId ?? 'local')
        }
        if (flags.subdirectory !== undefined) throw new Error('--subdirectory applies only to plugin modules')
        const { mode, settings } = fromHub ? { mode: fromHub.mode, settings: applyOverrides(fromHub.mode, fromHub.settings, flags) } : localSettings(flags)
        const checkout = directory(flags.checkout, fromHub?.checkout ?? undefined)
        if (command === 'doctor') {
            return runDevelopmentDoctor({ mode, settings, projectRoot, checkout, checks: [],
                androidSdkEnvironment: { ANDROID_HOME: process.env.ANDROID_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT } })
        }
        if (!checkout) throw new Error('inspect --local needs --checkout <dir> (or a cloned bound repository)')
        const major = settings.odoo?.major
        return inspectRepository({ checkout, repositoryId: fromHub?.repositoryId ?? 'local', mode, settings,
            odooSourceDirectory: mode === 'odoo' && major && projectRoot ? `${projectRoot}/${odooToolchain(major).source}` : null })
    }
    throw new Error('Unknown development command. Run hapi evolved development --help')
}
