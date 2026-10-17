import { expect, test } from 'bun:test'
import { providerModelCatalogSchema } from './providerModels'

test('native catalog boundary retains valid optional context metadata but rejects unsafe fields', () => {
    const catalog = {
        provider: 'codex', status: 'ready', method: 'subscription', source: 'native-cli',
        catalogOrigin: 'native-reported', entitlementVerified: false, upstreamRefresh: 'unknown',
        checkedAt: 1000, expiresAt: 2000,
        models: [{ id: 'gpt-6-astra', label: 'Astra', description: 'Native description', contextWindow: 900_000 }],
    }
    expect(providerModelCatalogSchema.parse(catalog).models[0]).toMatchObject({ contextWindow: 900_000, description: 'Native description' })
    for (const patch of [{ contextWindow: -1 }, { contextWindow: Infinity }, { contextWindow: 1.5 }, { contextWindow: '1000000' }, { description: 'hidden\ncontrol' }, { accountToken: 'synthetic' }]) {
        expect(providerModelCatalogSchema.safeParse({ ...catalog, models: [{ ...catalog.models[0], ...patch }] }).success).toBe(false)
    }
})
