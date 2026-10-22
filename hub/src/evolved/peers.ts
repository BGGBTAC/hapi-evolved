import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../sync/syncEngine'
import { EvolvedError, EvolvedStore, hashToken, type EvolvedPrincipal } from './store'
import { authenticateEvolvedRequest, parseBody, requireFreshPasskey, requireHuman, requireScope, type EvolvedEnv } from './security'
import { permissionAllowed, projectPermissionMode, withinProject } from './bridge'
import { toSessionSummaryMetadata } from '@hapi/protocol'
import { scoreSessionSearchMatch } from '../web/routes/sessionSearchMatch'
import { MessageProvenanceConflictError } from '../store/messageProvenance'
import { realpathSync } from 'node:fs'

const id = z.string().min(1).max(128)
const text = z.string().trim().min(1).max(32_000)
const initialized = new WeakSet<EvolvedStore>()
export function ensurePeerTables(store: EvolvedStore): void {
    if (initialized.has(store)) return
    store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_peer_policy(project_id TEXT PRIMARY KEY REFERENCES evolved_projects(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS evolved_peer_operations(project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,id TEXT NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,parent_id TEXT,PRIMARY KEY(project_id,id));
        CREATE TABLE IF NOT EXISTS evolved_peer_children(project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,child_id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,created_at INTEGER NOT NULL,auto_report INTEGER NOT NULL DEFAULT 0,spawn_operation_id TEXT NOT NULL,user_id TEXT NOT NULL,profile TEXT NOT NULL,capability_id TEXT NOT NULL,lease_id TEXT);
        CREATE TABLE IF NOT EXISTS evolved_peer_reports(child_id TEXT NOT NULL REFERENCES evolved_peer_children(child_id) ON DELETE CASCADE,turn_id TEXT NOT NULL,prompt_message_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(child_id,turn_id),UNIQUE(child_id,prompt_message_id));
        CREATE TABLE IF NOT EXISTS evolved_peer_rates(project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(project_id,kind,window));`)
    initialized.add(store)
}
export function consumePeerRate(store: EvolvedStore, projectId: string, kind: 'send' | 'spawn' | 'report', maximum: number): void {
    const window = Math.floor(store.now() / 60_000)
    store.db.transaction(() => {
        store.db.prepare('DELETE FROM evolved_peer_rates WHERE window<?').run(window - 2)
        const result = store.db.prepare('INSERT INTO evolved_peer_rates VALUES(?,?,?,1) ON CONFLICT(project_id,kind,window) DO UPDATE SET count=count+1 WHERE count<?').run(projectId, kind, window, maximum)
        if (!result.changes) throw new EvolvedError('peer_rate_limited', 'Project peer action rate exceeded. Retry after one minute.', 429)
    }).immediate()
}
export function peerPolicy(store: EvolvedStore, projectId: string): { enabled: boolean } {
    ensurePeerTables(store)
    const row = store.db.prepare('SELECT enabled FROM evolved_peer_policy WHERE project_id=?').get(projectId) as { enabled: number } | null
    return { enabled: row ? row.enabled === 1 : true }
}

/** A data envelope cannot be mistaken for a user slash command by an agent adapter. */
export function peerEnvelope(source: string, deliveryId: string, body: string): string {
    return `HAPI peer data (project-runner attested; sender session is a claimed reply address, not human authority).\n${JSON.stringify({ sourceSessionId: source, deliveryId, message: body })}`
}

export function createPeerRoutes(store: EvolvedStore, getEngine: () => SyncEngine | null): Hono<EvolvedEnv> {
    ensurePeerTables(store)
    const app = new Hono<EvolvedEnv>()
    const pending = new Map<string, Promise<unknown>>()
    app.use('*', async (c, next) => {
        if (!/\/(?:peers(?:\/[^/]+)?|projects\/[^/]+\/peer-policy)$/.test(c.req.path)) return next()
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        c.set('principal', principal)
        return next()
    })
    const engine = () => {
        const value = getEngine()
        if (!value) throw new EvolvedError('not_ready', 'Session service is not ready.', 503)
        return value
    }
    const access = (principal: EvolvedPrincipal, scope: string) => {
        if (!principal.capability) throw new EvolvedError('runner_required', 'Peer operations require a project runner.', 403)
        requireScope(principal, scope)
        const project = store.requireProject(principal.user.id, principal.capability.projectId, 'member')
        if (!peerPolicy(store, project.id).enabled) throw new EvolvedError('peers_disabled', 'Peer operations are disabled by the project administrator.', 403)
        return project
    }
    const session = (sessionId: string, namespace: string) => {
        const value = engine().getSessionByNamespace(sessionId, namespace)
        if (!value) throw new EvolvedError('not_found', 'Session not found in this project.', 404)
        return value
    }
    const current = async (request: Request, scope: string) => {
        const principal = await authenticateEvolvedRequest(request, store)
        if (!principal) throw new EvolvedError('revoked', 'Runner authorization expired.', 401)
        return access(principal, scope)
    }
    async function once(projectId: string, operationId: string, kind: string, payload: unknown, execute: () => Promise<unknown>) {
        const digest = hashToken(JSON.stringify(payload)), key = `${projectId}:${operationId}`
        const prior = store.db.prepare('SELECT * FROM evolved_peer_operations WHERE project_id=? AND id=?').get(projectId, operationId) as { payload_hash: string; kind: string; state: string; result: string | null } | null
        if (prior && (prior.payload_hash !== digest || prior.kind !== kind)) throw new EvolvedError('idempotency_conflict', 'This operation ID was used with different arguments.', 409)
        if (prior?.state === 'done') return JSON.parse(prior.result!) as unknown
        if (prior?.state === 'failed') {
            const error = JSON.parse(prior.result!) as { code: string; message: string; status: number }
            throw new EvolvedError(error.code, error.message, error.status)
        }
        if (pending.has(key)) return pending.get(key)!
        if (prior && kind === 'spawn') throw new EvolvedError('spawn_indeterminate', 'Spawn outcome is uncertain. Inspect existing peers before starting another.', 409)
        if (!prior && (store.db.prepare('SELECT COUNT(*) AS n FROM evolved_peer_operations WHERE project_id=?').get(projectId) as { n: number }).n >= 50_000) throw new EvolvedError('peer_capacity', 'Project peer operation capacity reached; operator maintenance is required.', 429)
        store.db.prepare("INSERT OR IGNORE INTO evolved_peer_operations VALUES(?,?,?,?,'pending',NULL,?,?)").run(projectId, operationId, kind, digest, store.now(), (payload as { senderSessionId?: string }).senderSessionId ?? null)
        const operation = execute().then(result => {
            store.db.prepare("UPDATE evolved_peer_operations SET state='done',result=? WHERE project_id=? AND id=?").run(JSON.stringify(result), projectId, operationId)
            return result
        }).catch(error => {
            if (error instanceof MessageProvenanceConflictError) error = new EvolvedError('idempotency_conflict', error.message, 409)
            if (error instanceof EvolvedError && ['peer_rate_limited', 'peer_capacity'].includes(error.code)) {
                // These guards run before external effects; the same ID may retry later.
                store.db.prepare('DELETE FROM evolved_peer_operations WHERE project_id=? AND id=?').run(projectId, operationId)
            } else if (error instanceof EvolvedError && !['spawn_failed', 'resume_failed'].includes(error.code)) store.db.prepare("UPDATE evolved_peer_operations SET state='failed',result=? WHERE project_id=? AND id=?").run(JSON.stringify({ code: error.code, message: error.message, status: error.status }), projectId, operationId)
            else store.db.prepare("UPDATE evolved_peer_operations SET state='indeterminate' WHERE project_id=? AND id=?").run(projectId, operationId)
            throw error
        }).finally(() => pending.delete(key))
        pending.set(key, operation)
        return operation
    }
    app.get('/projects/:id/peer-policy', c => {
        const cap = c.get('principal').capability
        if (cap && cap.projectId !== c.req.param('id')) throw new EvolvedError('scope_denied', 'Capability belongs to another project.', 403)
        store.requireProject(c.get('principal').user.id, c.req.param('id'))
        return c.json(peerPolicy(store, c.req.param('id')))
    })
    app.put('/projects/:id/peer-policy', async c => {
        const principal = c.get('principal'); requireHuman(principal); requireFreshPasskey(c, store, principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const body = await parseBody(c, z.object({ enabled: z.boolean() }).strict())
        store.db.prepare('INSERT INTO evolved_peer_policy VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled').run(project.id, body.enabled ? 1 : 0)
        store.audit(principal.user.id, project.id, body.enabled ? 'peers.enabled' : 'peers.disabled')
        return c.json(body)
    })
    app.get('/peers/status', c => {
        const principal = c.get('principal')
        if (!principal.capability) throw new EvolvedError('runner_required', 'Project runner required.', 403)
        return c.json({ ...peerPolicy(store, principal.capability.projectId), scopes: principal.capability.scopes })
    })
    app.get('/peers', c => {
        const project = access(c.get('principal'), 'peers:read')
        const query = (c.req.query('q') ?? '').trim().slice(0, 200).toLowerCase()
        const prefix = (c.req.query('prefix') ?? '').trim().slice(0, 128)
        const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
        const sessions = engine().getSessionsByNamespace(project.namespace).filter(s => (!prefix || s.id.startsWith(prefix)) && (!query || scoreSessionSearchMatch(s, query) > 0))
            .sort((a, b) => (query ? scoreSessionSearchMatch(b, query) - scoreSessionSearchMatch(a, query) : 0) || b.updatedAt - a.updatedAt).slice(0, limit)
            .map(s => ({ id: s.id, active: s.active, thinking: s.thinking, updatedAt: s.updatedAt, metadata: toSessionSummaryMetadata(s.metadata) }))
        return c.json({ sessions })
    })
    app.get('/peers/:id', c => {
        const project = access(c.get('principal'), 'peers:read'), target = session(c.req.param('id'), project.namespace)
        return c.json({ session: target, messages: engine().getMessagesPage(target.id, { limit: Math.min(50, Math.max(1, Number(c.req.query('limit')) || 10)) }).messages })
    })
    app.post('/peers/messages', async c => {
        const body = await parseBody(c, z.object({ senderSessionId: id, recipientSessionId: id, deliveryId: id, text, replyTo: id.optional(), resume: z.boolean().default(false) }).strict())
        const project = access(c.get('principal'), 'peers:send')
        session(body.senderSessionId, project.namespace); const target = session(body.recipientSessionId, project.namespace)
        if (!['claude', 'codex'].includes(target.metadata?.flavor ?? 'claude')) throw new EvolvedError('unsupported_agent', 'Peer delivery supports Claude and Codex only.')
        if (!permissionAllowed(project, target.permissionMode)) throw new EvolvedError('profile_denied', 'Recipient permissions exceed the project profile.', 403)
        if (body.replyTo) {
            const reply = store.db.prepare("SELECT result FROM evolved_peer_operations WHERE project_id=? AND id=? AND kind='send' AND state='done'").get(project.id, body.replyTo) as { result: string } | null
            const value = reply ? JSON.parse(reply.result) as { sessionId: string; senderSessionId: string } : null
            if (!value || value.sessionId !== body.senderSessionId || value.senderSessionId !== body.recipientSessionId) throw new EvolvedError('reply_mismatch', 'Reply does not match the prior handoff.', 409)
        }
        return c.json(await once(project.id, body.deliveryId, 'send', body, async () => {
            consumePeerRate(store, project.id, 'send', 60)
            let resumed = false
            let recipient = target
            if (!target.active) {
                if (target.metadata?.lifecycleState === 'archived' && !store.db.prepare('SELECT 1 FROM evolved_peer_children WHERE project_id=? AND child_id=?').get(project.id, target.id)) throw new EvolvedError('human_resume_required', 'A human must resume this archived session.', 403)
                if (!body.resume) throw new EvolvedError('inactive', 'Recipient is inactive; explicit resume is required.', 409)
                const result = await engine().resumeSession(target.id, project.namespace, { permissionMode: projectPermissionMode(project, target.metadata?.flavor) })
                if (result.type !== 'success') throw new EvolvedError('resume_failed', 'Recipient could not be resumed.', 409)
                recipient = session(result.sessionId, project.namespace)
                resumed = true
            }
            await current(c.req.raw, 'peers:send')
            const envelope = peerEnvelope(body.senderSessionId, body.deliveryId, body.text)
            await engine().sendMessage(recipient.id, { text: envelope, localId: `peer:${body.deliveryId}`, trustedPeer: { projectId: project.id, claimedSenderSessionId: body.senderSessionId, recipientSessionId: recipient.id, deliveryId: body.deliveryId, ...(body.replyTo ? { replyTo: body.replyTo } : {}) } })
            store.audit(c.get('principal').user.id, project.id, 'peer.sent', recipient.id)
            return { sessionId: recipient.id, senderSessionId: body.senderSessionId, deliveryId: body.deliveryId, resumed, acknowledged: 'persisted', name: recipient.metadata?.name ?? recipient.id }
        }))
    })
    app.post('/peers/spawn', async c => {
        const body = await parseBody(c, z.object({ senderSessionId: id, operationId: id, remit: text, autoReport: z.boolean().default(false), agent: z.enum(['claude', 'codex']).default('claude'), directory: z.string().max(4096).optional() }).strict())
        const project = access(c.get('principal'), 'peers:manage'), parent = session(body.senderSessionId, project.namespace)
        if (body.autoReport) { requireScope(c.get('principal'), 'peers:send'); store.requireProject(c.get('principal').user.id, project.id, 'admin') }
        if (body.autoReport && body.agent !== 'codex') throw new EvolvedError('unsupported_report', 'Automatic completion reports currently require Codex.')
        const directory = body.directory ?? parent.metadata?.path ?? project.rootPath
        if (!withinProject(project, directory)) throw new EvolvedError('path_denied', 'Directory is outside this project.', 403)
        let canonicalDirectory: string
        try { canonicalDirectory = realpathSync(directory) } catch { throw new EvolvedError('path_denied', 'Project directory is unavailable.', 403) }
        if (!withinProject(project, canonicalDirectory)) throw new EvolvedError('path_denied', 'Directory changed outside this project.', 403)
        const machineId = parent.metadata?.machineId
        if (!machineId || !engine().getMachineByNamespace(machineId, project.namespace)) throw new EvolvedError('runner_unavailable', 'Parent runner is unavailable.', 409)
        return c.json(await once(project.id, body.operationId, 'spawn', body, async () => {
            consumePeerRate(store, project.id, 'spawn', 8)
            const children = store.db.prepare('SELECT child_id,parent_id FROM evolved_peer_children WHERE project_id=?').all(project.id) as Array<{ child_id: string; parent_id: string }>
            const live = children.filter(child => { const s = engine().getSessionByNamespace(child.child_id, project.namespace); return s && s.metadata?.lifecycleState !== 'archived' })
            let ancestor = parent.id, depth = 0
            const visited = new Set<string>()
            while (!visited.has(ancestor)) { visited.add(ancestor); const prior = children.find(child => child.child_id === ancestor); if (!prior) break; depth++; ancestor = prior.parent_id }
            const pendingSpawns = store.db.prepare("SELECT COUNT(*) AS n, SUM(parent_id=?) AS parent_n FROM evolved_peer_operations WHERE project_id=? AND kind='spawn' AND state='pending' AND created_at>?").get(parent.id, project.id, store.now() - 10 * 60_000) as { n: number; parent_n: number }
            if (live.length + pendingSpawns.n > 32 || live.filter(child => child.parent_id === parent.id).length + pendingSpawns.parent_n > 8 || depth >= 3) throw new EvolvedError('peer_capacity', 'Peer limits reached (32 project workers, 8 per parent, depth 3).', 429)
            const spawned = await engine().spawnSession(machineId, canonicalDirectory, body.agent, undefined, undefined, false, 'simple', undefined, undefined, undefined, projectPermissionMode(project, body.agent), undefined, undefined, undefined, undefined, 'remote', project.namespace)
            if (spawned.type !== 'success') throw new EvolvedError('spawn_failed', 'Spawn was not confirmed. Inspect peers before retrying.', 409)
            const childId = spawned.sessionId
            const principal = c.get('principal'), capId = principal.capability!.id
            const lease = store.db.prepare('SELECT lease_id FROM evolved_capabilities WHERE id=?').get(capId) as { lease_id: string | null } | null
            store.db.prepare('INSERT INTO evolved_peer_children VALUES(?,?,?,?,?,?,?,?,?,?)').run(project.id, childId, parent.id, store.now(), body.autoReport ? 1 : 0, body.operationId, principal.user.id, project.profile, capId, lease?.lease_id ?? null)
            try {
                await current(c.req.raw, 'peers:manage')
                await engine().sendMessage(childId, { text: peerEnvelope(parent.id, body.operationId, body.remit), localId: `peer-spawn:${body.operationId}`, trustedPeer: { projectId: project.id, claimedSenderSessionId: parent.id, recipientSessionId: childId, deliveryId: body.operationId } })
                const accepted = engine().getMessagesPage(childId, { limit: 50 }).messages.find(message => message.localId === `peer-spawn:${body.operationId}`)
                if (!accepted) throw new Error('Remit readback failed')
                store.audit(principal.user.id, project.id, 'peer.spawned', childId)
                return { sessionId: childId, parentSessionId: parent.id, operationId: body.operationId, acknowledged: 'persisted', messageId: accepted.id }
            } catch (error) {
                try { await engine().archiveSession(childId) } catch { /* uncertain cleanup stays visible */ }
                throw error
            }
        }), 201)
    })
    app.post('/peers/archive', async c => {
        const body = await parseBody(c, z.object({ senderSessionId: id, sessionId: id, operationId: id }).strict())
        const project = access(c.get('principal'), 'peers:manage')
        session(body.senderSessionId, project.namespace); const target = session(body.sessionId, project.namespace)
        if (target.thinking || (target.backgroundTaskCount ?? 0) > 0 || Object.keys(target.agentState?.requests ?? {}).length > 0) throw new EvolvedError('worker_busy', 'Peer worker is still working or waiting for input; archive it after completion.', 409)
        const child = store.db.prepare('SELECT parent_id FROM evolved_peer_children WHERE project_id=? AND child_id=?').get(project.id, body.sessionId) as { parent_id: string } | null
        if (!child) throw new EvolvedError('not_owned', 'Runner automation may archive only hub-registered peer workers. Archive ordinary sessions from the human UI.', 403)
        return c.json(await once(project.id, body.operationId, 'archive', body, async () => {
            await engine().archiveSession(body.sessionId)
            store.audit(c.get('principal').user.id, project.id, 'peer.archived', body.sessionId)
            return { sessionId: body.sessionId, archived: true }
        }))
    })
    return app
}
