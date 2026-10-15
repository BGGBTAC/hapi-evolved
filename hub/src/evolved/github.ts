import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { EvolvedError, type EvolvedPrincipal, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, createEvolvedRequestGuard, parseBody, requireFreshPasskey, requireHuman, requireScope, type EvolvedEnv } from './security'
import type { VaultClient } from './vault'
import { boundedGitResponse, gitBodyHash, GIT_TIMEOUT_MS, parseGitRequest, readGitBody, type GitOperation } from './githubProtocol'

type GithubConfig = { store: EvolvedStore; vault: VaultClient; origin: string }
const tokenBody = z.object({ token: z.string().trim().min(10).max(1024) }).strict()
const grantBody = z.object({ repository: z.string().trim().min(3).max(240), permission: z.enum(['read', 'write']) }).strict()

/** Browser management is deliberately separate from the runner's Git transport. */
export function createGithubRoutes({ store, vault, origin }: GithubConfig): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>()
    for (const path of ['/projects/:id/github', '/projects/:id/github/*']) {
        app.use(path, createEvolvedRequestGuard(origin))
        app.use(path, bodyLimit({ maxSize: 16_384, onError: c => c.json({ error: 'GitHub configuration request is too large.', code: 'body_too_large' }, 413) }))
    }
    const authorize = async (c: Context, write: boolean): Promise<EvolvedPrincipal> => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal)
        store.requireProject(principal.user.id, c.req.param('id')!, write ? 'admin' : 'viewer')
        if (write) requireFreshPasskey(c, store, principal)
        return principal
    }
    const dispatch = async (c: Context, payload: Record<string, unknown>, write: boolean) => {
        const principal = await authorize(c, write), projectId = c.req.param('id')!
        const result = await vault.request({ userId: principal.user.id, projectId, operation: 'github', payload })
        // Do not disclose metadata after access was removed during a provider request.
        await authorize(c, write)
        if (write) store.audit(principal.user.id, projectId, `github.${String(payload.action)}`)
        return c.json(result as Record<string, unknown>)
    }
    app.get('/projects/:id/github', c => dispatch(c, { action: 'status' }, false))
    app.post('/projects/:id/github', async c => {
        const body = await parseBody(c, tokenBody)
        return dispatch(c, { action: 'connect', token: body.token }, true)
    })
    app.delete('/projects/:id/github', c => dispatch(c, { action: 'disconnect' }, true))
    app.put('/projects/:id/github/repositories', async c => {
        const body = await parseBody(c, grantBody)
        return dispatch(c, { action: 'grant', ...body }, true)
    })
    app.delete('/projects/:id/github/repositories/:repositoryId', c => {
        const repositoryId = c.req.param('repositoryId')
        if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) throw new EvolvedError('invalid_repository', 'Invalid repository identifier.')
        return dispatch(c, { action: 'revoke', repositoryId }, true)
    })
    return app
}

/** Mount before the general JSON body limit; only these exact routes accept Git packs. */
export function createGithubGitTransport({ store, vault, origin }: GithubConfig) {
    const routes = new Hono<EvolvedEnv>(), active = new Map<string, Set<AbortController>>()
    routes.use('/projects/:id/git/*', createEvolvedRequestGuard(origin))
    let total = 0
    const authorize = async (request: Request, projectId: string, git: GitOperation) => {
        // A browser session must never turn Git into an ambient-credential endpoint.
        if (request.headers.has('cookie')) throw new EvolvedError('runner_required', 'Use a project runner for Git.', 403)
        const principal = await authenticateEvolvedRequest(request, store)
        if (!principal?.capability?.leaseId) throw new EvolvedError('runner_required', 'Use a project runner lease for Git.', 403)
        requireScope(principal, 'runner:connect', projectId)
        requireScope(principal, git.service === 'git-receive-pack' ? 'git:write' : 'git:read', projectId)
        const project = store.requireProject(principal.user.id, projectId, 'member')
        if (git.service === 'git-receive-pack' && project.profile === 'restricted') throw new EvolvedError('profile_denied', 'This project profile does not permit Git push.', 403)
        return { principal, project }
    }
    routes.all('/projects/:id/git/*', async c => {
        const projectId = c.req.param('id'), request = c.req.raw
        const marker = `/projects/${projectId}/git/`, index = c.req.path.indexOf(marker)
        const git = parseGitRequest(request, c.req.path.slice(0, index) + marker)
        await authorize(request, projectId, git)
        if (!vault.git) throw new EvolvedError('github_unavailable', 'The Git credential broker is unavailable.', 503)
        const group = active.get(projectId) ?? new Set<AbortController>()
        if (total >= 4 || group.size >= 2) throw new EvolvedError('git_busy', 'Git transfer capacity is busy. Try again later.', 429)
        const controller = new AbortController()
        group.add(controller); active.set(projectId, group); total++
        let finished = false
        const timeout = setTimeout(() => controller.abort(), GIT_TIMEOUT_MS)
        const onAbort = () => controller.abort()
        request.signal.addEventListener('abort', onAbort, { once: true })
        if (request.signal.aborted) controller.abort()
        const interval = setInterval(() => {
            void authorize(request, projectId, git).catch(() => controller.abort())
        }, 1000)
        const finish = () => {
            if (finished) return
            finished = true
            clearTimeout(timeout); clearInterval(interval)
            request.signal.removeEventListener('abort', onAbort)
            group.delete(controller); if (!group.size) active.delete(projectId)
            total--
        }
        try {
            const body = await readGitBody(new Request(request, { signal: controller.signal }))
            const { principal, project } = await authorize(request, projectId, git)
            controller.signal.throwIfAborted()
            const response = await vault.git({ userId: principal.user.id, projectId, operation: 'githubGit', payload: { git, profile: project.profile, bodyHash: gitBodyHash(body) } }, body, controller.signal)
            await authorize(request, projectId, git)
            controller.signal.throwIfAborted()
            const type = `application/x-${git.service}-${git.advertisement ? 'advertisement' : 'result'}`
            if (response.status !== 200 || response.headers.get('content-type') !== type || response.headers.has('content-encoding')) {
                await response.body?.cancel().catch(() => {})
                throw new EvolvedError('git_broker_response_invalid', 'Git credential broker returned an invalid response.', 502)
            }
            store.audit(principal.user.id, projectId, git.service === 'git-receive-pack' ? 'github.push_requested' : 'github.fetch_requested')
            const clean = new Response(response.body, { headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
            return boundedGitResponse(clean, controller, finish)
        } catch (error) {
            controller.abort(); finish()
            if (error instanceof EvolvedError) throw error
            throw new EvolvedError('git_transfer_failed', 'Git transfer was interrupted or the broker is unavailable.', 502)
        }
    })
    return { routes, close() { for (const group of active.values()) for (const controller of group) controller.abort() } }
}
