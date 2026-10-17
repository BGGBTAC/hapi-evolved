import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import {
    defaultDevelopmentSettings,
    DevelopmentContextSchema,
    DevelopmentSettingsSchema,
    OdooMajorSchema,
    RepoSubdirectorySchema,
    SpecializedDevelopmentModeSchema,
    type DevelopmentSettings,
    type SpecializedDevelopmentMode,
} from '@hapi/protocol/evolvedDevelopment'
import type { EvolvedClient } from '../client'
import { runDevelopmentDoctor } from './doctor'
import { inspectRepository } from './inspect'
import { odooToolchain } from './layout'

export const DEVELOPMENT_USAGE = `hapi evolved development context
hapi evolved development knowledge [--topic <id> | <search words>] [--limit <1-20>]
hapi evolved development build-status [<branch-or-sha>]
hapi evolved development doctor [--local [--mode odoo|ios|android] [--odoo-major 19|20] [--project-root <dir>] [--checkout <dir>]]
hapi evolved development inspect [--local --checkout <dir> [--mode odoo|ios|android] [--odoo-major 19|20] [--addons <path,...>]]

Without --local, doctor/inspect ask the Hub, which runs the fixed checks on this project's runner with the saved settings.
With --local, the same read-only checks run in this process. Without --mode, the current settings are read from the Hub.
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

async function hubSettings(client: EvolvedClient): Promise<{ mode: SpecializedDevelopmentMode; settings: DevelopmentSettings; checkout: string | null; repositoryId: string | null }> {
    const parsed = DevelopmentContextSchema.safeParse(await client.developmentContext())
    if (!parsed.success) throw new Error('The Hub returned an unexpected development context')
    if (parsed.data.mode === 'none') throw new Error('This project has no development mode. Use --mode for a local check.')
    return { mode: parsed.data.mode, settings: parsed.data.settings, checkout: parsed.data.repository.state === 'granted' ? parsed.data.repository.checkoutPath : null, repositoryId: parsed.data.repository.repositoryId }
}

export async function runDevelopmentCommand(args: string[], client: () => EvolvedClient): Promise<unknown> {
    const [command, ...rest] = args
    if (command === 'context' && rest.length === 0) return client().developmentContext()
    if (command === 'knowledge') {
        const { flags, rest: words } = parseFlags(rest, ['topic', 'limit'])
        const limit = typeof flags.limit === 'string' ? Number(flags.limit) : undefined
        if (typeof flags.topic === 'string' && words.length) throw new Error('Use either --topic or search words')
        return client().developmentKnowledge({ topic: typeof flags.topic === 'string' ? flags.topic : undefined, q: words.length ? words.join(' ') : undefined, limit })
    }
    if (command === 'build-status' && rest.length <= 1) return client().developmentBuildStatus(rest[0])
    if (command === 'doctor' || command === 'inspect') {
        const { flags, rest: extra } = parseFlags(rest, ['local', 'mode', 'odoo-major', 'project-root', 'checkout', 'addons'])
        if (extra.length) throw new Error('Unexpected argument. Run hapi evolved development --help')
        if (!flags.local) {
            if (Object.keys(flags).length) throw new Error('Options other than --local need --local')
            return client().developmentAction(command)
        }
        const fromHub = flags.mode === undefined ? await hubSettings(client()) : null
        const { mode, settings } = fromHub ? { mode: fromHub.mode, settings: applyOverrides(fromHub.mode, fromHub.settings, flags) } : localSettings(flags)
        const checkout = directory(flags.checkout, fromHub?.checkout ?? undefined)
        const projectRoot = directory(flags['project-root'], process.env.EVOLVED_RUNNER_ROOT ?? process.cwd())
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
