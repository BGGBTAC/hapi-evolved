import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { EvolvedError, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, createEvolvedRequestGuard, parseBody, requireFreshPasskey, requireHuman } from './security'
import type { VaultClient } from './vault'

const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
const price = z.string().max(32).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).refine(value => Number(value) > 0 && Number(value) <= 1_000_000)
export const memoryProviderKeySchema = z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/)
export const memoryProviderPublicSchema = z.object({
    provider: z.literal('openai'), model: modelId, embeddingModel: modelId,
    embeddingDimensions: z.literal(1536), inputUsdPerMTok: price, outputUsdPerMTok: price,
    embeddingUsdPerMTok: price, maxOutputTokens: z.number().int().min(256).max(4096),
}).strict()
export const memoryProviderConfigSchema = memoryProviderPublicSchema.extend({ apiKey: memoryProviderKeySchema }).strict()
export type MemoryProviderConfig = z.infer<typeof memoryProviderConfigSchema>
export type MemoryProviderPublic = z.infer<typeof memoryProviderPublicSchema>
export type MemoryProviderRecord = { state: 'unset' | 'configured' | 'disabled'; version: number; config: MemoryProviderPublic | null; embeddingModel: string | null }
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
        const text = await response.text()
        if (text.length > 1_000_000) throw new EvolvedError('memory_provider_invalid_response', 'Invalid memory service response.', 502)
        try { return JSON.parse(text) as Record<string, unknown> } catch { throw new EvolvedError('memory_provider_invalid_response', 'Invalid memory service response.', 502) }
    }
    async models(apiKey: string): Promise<string[]> {
        const result = await this.request('/configuration/models', { apiKey })
        const parsed = z.array(modelId).max(5000).safeParse(result.models)
        if (!parsed.success || parsed.data.some(id => id.includes(apiKey))) throw new EvolvedError('memory_provider_invalid_response', 'Invalid model catalog response.', 502)
        return [...new Set(parsed.data)].sort()
    }
    async check(config: MemoryProviderConfig): Promise<void> {
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
        return { configured: record.state === 'configured', apiKeyConfigured: record.state === 'configured', version: record.version,
            source: record.state === 'configured' ? 'project' : record.state === 'disabled' ? 'disabled' : 'environment',
            config: record.config ? memoryProviderPublicSchema.parse(record.config) : null, boundEmbeddingModel: record.embeddingModel ? modelId.parse(record.embeddingModel) : null, embeddingLocked: service.embeddingLocked(project.id, record.embeddingModel !== null), canManage: project.role === 'admin' }
    }
    app.get(path, async c => c.json(await status(c)))
    const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
    app.put(path, async c => {
        const { principal, project } = await authorize(c, true)
        const input = await parseBody(c, memoryProviderPublicSchema.extend({ version, apiKey: z.union([z.literal(''), memoryProviderKeySchema]).optional() }).strict())
        return bounded(principal.user.id, project.id, () => service.changing(project.id, async () => {
            const current = await service.record(project.id, principal.user.id)
            if (current.version !== input.version) throw new EvolvedError('memory_provider_conflict', 'Configuration changed. Reload before saving.', 409)
            const existing = !input.apiKey ? await service.resolve(project.id) : null
            const apiKey = input.apiKey || existing?.apiKey
            if (!apiKey) throw new EvolvedError('memory_provider_key_required', 'An API key is required for the first configuration.', 400)
            const { version: expectedVersion, apiKey: _submitted, ...fields } = input
            const config = { ...fields, apiKey }
            await authorize(c, true)
            const models = await service.models(apiKey)
            if (!models.includes(config.model) || !models.includes(config.embeddingModel)) throw new EvolvedError('memory_provider_model_unavailable', 'Select models returned for this API key.', 400)
            await authorize(c, true)
            if (service.embeddingLocked(project.id, current.embeddingModel !== null) && current.embeddingModel !== config.embeddingModel) {
                // Old installations can have final, zero-cost failed jobs without ever
                // having a provider. Only the service can prove their graph is empty
                // and persist a model fence that rejects late incompatible requests.
                const empty = current.embeddingModel === null && (await service.request('/configuration/binding', { projectId: project.id, embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions })).empty === true
                if (!empty) throw new EvolvedError('memory_embedding_locked', 'Existing graph data or processing tasks prevent changing the embedding model.', 409)
            }
            await authorize(c, true)
            await service.vault.request({ userId: principal.user.id, projectId: project.id, operation: 'memoryProvider', payload: { action: 'set', version: expectedVersion, config } })
            await authorize(c, true)
            store.audit(principal.user.id, project.id, 'memory.provider.updated')
            return c.json(await status(c))
        }))
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
        const body = await parseBody(c, z.object({ apiKey: z.union([z.literal(''), memoryProviderKeySchema]).optional() }).strict())
        return bounded(principal.user.id, project.id, async () => {
            const apiKey = body.apiKey || (await service.resolve(project.id))?.apiKey
            if (!apiKey) throw new EvolvedError('memory_provider_key_required', 'Enter an API key or save a configuration first.', 400)
            await authorize(c, true)
            const models = await service.models(apiKey)
            await authorize(c, true)
            return c.json({ models })
        })
    })
    app.post(`${path}/test`, async c => {
        const { principal, project } = await authorize(c, true)
        await parseBody(c, z.object({}).strict())
        return bounded(principal.user.id, project.id, () => service.using(project.id, async () => {
            const config = await service.resolve(project.id)
            if (!config) throw new EvolvedError('memory_provider_missing', 'Save a project provider configuration first.', 400)
            await authorize(c, true)
            const models = await service.models(config.apiKey)
            if (!models.includes(config.model) || !models.includes(config.embeddingModel)) throw new EvolvedError('memory_provider_model_unavailable', 'A configured model is no longer listed for this API key.', 400)
            await service.check(config)
            await authorize(c, true)
            return c.json({ ok: true, backend: 'graphiti-0.30.2/neo4j', modelsVerified: true, inferenceTested: false })
        }))
    })
    return app
}
