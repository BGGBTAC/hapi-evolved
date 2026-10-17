import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { AgentCredentialVault } from './agentCredentialVault'

test('credential delegation rejects invalid UTF-8 before persisting a grant and preserves exact valid text', () => {
    const db = new Database(':memory:')
    try {
        db.exec('CREATE TABLE secrets(id TEXT,project_id TEXT,version INTEGER,ciphertext BLOB); CREATE TABLE audit(user_id TEXT,project_id TEXT,operation TEXT,target_id TEXT,at INTEGER)')
        const secretId = randomUUID(), leaseId = randomUUID()
        db.query('INSERT INTO secrets VALUES(?,?,1,?)').run(secretId, 'project', Buffer.from([255]))
        let bytes = Buffer.from([255])
        const vault = new AgentCredentialVault(db, () => Buffer.from(bytes))
        const grant = { action: 'grant', id: randomUUID(), secretId, leaseId, profile: 'workspace', envName: 'PROJECT_SECRET_CANARY' }
        expect(() => vault.request('admin', 'project', grant)).toThrow('UTF-8')
        expect(db.query('SELECT COUNT(*) AS n FROM agent_credential_grants').get()).toEqual({ n: 0 })
        const valid = '\uFEFFsynthetic\nGrüße-日本語'
        bytes = Buffer.from(valid)
        vault.request('admin', 'project', grant)
        expect(vault.request('admin', 'project', { action: 'resolve', leaseId, profile: 'workspace' })).toMatchObject({ environment: { PROJECT_SECRET_CANARY: valid } })
        bytes = Buffer.from([255])
        expect(() => vault.request('admin', 'project', { action: 'resolve', leaseId, profile: 'workspace' })).toThrow('UTF-8')
    } finally { db.close() }
})
