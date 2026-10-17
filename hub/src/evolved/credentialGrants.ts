import { Hono } from 'hono'
import { z } from 'zod'
import { isCredentialEnvName } from '@hapi/protocol/credentialEnv'
import { EvolvedError, type EvolvedProject, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, parseBody, requireFreshPasskey, requireHuman, requireScope, type EvolvedEnv } from './security'
import type { VaultClient } from './vault'
import type { AgentCredentialGrant } from './agentCredentialVault'

const mutations = new WeakMap<EvolvedStore, Map<string, { pending: Promise<unknown>; count: number }>>()
export async function withCredentialProjectLock<T>(store: EvolvedStore, projectId: string, run: () => Promise<T>): Promise<T> {
    let projects = mutations.get(store)
    if (!projects) { projects = new Map(); mutations.set(store, projects) }
    let entry = projects.get(projectId)
    if (!entry) { entry = { pending: Promise.resolve(), count: 0 }; projects.set(projectId, entry) }
    if (entry.count >= 8) throw new EvolvedError('credential_busy', 'Zu viele gleichzeitige Zugangsdatenanfragen. Bitte kurz warten.', 429)
    entry.count++
    const pending = entry.pending.catch(() => undefined).then(run)
    entry.pending = pending
    try { return await pending } finally { if (--entry.count === 0) projects.delete(projectId) }
}

export function getManagedCredentialLease(store: EvolvedStore, project: EvolvedProject): { id: string; name: string } | null {
    if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evolved_managed_runners'").get()) return null
    const lease = store.db.query(`SELECT l.id,l.name,l.user_id FROM evolved_managed_runners m JOIN evolved_runner_leases l ON l.id=m.lease_id
        WHERE m.project_id=? AND m.ready=1 AND l.project_id=? AND l.profile=? AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?)`)
        .get(project.id, project.id, project.profile, store.now()) as { id: string; name: string; user_id: string } | null
    if (!lease) return null
    try { store.requireProject(lease.user_id, project.id, 'admin') } catch { return null }
    return { id: lease.id, name: lease.name }
}

/** Revoking a leaked child-process environment requires terminating its entire project runner. */
export function revokeCredentialLeases(store: EvolvedStore, projectId: string, grants: Array<Pick<AgentCredentialGrant, 'leaseId'>>): void {
    for (const leaseId of new Set(grants.map(grant => grant.leaseId))) {
        store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND project_id=?').run(store.now(), leaseId, projectId)
    }
}

export function createCredentialGrantRoutes(store: EvolvedStore, vault: VaultClient): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>(), path = '/projects/:id/secret-grants'
    const list = async (userId: string, projectId: string) => await vault.request({ userId, projectId, operation: 'agentCredentials', payload: { action: 'list' } }) as { grants: AgentCredentialGrant[] }
    app.get(path, async c => {
        const principal = c.get('principal'); requireHuman(principal)
        store.requireProject(principal.user.id, c.req.param('id'))
        const result = await list(principal.user.id, c.req.param('id'))
        const live = await authenticateEvolvedRequest(c.req.raw, store)
        if (!live) throw new EvolvedError('unauthorized', 'Anmeldung erforderlich.', 401)
        requireHuman(live)
        const project = store.requireProject(live.user.id, c.req.param('id'))
        return c.json({ ...result, managedRunner: getManagedCredentialLease(store, project) })
    })
    app.post(path, async c => withCredentialProjectLock(store, c.req.param('id'), async () => {
        const body = await parseBody(c, z.object({ id: z.string().uuid(), secretId: z.string().uuid(), leaseId: z.string().uuid(), envName: z.string().refine(isCredentialEnvName), acknowledgeProcessAccess: z.literal(true) }).strict())
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        if (getManagedCredentialLease(store, project)?.id !== body.leaseId) throw new EvolvedError('credential_runner_changed', 'Der Projektdienst ist nicht mehr aktiv. Verbinde ihn erneut und lade die Freigaben neu.', 409)
        let result: unknown, committed = false
        try {
            result = await vault.request({ userId: principal.user.id, projectId: project.id, operation: 'agentCredentials', payload: { action: 'grant', id: body.id, secretId: body.secretId, leaseId: body.leaseId, envName: body.envName, profile: project.profile } })
            committed = true
            const live = await authenticateEvolvedRequest(c.req.raw, store)
            if (!live) throw new EvolvedError('unauthorized', 'Anmeldung erforderlich.', 401)
            requireFreshPasskey(c, store, live)
            const current = store.requireProject(live.user.id, project.id, 'admin')
            if (getManagedCredentialLease(store, current)?.id !== body.leaseId || current.profile !== project.profile) throw new EvolvedError('credential_runner_changed', 'Der Projektdienst wurde während der Freigabe geändert.', 409)
            store.audit(live.user.id, project.id, 'agent_credential.granted', body.id)
        } catch (error) {
            // A different administrator may own the runner. Losing the grantor's
            // session must not leave an unconfirmed, usable credential grant behind.
            // A timed-out signed request may still commit later in the Vault.
            // A definite validation rejection is safe; an unknown write is not.
            if (committed || !(error instanceof EvolvedError) || error.status >= 500) {
                revokeCredentialLeases(store, project.id, [{ leaseId: body.leaseId }])
                store.audit(principal.user.id, project.id, 'agent_credential.grant_invalidated', body.id)
            }
            throw error
        }
        return c.json(result, 201)
    }))
    app.delete(`${path}/:grantId`, async c => withCredentialProjectLock(store, c.req.param('id'), async () => {
        const principal = c.get('principal'); requireFreshPasskey(c, store, principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const result = await list(principal.user.id, project.id)
        const live = await authenticateEvolvedRequest(c.req.raw, store)
        if (!live) throw new EvolvedError('unauthorized', 'Anmeldung erforderlich.', 401)
        requireFreshPasskey(c, store, live); store.requireProject(live.user.id, project.id, 'admin')
        revokeCredentialLeases(store, project.id, result.grants.filter(grant => grant.id === c.req.param('grantId')))
        const response = await vault.request({ userId: live.user.id, projectId: project.id, operation: 'agentCredentials', payload: { action: 'revoke', id: c.req.param('grantId') } })
        store.audit(live.user.id, project.id, 'agent_credential.revoked', c.req.param('grantId'))
        return c.json(response)
    }))
    app.get('/projects/:id/agent-credentials', async c => {
        const principal = c.get('principal')
        requireScope(principal, 'runner:connect', c.req.param('id'))
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'member')
        const lease = getManagedCredentialLease(store, project)
        if (!principal.capability?.leaseId || lease?.id !== principal.capability.leaseId) throw new EvolvedError('credential_runner_required', 'Zugangsdatenfreigaben sind an den verwalteten Projektdienst gebunden.', 403)
        const result = await vault.request({ userId: principal.user.id, projectId: project.id, operation: 'agentCredentials', payload: { action: 'metadata', leaseId: lease.id, profile: project.profile } })
        const live = await authenticateEvolvedRequest(c.req.raw, store)
        if (!live) throw new EvolvedError('unauthorized', 'Anmeldung erforderlich.', 401)
        requireScope(live, 'runner:connect', project.id)
        const current = store.requireProject(live.user.id, project.id, 'member')
        if (getManagedCredentialLease(store, current)?.id !== lease.id || live.capability?.leaseId !== lease.id || current.profile !== project.profile) throw new EvolvedError('credential_runner_changed', 'Der Projektdienst wurde geändert.', 403)
        return c.json({ ...(result as object), delivery: 'new-agent-process', instructions: 'Only explicitly granted variable names are listed. Values are delivered to newly started agent processes. Never print their values or put them in prompts, memory, source files or logs. Ask an administrator to use Project Vault → Agent access when a required variable is not granted.' })
    })
    return app
}
