import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isCredentialEnvName, MAX_AGENT_CREDENTIALS, MAX_AGENT_CREDENTIAL_BYTES } from '@hapi/protocol/credentialEnv'
import { EvolvedError, type AgentProfile } from './store'

export type AgentCredentialGrant = {
    id: string; secretId: string; leaseId: string; profile: AgentProfile; envName: string
    secretVersion: number; createdAt: number
}
type GrantRow = { id: string; project_id: string; secret_id: string; lease_id: string; profile: AgentProfile; env_name: string; created_at: number; version: number }
const scope = { leaseId: z.string().uuid(), profile: z.enum(['restricted', 'workspace', 'extended']) }
const grantSchema = z.object({ action: z.literal('grant'), id: z.string().uuid(), secretId: z.string().uuid(), ...scope, envName: z.string().refine(isCredentialEnvName) }).strict()
const resolveSchema = z.object({ action: z.enum(['resolve', 'metadata']), ...scope }).strict()
const metadata = (row: GrantRow): AgentCredentialGrant => ({ id: row.id, secretId: row.secret_id, leaseId: row.lease_id, profile: row.profile, envName: row.env_name, secretVersion: row.version, createdAt: row.created_at })
function credentialText(clear: Uint8Array): string {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(clear) }
    catch { throw new EvolvedError('invalid_credential_value', 'Der Wert muss gültiger UTF-8-Text sein, um als Umgebungsvariable bereitgestellt zu werden.') }
}

/** Plaintext resolution is an internal, signed Hub-to-runner operation, never a public API. */
export class AgentCredentialVault {
    constructor(private readonly db: Database, private readonly reveal: (projectId: string, secretId: string) => Buffer) {
        db.exec(`CREATE TABLE IF NOT EXISTS agent_credential_grants(
            id TEXT PRIMARY KEY,project_id TEXT NOT NULL,secret_id TEXT NOT NULL,lease_id TEXT NOT NULL,
            profile TEXT NOT NULL,env_name TEXT NOT NULL,created_at INTEGER NOT NULL,
            UNIQUE(project_id,lease_id,env_name));`)
    }
    purge(projectId: string): void { this.db.prepare('DELETE FROM agent_credential_grants WHERE project_id=?').run(projectId) }
    deleteSecret(projectId: string, secretId: string): void { this.db.prepare('DELETE FROM agent_credential_grants WHERE project_id=? AND secret_id=?').run(projectId, secretId) }
    private rows(projectId: string): GrantRow[] {
        return this.db.prepare('SELECT g.*,s.version FROM agent_credential_grants g JOIN secrets s ON s.id=g.secret_id AND s.project_id=g.project_id WHERE g.project_id=? ORDER BY g.env_name,g.id').all(projectId) as GrantRow[]
    }
    request(userId: string, projectId: string, payload: Record<string, unknown>): unknown {
        return this.db.transaction(() => this.apply(userId, projectId, payload))()
    }
    private apply(userId: string, projectId: string, payload: Record<string, unknown>): unknown {
        if (payload.action === 'list') return { grants: this.rows(projectId).map(metadata) }
        if (payload.action === 'revoke') {
            const parsed = z.object({ action: z.literal('revoke'), id: z.string().uuid() }).strict().safeParse(payload)
            if (!parsed.success) throw new EvolvedError('invalid_credential_grant', 'Ungültige Zugangsdatenfreigabe.')
            this.db.prepare('DELETE FROM agent_credential_grants WHERE project_id=? AND id=?').run(projectId, parsed.data.id)
            this.audit(userId, projectId, 'revoked', parsed.data.id)
            return { ok: true }
        }
        if (payload.action === 'grant') {
            const parsed = grantSchema.safeParse(payload)
            if (!parsed.success) throw new EvolvedError('invalid_credential_grant', 'Ungültige Freigabe oder reservierter Variablenname.')
            const input = parsed.data
            const exists = this.rows(projectId).find(row => row.id === input.id)
            if (exists) {
                if (exists.secret_id !== input.secretId || exists.lease_id !== input.leaseId || exists.profile !== input.profile || exists.env_name !== input.envName) throw new EvolvedError('credential_grant_conflict', 'Diese Freigabekennung wurde bereits verwendet.', 409)
                return { grant: metadata(exists) }
            }
            if (this.rows(projectId).filter(row => row.lease_id === input.leaseId).length >= MAX_AGENT_CREDENTIALS) throw new EvolvedError('credential_grant_limit', 'Für diesen Projektdienst sind bereits zu viele Zugangsdaten freigegeben.', 409)
            const clear = this.reveal(projectId, input.secretId)
            try {
                credentialText(clear)
                if (clear.includes(0)) throw new EvolvedError('invalid_credential_value', 'Dieser Wert kann nicht als Umgebungsvariable bereitgestellt werden.')
                const used = this.db.prepare('SELECT COALESCE(SUM(length(s.ciphertext)+length(g.env_name)+2),0) AS bytes FROM agent_credential_grants g JOIN secrets s ON s.id=g.secret_id AND s.project_id=g.project_id WHERE g.project_id=? AND g.lease_id=?').get(projectId, input.leaseId) as { bytes: number }
                if (used.bytes + clear.length + Buffer.byteLength(input.envName) + 2 > MAX_AGENT_CREDENTIAL_BYTES) throw new EvolvedError('credential_bundle_limit', 'Die freigegebenen Zugangsdaten überschreiten insgesamt 64 KiB.', 409)
            } finally { clear.fill(0) }
            const occupied = this.db.prepare('SELECT 1 FROM agent_credential_grants WHERE project_id=? AND lease_id=? AND env_name=?').get(projectId, input.leaseId, input.envName)
            if (occupied) throw new EvolvedError('credential_name_in_use', 'Dieser Variablenname ist bereits belegt. Widerrufe zuerst die bisherige Freigabe.', 409)
            this.db.prepare('INSERT INTO agent_credential_grants VALUES(?,?,?,?,?,?,?)').run(input.id, projectId, input.secretId, input.leaseId, input.profile, input.envName, Date.now())
            this.audit(userId, projectId, 'granted', input.id)
            return { grant: metadata(this.rows(projectId).find(row => row.id === input.id)!) }
        }
        const parsed = resolveSchema.safeParse(payload)
        if (!parsed.success) throw new EvolvedError('operation_denied', 'Unsupported credential operation.', 403)
        const rows = this.rows(projectId).filter(row => row.lease_id === parsed.data.leaseId && row.profile === parsed.data.profile)
        const revision = createHash('sha256').update(JSON.stringify([projectId, parsed.data.leaseId, parsed.data.profile, rows.map(metadata)])).digest('hex')
        const variables = rows.map(row => ({ name: row.env_name, version: row.version }))
        if (payload.action === 'metadata') return { revision, variables }
        const environment: Record<string, string> = {}
        let bytes = 0
        for (const row of rows) {
            if (!isCredentialEnvName(row.env_name)) throw new EvolvedError('invalid_credential_grant', 'Eine Zugangsdatenfreigabe verwendet einen reservierten Namen.', 409)
            const clear = this.reveal(projectId, row.secret_id)
            try {
                bytes += clear.length + Buffer.byteLength(row.env_name) + 2
                if (clear.includes(0) || bytes > MAX_AGENT_CREDENTIAL_BYTES || rows.length > MAX_AGENT_CREDENTIALS) throw new EvolvedError('credential_bundle_limit', 'Die freigegebenen Zugangsdaten überschreiten die Grenzen für die Agentenumgebung.', 409)
                environment[row.env_name] = credentialText(clear)
            } finally { clear.fill(0) }
        }
        for (const row of rows) this.audit(userId, projectId, 'resolved', row.id)
        return { revision, environment }
    }
    private audit(userId: string, projectId: string, action: string, targetId: string): void {
        this.db.prepare('INSERT INTO audit(user_id,project_id,operation,target_id,at) VALUES(?,?,?,?,?)').run(userId, projectId, `agent_credential.${action}`, targetId, Date.now())
    }
}
