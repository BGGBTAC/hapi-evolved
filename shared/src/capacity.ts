import { z } from 'zod'

export const CAPACITY_STALE_AFTER_MS = 5 * 60_000
export const CapacityProviderSchema = z.enum(['claude', 'codex'])
export const CapacityStatusSchema = z.enum(['available', 'unknown', 'unsupported'])
export const CapacityReasonSchema = z.enum([
    'not_reported', 'utilization_not_reported', 'native_read_failed',
    'authentication_required', 'subscription_auth_required', 'invalid_report',
]).nullable()
export const CapacityWindowSchema = z.object({
    observedAt: z.number().int().positive().max(8_640_000_000_000_000).optional(),
    id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,96}$/),
    usedPercent: z.number().finite().min(0).max(100).nullable(),
    remainingPercent: z.number().finite().min(0).max(100).nullable(),
    resetsAt: z.number().int().positive().max(8_640_000_000_000_000).nullable(),
    durationMinutes: z.number().finite().positive().max(527_040).nullable(),
    status: z.enum(['allowed', 'warning', 'rejected', 'unknown']),
})
/** Sanitized native telemetry. Never contains account IDs, email, credits or raw provider data. */
export const ProviderCapacitySchema = z.object({
    provider: CapacityProviderSchema,
    source: z.enum(['claude-sdk', 'codex-app-server']),
    scope: z.literal('account'),
    observedAt: z.number().int().positive().max(8_640_000_000_000_000),
    status: CapacityStatusSchema,
    reason: CapacityReasonSchema,
    windows: z.array(CapacityWindowSchema).max(32),
})
export type CapacityWindow = z.infer<typeof CapacityWindowSchema>
export type ProviderCapacity = z.infer<typeof ProviderCapacitySchema>
export type CapacityReport = Omit<ProviderCapacity, 'windows'> & {
    sessionId: string
    stale: boolean
    windows: Array<CapacityWindow & { stale: boolean }>
}
export type ProjectCapacity = {
    projectId: string
    generatedAt: number
    providers: Array<{
        provider: ProviderCapacity['provider']
        status: ProviderCapacity['status']
        reports: CapacityReport[]
    }>
}
