import { z } from 'zod'

const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,99}$/)
const label = z.string().trim().min(1).max(80).refine(value => !/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(value))
export const providerModelCatalogSchema = z.object({
    provider: z.enum(['codex', 'claude']), status: z.enum(['ready', 'unavailable', 'disconnected']),
    method: z.enum(['subscription', 'api-key']).nullable(), source: z.literal('native-cli'),
    catalogOrigin: z.literal('native-reported'), entitlementVerified: z.literal(false), upstreamRefresh: z.literal('unknown'),
    checkedAt: z.number().int().nonnegative().nullable(), expiresAt: z.number().int().nonnegative().nullable(),
    models: z.array(z.object({ id: modelId, label, resolvedModel: modelId.optional(), isDefault: z.boolean().optional(),
        reasoningEfforts: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(8).optional(),
    }).strict()).max(100), message: z.string().max(300).optional(),
}).strict().superRefine((value, context) => {
    if (new Set(value.models.map(model => model.id)).size !== value.models.length) context.addIssue({ code: 'custom', message: 'Duplicate model IDs' })
    if (value.status !== 'ready' && value.models.length) context.addIssue({ code: 'custom', message: 'Unavailable catalog must be empty' })
    if (value.status === 'ready' && (!value.method || value.checkedAt === null || value.expiresAt === null || value.expiresAt <= value.checkedAt || value.expiresAt - value.checkedAt > 300_000)) {
        context.addIssue({ code: 'custom', message: 'Ready catalog requires bounded native authentication freshness' })
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 30_000) context.addIssue({ code: 'custom', message: 'Catalog exceeds IPC reply budget' })
})
export type ProviderModelCatalog = z.infer<typeof providerModelCatalogSchema>
export function unavailableModelCatalog(provider: 'codex' | 'claude'): ProviderModelCatalog & { stale: boolean } {
    return { provider, status: 'unavailable', method: null, source: 'native-cli', catalogOrigin: 'native-reported', entitlementVerified: false,
        upstreamRefresh: 'unknown', checkedAt: null, expiresAt: null, stale: true, models: [], message: 'Noch kein CLI-Katalog vorhanden. Ein Projektadministrator kann ihn abfragen; Anbieter-Standard und manuelle Modellwahl bleiben verfügbar.' }
}
