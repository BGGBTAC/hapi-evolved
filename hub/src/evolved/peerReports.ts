import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { SyncEvent } from '@hapi/protocol/types'
import type { SyncEngine } from '../sync/syncEngine'
import { permissionAllowed } from './bridge'
import { EvolvedError, EvolvedStore } from './store'
import { consumePeerRate, ensurePeerTables, peerEnvelope, peerPolicy } from './peers'

type Child = { project_id: string; child_id: string; parent_id: string; auto_report: number; spawn_operation_id: string; user_id: string; profile: string; capability_id: string; lease_id: string | null }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }

export class PeerCompletionReporter {
    constructor(private readonly store: EvolvedStore, private readonly engine: SyncEngine) { ensurePeerTables(store) }
    async handle(event: SyncEvent): Promise<void> {
        if (event.type !== 'message-received') return
        const envelope = unwrapRoleWrappedRecordEnvelope(event.message.content)
        if (envelope?.role !== 'agent') return
        const content = record(envelope?.content), data = record(content?.data) ?? content
        if (data?.type !== 'hapi-turn-completed' || typeof data.turnId !== 'string' || data.turnId.length > 128 || !['completed', 'failed', 'interrupted'].includes(String(data.status))) return
        const child = this.store.db.prepare('SELECT * FROM evolved_peer_children WHERE child_id=? AND auto_report=1').get(event.sessionId) as Child | null
        if (!child) return
        let project
        try {
            project = this.store.requireProject(child.user_id, child.project_id, 'admin')
            if (project.profile !== child.profile || !peerPolicy(this.store, project.id).enabled) return
            const row = child.lease_id
                ? this.store.db.prepare('SELECT scopes FROM evolved_runner_leases WHERE id=? AND project_id=? AND user_id=? AND profile=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').get(child.lease_id, project.id, child.user_id, child.profile, this.store.now())
                : this.store.db.prepare('SELECT scopes FROM evolved_capabilities WHERE id=? AND project_id=? AND user_id=? AND profile=? AND revoked_at IS NULL AND expires_at>?').get(child.capability_id, project.id, child.user_id, child.profile, this.store.now())
            if (!row || !(JSON.parse((row as { scopes: string }).scopes) as string[]).includes('peers:send')) return
        } catch { return }
        const source = this.engine.getSessionByNamespace(child.child_id, project.namespace)
        const parent = this.engine.getSessionByNamespace(child.parent_id, project.namespace)
        if (!source || !parent || source.metadata?.flavor !== 'codex' || parent.id === source.id || !permissionAllowed(project, parent.permissionMode)) return
        const prompt = await this.engine.getLatestUserMessage(child.child_id)
        // Fail closed when the turn's cause is unknown. Initial spawn remit may
        // report once; ordinary peer pings/reports cannot generate another report.
        if (!prompt || prompt.invokedAt === null) return
        try {
            const current = this.store.requireProject(child.user_id, child.project_id, 'admin')
            if (current.profile !== child.profile || !peerPolicy(this.store, current.id).enabled) return
            const table = child.lease_id ? 'evolved_runner_leases' : 'evolved_capabilities'
            const expiry = child.lease_id ? '(expires_at IS NULL OR expires_at>?)' : 'expires_at>?'
            const row = this.store.db.prepare(`SELECT scopes FROM ${table} WHERE id=? AND project_id=? AND user_id=? AND profile=? AND revoked_at IS NULL AND ${expiry}`)
                .get(child.lease_id ?? child.capability_id, current.id, child.user_id, child.profile, this.store.now()) as { scopes: string } | null
            if (!row || !(JSON.parse(row.scopes) as string[]).includes('peers:send')) return
        } catch { return }
        const currentParent = this.engine.getSessionByNamespace(child.parent_id, project.namespace)
        if (!currentParent || !permissionAllowed(project, currentParent.permissionMode)) return
        const promptMeta = record(unwrapRoleWrappedRecordEnvelope(prompt.content)?.meta)
        const peer = record(promptMeta?.peer)
        if (peer && !(prompt.localId === `peer-spawn:${child.spawn_operation_id}` && peer.deliveryId === child.spawn_operation_id)) return
        if (this.store.db.prepare('SELECT 1 FROM evolved_peer_reports WHERE child_id=? AND (turn_id=? OR prompt_message_id=?)').get(source.id, data.turnId, prompt.id)) return
        if ((this.store.db.prepare('SELECT COUNT(*) AS n FROM evolved_peer_reports r JOIN evolved_peer_children c ON c.child_id=r.child_id WHERE c.project_id=?').get(project.id) as { n: number }).n >= 50_000) return
        const inserted = this.store.db.prepare("INSERT OR IGNORE INTO evolved_peer_reports VALUES(?,?,?,'dispatching',?)").run(source.id, data.turnId, prompt.id, this.store.now())
        if (!inserted.changes) return
        try {
            consumePeerRate(this.store, project.id, 'report', 30)
        } catch (error) {
            const state = error instanceof EvolvedError && error.code === 'peer_rate_limited' ? 'rate_limited' : 'indeterminate'
            this.store.db.prepare('UPDATE evolved_peer_reports SET state=? WHERE child_id=? AND turn_id=?').run(state, source.id, data.turnId)
            return
        }
        try {
            const reportId = `report:${source.id}:${data.turnId}`
            const finalText = typeof data.finalText === 'string' ? data.finalText.slice(0, 24_000) : ''
            await this.engine.sendMessage(parent.id, {
                text: peerEnvelope(source.id, reportId, `Codex turn ${data.status}.\n${finalText}`), localId: reportId,
                trustedPeer: { projectId: project.id, claimedSenderSessionId: source.id, recipientSessionId: parent.id, deliveryId: reportId }
            })
            this.store.db.prepare("UPDATE evolved_peer_reports SET state='accepted' WHERE child_id=? AND turn_id=?").run(source.id, data.turnId)
        } catch {
            // Stable identity plus a durable uncertain outcome prevents restart loops.
            this.store.db.prepare("UPDATE evolved_peer_reports SET state='indeterminate' WHERE child_id=? AND turn_id=?").run(source.id, data.turnId)
        }
    }
    start(): () => void { return this.engine.subscribe(event => { void this.handle(event).catch(() => {}) }) }
}
