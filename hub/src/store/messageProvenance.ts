import type { Database } from 'bun:sqlite'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { createHash } from 'node:crypto'

export type TrustedPeerProvenance = {
    projectId: string
    claimedSenderSessionId: string
    recipientSessionId: string
    deliveryId: string
    replyTo?: string
}
const initialized = new WeakSet<Database>()
export class MessageProvenanceConflictError extends Error {}
function contentHash(content: unknown): string {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    return createHash('sha256').update(JSON.stringify(record ? { role: record.role, content: record.content } : content) ?? '').digest('hex')
}
export function ensureMessageProvenanceTable(db: Database): void {
    if (initialized.has(db)) return
    db.exec(`CREATE TABLE IF NOT EXISTS hub_peer_provenance(
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        provenance TEXT NOT NULL,
        content_hash TEXT NOT NULL
    )`)
    initialized.add(db)
}
export function attestPeerMessage(db: Database, messageId: string, provenance: TrustedPeerProvenance, content: unknown, existing = false): void {
    ensureMessageProvenanceTable(db)
    const prior = db.prepare('SELECT provenance,content_hash FROM hub_peer_provenance WHERE message_id=?').get(messageId) as { provenance: string; content_hash: string } | null
    const digest = contentHash(content)
    if (existing && (!prior || prior.provenance !== JSON.stringify(provenance) || prior.content_hash !== digest)) throw new MessageProvenanceConflictError('Peer delivery ID conflicts with an existing message')
    db.prepare('INSERT OR IGNORE INTO hub_peer_provenance VALUES(?,?,?)').run(messageId, JSON.stringify(provenance), digest)
}

/** Remove reserved metadata from every object in a JSON transcript, including unknown wrappers. */
function stripReservedPeerMetadata(value: unknown, depth = 0): unknown {
    if (depth > 64) return null // Unsupported deeply nested records never gain provenance.
    if (Array.isArray(value)) return value.map(item => stripReservedPeerMetadata(item, depth + 1))
    if (!value || typeof value !== 'object') return value
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
        if (key === 'meta' && child && typeof child === 'object' && !Array.isArray(child)) {
            const meta = { ...child as Record<string, unknown> }
            delete meta.peer; delete meta.peerAuthenticated
            if (meta.sentFrom === 'peer') meta.sentFrom = 'cli'
            result[key] = stripReservedPeerMetadata(meta, depth + 1)
        } else result[key] = stripReservedPeerMetadata(child, depth + 1)
    }
    return result
}

/** Raw transcript metadata is untrusted; only a hub-owned side row grants a badge. */
export function decorateMessageProvenance(db: Database, messageId: string, content: unknown): unknown {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return stripReservedPeerMetadata(content)
    ensureMessageProvenanceTable(db)
    const stored = db.prepare('SELECT provenance,content_hash FROM hub_peer_provenance WHERE message_id=?').get(messageId) as { provenance: string; content_hash: string } | null
    const clean = stripReservedPeerMetadata(content) as Record<string, unknown>
    const source = unwrapRoleWrappedRecordEnvelope(clean) as Record<string, unknown> | null
    if (!source || stored?.content_hash !== contentHash(content)) return clean
    const meta = source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta) ? source.meta as Record<string, unknown> : {}
    const sanitized = { ...source, meta: { ...meta, peer: { ...JSON.parse(stored.provenance) as TrustedPeerProvenance, trust: 'project-runner' }, sentFrom: 'peer' } }
    if (source === clean) return sanitized
    if (clean.message === source) return { ...clean, message: sanitized }
    for (const key of ['data', 'payload']) {
        const container = clean[key] as Record<string, unknown> | undefined
        if (container?.message === source) return { ...clean, [key]: { ...container, message: sanitized } }
    }
    return clean
}
