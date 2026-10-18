import { developmentProviderCapability } from '@hapi/protocol/developmentModules'

/**
 * Development-module providers this runner implements on the `evolved-development` RPC. Exact id + version; anything
 * else is answered as unsupported, never substituted by a similar provider. Kept free of probe code so the session
 * bootstrap can advertise the capabilities without loading the doctor.
 */
export const RUNNER_DEVELOPMENT_PROVIDERS = Object.freeze({
    'hapi.toolchain': { version: 1, action: 'module_doctor' },
    'hapi.repository-inventory': { version: 1, action: 'module_inspect' },
} as const)
export type RunnerDevelopmentProviderId = keyof typeof RUNNER_DEVELOPMENT_PROVIDERS

export function runnerDevelopmentProvider(ref: { id: string; version: number }, action: 'module_doctor' | 'module_inspect'): RunnerDevelopmentProviderId | null {
    if (!Object.hasOwn(RUNNER_DEVELOPMENT_PROVIDERS, ref.id)) return null
    const provider = RUNNER_DEVELOPMENT_PROVIDERS[ref.id as RunnerDevelopmentProviderId]
    return provider.version === ref.version && provider.action === action ? ref.id as RunnerDevelopmentProviderId : null
}

/** Machine capabilities advertised in addition to the shared CURRENT_MACHINE_CAPABILITIES. */
export const RUNNER_DEVELOPMENT_PROVIDER_CAPABILITIES: readonly string[] = Object.freeze(
    Object.entries(RUNNER_DEVELOPMENT_PROVIDERS).map(([id, provider]) => developmentProviderCapability(id, provider.version)))
