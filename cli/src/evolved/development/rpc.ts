import { DevelopmentRpcRequestSchema, type DevelopmentRpcRepository } from '@hapi/protocol/evolvedDevelopment'
import {
    DEVELOPMENT_MODULE_CONTRACT_VERSION,
    DevelopmentModuleRpcRequestSchema,
    type DevelopmentModuleDoctorResult,
    type DevelopmentModuleInspectResult,
} from '@hapi/protocol/developmentModules'
import { runDevelopmentDoctor, runToolchainDoctor } from './doctor'
import { inspectRepository } from './inspect'
import { inventoryRepository } from './inventory'
import { odooToolchain } from './layout'
import { runnerDevelopmentProvider } from './providers'
import { runAdsDoctor } from '../ads/doctor'

const ROOT = /^\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Same workspace identity rules as the repository RPC; the daemon never runs as root. */
export function developmentRunnerRoot(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
    const root = env.EVOLVED_RUNNER_ROOT
    if (!root || projectId !== env.EVOLVED_PROJECT_ID || env.HAPI_EVOLVED_PROXY !== '1'
        || root !== `/managed-workspaces/${projectId}` && !ROOT.test(root)
        || process.getuid?.() === 0) throw new Error('Development tooling unavailable in this runner')
    return root
}

export function checkedCheckout(root: string, repository: DevelopmentRpcRepository): string {
    if (repository.fullName !== `${repository.owner}/${repository.name}` || repository.cloneUrl !== `https://github.com/${repository.fullName}.git`
        || repository.path !== `${root}/repositories/${repository.fullName}`) throw new Error('Invalid project repository')
    return repository.path
}

/**
 * `evolved-development` RPC: fixed read-only doctor probes and static repository
 * inspection. Nothing from settings is executed; argv and paths are fixed.
 */
export async function developmentRpc(raw: unknown, env: NodeJS.ProcessEnv = process.env) {
    const action = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).action : undefined
    if (action === 'module_doctor' || action === 'module_inspect') return developmentModuleRpc(raw, env)
    const parsed = DevelopmentRpcRequestSchema.safeParse(raw)
    if (!parsed.success) return { error: { code: 'invalid_request', message: 'Ungültige Entwicklungsanfrage.' } }
    const params = parsed.data
    let root: string
    try { root = developmentRunnerRoot(params.projectId, env) }
    catch { return { error: { code: 'unavailable', message: 'Die Entwicklungswerkzeuge sind in diesem Runner nicht verfügbar.' } } }
    let checkout: string | null = null
    try { checkout = params.repository ? checkedCheckout(root, params.repository) : null }
    catch { return { error: { code: 'invalid_repository', message: 'Die Repositorydaten oder der Projektpfad sind ungültig.' } } }
    try {
        if (params.action === 'doctor') {
            return await runDevelopmentDoctor({ mode: params.mode, settings: params.settings, projectRoot: root, checkout, checks: params.checks,
                androidSdkEnvironment: { ANDROID_HOME: env.ANDROID_HOME, ANDROID_SDK_ROOT: env.ANDROID_SDK_ROOT } })
        }
        const major = params.settings.odoo?.major
        return await inspectRepository({ checkout: checkout!, repositoryId: params.repository.id, mode: params.mode, settings: params.settings,
            odooSourceDirectory: params.mode === 'odoo' && major ? `${root}/${odooToolchain(major).source}` : null })
    } catch {
        return { error: { code: 'development_failed', message: 'Die Prüfung konnte nicht abgeschlossen werden.' } }
    }
}

/**
 * Contract-v2 actions for development modules. Only the providers in RUNNER_DEVELOPMENT_PROVIDERS run, with the
 * same project root and checkout validation as v1; no settings, commands or paths besides the validated
 * `repo_path` subdirectory reach the runner. Results echo the exact module id, digest and provider for the Hub.
 */
async function developmentModuleRpc(raw: unknown, env: NodeJS.ProcessEnv) {
    const parsed = DevelopmentModuleRpcRequestSchema.safeParse(raw)
    if (!parsed.success) return { error: { code: 'invalid_request', message: 'Ungültige Entwicklungsanfrage.' } }
    const params = parsed.data
    if (!runnerDevelopmentProvider(params.provider, params.action)) {
        return { error: { code: 'unsupported_provider', message: `Provider ${params.provider.id} v${params.provider.version} wird von diesem Runner nicht unterstützt.` } }
    }
    let root: string
    try { root = developmentRunnerRoot(params.projectId, env) }
    catch { return { error: { code: 'unavailable', message: 'Die Entwicklungswerkzeuge sind in diesem Runner nicht verfügbar.' } } }
    let checkout: string | null = null
    try { checkout = params.repository ? checkedCheckout(root, params.repository) : null }
    catch { return { error: { code: 'invalid_repository', message: 'Die Repositorydaten oder der Projektpfad sind ungültig.' } } }
    const provenance = { contractVersion: DEVELOPMENT_MODULE_CONTRACT_VERSION, moduleId: params.moduleId, moduleDigest: params.moduleDigest, provider: params.provider }
    try {
        if (params.action === 'module_doctor') {
            const report = params.provider.id === 'hapi.claude-ads'
                ? await runAdsDoctor({ projectRoot: root, checkout, checks: params.checks, env })
                : await runToolchainDoctor({ projectRoot: root, checkout, checks: params.checks })
            return { ...provenance, ...report } satisfies DevelopmentModuleDoctorResult
        }
        const report = await inventoryRepository({ checkout: checkout!, repositoryId: params.repository.id, subdirectory: params.subdirectory })
        return { ...provenance, ...report } satisfies DevelopmentModuleInspectResult
    } catch {
        return { error: { code: 'development_failed', message: 'Die Prüfung konnte nicht abgeschlossen werden.' } }
    }
}
