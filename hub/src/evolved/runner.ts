import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EvolvedError, EvolvedStore, hashToken, randomToken, type AgentProfile, type EvolvedPrincipal } from './store'
import { authenticateEvolvedRequest, parseBody, requireFreshPasskey, requireHuman, type EvolvedEnv } from './security'

type LeaseRow = { id: string; name: string; token_hash: string; user_id: string; project_id: string; scopes: string; action_ids: string; profile: AgentProfile; created_at: number; expires_at: number; revoked_at: number | null }
const scopeSchema = z.enum(['runner:connect', 'memory:read', 'memory:write', 'codegraph:read', 'resource:execute', 'peers:read', 'peers:send', 'peers:manage', 'git:read', 'git:write'])
function publicLease(row: LeaseRow) { return { id: row.id, name: row.name, userId: row.user_id, projectId: row.project_id, scopes: JSON.parse(row.scopes) as string[], actionIds: JSON.parse(row.action_ids) as string[], profile: row.profile, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at } }
function currentLease(store: EvolvedStore, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new EvolvedError('invalid_lease', 'Invalid runner lease.', 401)
    const lease = store.db.prepare('SELECT * FROM evolved_runner_leases WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hashToken(token), store.now() + 1000) as LeaseRow | null
    if (!lease) throw new EvolvedError('invalid_lease', 'Runner lease expired or was revoked.', 401)
    const project = store.requireProject(lease.user_id, lease.project_id, 'admin')
    if (project.profile !== lease.profile) throw new EvolvedError('lease_profile_changed', 'Runner lease profile has changed; request a new lease.', 403)
    return { lease, project }
}
export function exchangeRunnerLease(store: EvolvedStore, token: string) {
    return store.db.transaction(() => {
        const { lease, project } = currentLease(store, token)
        const lifetime = Math.min(900, Math.floor((lease.expires_at - store.now()) / 1000))
        const cap = store.issueCapability(lease.user_id, lease.project_id, JSON.parse(lease.scopes) as string[], JSON.parse(lease.action_ids) as string[], lifetime, lease.id)
        return { ...cap, projectId: project.id, namespace: project.namespace, profile: project.profile, rootPath: project.rootPath, leaseExpiresAt: lease.expires_at }
    })()
}
export function createRunnerRoutes(store: EvolvedStore): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>()
    const exchanges = new Map<string, { count: number; expiresAt: number }>()
    const human = async (req: Request): Promise<EvolvedPrincipal> => {
        const principal = await authenticateEvolvedRequest(req, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal)
        return principal
    }
    app.get('/runner/authority', c => {
        if (c.req.header('cookie')) throw new EvolvedError('lease_only', 'Runner authority does not accept browser credentials.', 403)
        const authorization = c.req.header('authorization') ?? ''
        if (!authorization.startsWith('Bearer ')) throw new EvolvedError('invalid_lease', 'Runner lease required.', 401)
        const { lease, project } = currentLease(store, authorization.slice(7))
        if (!(JSON.parse(lease.scopes) as string[]).includes('runner:connect')) throw new EvolvedError('scope_denied', 'Runner connection scope required.', 403)
        return c.json({ projectId: project.id, profile: project.profile, rootPath: project.rootPath, expiresAt: lease.expires_at })
    })
    app.post('/runner/token', async c => {
        if (c.req.header('cookie')) throw new EvolvedError('lease_only', 'Runner token exchange does not accept browser credentials.', 403)
        const authorization = c.req.header('authorization') ?? ''
        if (!authorization.startsWith('Bearer ')) throw new EvolvedError('invalid_lease', 'Runner lease required.', 401)
        await parseBody(c, z.object({}).strict())
        const token = authorization.slice(7), digest = hashToken(token), now = store.now()
        for (const [id, entry] of exchanges) if (entry.expiresAt <= now) exchanges.delete(id)
        const prior = exchanges.get(digest)
        if (prior && prior.count >= 6) throw new EvolvedError('rate_limited', 'Runner token refresh is limited to six requests per minute.', 429)
        const result = exchangeRunnerLease(store, token)
        exchanges.set(digest, { count: (prior?.count ?? 0) + 1, expiresAt: prior?.expiresAt ?? now + 60_000 })
        return c.json(result)
    })
    app.get('/projects/:id/runner-leases', async c => {
        const principal = await human(c.req.raw)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const rows = store.db.prepare('SELECT * FROM evolved_runner_leases WHERE project_id=? ORDER BY created_at DESC').all(c.req.param('id')) as LeaseRow[]
        return c.json({ leases: rows.map(publicLease) })
    })
    app.post('/projects/:id/runner-leases', async c => {
        const principal = await human(c.req.raw); requireFreshPasskey(c, store, principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(120), scopes: z.array(scopeSchema).min(1).max(10).default(['runner:connect', 'git:read', ...(project.profile === 'restricted' ? [] : ['git:write'])] as z.infer<typeof scopeSchema>[]), actionIds: z.array(z.string().min(1).max(128)).max(50).default([]), expiresInSeconds: z.number().int().min(60).max(7 * 86400).default(86400) }).strict())
        if (project.profile === 'restricted' && body.scopes.includes('git:write')) throw new EvolvedError('profile_denied', 'Restricted runners cannot receive Git push permission.', 403)
        const id = randomUUID(), token = randomToken(), now = store.now(), expiresAt = now + body.expiresInSeconds * 1000
        store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id, body.name, hashToken(token), principal.user.id, project.id, JSON.stringify([...new Set(body.scopes)]), JSON.stringify([...new Set(body.actionIds)]), project.profile, now, expiresAt)
        store.audit(principal.user.id, project.id, 'runner_lease.created', id)
        return c.json({ id, token, expiresAt, projectId: project.id, profile: project.profile }, 201)
    })
    app.delete('/projects/:id/runner-leases/:leaseId', async c => {
        const principal = await human(c.req.raw)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=? WHERE id=? AND project_id=?').run(store.now(), c.req.param('leaseId'), c.req.param('id'))
        store.audit(principal.user.id, c.req.param('id'), 'runner_lease.revoked', c.req.param('leaseId'))
        return c.json({ ok: true })
    })
    return app
}
