import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EvolvedError, hashToken, privateFile, type AgentProfile } from './store'

export type SecretMetadata = { id: string; projectId: string; name: string; version: number; createdAt: number; updatedAt: number }
export type ResourceAction = {
    id: string; projectId: string; name: string; profiles: AgentProfile[]
    timeoutSeconds?: number
} & ({ type: 'http'; url: string; method: 'GET' | 'HEAD' | 'POST'; secretId?: string; header?: string; prefix?: string; expectedStatus?: number }
    | { type: 'ssh'; host: string; port?: number; user: string; command: string; secretId: string; knownHostsFile: string })
export type VaultRequest = { userId: string; projectId: string; operation: 'list' | 'set' | 'delete' | 'resources' | 'invoke' | 'purgeProject'; payload: Record<string, unknown> }
export interface VaultClient { request(input: VaultRequest): Promise<unknown> }
type Envelope = VaultRequest & { expiresAt: number; nonce: string }
type CipherRow = { id: string; project_id: string; name: string; version: number; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array; created_at: number; updated_at: number }
type BrokerResult = { status: 'succeeded' | 'failed' | 'indeterminate'; httpStatus?: number; exitCode?: number }

function encrypted(key: Uint8Array, plaintext: Uint8Array, aad: string): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(aad))
    return { nonce, ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), tag: cipher.getAuthTag() }
}
function decrypted(key: Uint8Array, row: { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }, aad: string): Buffer {
    try {
        const cipher = createDecipheriv('aes-256-gcm', key, row.nonce)
        cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(Buffer.from(row.tag))
        return Buffer.concat([cipher.update(row.ciphertext), cipher.final()])
    } catch { throw new EvolvedError('vault_integrity', 'Encrypted record failed integrity verification.', 500) }
}
function metadata(row: CipherRow): SecretMetadata { return { id: row.id, projectId: row.project_id, name: row.name, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } }

/** Lives in the dedicated vault process. No plaintext read operation is exposed by its protocol. */
export class EvolvedVault implements VaultClient {
    readonly db: Database
    private readonly masterKey: Buffer
    private readonly actions: ResourceAction[]
    constructor(options: { dbPath: string; masterKeyFile: string; workspaceRoot?: string; actions?: ResourceAction[] }) {
        if (!isAbsolute(options.masterKeyFile)) throw new EvolvedError('key_path', 'Vault master key path must be absolute.', 500)
        mkdirSync(dirname(options.masterKeyFile), { recursive: true, mode: 0o700 })
        const workspace = realpathSync(options.workspaceRoot ?? process.cwd())
        const rel = relative(workspace, realpathSync(dirname(options.masterKeyFile)))
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new EvolvedError('key_in_workspace', 'Vault master key must be outside the workspace.', 500)
        this.masterKey = privateFile(options.masterKeyFile, randomBytes(32))
        if (this.masterKey.length !== 32) throw new EvolvedError('invalid_key', 'Invalid vault master key length.', 500)
        if (options.dbPath !== ':memory:') {
            mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 })
            const fd = openSync(options.dbPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
            const st = fstatSync(fd); closeSync(fd)
            if (!st.isFile() || (st.mode & 0o077) !== 0 || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid())) throw new EvolvedError('insecure_database', 'Vault database must be private.', 500)
        }
        this.db = new Database(options.dbPath, { create: true, strict: true })
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS project_keys(project_id TEXT PRIMARY KEY,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project_id,name));
            CREATE TABLE IF NOT EXISTS requests(nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS revoked_projects(project_id TEXT PRIMARY KEY,revoked_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT,UNIQUE(user_id,project_id,request_key));
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL,operation TEXT NOT NULL,target_id TEXT,at INTEGER NOT NULL);
        `)
        this.db.prepare("UPDATE runs SET status='indeterminate',result=? WHERE status='running'").run(JSON.stringify({ status: 'indeterminate' }))
        this.actions = options.actions ?? []
        const ids = new Set<string>()
        for (const action of this.actions) {
            if (ids.has(action.id) || !action.id || !action.projectId || !action.profiles.length) throw new EvolvedError('invalid_action', 'Invalid configured resource action.', 500)
            ids.add(action.id)
            if (action.type === 'http') {
                const url = new URL(action.url)
                if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !['GET', 'HEAD', 'POST'].includes(action.method)) throw new EvolvedError('invalid_action', 'Invalid configured HTTP action.', 500)
                if (action.secretId && url.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new EvolvedError('insecure_action', 'HTTP actions carrying credentials require HTTPS outside literal loopback addresses.', 500)
                if (action.secretId && (!action.header || !/^[A-Za-z][A-Za-z0-9-]*$/.test(action.header))) throw new EvolvedError('invalid_action', 'Invalid configured secret header.', 500)
            } else if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(action.host) || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(action.user) || !action.command || !isAbsolute(action.knownHostsFile)) throw new EvolvedError('invalid_action', 'Invalid configured SSH action.', 500)
        }
    }
    close(): void { this.masterKey.fill(0); this.db.close() }
    private projectKey(projectId: string): Buffer {
        let row = this.db.prepare('SELECT * FROM project_keys WHERE project_id=?').get(projectId) as { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array } | null
        const aad = JSON.stringify(['hapi-evolved-project-key-v1', projectId])
        if (!row) {
            const key = randomBytes(32), wrapped = encrypted(this.masterKey, key, aad)
            try { this.db.prepare('INSERT INTO project_keys VALUES(?,?,?,?)').run(projectId, wrapped.nonce, wrapped.ciphertext, wrapped.tag) } finally { key.fill(0) }
            row = wrapped
        }
        return decrypted(this.masterKey, row, aad)
    }
    private revealForAction(projectId: string, secretId: string): Buffer {
        const row = this.db.prepare('SELECT * FROM secrets WHERE id=? AND project_id=?').get(secretId, projectId) as CipherRow | null
        if (!row) throw new EvolvedError('secret_not_found', 'Resource credential unavailable.', 404)
        const key = this.projectKey(projectId)
        try { return decrypted(key, row, JSON.stringify(['hapi-evolved-secret-v1', projectId, secretId, row.version])) } finally { key.fill(0) }
    }
    async request(input: VaultRequest): Promise<unknown> {
        const { operation, projectId, userId, payload } = input
        if (!projectId || !userId) throw new EvolvedError('invalid_scope', 'Vault scope is required.', 400)
        if (operation === 'purgeProject') {
            this.db.transaction(() => {
                this.db.prepare('INSERT OR IGNORE INTO revoked_projects VALUES(?,?)').run(projectId, Date.now())
                this.db.prepare('DELETE FROM secrets WHERE project_id=?').run(projectId)
                this.db.prepare('DELETE FROM project_keys WHERE project_id=?').run(projectId)
                this.db.prepare('INSERT INTO audit(user_id,project_id,operation,target_id,at) VALUES(?,?,?,?,?)').run(userId, projectId, 'project.purged', projectId, Date.now())
            })()
            return { ok: true }
        }
        if (this.db.prepare('SELECT 1 FROM revoked_projects WHERE project_id=?').get(projectId)) throw new EvolvedError('project_revoked', 'Project has been deleted.', 403)
        if (operation === 'list') return { secrets: (this.db.prepare('SELECT * FROM secrets WHERE project_id=? ORDER BY name').all(projectId) as CipherRow[]).map(metadata) }
        if (operation === 'resources') return { resources: this.actions.filter(a => a.projectId === projectId).map(a => ({ id: a.id, name: a.name, type: a.type, actions: ['execute'], profiles: a.profiles })) }
        if (operation === 'set') {
            if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 120 || typeof payload.value !== 'string' || !payload.value || Buffer.byteLength(payload.value) > 64 * 1024) throw new EvolvedError('invalid_secret', 'Secret name and bounded value are required.')
            return this.db.transaction(() => {
                const id = typeof payload.id === 'string' ? payload.id : randomUUID()
                const prior = this.db.prepare('SELECT * FROM secrets WHERE id=? AND project_id=?').get(id, projectId) as CipherRow | null
                if (payload.id && !prior) throw new EvolvedError('not_found', 'Secret not found.', 404)
                const version = (prior?.version ?? 0) + 1, now = Date.now(), key = this.projectKey(projectId), value = Buffer.from(payload.value as string)
                let cipher
                try { cipher = encrypted(key, value, JSON.stringify(['hapi-evolved-secret-v1', projectId, id, version])) } finally { key.fill(0); value.fill(0) }
                this.db.prepare(`INSERT INTO secrets VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag,updated_at=excluded.updated_at`).run(id, projectId, payload.name as string, version, cipher.nonce, cipher.ciphertext, cipher.tag, prior?.created_at ?? now, now)
                this.db.prepare('INSERT INTO audit(user_id,project_id,operation,target_id,at) VALUES(?,?,?,?,?)').run(userId, projectId, 'secret.set', id, now)
                return { secret: { id, projectId, name: payload.name, version, createdAt: prior?.created_at ?? now, updatedAt: now } }
            })()
        }
        if (operation === 'delete') {
            if (typeof payload.id !== 'string') throw new EvolvedError('invalid_secret', 'Secret identifier required.')
            this.db.transaction(() => {
                this.db.prepare('DELETE FROM secrets WHERE id=? AND project_id=?').run(payload.id as string, projectId)
                this.db.prepare('INSERT INTO audit(user_id,project_id,operation,target_id,at) VALUES(?,?,?,?,?)').run(userId, projectId, 'secret.deleted', payload.id as string, Date.now())
            })()
            return { ok: true }
        }
        if (operation === 'invoke') return this.invoke(input)
        throw new EvolvedError('operation_denied', 'Unsupported vault operation.', 403)
    }
    private async invoke(input: VaultRequest): Promise<BrokerResult> {
        const { projectId, userId, payload } = input
        const action = this.actions.find(a => a.id === payload.actionId && a.projectId === projectId)
        if (!action || !action.profiles.includes(payload.profile as AgentProfile)) throw new EvolvedError('action_denied', 'Resource action is not authorized by this profile.', 403)
        if (typeof payload.idempotencyKey !== 'string' || payload.idempotencyKey.length < 8 || payload.idempotencyKey.length > 128) throw new EvolvedError('idempotency_required', 'An idempotency key is required.')
        const fingerprint = hashToken(JSON.stringify(action)), id = randomUUID()
        const previous = this.db.prepare('SELECT * FROM runs WHERE user_id=? AND project_id=? AND request_key=?').get(userId, projectId, payload.idempotencyKey) as { fingerprint: string; status: string; result: string | null } | null
        if (previous) {
            if (previous.fingerprint !== fingerprint) throw new EvolvedError('idempotency_conflict', 'Request key was used for a different resource configuration.', 409)
            return previous.result ? JSON.parse(previous.result) as BrokerResult : { status: 'indeterminate' }
        }
        this.db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,'running',NULL)").run(id, userId, projectId, payload.idempotencyKey, fingerprint)
        const timeout = Math.min(Math.max(action.timeoutSeconds ?? 15, 1), 60) * 1000
        let result: BrokerResult
        try {
            if (action.type === 'http') {
                const headers = new Headers()
                if (action.secretId) {
                    const secret = this.revealForAction(projectId, action.secretId)
                    try { headers.set(action.header!, (action.prefix ?? '') + secret.toString('utf8')) } finally { secret.fill(0) }
                }
                const response = await fetch(action.url, { method: action.method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout) })
                await response.body?.cancel()
                result = { status: response.status === (action.expectedStatus ?? 200) ? 'succeeded' : 'failed', httpStatus: response.status }
            } else {
                const secret = this.revealForAction(projectId, action.secretId), directory = await mkdtemp(join(tmpdir(), 'evolved-broker-'))
                try {
                    const keyPath = join(directory, 'identity')
                    await writeFile(keyPath, secret, { mode: 0o600 })
                    await promisify(execFile)('/usr/bin/ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${action.knownHostsFile}`, '-o', 'ConnectTimeout=10', '-i', keyPath, '-p', String(action.port ?? 22), `${action.user}@${action.host}`, action.command], { timeout, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
                    result = { status: 'succeeded', exitCode: 0 }
                } finally { secret.fill(0); await rm(directory, { recursive: true, force: true }) }
            }
        } catch {
            // Network failure/timeout can occur after the external effect. Never replay automatically.
            result = { status: 'indeterminate' }
        }
        this.db.prepare('UPDATE runs SET status=?,result=? WHERE id=?').run(result.status, JSON.stringify(result), id)
        this.db.prepare('INSERT INTO audit(user_id,project_id,operation,target_id,at) VALUES(?,?,?,?,?)').run(userId, projectId, `action.${result.status}`, action.id, Date.now())
        return result
    }
}

export function createVaultSigningKey(path: string): { publicKey: string } {
    const pair = generateKeyPairSync('ed25519')
    const secret = privateFile(path, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    const key = createPrivateKey(secret)
    secret.fill(0)
    return { publicKey: createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString() }
}
export class RemoteVaultClient implements VaultClient {
    private readonly signingKey
    constructor(private readonly config: { url: string; signingKeyFile: string; fetcher?: typeof fetch }) {
        const url = new URL(config.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new EvolvedError('invalid_vault_url', 'Invalid vault service URL.', 500)
        const raw = privateFile(config.signingKeyFile)
        try { this.signingKey = createPrivateKey(raw) } finally { raw.fill(0) }
    }
    async request(input: VaultRequest): Promise<unknown> {
        const body = JSON.stringify({ ...input, nonce: randomUUID(), expiresAt: Date.now() + 30_000 } satisfies Envelope)
        const signature = sign(null, Buffer.from(body), this.signingKey).toString('base64url')
        const result = await (this.config.fetcher ?? fetch)(new URL('/v1/request', this.config.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-evolved-signature': signature }, body, redirect: 'error', signal: AbortSignal.timeout(70_000) })
        const json = await result.json() as { error?: string; code?: string }
        if (!result.ok) throw new EvolvedError(json.code ?? 'vault_unavailable', json.error ?? 'Vault request failed.', result.status)
        return json
    }
}

export function verifyVaultEnvelope(body: string, signature: string, publicKey: string, vault: EvolvedVault): Envelope {
    if (body.length > 100_000 || signature.length > 200) throw new EvolvedError('invalid_capability', 'Invalid vault capability.', 401)
    let valid = false
    try { valid = verify(null, Buffer.from(body), publicKey, Buffer.from(signature, 'base64url')) } catch { /* sanitized below */ }
    if (!valid) throw new EvolvedError('invalid_capability', 'Invalid vault capability.', 401)
    let request: Envelope
    try { request = JSON.parse(body) as Envelope } catch { throw new EvolvedError('invalid_body', 'Invalid vault request.') }
    const now = Date.now()
    if (!request || typeof request.expiresAt !== 'number' || request.expiresAt <= now || request.expiresAt > now + 60_000 || typeof request.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(request.nonce) || typeof request.userId !== 'string' || typeof request.projectId !== 'string' || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) throw new EvolvedError('invalid_capability', 'Invalid or expired vault capability.', 401)
    vault.db.prepare('DELETE FROM requests WHERE expires_at<=?').run(now)
    const consumed = vault.db.prepare('INSERT OR IGNORE INTO requests VALUES(?,?)').run(request.nonce, request.expiresAt)
    if (consumed.changes !== 1) throw new EvolvedError('capability_replayed', 'Vault capability has already been used.', 409)
    return request
}
