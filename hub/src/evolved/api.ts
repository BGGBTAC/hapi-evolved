import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { EvolvedError, EvolvedStore, canonicalWorkspace } from './store'
import { assertOrigin, authenticateEvolvedRequest, createAuthRoutes, parseBody, requireFreshPasskey, requireHuman, requireScope, type EvolvedEnv } from './security'
import type { VaultClient } from './vault'
import { createRunnerRoutes } from './runner'
import { createSavedPromptRoutes } from './savedPrompts'
import { browseWorkspaces } from './workspaces'
import { createCredentialGrantRoutes, revokeCredentialLeases, withCredentialProjectLock } from './credentialGrants'
import type { AgentCredentialGrant } from './agentCredentialVault'
import { developmentCreation } from './development'
import type { DevelopmentModuleRegistry } from './developmentModules'

const role = z.enum(['viewer', 'member', 'admin'])
const profile = z.enum(['restricted', 'workspace', 'extended'])
const name = z.string().trim().min(1).max(120)
const identifier = z.string().min(1).max(128)
const capabilityScope = z.enum(['memory:read', 'memory:write', 'codegraph:read', 'resource:execute', 'peers:read', 'peers:send', 'peers:manage', 'runner:connect', 'git:read', 'git:write'])
export type EvolvedRoutesConfig = { store: EvolvedStore; vault: VaultClient; origin: string; rpName?: string; allowedWorkspaceRoots?: string[]; onProjectDelete?: (projectId: string) => void; repositoryDiscovery?: (request: Request, projectId: string) => Promise<unknown>; developmentModules?: DevelopmentModuleRegistry }

export function createEvolvedRoutes(config: EvolvedRoutesConfig): Hono<EvolvedEnv> {
    const { store, vault } = config, app = new Hono<EvolvedEnv>()
    app.use('*', bodyLimit({ maxSize: 100_000 }))
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('X-Content-Type-Options', 'nosniff')
        const authorization = c.req.header('authorization')
        if (c.req.path.includes('/auth/') || !authorization || c.req.header('cookie')) assertOrigin(c.req.raw, config.origin)
        await next()
    })
    app.onError((error, c) => {
        if (error instanceof EvolvedError) return c.json({ error: error.message, code: error.code }, error.status as 400)
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return c.json({ error: 'This name or identifier is already in use.', code: 'conflict' }, 409)
        return c.json({ error: 'Request could not be completed.', code: 'internal_error' }, 500)
    })
    app.route('/auth', createAuthRoutes(config))
    app.route('/', createRunnerRoutes(store, vault))
    app.use('*', async (c, next) => {
        // Finish bounded request-body I/O before deciding authorization; a client
        // must not hold an authorized mutation open while its session is revoked.
        if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) await c.req.text()
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) return c.json({ error: 'Sign in required.', code: 'unauthorized' }, 401)
        c.set('principal', principal)
        return next()
    })
    app.route('/saved-prompts', createSavedPromptRoutes(store))
    app.route('/', createCredentialGrantRoutes(store, vault))
    app.get('/me', c => c.json(c.get('principal')))
    app.get('/teams', c => {
        const principal = c.get('principal'); requireHuman(principal)
        return c.json({ teams: store.listTeams(principal.user.id) })
    })
    app.post('/teams', async c => {
        const principal = c.get('principal'); requireHuman(principal)
        const body = await parseBody(c, z.object({ name }).strict())
        return c.json({ team: store.createTeam(principal.user.id, body.name) }, 201)
    })
    app.get('/teams/:id/members', c => {
        const principal = c.get('principal'); requireHuman(principal)
        store.requireTeam(principal.user.id, c.req.param('id'))
        const members = store.db.prepare('SELECT m.user_id AS userId,u.display_name AS displayName,m.role FROM evolved_team_members m JOIN evolved_users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.display_name').all(c.req.param('id'))
        return c.json({ members })
    })
    app.post('/teams/:id/members', async c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const body = await parseBody(c, z.object({ userId: identifier, role }).strict())
        store.setMember(principal.user.id, c.req.param('id'), body.userId, body.role)
        return c.json({ ok: true })
    })
    app.delete('/teams/:id/members/:userId', c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        store.setMember(principal.user.id, c.req.param('id'), c.req.param('userId'), null)
        return c.json({ ok: true })
    })
    app.post('/teams/:id/invitations', async c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const body = await parseBody(c, z.object({ displayName: z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N} _@.+-]+$/u), role }).strict())
        return c.json(store.issueInvitation(principal.user.id, c.req.param('id'), body.displayName, body.role), 201)
    })
    app.get('/projects', c => c.json({ projects: c.get('principal').accessibleProjects }))
    app.get('/workspaces', c => {
        const principal = c.get('principal'); requireHuman(principal)
        if (!principal.user.isAdmin) throw new EvolvedError('workspace_admin_required', 'Only the installation administrator can browse workspaces.', 403)
        const query = z.object({ path: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10_000).default(0) }).strict().safeParse(c.req.query())
        if (!query.success) throw new EvolvedError('invalid_query', 'Invalid workspace browser parameters.')
        const boundPaths = (store.db.prepare("SELECT root_path FROM evolved_projects WHERE root_path<>''").all() as Array<{ root_path: string }>).map(row => row.root_path)
        return c.json(browseWorkspaces({ ...query.data, roots: config.allowedWorkspaceRoots ?? [], managedRoot: store.managedWorkspaceRoot, boundPaths }))
    })
    app.post('/projects', async c => {
        const principal = c.get('principal'); requireHuman(principal)
        const body = await parseBody(c, z.object({ teamId: identifier, name, rootPath: z.string().max(4096).optional(), root: z.string().max(4096).optional(), development: z.unknown().optional() }).strict())
        if (body.rootPath !== undefined && body.root !== undefined && body.rootPath !== body.root) throw new EvolvedError('invalid_workspace', 'Specify only one workspace path.')
        // Optional creation mode: validated completely before the project exists, persisted in the same transaction.
        const development = developmentCreation(body.development, config.developmentModules)
        if (body.rootPath || body.root) {
            if (!principal.user.isAdmin) throw new EvolvedError('workspace_admin_required', 'Only the installation administrator can attach a workspace.', 403)
            requireFreshPasskey(c, store, principal)
        }
        const root = canonicalWorkspace(body.rootPath ?? body.root ?? '', config.allowedWorkspaceRoots ?? [])
        return c.json({ project: store.createProject(principal.user.id, body.teamId, body.name, root, development?.(store, principal.user.id)) }, 201)
    })
    app.delete('/projects/:id', async c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const id = c.req.param('id'), project = store.listProjects(principal.user.id, true).find(p => p.id === id)
        if (!project || project.role !== 'admin') throw new EvolvedError('forbidden', 'Project administration required.', 403)
        // Stop reads/writes first. A failed purge remains hidden and can be retried by its administrator.
        store.db.prepare('UPDATE evolved_projects SET deleting_at=COALESCE(deleting_at,?) WHERE id=?').run(store.now(), id)
        await vault.request({ userId: principal.user.id, projectId: id, operation: 'purgeProject', payload: {} })
        store.db.transaction(() => {
            config.onProjectDelete?.(id)
            store.db.prepare('DELETE FROM evolved_capabilities WHERE project_id=?').run(id)
            store.db.prepare('DELETE FROM evolved_runner_leases WHERE project_id=?').run(id)
            store.db.prepare('DELETE FROM evolved_projects WHERE id=?').run(id)
            store.audit(principal.user.id, id, 'project.deleted', id)
        })()
        return c.json({ ok: true })
    })
    app.put('/projects/:id/profile', async c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const body = await parseBody(c, z.object({ profile }).strict())
        return c.json({ project: store.setProfile(principal.user.id, c.req.param('id'), body.profile) })
    })
    app.get('/projects/:id/members', c => {
        const principal = c.get('principal'); requireHuman(principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'))
        const members = store.db.prepare('SELECT m.user_id AS userId,u.display_name AS displayName,COALESCE(r.role,m.role) AS role,r.role AS override FROM evolved_team_members m JOIN evolved_users u ON u.id=m.user_id LEFT JOIN evolved_project_roles r ON r.project_id=? AND r.user_id=m.user_id WHERE m.team_id=?').all(project.id, project.teamId)
        return c.json({ members })
    })
    app.put('/projects/:id/members', async c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const body = await parseBody(c, z.object({ userId: identifier, role }).strict())
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        store.requireTeam(body.userId, project.teamId)
        store.db.transaction(() => {
            store.db.prepare('INSERT INTO evolved_project_roles VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(project.id, body.userId, body.role)
            const admins = store.listProjectsForService().filter(p => p.id === project.id)
            const available = store.db.prepare("SELECT 1 FROM evolved_team_members m LEFT JOIN evolved_project_roles r ON r.project_id=? AND r.user_id=m.user_id WHERE m.team_id=? AND COALESCE(r.role,m.role)='admin' LIMIT 1").get(project.id, project.teamId)
            if (!admins.length || !available) throw new EvolvedError('last_admin', 'Project must retain an administrator.', 409)
            store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE project_id=? AND user_id=?').run(store.now(), project.id, body.userId)
            store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=COALESCE(revoked_at,?) WHERE project_id=? AND user_id=?').run(store.now(), project.id, body.userId)
            store.audit(principal.user.id, project.id, 'project.role_changed', body.userId)
        })()
        return c.json({ ok: true })
    })
    app.delete('/projects/:id/members/:userId', c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        store.db.transaction(() => {
            store.db.prepare('DELETE FROM evolved_project_roles WHERE project_id=? AND user_id=?').run(project.id, c.req.param('userId'))
            const available = store.db.prepare("SELECT 1 FROM evolved_team_members m LEFT JOIN evolved_project_roles r ON r.project_id=? AND r.user_id=m.user_id WHERE m.team_id=? AND COALESCE(r.role,m.role)='admin' LIMIT 1").get(project.id, project.teamId)
            if (!available) throw new EvolvedError('last_admin', 'Project must retain an administrator.', 409)
            store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE project_id=? AND user_id=?').run(store.now(), project.id, c.req.param('userId'))
            store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=COALESCE(revoked_at,?) WHERE project_id=? AND user_id=?').run(store.now(), project.id, c.req.param('userId'))
            store.audit(principal.user.id, project.id, 'project.role_reset', c.req.param('userId'))
        })()
        return c.json({ ok: true })
    })
    app.post('/projects/:id/capabilities', async c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const body = await parseBody(c, z.object({ scopes: z.array(capabilityScope).min(1).max(10), actionIds: z.array(identifier).max(50).default([]), expiresInSeconds: z.number().int().min(30).max(900).default(900) }).strict())
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        if (project.profile === 'restricted' && body.scopes.includes('git:write')) throw new EvolvedError('profile_denied', 'Restricted capabilities cannot receive Git push permission.', 403)
        return c.json(store.issueCapability(principal.user.id, c.req.param('id'), [...new Set(body.scopes)], [...new Set(body.actionIds)], body.expiresInSeconds), 201)
    })
    app.delete('/projects/:id/capabilities/:capabilityId', c => {
        const principal = c.get('principal'); requireHuman(principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE id=? AND project_id=?').run(store.now(), c.req.param('capabilityId'), c.req.param('id'))
        store.audit(principal.user.id, c.req.param('id'), 'capability.revoked', c.req.param('capabilityId'))
        return c.json({ ok: true })
    })
    app.get('/projects/:id/secrets', async c => {
        const principal = c.get('principal'); requireHuman(principal)
        store.requireProject(principal.user.id, c.req.param('id'))
        return c.json(await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'list', payload: {} }))
    })
    app.post('/projects/:id/secrets', async c => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const body = await parseBody(c, z.object({ name, value: z.string().min(1).max(64 * 1024) }).strict())
        return c.json(await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'set', payload: body }), 201)
    })
    app.put('/projects/:id/secrets/:secretId', async c => withCredentialProjectLock(store, c.req.param('id'), async () => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const body = await parseBody(c, z.object({ name: name.optional(), value: z.string().min(1).max(64 * 1024) }).strict())
        let secretName = body.name
        if (!secretName) {
            const listed = await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'list', payload: {} }) as { secrets: Array<{ id: string; name: string }> }
            secretName = listed.secrets.find(s => s.id === c.req.param('secretId'))?.name
        }
        if (!secretName) throw new EvolvedError('not_found', 'Secret not found.', 404)
        requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const grants = await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'agentCredentials', payload: { action: 'list' } }) as { grants: AgentCredentialGrant[] }
        // Metadata lookup crossed a service boundary; revalidate before signing a
        // write capability in case account/project access changed meanwhile.
        requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        revokeCredentialLeases(store, c.req.param('id'), (grants.grants ?? []).filter(grant => grant.secretId === c.req.param('secretId')))
        return c.json(await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'set', payload: { id: c.req.param('secretId'), name: secretName, value: body.value } }))
    }))
    app.delete('/projects/:id/secrets/:secretId', async c => withCredentialProjectLock(store, c.req.param('id'), async () => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const grants = await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'agentCredentials', payload: { action: 'list' } }) as { grants: AgentCredentialGrant[] }
        requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        revokeCredentialLeases(store, c.req.param('id'), (grants.grants ?? []).filter(grant => grant.secretId === c.req.param('secretId')))
        return c.json(await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'delete', payload: { id: c.req.param('secretId') } }))
    }))
    app.get('/projects/:id/resources', async c => {
        const principal = c.get('principal')
        store.requireProject(principal.user.id, c.req.param('id'))
        const canDiscoverGit = !!config.repositoryDiscovery && (!principal.capability || !!principal.capability.leaseId && principal.capability.scopes.includes('runner:connect') && principal.capability.scopes.includes('git:read'))
        const canListActions = !principal.capability || principal.capability.scopes.includes('resource:execute')
        if (!canDiscoverGit) requireScope(principal, 'resource:execute', c.req.param('id'))
        if (canDiscoverGit) { requireScope(principal, 'runner:connect', c.req.param('id')); requireScope(principal, 'git:read', c.req.param('id')) }
        if (canListActions) requireScope(principal, 'resource:execute', c.req.param('id'))
        const listed = canListActions ? await vault.request({ userId: principal.user.id, projectId: c.req.param('id'), operation: 'resources', payload: {} }) as { resources: Array<{ id: string }> } : { resources: [] }
        if (principal.capability) listed.resources = listed.resources.filter(r => principal.capability!.actionIds.includes(r.id))
        let discovery: unknown = {}
        if (canDiscoverGit) {
            try { discovery = await config.repositoryDiscovery!(c.req.raw, c.req.param('id')) }
            catch (error) {
                if (!canListActions || error instanceof EvolvedError && [401, 403].includes(error.status)) throw error
                discovery = { git: { error: 'Repository-Metadaten sind vorübergehend nicht verfügbar. Bitte evolved_repositories erneut abfragen.' } }
            }
        }
        const live = await authenticateEvolvedRequest(c.req.raw, store)
        if (!live) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        store.requireProject(live.user.id, c.req.param('id'))
        if (canListActions) requireScope(live, 'resource:execute', c.req.param('id'))
        return c.json({ ...listed, ...(discovery as object) })
    })
    app.post('/projects/:id/resources/:resourceId/invoke', async c => {
        await parseBody(c, z.object({ action: z.literal('execute'), input: z.object({}).strict().default({}) }).strict())
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireScope(principal, 'resource:execute', c.req.param('id'))
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'member')
        if (principal.capability && !principal.capability.actionIds.includes(c.req.param('resourceId'))) throw new EvolvedError('action_denied', 'Capability does not allow this resource.', 403)
        const key = c.req.header('idempotency-key')
        if (!key || key.length < 8 || key.length > 128) throw new EvolvedError('idempotency_required', 'Idempotency-Key header is required.')
        return c.json(await vault.request({ userId: principal.user.id, projectId: project.id, operation: 'invoke', payload: { actionId: c.req.param('resourceId'), profile: project.profile, idempotencyKey: key } }))
    })
    return app
}
