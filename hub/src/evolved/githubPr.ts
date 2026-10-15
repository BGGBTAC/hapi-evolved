import { Hono } from 'hono'
import { z } from 'zod'
import { parseGithubPrInput } from '@hapi/protocol'
import type { SyncEngine } from '../sync/syncEngine'
import { githubPrFeature } from '../config/githubPrAwareness'
import { EvolvedError, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, parseBody, requireScope, type EvolvedEnv } from './security'

/** Authorization is project-runner scoped; a session id is a claimed address. */
export function createGithubPrRunnerRoutes(store: EvolvedStore, getEngine: () => SyncEngine | null, dataDir: string): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>()
    app.use('/github-pr/*', async (c, next) => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal?.capability) throw new EvolvedError('runner_required', 'Project runner required.', 403)
        requireScope(principal, 'runner:connect')
        store.requireProject(principal.user.id, principal.capability.projectId, 'member')
        c.set('principal', principal)
        return next()
    })
    app.get('/github-pr/features', c => c.json(githubPrFeature(dataDir)))
    app.post('/github-pr/link', async c => {
        const body = await parseBody(c, z.object({ sessionId: z.string().min(1).max(128), pr: z.string().min(1).max(300) }).strict())
        if (!githubPrFeature(dataDir).enabled) throw new EvolvedError('feature_disabled', 'GitHub PR awareness is disabled.', 403)
        const parsed = parseGithubPrInput(body.pr)
        if (!parsed) throw new EvolvedError('invalid_pr', 'Use a github.com PR URL or owner/repository#number.')
        const principal = c.get('principal'), project = store.requireProject(principal.user.id, principal.capability!.projectId, 'member')
        const engine = getEngine()
        if (!engine) throw new EvolvedError('not_ready', 'Session service is unavailable.', 503)
        if (!engine.getSessionByNamespace(body.sessionId, project.namespace)) throw new EvolvedError('not_found', 'Session not found in this project.', 404)
        try {
            const externalRefs = await engine.linkSessionGithubPr(body.sessionId, project.namespace,
                { ...parsed, role: 'primary', source: 'agent', linkedAt: store.now() })
            return c.json({ externalRefs })
        } catch { throw new EvolvedError('pr_conflict', 'The primary PR was linked by a person or changed concurrently. Review it in the browser.', 409) }
    })
    return app
}
