import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { EvolvedError, type EvolvedStore, type EvolvedProject } from './store'
import { authenticateEvolvedRequest, createEvolvedRequestGuard, parseBody, requireFreshPasskey, requireHuman, requireScope } from './security'
import type { VaultClient } from './vault'
import type { McpConnection, McpCredential, McpTool } from './mcpVault'
import { createRemoteMcpClient } from './mcpTransport'

const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const toolName = z.string().min(1).max(200)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const auth = z.object({ mode: z.enum(['none', 'bearer', 'header']), headerName: z.string().max(100).optional(), token: z.string().min(1).max(4096).optional() }).strict()
const create = z.object({ id: z.string().uuid(), kind: z.enum(['context7', 'custom']), name: z.string().trim().min(1).max(100).optional(), endpoint: z.string().max(2048).optional(), auth }).strict()
const update = z.object({ version, catalogRevision: revision.nullable(), name: z.string().trim().min(1).max(100).optional(), enabled: z.boolean(),
    enabledTools: z.array(toolName).max(100), readOnlyTools: z.array(toolName).max(100), auth: auth.optional() }).strict()
const invoke = z.object({ toolName, arguments: z.record(z.string(), z.unknown()), version, catalogRevision: revision }).strict()
const templates = [{ id: 'context7', name: 'Context7', description: 'Aktuelle Bibliotheksdokumentation und Codebeispiele für deine Agenten.', endpoint: 'https://mcp.context7.com/mcp', docsUrl: 'https://context7.com/docs/resources/all-clients' }]
type Revalidate = () => Promise<void>
type RemoteConfig = { endpoint: string; credential: McpCredential }
export interface ProjectMcpRemote {
    discover(config: RemoteConfig, revalidate: Revalidate): Promise<McpTool[]>
    call(config: RemoteConfig, name: string, args: Record<string, unknown>, fingerprint: string, revalidate: Revalidate): Promise<CallToolResult>
}

export class ProjectMcpService {
    private active = 0
    private readonly projects = new Map<string, number>()
    private readonly users = new Map<string, number>()
    private readonly teams = new Map<string, number>()
    private readonly rates = new Map<string, { count: number; until: number }>()
    constructor(readonly vault: VaultClient, readonly remote: ProjectMcpRemote = createRemoteMcpClient()) {}
    async request<T>(userId: string, projectId: string, action: string, payload: Record<string, unknown> = {}): Promise<T> {
        return await this.vault.request({ userId, projectId, operation: 'mcp', payload: { ...payload, action } }) as T
    }
    async list(userId: string, projectId: string): Promise<McpConnection[]> {
        return (await this.request<{ connections: McpConnection[] }>(userId, projectId, 'list')).connections
    }
    async connection(userId: string, projectId: string, id: string): Promise<McpConnection> {
        return (await this.request<{ connection: McpConnection }>(userId, projectId, 'get', { id })).connection
    }
    async bounded<T>(project: Pick<EvolvedProject, 'id' | 'teamId'>, userId: string, operation: 'discover' | 'call', run: () => Promise<T>): Promise<T> {
        const projectId = project.id
        const now = Date.now()
        for (const [key, value] of this.rates) if (value.until <= now) this.rates.delete(key)
        const key = `${projectId}:${operation}`, rate = this.rates.get(key) ?? { count: 0, until: now + 60_000 }
        if (this.active >= 12 || (this.projects.get(projectId) ?? 0) >= 3 || (this.users.get(userId) ?? 0) >= 4 || (this.teams.get(project.teamId) ?? 0) >= 6 || rate.count >= (operation === 'discover' ? 8 : 60) || (!this.rates.has(key) && this.rates.size >= 2048)) {
            throw new EvolvedError('mcp_busy', 'MCP-Auslastungsgrenze erreicht. Bitte kurz warten.', 429)
        }
        rate.count++; this.rates.set(key, rate); this.active++; this.projects.set(projectId, (this.projects.get(projectId) ?? 0) + 1)
        this.users.set(userId, (this.users.get(userId) ?? 0) + 1); this.teams.set(project.teamId, (this.teams.get(project.teamId) ?? 0) + 1)
        try { return await run() } finally {
            this.active--; const remaining = this.projects.get(projectId)! - 1
            if (remaining) this.projects.set(projectId, remaining); else this.projects.delete(projectId)
            for (const [map, id] of [[this.users, userId], [this.teams, project.teamId]] as const) { const count = map.get(id)! - 1; if (count) map.set(id, count); else map.delete(id) }
        }
    }
}

/** Fixed metadata only, fifty latest completed attempts per connection; project deletion cascades. */
export class McpCallJournal {
    private readonly active = new Set<{ projectId: string; serverId: string; cancelled: boolean }>()
    constructor(private readonly store: EvolvedStore) {
        store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_mcp_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,server_id TEXT NOT NULL,tool_name TEXT NOT NULL,started_at INTEGER NOT NULL,duration_ms INTEGER NOT NULL,status TEXT NOT NULL,error_code TEXT);
            CREATE INDEX IF NOT EXISTS evolved_mcp_calls_server ON evolved_mcp_calls(project_id,server_id,id DESC);`)
    }
    begin(projectId: string, serverId: string, name: string, startedAt: number) {
        const ticket = { projectId, serverId, cancelled: false }; this.active.add(ticket)
        return (status: 'success' | 'tool_error' | 'failed' | 'unknown', errorCode?: string) => {
            if (!this.active.delete(ticket) || ticket.cancelled) return
            this.record(projectId, serverId, name, startedAt, status, errorCode)
        }
    }
    record(projectId: string, serverId: string, name: string, startedAt: number, status: 'success' | 'tool_error' | 'failed' | 'unknown', errorCode?: string): void {
        // Deletion can race with a remote response; never resurrect history for a deleted project.
        if (!this.store.db.query('SELECT 1 FROM evolved_projects WHERE id=? AND deleting_at IS NULL').get(projectId)) return
        this.store.db.transaction(() => {
            this.store.db.query('INSERT INTO evolved_mcp_calls(project_id,server_id,tool_name,started_at,duration_ms,status,error_code) VALUES(?,?,?,?,?,?,?)').run(projectId, serverId, name, startedAt, Math.max(0, this.store.now() - startedAt), status, errorCode && /^[a-z_]{1,80}$/.test(errorCode) ? errorCode : null)
            this.store.db.query('DELETE FROM evolved_mcp_calls WHERE project_id=? AND server_id=? AND id NOT IN (SELECT id FROM evolved_mcp_calls WHERE project_id=? AND server_id=? ORDER BY id DESC LIMIT 50)').run(projectId, serverId, projectId, serverId)
        })()
    }
    list(projectId: string, serverId: string): unknown[] {
        return this.store.db.query('SELECT id,tool_name AS toolName,started_at AS startedAt,duration_ms AS durationMs,status,error_code AS errorCode FROM evolved_mcp_calls WHERE project_id=? AND server_id=? ORDER BY id DESC LIMIT 50').all(projectId, serverId)
    }
    remove(projectId: string, serverId: string): void {
        for (const ticket of this.active) if (ticket.projectId === projectId && ticket.serverId === serverId) ticket.cancelled = true
        this.store.db.query('DELETE FROM evolved_mcp_calls WHERE project_id=? AND server_id=?').run(projectId, serverId)
    }
}

function boundedArguments(args: Record<string, unknown>): void {
    if (Buffer.byteLength(JSON.stringify(args)) > 65_536) throw new EvolvedError('mcp_arguments_too_large', 'Werkzeugargumente überschreiten 64 KiB.', 413)
    const visit = (value: unknown, depth: number): void => {
        if (depth > 32) throw new EvolvedError('mcp_arguments_too_deep', 'Werkzeugargumente sind zu tief verschachtelt.')
        if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1)
    }
    visit(args, 0)
}
function assertVersion(item: McpConnection, expected: number): void {
    if (item.version !== expected) throw new EvolvedError('mcp_version_conflict', 'Die MCP-Verbindung wurde geändert. Bitte neu laden.', 409)
}
function allowedTools(item: McpConnection, project: EvolvedProject): McpTool[] {
    return item.tools.filter(tool => item.enabledTools.includes(tool.name) && (project.profile !== 'restricted' || tool.readOnly))
}
function mayCall(item: McpConnection, project: EvolvedProject, input: z.infer<typeof invoke>, readOnly = false): McpTool {
    assertVersion(item, input.version)
    if (!item.enabled) throw new EvolvedError('mcp_disabled', 'Diese MCP-Verbindung ist deaktiviert.', 403)
    if (item.catalogRevision !== input.catalogRevision || item.status.state !== 'ready') throw new EvolvedError('mcp_catalog_changed', 'Werkzeugkatalog neu prüfen und freigeben.', 409)
    const tool = allowedTools(item, project).find(tool => tool.name === input.toolName)
    if (!tool || (readOnly && !tool.readOnly)) throw new EvolvedError('mcp_tool_denied', 'Dieses Werkzeug ist für das Projektprofil nicht freigegeben.', 403)
    return tool
}

/** Configuration is human-only. Runner authority plus explicit project tool grants governs execution. */
export function createProjectMcpRoutes(options: { store: EvolvedStore; service: ProjectMcpService; origin: string }): Hono {
    const { store, service, origin } = options, app = new Hono(), base = '/projects/:id/mcp'
    const journal = new McpCallJournal(store)
    for (const path of [base, `${base}/*`]) {
        app.use(path, createEvolvedRequestGuard(origin))
        app.use(path, bodyLimit({ maxSize: 131_072, onError: c => c.json({ code: 'body_too_large', error: 'MCP-Anfrage ist zu groß.' }, 413) }))
    }
    app.onError((error, c) => error instanceof EvolvedError
        ? c.json({ code: error.code, error: error.message }, error.status as 400)
        : c.json({ code: 'mcp_failed', error: 'MCP-Anfrage fehlgeschlagen. Nach unklarem Ergebnis keine Aktion automatisch wiederholen.' }, 502))
    const authorize = async (c: Context, mode: 'view' | 'manage' | 'agent') => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Anmeldung erforderlich.', 401)
        if (mode === 'agent') requireScope(principal, 'runner:connect', c.req.param('id'))
        else requireHuman(principal)
        const project = store.requireProject(principal.user.id, c.req.param('id')!, mode === 'manage' ? 'admin' : mode === 'agent' ? 'member' : 'viewer')
        if (mode === 'manage') requireFreshPasskey(c, store, principal)
        return { principal, project }
    }
    const lookup = async (c: Context, mode: 'view' | 'manage' | 'agent', expected?: number) => {
        const a = await authorize(c, mode)
        const item = await service.connection(a.principal.user.id, a.project.id, c.req.param('serverId')!)
        const live = await authorize(c, mode)
        if (live.principal.user.id !== a.principal.user.id || live.project.profile !== a.project.profile) throw new EvolvedError('mcp_authority_changed', 'Projektberechtigung wurde geändert.', 403)
        if (expected !== undefined) assertVersion(item, expected)
        return { ...live, item }
    }
    app.get(base, async c => {
        const { principal, project } = await authorize(c, 'view')
        const connections = await service.list(principal.user.id, project.id)
        const live = await authorize(c, 'view')
        return c.json({ canManage: live.project.role === 'admin', templates, connections })
    })
    app.post(base, async c => {
        const body = await parseBody(c, create), { principal, project } = await authorize(c, 'manage')
        const result = await service.request<{ connection: McpConnection }>(principal.user.id, project.id, 'create', body)
        await authorize(c, 'manage')
        store.audit(principal.user.id, project.id, 'mcp.create', body.id)
        return c.json(result, 201)
    })
    app.get(`${base}/servers`, async c => {
        const { principal, project } = await authorize(c, 'agent')
        const connections = await service.list(principal.user.id, project.id)
        const live = await authorize(c, 'agent')
        return c.json({ servers: connections.filter(item => item.enabled).map(item => ({ id: item.id, name: item.name, kind: item.kind, toolCount: allowedTools(item, live.project).length, status: item.status })) })
    })
    app.get(`${base}/servers/:serverId/tools`, async c => {
        const { item, project } = await lookup(c, 'agent')
        if (!item.enabled) throw new EvolvedError('mcp_disabled', 'Diese MCP-Verbindung ist deaktiviert.', 403)
        return c.json({ server: { id: item.id, name: item.name, version: item.version, catalogRevision: item.catalogRevision }, tools: allowedTools(item, project) })
    })
    for (const operation of ['call', 'query'] as const) app.post(`${base}/servers/:serverId/${operation}`, async c => {
        const body = await parseBody(c, invoke); boundedArguments(body.arguments)
        const a = await lookup(c, 'agent', body.version), approved = mayCall(a.item, a.project, body, operation === 'query')
        return service.bounded(a.project, a.principal.user.id, 'call', async () => {
            const resolved = await service.request<{ connection: McpConnection; credential: McpCredential }>(a.principal.user.id, a.project.id, 'resolve', { id: a.item.id, version: body.version })
            const revalidate = async () => { const live = await lookup(c, 'agent', body.version); mayCall(live.item, live.project, body, operation === 'query') }
            await revalidate()
            // Metadata-only audit: never arguments, output, headers or credentials.
            store.audit(a.principal.user.id, a.project.id, 'mcp.call', a.item.id)
            const complete = journal.begin(a.project.id, a.item.id, body.toolName, store.now())
            let returned = false
            let result: CallToolResult
            try {
                result = await service.remote.call({ endpoint: resolved.connection.endpoint, credential: resolved.credential }, body.toolName, body.arguments, approved.fingerprint, revalidate)
                returned = true
                await revalidate()
                complete(result.isError ? 'tool_error' : 'success')
            } catch (cause) {
                const unknown = returned || !(cause instanceof EvolvedError) || cause.code === 'mcp_outcome_unknown'
                const error = unknown ? new EvolvedError('mcp_outcome_unknown', 'Die externe Aktion kann bereits ausgeführt worden sein. Das Ergebnis ist unklar oder wurde zurückgehalten. Nicht erneut ausführen; zuerst den Zustand beim Anbieter prüfen.', 502) : cause
                complete(unknown ? 'unknown' : 'failed', error.code)
                if (error instanceof EvolvedError && error.code === 'mcp_catalog_changed') {
                    // Record a failed safety check, never grant newly discovered tools.
                    // Concurrent administrator edits win over this stale observation.
                    try {
                        await revalidate()
                        await service.request(a.principal.user.id, a.project.id, 'discovered', { id: a.item.id, version: body.version, tools: [], status: { state: 'catalog_changed', checkedAt: store.now(), errorCode: 'mcp_catalog_changed' } })
                    } catch { /* The call remains denied even if its old snapshot was superseded. */ }
                }
                throw error
            }
            return c.json(result)
        })
    })
    app.get(`${base}/:serverId/history`, async c => {
        const a = await lookup(c, 'view')
        return c.json({ calls: journal.list(a.project.id, a.item.id) })
    })
    app.post(`${base}/:serverId/discover`, async c => {
        const body = await parseBody(c, z.object({ version }).strict()), a = await lookup(c, 'manage', body.version)
        return service.bounded(a.project, a.principal.user.id, 'discover', async () => {
            const resolved = await service.request<{ connection: McpConnection; credential: McpCredential }>(a.principal.user.id, a.project.id, 'resolve', { id: a.item.id, version: body.version })
            const revalidate = async () => { await lookup(c, 'manage', body.version) }
            let tools: McpTool[] = [], status: McpConnection['status']
            try {
                await revalidate()
                tools = await service.remote.discover({ endpoint: resolved.connection.endpoint, credential: resolved.credential }, revalidate)
                status = { state: 'ready', checkedAt: store.now() }
            } catch (error) {
                if (error instanceof EvolvedError && ['unauthorized', 'forbidden', 'not_found', 'mcp_version_conflict', 'step_up_required', 'mcp_authority_changed'].includes(error.code)) throw error
                status = { state: error instanceof EvolvedError && error.code === 'mcp_auth_required' ? 'auth_required' : 'unreachable', checkedAt: store.now(), errorCode: error instanceof EvolvedError && ['mcp_auth_required', 'mcp_unreachable', 'mcp_timeout', 'mcp_catalog_changed', 'mcp_invalid_catalog', 'mcp_endpoint_denied', 'mcp_response_too_large', 'mcp_credential_echo', 'mcp_remote_failed', 'mcp_proxy_unsupported'].includes(error.code) ? error.code : 'mcp_remote_failed' }
            }
            await revalidate()
            const result = await service.request<{ connection: McpConnection }>(a.principal.user.id, a.project.id, 'discovered', { id: a.item.id, version: body.version, tools, status })
            await authorize(c, 'manage')
            store.audit(a.principal.user.id, a.project.id, 'mcp.discover', a.item.id)
            return c.json(result)
        })
    })
    app.put(`${base}/:serverId`, async c => {
        const body = await parseBody(c, update), a = await lookup(c, 'manage', body.version)
        const result = await service.request<{ connection: McpConnection }>(a.principal.user.id, a.project.id, 'update', { ...body, id: a.item.id })
        await authorize(c, 'manage'); store.audit(a.principal.user.id, a.project.id, body.enabled ? 'mcp.configure' : 'mcp.disable', a.item.id)
        return c.json(result)
    })
    app.delete(`${base}/:serverId`, async c => {
        const body = await parseBody(c, z.object({ version }).strict()), a = await lookup(c, 'manage', body.version)
        const result = await service.request<{ ok: boolean }>(a.principal.user.id, a.project.id, 'delete', { id: a.item.id, version: body.version })
        journal.remove(a.project.id, a.item.id); await authorize(c, 'manage'); store.audit(a.principal.user.id, a.project.id, 'mcp.delete', a.item.id)
        return c.json(result)
    })
    return app
}
