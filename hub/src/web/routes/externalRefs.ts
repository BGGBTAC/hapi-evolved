import { Hono } from 'hono'
import { z } from 'zod'
import { ExternalRefsSchema, parseGithubPrInput } from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { githubPrFeature, setGithubPrFeature, FeaturePinnedError } from '../../config/githubPrAwareness'
import { requireSessionFromParam, requireSyncEngine } from './guards'

export function createExternalRefsRoutes(getEngine: () => SyncEngine | null, dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/features', c => c.json({ githubPrAwareness: githubPrFeature(dataDir),
        canManage: c.get('evolvedAccess') ? c.get('evolvedAccess')!.principal.user.isAdmin : c.get('namespace') === 'default' }))
    app.patch('/features', async c => {
        const access = c.get('evolvedAccess')
        if (access ? !access.principal.user.isAdmin : c.get('namespace') !== 'default') return c.json({ error: 'Hub administrator required.' }, 403)
        const parsed = z.object({ githubPrAwareness: z.boolean() }).strict().safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid feature settings.' }, 400)
        try { setGithubPrFeature(dataDir, parsed.data.githubPrAwareness) }
        catch (error) {
            if (error instanceof FeaturePinnedError) return c.json({ error: error.message, code: 'feature_pinned_by_env' }, 409)
            return c.json({ error: 'Feature settings could not be saved.' }, 500)
        }
        return c.json({ githubPrAwareness: githubPrFeature(dataDir), canManage: true })
    })
    app.get('/sessions/:id/external-refs', c => {
        const engine = requireSyncEngine(c, getEngine); if(engine instanceof Response)return engine
        const resolved = requireSessionFromParam(c, engine); if(resolved instanceof Response)return resolved
        return c.json({ externalRefs: resolved.session.metadata?.externalRefs ?? [] })
    })
    app.post('/sessions/:id/link-pr', async c => {
        if (!githubPrFeature(dataDir).enabled) return c.json({ error: 'GitHub PR awareness is disabled.' }, 403)
        const engine = requireSyncEngine(c, getEngine); if (engine instanceof Response) return engine
        const resolved = requireSessionFromParam(c, engine); if (resolved instanceof Response) return resolved
        const body = z.object({ pr: z.string().max(300) }).strict().safeParse(await c.req.json().catch(() => null))
        const ref = body.success ? parseGithubPrInput(body.data.pr) : null
        if (!ref) return c.json({ error: 'Invalid GitHub PR.' }, 400)
        try {
            const externalRefs = await engine.linkSessionGithubPr(resolved.session.id, c.get('namespace'), { ...ref, source: 'agent', linkedAt: Date.now() })
            return c.json({ externalRefs })
        } catch { return c.json({ error: 'The primary PR was linked by a person or changed concurrently. Review it in the browser.' }, 409) }
    })
    app.put('/sessions/:id/external-refs', async c => {
        if (!githubPrFeature(dataDir).enabled) return c.json({ error: 'GitHub PR awareness is disabled.' }, 403)
        const engine = requireSyncEngine(c, getEngine); if(engine instanceof Response)return engine
        const resolved = requireSessionFromParam(c, engine); if(resolved instanceof Response)return resolved
        const parsed = z.object({ externalRefs: ExternalRefsSchema }).strict().safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid PR references.' }, 400)
        try {
            const externalRefs = parsed.data.externalRefs.map(ref => ({...ref, source:'user' as const, linkedAt:Date.now()}))
            await engine.setSessionExternalRefs(resolved.session.id, c.get('namespace'), externalRefs)
            return c.json({ externalRefs })
        } catch { return c.json({ error: 'Session changed concurrently; retry.', code:'version_conflict' }, 409) }
    })
    return app
}
