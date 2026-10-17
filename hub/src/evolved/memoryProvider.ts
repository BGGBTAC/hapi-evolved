import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { EvolvedError, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, createEvolvedRequestGuard, parseBody, requireFreshPasskey, requireHuman } from './security'
import type { VaultClient } from './vault'

const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
const price = z.string().max(32).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).refine(value => Number(value) > 0 && Number(value) <= 1_000_000)
export const memoryProviderKeySchema = z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/)
const llmPublicSchema = z.object({
    provider: z.enum(['openai', 'anthropic']), model: modelId,
    inputUsdPerMTok: price, outputUsdPerMTok: price, maxOutputTokens: z.number().int().min(256).max(4096),
}).strict()
const embeddingFields = { model: modelId, inputUsdPerMTok: price }
const openaiEmbeddingSchema = z.object({ ...embeddingFields, provider: z.literal('openai'), dimensions: z.number().int().min(1).max(3072) }).strict()
const voyageEmbeddingSchema = z.object({ ...embeddingFields, provider: z.literal('voyage'), dimensions: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)]) }).strict()
const rrfSchema = z.object({ provider: z.literal('rrf') }).strict()
const openaiRerankerSchema = llmPublicSchema.extend({ provider: z.literal('openai') }).strict()
const voyageRerankerSchema = z.object({ provider: z.literal('voyage'), model: modelId, inputUsdPerMTok: price }).strict()
export const memoryProviderPublicSchema = z.object({
    schemaVersion: z.literal(2), llm: llmPublicSchema,
    embedding: z.discriminatedUnion('provider', [openaiEmbeddingSchema, voyageEmbeddingSchema]),
    reranker: z.discriminatedUnion('provider', [rrfSchema, openaiRerankerSchema, voyageRerankerSchema]),
}).strict()
export const memoryProviderConfigSchema = memoryProviderPublicSchema.extend({
    llm: llmPublicSchema.extend({ apiKey: memoryProviderKeySchema }).strict(),
    embedding: z.discriminatedUnion('provider', [openaiEmbeddingSchema.extend({ apiKey: memoryProviderKeySchema }), voyageEmbeddingSchema.extend({ apiKey: memoryProviderKeySchema })]),
    reranker: z.discriminatedUnion('provider', [rrfSchema, openaiRerankerSchema.extend({ apiKey: memoryProviderKeySchema }), voyageRerankerSchema.extend({ apiKey: memoryProviderKeySchema })]),
}).strict()
export type MemoryProviderConfig = z.infer<typeof memoryProviderConfigSchema>
export type MemoryProviderPublic = z.infer<typeof memoryProviderPublicSchema>
export type MemoryProviderComponent = 'llm' | 'embedding' | 'reranker'
type CloudProvider = 'openai' | 'anthropic' | 'voyage'
export type MemoryProviderRecord = { state: 'unset' | 'configured' | 'disabled'; version: number; config: MemoryProviderPublic | null; embeddingProvider: 'openai' | 'voyage' | null; embeddingModel: string | null; embeddingDimensions: number | null }

/** An explicit public allowlist prevents newly nested credentials leaking through status. */
export function memoryProviderPublic(config: MemoryProviderConfig): MemoryProviderPublic {
    const { llm, embedding, reranker } = config
    return {
        schemaVersion: 2,
        llm: { provider: llm.provider, model: llm.model, inputUsdPerMTok: llm.inputUsdPerMTok, outputUsdPerMTok: llm.outputUsdPerMTok, maxOutputTokens: llm.maxOutputTokens },
        embedding: { provider: embedding.provider, model: embedding.model, dimensions: embedding.dimensions, inputUsdPerMTok: embedding.inputUsdPerMTok } as MemoryProviderPublic['embedding'],
        reranker: reranker.provider === 'rrf' ? { provider: 'rrf' } : reranker.provider === 'voyage'
            ? { provider: 'voyage', model: reranker.model, inputUsdPerMTok: reranker.inputUsdPerMTok }
            : { provider: 'openai', model: reranker.model, inputUsdPerMTok: reranker.inputUsdPerMTok, outputUsdPerMTok: reranker.outputUsdPerMTok, maxOutputTokens: reranker.maxOutputTokens },
    }
}

const legacyConfigSchema = z.object({
    provider: z.literal('openai'), apiKey: memoryProviderKeySchema, model: modelId, embeddingModel: modelId,
    embeddingDimensions: z.literal(1536), inputUsdPerMTok: price, outputUsdPerMTok: price,
    embeddingUsdPerMTok: price, maxOutputTokens: z.number().int().min(256).max(4096),
}).strict()
/** Only encrypted legacy records use this migration. Public writes require v2. */
export function storedMemoryProviderConfig(value: unknown): MemoryProviderConfig {
    const current = memoryProviderConfigSchema.safeParse(value)
    if (current.success) return current.data
    const old = legacyConfigSchema.parse(value)
    return {
        schemaVersion: 2,
        llm: { provider: 'openai', apiKey: old.apiKey, model: old.model, inputUsdPerMTok: old.inputUsdPerMTok, outputUsdPerMTok: old.outputUsdPerMTok, maxOutputTokens: old.maxOutputTokens },
        embedding: { provider: 'openai', apiKey: old.apiKey, model: old.embeddingModel, dimensions: old.embeddingDimensions, inputUsdPerMTok: old.embeddingUsdPerMTok },
        reranker: { provider: 'rrf' },
    }
}
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const optionalKey = z.union([z.literal(''), memoryProviderKeySchema]).optional()
const inputSchema = memoryProviderPublicSchema.extend({
    version, llm: llmPublicSchema.extend({ apiKey: optionalKey }),
    embedding: z.discriminatedUnion('provider', [openaiEmbeddingSchema.extend({ apiKey: optionalKey }), voyageEmbeddingSchema.extend({ apiKey: optionalKey })]),
    reranker: z.discriminatedUnion('provider', [rrfSchema, openaiRerankerSchema.extend({ apiKey: optionalKey }), voyageRerankerSchema.extend({ apiKey: optionalKey })]),
}).strict()
const catalogInputSchema = z.discriminatedUnion('component', [
    z.object({ component: z.literal('llm'), provider: z.enum(['openai', 'anthropic']), apiKey: optionalKey }).strict(),
    z.object({ component: z.literal('embedding'), provider: z.enum(['openai', 'voyage']), apiKey: optionalKey }).strict(),
    z.object({ component: z.literal('reranker'), provider: z.enum(['openai', 'voyage']), apiKey: optionalKey }).strict(),
])

/** OpenAI's catalog mixes model capabilities. Keep provider-discovered embedding IDs,
 * not a frozen list of versions, and never interpret a chat model as an embedder. */
export function memoryModelMatchesComponent(component: MemoryProviderComponent, provider: CloudProvider, model: string): boolean {
    if (provider !== 'openai') return true
    return component === 'embedding' ? model.startsWith('text-embedding-') : !model.startsWith('text-embedding-')
}
export function validateMemoryModelRoles(config: MemoryProviderPublic): void {
    // Known API constraints, not a model availability list. Future provider IDs remain discoverable.
    const embedding = config.embedding
    if (embedding.provider === 'openai' && (embedding.model === 'text-embedding-3-small' && embedding.dimensions > 1536
        || embedding.model === 'text-embedding-ada-002' && embedding.dimensions !== 1536)) {
        throw new EvolvedError('memory_provider_embedding_dimensions', 'text-embedding-3-small supports at most 1536 dimensions; text-embedding-ada-002 requires exactly 1536.', 400)
    }
    for (const component of ['llm', 'embedding', 'reranker'] as const) {
        const slot = config[component]
        if (slot.provider !== 'rrf' && !memoryModelMatchesComponent(component, slot.provider, slot.model)) {
            throw new EvolvedError('memory_provider_model_role', 'Select a text-embedding model for OpenAI embeddings and a language model for text processing.', 400)
        }
    }
}
export type MemoryProviderResolver = (projectId: string) => Promise<MemoryProviderConfig | null | undefined>
export type MemoryProviderOperation = <T>(projectId: string, operation: () => Promise<T>) => Promise<T>

/** Project configuration stays separate from user secrets. Only the internal runtime resolves keys. */
export class MemoryProviderService {
    private readonly readers = new Map<string, number>()
    private readonly writers = new Set<string>()
    constructor(readonly store: EvolvedStore, readonly vault: VaultClient, private url?: string, private token?: string, private fetcher: typeof fetch = fetch) {}
    async record(projectId: string, userId: string): Promise<MemoryProviderRecord> {
        return await this.vault.request({ userId, projectId, operation: 'memoryProvider', payload: { action: 'status' } }) as MemoryProviderRecord
    }
    resolve: MemoryProviderResolver = async projectId => {
        // A deleted project must not fall back to installation-wide credentials.
        if (!this.store.db.query('SELECT 1 FROM evolved_projects WHERE id=? AND deleting_at IS NULL').get(projectId)) return null
        const result = await this.vault.request({ userId: 'system:memory', projectId, operation: 'memoryProvider', payload: { action: 'resolve' } }) as { state: MemoryProviderRecord['state']; config: MemoryProviderConfig | null }
        if (result.state === 'disabled') return null
        if (result.state === 'unset') return undefined
        const parsed = memoryProviderConfigSchema.safeParse(result.config)
        if (!parsed.success) throw new EvolvedError('memory_provider_invalid', 'Memory provider configuration is unavailable.', 503)
        return parsed.data
    }
    using: MemoryProviderOperation = async (projectId, operation) => {
        if (this.writers.has(projectId)) throw new EvolvedError('memory_provider_busy', 'Memory configuration is being changed. Retry shortly.', 409)
        this.readers.set(projectId, (this.readers.get(projectId) ?? 0) + 1)
        try { return await operation() } finally {
            const remaining = this.readers.get(projectId)! - 1
            if (remaining) this.readers.set(projectId, remaining); else this.readers.delete(projectId)
        }
    }
    async changing<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
        if (this.writers.has(projectId) || this.readers.has(projectId)) throw new EvolvedError('memory_provider_busy', 'Memory processing or a configuration change is running. Retry shortly.', 409)
        this.writers.add(projectId)
        try { return await operation() } finally { this.writers.delete(projectId) }
    }
    embeddingLocked(projectId: string, hasBinding = true): boolean {
        // Never-started local work must not block first setup. Existing binding and graph evidence
        // remain conservative even after a ledger item was removed.
        return !!this.store.db.query("SELECT 1 FROM evolved_memory_tasks WHERE project_id=? AND kind='index' AND (?=1 OR reservation_id IS NOT NULL OR state IN ('running','complete')) LIMIT 1").get(projectId, hasBinding ? 1 : 0)
            || !!this.store.db.query("SELECT 1 FROM evolved_memory_items WHERE project_id=? AND index_state='indexed' LIMIT 1").get(projectId)
            || !!this.store.db.query("SELECT 1 FROM evolved_memory_reservations WHERE project_id=? LIMIT 1").get(projectId)
    }
    async request(path: '/configuration/models' | '/configuration/check' | '/configuration/binding', body: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (!this.url || !this.token) throw new EvolvedError('memory_service_unavailable', 'Memory service is not configured.', 503)
        let response: Response
        try {
            response = await this.fetcher(`${this.url}${path}`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
        } catch { throw new EvolvedError('memory_service_unavailable', 'Memory service or provider could not be reached.', 503) }
        if (!response.ok) {
            await response.body?.cancel()
            if (response.status === 401) throw new EvolvedError('memory_provider_auth_failed', 'The API key was not accepted.', 400)
            throw new EvolvedError('memory_provider_check_failed', 'Memory configuration or connection check failed.', response.status === 400 ? 400 : 503)
        }
        const reader = response.body?.getReader(), chunks: Uint8Array[] = []
        let bytes = 0
        try {
            if (!reader) throw new Error()
            while (true) {
                const next = await reader.read()
                if (next.done) break
                bytes += next.value.byteLength
                if (bytes > 1_000_000) throw new Error()
                chunks.push(next.value)
            }
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error()
            return result as Record<string, unknown>
        } catch {
            await reader?.cancel().catch(() => {})
            throw new EvolvedError('memory_provider_invalid_response', 'Invalid memory service response.', 502)
        } finally { reader?.releaseLock() }
    }
    async models(provider: CloudProvider, apiKey: string): Promise<{ models: string[]; verified: boolean }> {
        const result = await this.request('/configuration/models', { provider, apiKey })
        const parsed = z.object({ models: z.array(modelId).max(5000), verified: z.boolean() }).strict().safeParse(result)
        if (!parsed.success || parsed.data.models.some(id => id.includes(apiKey))
            || parsed.data.verified !== (provider !== 'voyage') || provider === 'voyage' && parsed.data.models.length !== 0) {
            throw new EvolvedError('memory_provider_invalid_response', 'Invalid model catalog response.', 502)
        }
        return { models: [...new Set(parsed.data.models)].sort(), verified: parsed.data.verified }
    }
    async verifyModels(config: MemoryProviderConfig, reauthorize: () => Promise<unknown>): Promise<MemoryProviderComponent[]> {
        validateMemoryModelRoles(config)
        const catalogs = new Map<string, { models: string[]; verified: boolean }>()
        const unverified: MemoryProviderComponent[] = []
        for (const component of ['llm', 'embedding', 'reranker'] as const) {
            const slot = config[component]
            if (slot.provider === 'rrf') continue
            const cacheKey = JSON.stringify([slot.provider, slot.apiKey])
            let catalog = catalogs.get(cacheKey)
            if (!catalog) {
                await reauthorize()
                catalog = await this.models(slot.provider, slot.apiKey)
                catalogs.set(cacheKey, catalog)
            }
            if (!catalog.verified) unverified.push(component)
            else if (!catalog.models.includes(slot.model)) throw new EvolvedError('memory_provider_model_unavailable', 'Select models returned for this component API key.', 400)
        }
        return unverified
    }
    /** Shared browser/operator path: credentials never leave this service's execution. */
    async savePublic(projectId: string, userId: string, value: unknown, reauthorize: () => Promise<unknown>): Promise<MemoryProviderRecord> {
        const parsed = inputSchema.safeParse(value)
        if (!parsed.success) throw new EvolvedError('memory_provider_invalid', 'Invalid memory provider configuration.', 400)
        const input = parsed.data
        validateMemoryModelRoles(input)
        return this.changing(projectId, async () => {
            await reauthorize()
            const current = await this.record(projectId, userId)
            if (current.version !== input.version) throw new EvolvedError('memory_provider_conflict', 'Configuration changed. Reload before saving.', 409)
            const existing = await this.resolve(projectId)
            const credentials = (component: MemoryProviderComponent) => {
                const slot = input[component], prior = existing?.[component]
                if (slot.provider === 'rrf') return { provider: 'rrf' }
                const apiKey = slot.apiKey || (prior?.provider === slot.provider ? prior.apiKey : undefined)
                if (!apiKey) throw new EvolvedError('memory_provider_key_required', 'An API key is required for each new provider component.', 400)
                return { ...slot, apiKey }
            }
            const config = memoryProviderConfigSchema.parse({ schemaVersion: 2, llm: credentials('llm'), embedding: credentials('embedding'), reranker: credentials('reranker') })
            await this.verifyModels(config, reauthorize)
            await reauthorize()
            // Confirm even unchanged selections: a Python bind may have succeeded before a Vault CAS failure.
            const binding = await this.request('/configuration/binding', { projectId: projectId, embeddingProvider: config.embedding.provider, embeddingModel: config.embedding.model, embeddingDimensions: config.embedding.dimensions })
            if (binding.bound !== true) throw new EvolvedError('memory_embedding_locked', 'Existing graph data or processing tasks prevent changing the embedding configuration.', 409)
            await reauthorize()
            await this.vault.request({ userId: userId, projectId: projectId, operation: 'memoryProvider', payload: { action: 'set', version: input.version, config } })
            await reauthorize()
            this.store.audit(userId, projectId, 'memory.provider.updated')
            return this.record(projectId, userId)
        })
    }
    /** Metadata only; stored component credentials are resolved solely inside the service. */
    async modelsForProject(projectId: string, value: unknown, reauthorize: () => Promise<unknown>): Promise<{ models: string[]; verified: boolean }> {
        const parsed = catalogInputSchema.safeParse(value)
        if (!parsed.success) throw new EvolvedError('memory_provider_invalid', 'Invalid model catalog request.', 400)
        const body = parsed.data
        return this.using(projectId, async () => {
            await reauthorize()
            const prior = body.apiKey ? undefined : (await this.resolve(projectId))?.[body.component]
            const apiKey = body.apiKey || (prior?.provider === body.provider ? prior.apiKey : undefined)
            if (!apiKey) throw new EvolvedError('memory_provider_key_required', 'Enter an API key for this provider component or save it first.', 400)
            await reauthorize()
            const catalog = await this.models(body.provider, apiKey)
            await reauthorize()
            return { ...catalog, models: catalog.models.filter(model => memoryModelMatchesComponent(body.component, body.provider, model)) }
        })
    }
    async check(config: MemoryProviderConfig): Promise<void> {
        validateMemoryModelRoles(config)
        const result = await this.request('/configuration/check', { providerConfig: config })
        if (result.ok !== true) throw new EvolvedError('memory_provider_check_failed', 'Memory configuration or database is unavailable.', 503)
    }
}

export function createMemoryProviderRoutes(options: { store: EvolvedStore; service: MemoryProviderService; origin: string }): Hono {
    const { store, service, origin } = options, app = new Hono()
    const path = '/projects/:id/memory/provider'
    for (const pattern of [path, `${path}/*`]) {
        app.use(pattern, createEvolvedRequestGuard(origin))
        app.use(pattern, bodyLimit({ maxSize: 16_384, onError: c => c.json({ code: 'body_too_large', error: 'Request body is too large.' }, 413) }))
    }
    app.onError((error, c) => error instanceof EvolvedError
        ? c.json({ code: error.code, error: error.message }, error.status as 400)
        : c.json({ code: 'memory_provider_failed', error: 'Memory provider operation failed.' }, 500))
    const authorize = async (c: Context, write = false) => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal)
        const project = store.requireProject(principal.user.id, c.req.param('id')!, write ? 'admin' : 'member')
        if (write) requireFreshPasskey(c, store, principal)
        return { principal, project }
    }
    const limited = new Map<string, { expires: number; count: number }>()
    let active = 0
    async function bounded<T>(userId: string, projectId: string, operation: () => Promise<T>): Promise<T> {
        const now = store.now()
        for (const [key, entry] of limited) if (entry.expires <= now) limited.delete(key)
        const key = `${userId}:${projectId}`, entry = limited.get(key) ?? { expires: now + 60_000, count: 0 }
        if (active >= 4 || entry.count >= 6 || !limited.has(key) && limited.size >= 256) throw new EvolvedError('memory_provider_rate_limited', 'Too many configuration checks. Retry shortly.', 429)
        entry.count++; limited.set(key, entry); active++
        try { return await operation() } finally { active-- }
    }
    const status = async (c: Context) => {
        const { principal, project } = await authorize(c)
        const record = await service.record(project.id, principal.user.id)
        await authorize(c)
        const config = record.config ? memoryProviderPublicSchema.parse(record.config) : null
        return { configured: record.state === 'configured', apiKeyConfigured: record.state === 'configured', version: record.version,
            keyConfigured: { llm: !!config, embedding: !!config, reranker: !!config && config.reranker.provider !== 'rrf' },
            source: record.state === 'configured' ? 'project' : record.state === 'disabled' ? 'disabled' : 'environment', config,
            boundEmbeddingProvider: record.embeddingProvider, boundEmbeddingModel: record.embeddingModel ? modelId.parse(record.embeddingModel) : null,
            boundEmbeddingDimensions: record.embeddingDimensions, embeddingLocked: service.embeddingLocked(project.id, record.embeddingModel !== null), canManage: project.role === 'admin' }
    }
    app.get(path, async c => c.json(await status(c)))
    app.put(path, async c => {
        const { principal, project } = await authorize(c, true)
        const input = await parseBody(c, inputSchema)
        return bounded(principal.user.id, project.id, async () => {
            await service.savePublic(project.id, principal.user.id, input, () => authorize(c, true))
            return c.json(await status(c))
        })
    })
    app.delete(path, async c => {
        const { principal, project } = await authorize(c, true), body = await parseBody(c, z.object({ version }).strict())
        return service.changing(project.id, async () => {
            await authorize(c, true)
            await service.vault.request({ userId: principal.user.id, projectId: project.id, operation: 'memoryProvider', payload: { action: 'delete', version: body.version } })
            await authorize(c, true)
            store.audit(principal.user.id, project.id, 'memory.provider.deleted')
            return c.json(await status(c))
        })
    })
    app.post(`${path}/models`, async c => {
        const { principal, project } = await authorize(c, true)
        const body = await parseBody(c, catalogInputSchema)
        return bounded(principal.user.id, project.id, async () => c.json(
            await service.modelsForProject(project.id, body, () => authorize(c, true))))
    })
    app.post(`${path}/test`, async c => {
        const { principal, project } = await authorize(c, true)
        await parseBody(c, z.object({}).strict())
        return bounded(principal.user.id, project.id, () => service.using(project.id, async () => {
            const config = await service.resolve(project.id)
            if (!config) throw new EvolvedError('memory_provider_missing', 'Save a project provider configuration first.', 400)
            const unverifiedComponents = await service.verifyModels(config, () => authorize(c, true))
            await authorize(c, true)
            await service.check(config)
            await authorize(c, true)
            return c.json({ ok: true, backend: 'graphiti-0.30.2/neo4j', modelsVerified: unverifiedComponents.length === 0, unverifiedComponents, inferenceTested: false })
        }))
    })
    return app
}
