import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { EvolvedError } from './store'

export const MCP_CONTEXT7_ENDPOINT = 'https://mcp.context7.com/mcp'
export const MCP_MAX_CATALOG_BYTES = 64 * 1024
export const MCP_MAX_ARGUMENT_BYTES = 64 * 1024
export const MCP_MAX_RESPONSE_BYTES = 512 * 1024
export type McpCredential = { mode: 'none' | 'bearer' | 'header'; token?: string; headerName?: string }
export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean; fingerprint: string }
export type McpStatus = { state: 'untested' | 'ready' | 'auth_required' | 'unreachable' | 'catalog_changed'; checkedAt: number | null; errorCode?: string }
export type McpConnection = {
    id: string; name: string; kind: 'context7' | 'custom'; endpoint: string; version: number; enabled: boolean
    auth: { mode: McpCredential['mode']; configured: boolean; headerName?: string }
    status: McpStatus; catalogRevision: string | null; tools: McpTool[]; enabledTools: string[]; createdAt: number; updatedAt: number
}
const identifier = z.string().uuid(), versionSchema = z.number().int().positive()
const names = z.array(z.string().min(1).max(200)).max(100)
const authSchema = z.object({ mode: z.enum(['none', 'bearer', 'header']), token: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/).optional(), headerName: z.string().max(64).optional() }).strict()
const statusSchema = z.object({ state: z.enum(['untested', 'ready', 'auth_required', 'unreachable', 'catalog_changed']), checkedAt: z.number().int().nonnegative().nullable(), errorCode: z.string().regex(/^[a-z_]{1,80}$/).optional() }).strict()
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new EvolvedError('mcp_invalid_configuration', 'Invalid MCP configuration.', 400)
    return result.data
}
export function validateMcpEndpoint(value: string): string {
    let url: URL
    try { url = new URL(value) } catch { throw new EvolvedError('mcp_endpoint_denied', 'Use a public HTTPS MCP endpoint on port 443.', 400) }
    if (value.length > 2048 || value !== value.trim() || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new EvolvedError('mcp_endpoint_denied', 'Use a public HTTPS MCP endpoint on port 443 without credentials, query or fragment.', 400)
    return url.href
}
export function validateMcpCredential(value: unknown, kind?: McpConnection['kind']): McpCredential {
    const auth = parse(authSchema, value)
    if (auth.mode === 'none') {
        if (auth.token !== undefined || auth.headerName !== undefined) throw new EvolvedError('mcp_invalid_configuration', 'No authentication must not include a key or header.', 400)
        return { mode: 'none' }
    }
    if (!auth.token || (auth.mode === 'bearer' && auth.headerName !== undefined) || (auth.mode === 'header' && (kind === 'context7' || !/^X-[A-Za-z0-9][A-Za-z0-9-]*$/i.test(auth.headerName ?? '') || /^x-(forwarded|real-ip|original|rewrite|http-method|method-override)/i.test(auth.headerName!)))) throw new EvolvedError('mcp_invalid_configuration', 'Use a bearer key or a permitted X-* key header.', 400)
    return auth
}
/** Canonical bounded JSON; no schema evaluation or remote references are executed. */
export function canonicalMcpJson(value: unknown, maxBytes = MCP_MAX_ARGUMENT_BYTES): string {
    let nodes = 0
    const normalize = (item: unknown, depth: number): unknown => {
        if (++nodes > 20_000 || depth > 32) throw new EvolvedError('mcp_payload_too_large', 'MCP data is too deeply nested or too large.', 413)
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
        if (typeof item === 'number' && Number.isFinite(item)) return item
        if (Array.isArray(item)) return item.map(child => normalize(child, depth + 1))
        if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]))
        throw new EvolvedError('mcp_invalid_payload', 'MCP data must be finite JSON.', 400)
    }
    const result = JSON.stringify(normalize(value, 0))
    if (Buffer.byteLength(result) > maxBytes) throw new EvolvedError('mcp_payload_too_large', 'MCP data exceeds its size limit.', 413)
    return result
}
export function toolFingerprint(tool: Pick<McpTool, 'name' | 'description' | 'inputSchema'>): string {
    return createHash('sha256').update(canonicalMcpJson({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })).digest('hex')
}
export function normalizeMcpTools(value: unknown, kind: McpConnection['kind'] = 'custom'): McpTool[] {
    if (!Array.isArray(value) || value.length > 100) throw new EvolvedError('mcp_invalid_catalog', 'MCP catalog has too many tools or is invalid.', 502)
    const seen = new Set<string>()
    const tools = value.map(raw => {
        const parsed = z.object({ name: z.string().min(1).max(200).regex(/^[^\s\x00-\x1f\x7f]+$/u), description: z.string().max(4000).optional(), inputSchema: z.record(z.string(), z.unknown()) }).safeParse(raw)
        if (!parsed.success || seen.has(parsed.data.name)) throw new EvolvedError('mcp_invalid_catalog', 'MCP tool names or schemas are invalid.', 502)
        const { name, inputSchema } = parsed.data, description = parsed.data.description ?? ''
        if (inputSchema.type !== 'object') throw new EvolvedError('mcp_invalid_catalog', 'MCP tool input schema must describe an object.', 502)
        canonicalMcpJson(inputSchema, 16 * 1024); seen.add(name)
        const tool = { name, description, inputSchema, readOnly: kind === 'context7' && ['resolve-library-id', 'query-docs'].includes(name) }
        return { ...tool, fingerprint: toolFingerprint(tool) }
    }).sort((a, b) => a.name.localeCompare(b.name))
    canonicalMcpJson(tools, MCP_MAX_CATALOG_BYTES)
    return tools
}
type Cipher = { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }
type Crypto = { creationFingerprint(projectId: string, value: string): string; encrypt(projectId: string, id: string, version: number, value: Buffer): Cipher; decrypt(projectId: string, id: string, version: number, value: Cipher): Buffer }
type Row = { project_id: string; id: string; version: number; credential_version: number; metadata: string; creation_fingerprint: string; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }

export class McpVault {
    constructor(private readonly db: Database, private readonly crypto: Crypto) {
        db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(project_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,credential_version INTEGER NOT NULL,metadata TEXT NOT NULL,creation_fingerprint TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL,PRIMARY KEY(project_id,id));
            CREATE TABLE IF NOT EXISTS mcp_deleted(project_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(project_id,id));`)
    }
    purge(projectId: string): void {
        this.db.prepare('DELETE FROM mcp_connections WHERE project_id=?').run(projectId)
        this.db.prepare('DELETE FROM mcp_deleted WHERE project_id=?').run(projectId)
    }
    private row(projectId: string, id: string): Row {
        const row = this.db.prepare('SELECT * FROM mcp_connections WHERE project_id=? AND id=?').get(projectId, id) as Row | null
        if (!row) throw new EvolvedError('mcp_not_found', 'MCP connection not found.', 404)
        return row
    }
    request(userId: string, projectId: string, payload: Record<string, unknown>): unknown {
        return this.db.transaction(() => this.apply(userId, projectId, payload))()
    }
    private apply(userId: string, projectId: string, payload: Record<string, unknown>): unknown {
        if (payload.action === 'list') return { connections: (this.db.prepare('SELECT metadata FROM mcp_connections WHERE project_id=? ORDER BY id').all(projectId) as Array<{ metadata: string }>).map(row => JSON.parse(row.metadata) as McpConnection) }
        const id = parse(identifier, payload.id)
        if (payload.action === 'create') {
            const input = parse(z.object({ action: z.literal('create'), id: identifier, kind: z.enum(['context7', 'custom']), name: z.string().trim().min(1).max(120).optional(), endpoint: z.string().max(2048).optional(), auth: authSchema }).strict(), payload)
            const endpoint = validateMcpEndpoint(input.kind === 'context7' ? MCP_CONTEXT7_ENDPOINT : input.endpoint ?? '')
            if (input.kind === 'context7' && input.endpoint !== undefined && validateMcpEndpoint(input.endpoint) !== endpoint) throw new EvolvedError('mcp_endpoint_denied', 'Context7 has a fixed endpoint.', 400)
            const credential = validateMcpCredential(input.auth, input.kind)
            const fingerprint = this.crypto.creationFingerprint(projectId, canonicalMcpJson({ ...input, endpoint, auth: credential }))
            const previous = this.db.prepare('SELECT * FROM mcp_connections WHERE project_id=? AND id=?').get(projectId, id) as Row | null
            if (previous) {
                if (previous.creation_fingerprint !== fingerprint) throw new EvolvedError('mcp_conflict', 'MCP identifier was already used for another configuration.', 409)
                return { connection: JSON.parse(previous.metadata) as McpConnection }
            }
            if (this.db.prepare('SELECT 1 FROM mcp_deleted WHERE project_id=? AND id=?').get(projectId, id)) throw new EvolvedError('mcp_conflict', 'Deleted MCP identifiers cannot be reused.', 409)
            if ((this.db.prepare('SELECT COUNT(*) AS n FROM mcp_connections WHERE project_id=?').get(projectId) as { n: number }).n >= 20) throw new EvolvedError('mcp_limit', 'A project may have at most twenty MCP connections.', 409)
            const now = Date.now(), connection: McpConnection = { id, kind: input.kind, name: input.name ?? (input.kind === 'context7' ? 'Context7' : new URL(endpoint).hostname), endpoint, version: 1, enabled: false, auth: { mode: credential.mode, configured: credential.mode !== 'none', ...(credential.headerName ? { headerName: credential.headerName } : {}) }, status: { state: 'untested', checkedAt: null }, catalogRevision: null, tools: [], enabledTools: [], createdAt: now, updatedAt: now }
            const clear = Buffer.from(JSON.stringify(credential)); let cipher: Cipher
            try { cipher = this.crypto.encrypt(projectId, id, 1, clear) } finally { clear.fill(0) }
            this.db.prepare('INSERT INTO mcp_connections VALUES(?,?,?,?,?,?,?,?,?)').run(projectId, id, 1, 1, JSON.stringify(connection), fingerprint, cipher.nonce, cipher.ciphertext, cipher.tag)
            this.audit(userId, projectId, 'created', id)
            return { connection }
        }
        if (payload.action === 'get') return { connection: JSON.parse(this.row(projectId, id).metadata) as McpConnection }
        const row = this.row(projectId, id), expected = parse(versionSchema, payload.version)
        if (row.version !== expected) throw new EvolvedError('mcp_version_conflict', 'MCP configuration changed. Refresh before trying again.', 409)
        const connection = JSON.parse(row.metadata) as McpConnection
        if (payload.action === 'resolve') {
            const clear = this.crypto.decrypt(projectId, id, row.credential_version, row)
            try { return { connection, credential: validateMcpCredential(JSON.parse(clear.toString('utf8')), connection.kind) } }
            finally { clear.fill(0) }
        }
        if (payload.action === 'delete') {
            this.db.prepare('DELETE FROM mcp_connections WHERE project_id=? AND id=?').run(projectId, id)
            this.db.prepare('INSERT INTO mcp_deleted VALUES(?,?)').run(projectId, id)
            this.audit(userId, projectId, 'deleted', id)
            return { ok: true }
        }
        let credential: McpCredential | undefined
        if (payload.action === 'update') {
            const input = parse(z.object({ action: z.literal('update'), id: identifier, version: versionSchema, catalogRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean(), enabledTools: names, readOnlyTools: names, auth: authSchema.optional() }).strict(), payload)
            if (input.catalogRevision !== connection.catalogRevision) throw new EvolvedError('mcp_version_conflict', 'MCP tool catalog changed. Refresh before granting tools.', 409)
            const tools = new Set(connection.tools.map(tool => tool.name)), granted = new Set(input.enabledTools)
            if ([...input.enabledTools, ...input.readOnlyTools].some(name => !tools.has(name)) || input.readOnlyTools.some(name => !granted.has(name))) throw new EvolvedError('mcp_tool_denied', 'Only discovered and explicitly granted MCP tools are allowed.', 400)
            if (input.name !== undefined) connection.name = input.name
            if (input.auth) {
                credential = validateMcpCredential(input.auth, connection.kind)
                connection.auth = { mode: credential.mode, configured: credential.mode !== 'none', ...(credential.headerName ? { headerName: credential.headerName } : {}) }
                connection.enabled = false; connection.enabledTools = []; connection.tools = []; connection.catalogRevision = null; connection.status = { state: 'untested', checkedAt: null }
            } else {
                if (input.enabled && (connection.status.state !== 'ready' || !connection.catalogRevision)) throw new EvolvedError('mcp_not_ready', 'Discover the MCP tools before enabling this connection.', 409)
                connection.enabled = input.enabled; connection.enabledTools = [...granted].sort()
                connection.tools = connection.tools.map(tool => ({ ...tool, readOnly: input.readOnlyTools.includes(tool.name) }))
            }
        } else if (payload.action === 'discovered') {
            const status = parse(statusSchema, payload.status)
            // Diagnostic codes are fixed Hub classifications, never remote error text.
            if (status.errorCode && !['mcp_auth_required', 'mcp_unreachable', 'mcp_timeout', 'mcp_catalog_changed', 'mcp_invalid_catalog', 'mcp_endpoint_denied', 'mcp_proxy_unsupported', 'mcp_response_too_large', 'mcp_credential_echo', 'mcp_remote_failed'].includes(status.errorCode)) throw new EvolvedError('mcp_invalid_configuration', 'Invalid MCP diagnostic code.', 400)
            connection.status = status
            if (status.state === 'ready') {
                const tools = normalizeMcpTools(payload.tools, connection.kind)
                const old = new Map(connection.tools.map(tool => [tool.name, tool]))
                connection.enabledTools = connection.enabledTools.filter(name => tools.some(tool => tool.name === name && tool.fingerprint === old.get(name)?.fingerprint))
                connection.tools = tools.map(tool => ({ ...tool, readOnly: old.get(tool.name)?.fingerprint === tool.fingerprint ? old.get(tool.name)!.readOnly : tool.readOnly }))
                connection.catalogRevision = createHash('sha256').update(canonicalMcpJson(tools.map(({ name, fingerprint }) => ({ name, fingerprint })))).digest('hex')
            } else { connection.enabled = false; connection.enabledTools = [] }
        } else throw new EvolvedError('mcp_operation_denied', 'Unsupported MCP configuration operation.', 403)
        connection.version++; connection.updatedAt = Date.now()
        if (credential) {
            const clear = Buffer.from(JSON.stringify(credential)), next = row.credential_version + 1; let cipher: Cipher
            try { cipher = this.crypto.encrypt(projectId, id, next, clear) } finally { clear.fill(0) }
            this.db.prepare('UPDATE mcp_connections SET credential_version=?,nonce=?,ciphertext=?,tag=? WHERE project_id=? AND id=?').run(next, cipher.nonce, cipher.ciphertext, cipher.tag, projectId, id)
        }
        this.db.prepare('UPDATE mcp_connections SET version=?,metadata=? WHERE project_id=? AND id=?').run(connection.version, JSON.stringify(connection), projectId, id)
        this.audit(userId, projectId, String(payload.action), id)
        return { connection }
    }
    private audit(userId: string, projectId: string, action: string, id: string): void {
        this.db.prepare('INSERT INTO audit(user_id,project_id,operation,target_id,at) VALUES(?,?,?,?,?)').run(userId, projectId, `mcp.${action}`, id, Date.now())
    }
}
