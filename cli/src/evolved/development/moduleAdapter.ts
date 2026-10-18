import { z } from 'zod'
import { DevelopmentModuleDigestSchema, DevelopmentModuleIdSchema, DevelopmentModuleStateSchema } from '@hapi/protocol/developmentModules'
import { EvolvedRequestError, type EvolvedClient } from '../client'

/**
 * Agent/CLI adapter for project development data. Contract v2 (`/development/modules-*`) serves builtin and plugin
 * modules alike. Only a Hub or runner proxy that does not know the v2 route at all (404/403 without an error code)
 * makes the adapter use the v1 routes, so an older Hub keeps working for builtin modes. Every other error, including
 * `development_client_upgrade_required`, is passed through unchanged.
 */

export function isRouteUnavailable(error: unknown): boolean {
    return error instanceof EvolvedRequestError && (error.status === 404 || error.status === 403) && error.code === undefined
}

async function preferV2<T>(v2: () => Promise<T>, v1: () => Promise<T>): Promise<T> {
    try { return await v2() } catch (error) {
        if (isRouteUnavailable(error)) return v1()
        throw error
    }
}

export function developmentContext(client: EvolvedClient): Promise<unknown> {
    return preferV2(() => client.developmentModulesContext(), () => client.developmentContext())
}

export function developmentKnowledge(client: EvolvedClient, query: { topic?: string; q?: string; limit?: number }): Promise<unknown> {
    return preferV2(() => client.developmentModulesKnowledge(query), () => client.developmentKnowledge(query))
}

/** Fields of the v2 context the adapter relies on; unknown additional fields are ignored. */
export const ModuleContextBindingSchema = z.object({
    contractVersion: z.literal(2),
    active: z.object({ moduleId: DevelopmentModuleIdSchema.nullable(), state: DevelopmentModuleStateSchema, reasons: z.array(z.string()).max(6) }),
    module: z.object({ id: DevelopmentModuleIdSchema, digest: DevelopmentModuleDigestSchema, doctor: z.unknown(), inspect: z.unknown() }).nullable(),
})
export type ModuleContextBinding = z.infer<typeof ModuleContextBindingSchema>

/** Module the caller may act on, or an honest, coded error for none/unavailable/undefined actions. */
export function boundModule(context: ModuleContextBinding, action: 'doctor' | 'inspect'): { moduleId: string; moduleDigest: string } {
    const { active, module } = context
    if (active.state === 'none') throw new EvolvedRequestError('Für dieses Projekt ist kein Entwicklungsmodul aktiv.', 409, 'development_mode_none')
    if (active.state !== 'ready' || !module) {
        throw new EvolvedRequestError(`Das aktive Entwicklungsmodul ${active.moduleId ?? ''} ist nicht bereit (${active.state}). ${active.reasons.join(' ')} Einen Projektadmin informieren; nicht raten.`.replace(/\s+/g, ' ').trim(), 409, 'development_module_unavailable')
    }
    if (module[action] === null || module[action] === undefined) {
        throw new EvolvedRequestError(action === 'doctor' ? 'Dieses Entwicklungsmodul definiert keine Doctor-Prüfungen.' : 'Dieses Entwicklungsmodul definiert keine Repository-Inspektion.', 409, `development_${action}_unavailable`)
    }
    return { moduleId: module.id, moduleDigest: module.digest }
}

/**
 * Doctor/inspect of the active module: reads modules-context, then posts exactly the module id and digest it saw.
 * A change in between is refused by the Hub (`development_module_changed`) instead of running another definition.
 */
export async function developmentAction(client: EvolvedClient, action: 'doctor' | 'inspect'): Promise<unknown> {
    let raw: unknown
    try { raw = await client.developmentModulesContext() } catch (error) {
        if (isRouteUnavailable(error)) return client.developmentAction(action)
        throw error
    }
    const parsed = ModuleContextBindingSchema.safeParse(raw)
    if (!parsed.success) throw new Error('The Hub returned an unexpected development module context')
    return client.developmentModuleAction(action, boundModule(parsed.data, action))
}
