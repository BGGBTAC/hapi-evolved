import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { EvolvedError, EvolvedStore, type EvolvedPrincipal } from './store'
import { authenticateEvolvedRequest, requireScope } from './security'
import { MemoryError, memoryHash, type MemorySource } from './memoryStore'
import { containsCredential, excludedMemoryPath, HttpMemoryBackend, MemoryService, readMemorySource } from './memoryService'

type MemoryEnv = { Variables: { principal: EvolvedPrincipal } }
const sourceSchema = z.object({ projectId: z.string().max(80).optional(), kind: z.enum(['manual', 'chat', 'code', 'attachment']),
    path: z.string().max(2048).optional(), commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
    sessionId: z.string().max(200).optional(), messageId: z.string().max(200).optional() })
const createSchema = z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(50_000), sources: z.array(sourceSchema).max(20).optional() })
const settingsSchema = z.object({ enabled: z.boolean().optional(), cloudAllowed: z.boolean().optional(), monthlyBudgetMicros: z.number().int().min(0).max(1_000_000_000).optional(), jobBudgetMicros: z.number().int().min(0).max(1_000_000_000).optional() }).strict()

export function createMemoryRoutes(options: { store: EvolvedStore; service?: MemoryService; backendUrl?: string; serviceToken?: string; origin?: string }) {
    const app = new Hono<MemoryEnv>()
    const service = options.service ?? new MemoryService(options.store, new HttpMemoryBackend(options.backendUrl, options.serviceToken))
    const ledger = service.ledger
    app.use('*', async (c, next) => {
        const principal = await authenticateEvolvedRequest(c.req.raw, options.store)
        if (!principal) return c.json({ error: 'Authentication required' }, 401)
        if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !principal.capability) {
            const origin = c.req.header('origin')
            if (!origin || origin !== (options.origin ?? new URL(c.req.url).origin)) return c.json({ error: 'Origin rejected' }, 403)
        }
        c.set('principal', principal)
        return next()
    })
    app.onError((error, c) => {
        if (error instanceof MemoryError || error instanceof EvolvedError) return c.json({ error: error.message }, error.status as 400)
        return c.json({ error: 'Memory operation failed' }, 500)
    })
    const authorized = (principal: EvolvedPrincipal, projectId: string, write = false) => {
        requireScope(principal, write ? 'memory:write' : 'memory:read', projectId)
        return options.store.requireProject(principal.user.id, projectId, write ? 'member' : 'viewer')
    }
    const revalidate = async (c: Context<MemoryEnv>, ids: string[], write = false) => {
        const current = await authenticateEvolvedRequest(c.req.raw, options.store)
        if (!current) throw new MemoryError('Authentication expired', 401)
        for (const id of ids) authorized(current, id, write)
    }
    app.get('/projects/:id/memory', async c => {
        const projectId = c.req.param('id'); authorized(c.get('principal'), projectId)
        const available = await service.backend.available()
        await service.reconcileSources([projectId])
        await revalidate(c, [projectId])
        return c.json({ items: ledger.list(projectId), settings: ledger.settings(projectId), budget: ledger.budget(projectId), backend: { available } })
    })
    app.post('/projects/:id/memory', async c => {
        const projectId = c.req.param('id'); const principal = c.get('principal'); authorized(principal, projectId, true)
        const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid memory entry' }, 400)
        if (containsCredential(parsed.data.body) || containsCredential(parsed.data.title)) return c.json({ error: 'Credentials must remain in the vault' }, 422)
        const sources: MemorySource[] = await Promise.all((parsed.data.sources ?? [{ kind: 'manual' as const }]).map(async source => {
            if (source.projectId && source.projectId !== projectId) throw new MemoryError('Store source facts in their own project', 403)
            if (source.path && excludedMemoryPath(source.path)) throw new MemoryError('Source path is excluded', 403)
            const sourceBody = source.kind === 'code' || source.kind === 'attachment'
                ? await readMemorySource(authorized(principal, projectId).rootPath, source.path ?? '') : parsed.data.body
            return { ...source, projectId, hash: memoryHash(sourceBody), ...(source.kind === 'chat' ? { origin: 'user:reference' } : {}) }
        }))
        await revalidate(c, [projectId], true)
        const item = ledger.create(projectId, principal.user.id, parsed.data.title, parsed.data.body, sources)
        options.store.audit(principal.user.id, projectId, 'memory.propose', item.id)
        return c.json({ item }, 201)
    })
    app.post('/projects/:id/memory/intake', async c => {
        const projectId = c.req.param('id'); const principal = c.get('principal'); const project = authorized(principal, projectId, true)
        const parsed = z.object({ path: z.string().min(1).max(2048), kind: z.enum(['code', 'attachment']).default('code'), commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional() }).safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid source request' }, 400)
        const body = await readMemorySource(project.rootPath, parsed.data.path)
        await revalidate(c, [projectId], true)
        const item = ledger.create(projectId, principal.user.id, parsed.data.path.slice(0, 200), body, [{ ...parsed.data, projectId, hash: memoryHash(body) }])
        options.store.audit(principal.user.id, projectId, 'memory.intake', item.id)
        return c.json({ item }, 201)
    })
    app.patch('/projects/:id/memory/settings', async c => {
        const projectId = c.req.param('id'); const principal = c.get('principal'); authorized(principal, projectId, true)
        if (principal.capability) return c.json({ error: 'Only a person may configure cloud memory spending' }, 403)
        options.store.requireProject(principal.user.id, projectId, 'admin')
        const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid memory settings' }, 400)
        await revalidate(c, [projectId], true)
        options.store.requireProject(principal.user.id, projectId, 'admin')
        const settings = ledger.configure(projectId, parsed.data, principal.user.id)
        options.store.audit(principal.user.id, projectId, 'memory.settings')
        return c.json({ settings, budget: ledger.budget(projectId) })
    })
    app.patch('/projects/:id/memory/:memoryId', async c => {
        const projectId = c.req.param('id'); const principal = c.get('principal'); authorized(principal, projectId, true)
        const parsed = z.object({ status: z.enum(['proposed', 'verified']) }).safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid memory status' }, 400)
        if (parsed.data.status === 'verified' && principal.capability) return c.json({ error: 'A person must verify agent knowledge' }, 403)
        await revalidate(c, [projectId], true)
        const item = ledger.setStatus(projectId, c.req.param('memoryId'), parsed.data.status)
        options.store.audit(principal.user.id, projectId, 'memory.status', item.id)
        return c.json({ item })
    })
    app.delete('/projects/:id/memory/:memoryId', async c => {
        const projectId = c.req.param('id'); const principal = c.get('principal'); authorized(principal, projectId, true)
        const result = ledger.forget(projectId, c.req.param('memoryId'), principal.user.id)
        options.store.audit(principal.user.id, projectId, 'memory.forget', c.req.param('memoryId'))
        void service.processOne()
        return c.json({ deleted: true, graphPurgePending: true, ...result }, 202)
    })
    app.get('/memory/search', async c => {
        const principal = c.get('principal')
        const query = (c.req.query('q') ?? '').trim()
        if (!query || query.length > 500) return c.json({ error: 'Search query must contain 1–500 characters' }, 400)
        const requested = c.req.query('projectId')
        const ids = requested ? [requested] : principal.capability ? [principal.capability.projectId] : principal.accessibleProjects.map(project => project.id)
        for (const id of ids) authorized(principal, id)
        const backendAvailable = await service.backend.available()
        const useHybrid = c.req.query('mode') === 'hybrid'
        if (useHybrid && !backendAvailable) return c.json({ error: 'Memory graph service unavailable', backendAvailable: false }, 503)
        if (useHybrid) {
            const results = await service.hybridSearch(principal.user.id, ids, query, 30, () => revalidate(c, ids))
            await revalidate(c, ids)
            return c.json({ results, mode: 'hybrid', backendAvailable })
        }
        await service.reconcileSources(ids)
        await revalidate(c, ids)
        return c.json({ results: ledger.search(ids, query), mode: 'ledger', backendAvailable })
    })
    return app
}
