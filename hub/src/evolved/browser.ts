import { createHash, randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
    BROWSER_DEFAULT_TOOLS, BROWSER_TOOLS, BrowserAuthorizeSchema, BrowserConfigUpdateSchema, BrowserReportSchema,
    type BrowserConfig, type BrowserGrant, type BrowserReport, type BrowserRuntimeState, type BrowserStatus, type BrowserToolName,
} from '@hapi/protocol/browserTools'
import { EvolvedError, hashToken, type EvolvedPrincipal, type EvolvedProject, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, cookieToken, createEvolvedRequestGuard, parseBody, requireFreshPasskey, requireHuman, requireScope } from './security'
import { getManagedCredentialLease } from './credentialGrants'
import type { ProviderControl } from './providers'
import type { ControlRequest } from './runnerControlProtocol'

/** Static HAPI catalog revision; changes whenever a tool name, description or schema changes. */
export const BROWSER_CATALOG_REVISION = createHash('sha256').update(JSON.stringify(BROWSER_TOOLS)).digest('hex')
const REPORT_STALE_MS = 45_000
const ENGINE_FRESH_MS = 10 * 60_000
type Row = { enabled: number; version: number; enabled_tools: string; read_only_tools: string; updated_at: number }
type Runtime = { leaseId: string; report: BrowserReport; at: number; engineAt: number | null; engineState: 'unknown' | 'ready' | 'failed'; probe: string | null }
const operatorStatus = z.object({
    image: z.boolean(),
    containers: z.object({ 'browser-gateway': z.string().max(32), browser: z.string().max(32), 'browser-egress': z.string().max(32) }).strict(),
}).strict()

/** Opaque browser user identity: trusted project plus current managed lease, never caller-supplied. Shared by all agent sessions of that lease. */
export function browserContextId(projectId: string, leaseId: string): string {
    return `hapi-${createHash('sha256').update(`hapi-camofox-context:v1:${projectId}:${leaseId}`).digest('hex').slice(0, 32)}`
}

export class BrowserConfigStore {
    constructor(private readonly store: EvolvedStore) {
        // Additive table; older releases ignore it, so rollback leaves the browser simply unused.
        store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_project_browser(project_id TEXT PRIMARY KEY REFERENCES evolved_projects(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL,version INTEGER NOT NULL,enabled_tools TEXT NOT NULL,read_only_tools TEXT NOT NULL,updated_at INTEGER NOT NULL,updated_by TEXT NOT NULL)`)
    }
    get(projectId: string): BrowserConfig {
        const row = this.store.db.query('SELECT enabled,version,enabled_tools,read_only_tools,updated_at FROM evolved_project_browser WHERE project_id=?').get(projectId) as Row | null
        if (!row) return { enabled: false, version: 0, enabledTools: [...BROWSER_DEFAULT_TOOLS], readOnlyTools: ['camofox_list_tabs'], updatedAt: null }
        return { enabled: row.enabled === 1, version: row.version, enabledTools: JSON.parse(row.enabled_tools), readOnlyTools: JSON.parse(row.read_only_tools), updatedAt: row.updated_at }
    }
    update(userId: string, projectId: string, input: z.infer<typeof BrowserConfigUpdateSchema>): BrowserConfig {
        return this.store.db.transaction(() => {
            const current = this.get(projectId)
            if (current.version !== input.version) throw new EvolvedError('browser_version_conflict', 'Die Browser-Konfiguration wurde geändert. Bitte neu laden.', 409)
            const enabledTools = [...input.enabledTools].sort(), readOnlyTools = [...input.readOnlyTools].sort()
            this.store.db.query(`INSERT INTO evolved_project_browser VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version,
                enabled_tools=excluded.enabled_tools,read_only_tools=excluded.read_only_tools,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
                .run(projectId, input.enabled ? 1 : 0, current.version + 1, JSON.stringify(enabledTools), JSON.stringify(readOnlyTools), this.store.now(), userId)
            return this.get(projectId)
        })()
    }
}

/** Project browser (Camofox sidecar): human configuration, gateway authorization and health. No caller-chosen identity, URL or credential. */
export function createBrowserRoutes(options: { store: EvolvedStore; origin: string; control?: ProviderControl }): Hono {
    const { store, origin } = options, app = new Hono(), configs = new BrowserConfigStore(store)
    const runtimes = new Map<string, Runtime>()
    // Last operator observation (admin status read or lifecycle result), reused for agents, who never call the operator.
    const observed = new Map<string, { state: BrowserRuntimeState; errorCode?: string; at: number }>()
    const observe = (projectId: string, state: BrowserRuntimeState, errorCode?: string) => {
        if (observed.size >= 4096 && !observed.has(projectId)) observed.delete(observed.keys().next().value!)
        observed.set(projectId, { state, ...(errorCode ? { errorCode } : {}), at: store.now() })
    }
    const base = '/projects/:id/browser'
    for (const path of [base, `${base}/*`]) {
        app.use(path, createEvolvedRequestGuard(origin))
        app.use(path, bodyLimit({ maxSize: 8192, onError: c => c.json({ code: 'body_too_large', error: 'Browser-Anfrage ist zu groß.' }, 413) }))
    }
    app.onError((error, c) => error instanceof EvolvedError
        ? c.json({ code: error.code, error: error.message }, error.status as 400)
        : c.json({ code: 'browser_failed', error: 'Browser-Anfrage fehlgeschlagen.' }, 502))

    const human = async (c: Context, role: 'viewer' | 'admin') => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Anmeldung erforderlich.', 401)
        requireHuman(principal)
        return { principal, project: store.requireProject(principal.user.id, c.req.param('id')!, role) }
    }
    /** Only the current managed runner lease of exactly this project; humans and manual leases are refused. */
    const gateway = async (c: Context) => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal?.capability?.leaseId) throw new EvolvedError('unauthorized', 'Runner capability required.', 401)
        requireScope(principal, 'runner:connect', c.req.param('id'))
        const project = store.requireProject(principal.user.id, c.req.param('id')!, 'member')
        if (getManagedCredentialLease(store, project)?.id !== principal.capability.leaseId) throw new EvolvedError('browser_runner_required', 'Only the current managed project runner may use the project browser.', 403)
        return { principal, project, leaseId: principal.capability.leaseId }
    }
    const managedLeaseId = (projectId: string) => (store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evolved_managed_runners'").get()
        ? (store.db.query('SELECT lease_id FROM evolved_managed_runners WHERE project_id=?').get(projectId) as { lease_id: string } | null)?.lease_id : undefined) ?? ''
    const controlRequest = (c: Context, project: EvolvedProject, principal: EvolvedPrincipal, action: 'browser' | 'browser-status', browser?: boolean): ControlRequest => ({
        action, projectId: project.id, userId: principal.user.id, sessionHash: hashToken(cookieToken(c.req.raw) ?? ''), profile: project.profile, rootPath: project.rootPath,
        leaseId: managedLeaseId(project.id), ...(browser === undefined ? {} : { browser }),
    })
    const control = async (c: Context, project: EvolvedProject, principal: EvolvedPrincipal, action: 'browser' | 'browser-status', browser?: boolean): Promise<unknown> => {
        if (!options.control) throw new EvolvedError('runner_unavailable', 'Die Projektdienst-Steuerung ist auf diesem Server nicht eingerichtet.', 503)
        if (!getManagedCredentialLease(store, project)) throw new EvolvedError('browser_runner_missing', 'Zuerst den verwalteten Projektdienst verbinden.', 409)
        return options.control.request(controlRequest(c, project, principal, action, browser))
    }
    const runtimeState = async (c: Context, project: EvolvedProject, principal: EvolvedPrincipal, config: BrowserConfig, useOperator = project.role === 'admin'): Promise<BrowserStatus['runtime']> => {
        const entry = runtimes.get(project.id), managed = getManagedCredentialLease(store, project)
        const report = entry && managed && entry.leaseId === managed.id ? entry : undefined
        const at = report?.at ?? null, engineCheckedAt = report?.engineAt ?? null
        const result = (state: BrowserRuntimeState, errorCode?: string) => ({ state, checkedAt: at, engineCheckedAt, ...(errorCode ? { errorCode } : {}), ...(report?.report.upstreamVersion ? { upstreamVersion: report.report.upstreamVersion } : {}) })
        if (!config.enabled) return result('disabled')
        if (!managed) return result('runner_missing')
        if (useOperator && options.control) {
            try {
                const status = operatorStatus.parse(await control(c, project, principal, 'browser-status'))
                const states = Object.values(status.containers)
                const seen: [BrowserRuntimeState, string?] = !status.image ? ['image_missing']
                    : states.some(state => state === 'exited' || state === 'dead') ? ['failed', 'browser_container_exited']
                    : states.some(state => state !== 'running') ? ['stopped'] : ['starting']
                observe(project.id, ...seen)
                if (seen[0] !== 'starting') return result(...seen)
            } catch (error) {
                if (error instanceof EvolvedError && error.code === 'browser_runner_missing') return result('runner_missing')
                return result('unavailable', 'browser_control_unavailable')
            }
        } else {
            // Agents: a recent operator failure wins unless the gateway reported afterwards.
            const seen = observed.get(project.id)
            if (seen && seen.state !== 'starting' && store.now() - seen.at <= ENGINE_FRESH_MS && (!report || report.at < seen.at)) return result(seen.state, seen.errorCode)
        }
        // Enabled but no report long after the last configuration change: never "starting" forever.
        if (!report) return result(config.updatedAt !== null && store.now() - config.updatedAt > REPORT_STALE_MS ? 'stale' : 'starting')
        if (store.now() - report.at > REPORT_STALE_MS) return result('stale')
        if (report.report.service !== 'reachable') return result('failed', report.report.service === 'unreachable' ? 'browser_unreachable' : 'browser_unhealthy')
        if (report.engineState === 'failed') return result('failed', 'browser_engine_failed')
        if (report.engineState === 'ready' && report.engineAt !== null && store.now() - report.engineAt <= ENGINE_FRESH_MS) return result('ready')
        return result('service_ready')
    }
    const status = async (c: Context, project: EvolvedProject, principal: EvolvedPrincipal): Promise<BrowserStatus> => {
        const config = configs.get(project.id)
        return { config, catalogRevision: BROWSER_CATALOG_REVISION, tools: [...BROWSER_TOOLS], canManage: project.role === 'admin', runtime: await runtimeState(c, project, principal, config) }
    }

    app.get(base, async c => {
        const { principal, project } = await human(c, 'viewer')
        return c.json(await status(c, project, principal))
    })
    app.put(base, async c => {
        const body = await parseBody(c, BrowserConfigUpdateSchema)
        const { principal, project } = await human(c, 'admin'); requireFreshPasskey(c, store, principal)
        const before = configs.get(project.id)
        const config = configs.update(principal.user.id, project.id, body)
        store.audit(principal.user.id, project.id, config.enabled ? 'browser.configure' : 'browser.disable', project.id)
        let lifecycle: { ok: boolean; errorCode?: string } = { ok: true }
        // Start/stop only on an actual change; disabling always stops (explicit, Compose profiles are not stopped implicitly).
        if (before.enabled !== config.enabled || !config.enabled) {
            if (!config.enabled) { runtimes.delete(project.id); observed.delete(project.id) }
            try { await control(c, project, principal, 'browser', config.enabled) }
            catch (error) {
                lifecycle = { ok: false, errorCode: error instanceof EvolvedError ? error.code : 'browser_lifecycle_failed' }
                if (config.enabled) observe(project.id, lifecycle.errorCode === 'browser_image_missing' ? 'image_missing' : lifecycle.errorCode === 'browser_runner_missing' ? 'runner_missing' : 'failed', lifecycle.errorCode)
            }
        }
        return c.json({ ...await status(c, project, principal), lifecycle })
    })
    app.post(`${base}/start`, async c => {
        await parseBody(c, z.object({}).strict())
        const { principal, project } = await human(c, 'admin'); requireFreshPasskey(c, store, principal)
        if (!configs.get(project.id).enabled) throw new EvolvedError('browser_disabled', 'Der Projektbrowser ist deaktiviert.', 409)
        try { await control(c, project, principal, 'browser', true) }
        catch (error) { if (error instanceof EvolvedError && error.code === 'browser_image_missing') observe(project.id, 'image_missing', error.code); throw error }
        observe(project.id, 'starting')
        store.audit(principal.user.id, project.id, 'browser.start', project.id)
        return c.json(await status(c, project, principal))
    })
    app.post(`${base}/probe`, async c => {
        await parseBody(c, z.object({}).strict())
        const { principal, project } = await human(c, 'admin')
        const entry = runtimes.get(project.id)
        if (!configs.get(project.id).enabled || !entry) throw new EvolvedError('browser_not_running', 'Der Projektbrowser meldet sich noch nicht.', 409)
        entry.probe = randomUUID()
        return c.json({ probeId: entry.probe })
    })
    /** Agent self-discovery of the project browser and its actual rights; works while the optional sidecar is stopped. */
    app.get(`${base}/agent`, async c => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal?.capability) throw new EvolvedError('unauthorized', 'Runner capability required.', 401)
        requireScope(principal, 'runner:connect', c.req.param('id'))
        const project = store.requireProject(principal.user.id, c.req.param('id')!, 'member')
        const config = configs.get(project.id), managed = getManagedCredentialLease(store, project)
        const managedRunner = !!managed && managed.id === principal.capability.leaseId
        const restricted = project.profile === 'restricted'
        const tools = config.enabled ? BROWSER_TOOLS.filter(tool => config.enabledTools.includes(tool.name) && (!restricted || config.readOnlyTools.includes(tool.name)))
            .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, readOnly: config.readOnlyTools.includes(tool.name) })) : []
        const runtime = await runtimeState(c, project, principal, config, false)
        const available = config.enabled && managedRunner && tools.length > 0 && ['ready', 'service_ready', 'starting'].includes(runtime.state)
        return c.json({ enabled: config.enabled, available, managedRunner, profile: project.profile, version: config.version, catalogRevision: BROWSER_CATALOG_REVISION, runtime, tools,
            sharing: 'One browser state (tabs, cookies, logins) is shared by all agent sessions of this project runner lease; ephemeral, lost on restart, disable or lease change. No per-session isolation.',
            guidance: !config.enabled ? 'The project browser is disabled. A project administrator can enable it in the MCP Shop; do not install or start another browser.'
                : !managedRunner ? 'The project browser is only reachable from the current managed project runner of this project.'
                : !tools.length ? 'No browser tool is granted for this project profile.'
                : runtime.state === 'ready' ? 'Use evolved_browser_query for read-only grants and evolved_browser_call for actions.'
                : `The browser runtime is ${runtime.state}; calls may fail until it is ready.` })
    })
    app.post(`${base}/authorize`, async c => {
        const body = await parseBody(c, BrowserAuthorizeSchema), { project, leaseId } = await gateway(c)
        const config = configs.get(project.id)
        const restricted = project.profile === 'restricted'
        const permitted = (name: BrowserToolName, mode: 'query' | 'call') => config.enabledTools.includes(name) && (!(restricted || mode === 'query') || config.readOnlyTools.includes(name))
        const grant: BrowserGrant = { projectId: project.id, contextId: browserContextId(project.id, leaseId), sessionKey: 'hapi', version: config.version, catalogRevision: BROWSER_CATALOG_REVISION, profile: project.profile,
            tools: BROWSER_TOOLS.filter(tool => permitted(tool.name, 'call')).map(tool => ({ ...tool, readOnlyEligible: config.readOnlyTools.includes(tool.name) })) }
        if (!config.enabled) throw new EvolvedError('browser_disabled', 'Der Projektbrowser ist für dieses Projekt deaktiviert.', 403)
        if (body.phase === 'catalog') return c.json(grant)
        if (!body.toolName || !body.mode || body.version === undefined || !body.catalogRevision) throw new EvolvedError('invalid_body', 'Invalid request body.')
        if (body.version !== config.version || body.catalogRevision !== BROWSER_CATALOG_REVISION) throw new EvolvedError('browser_catalog_changed', 'Browser-Werkzeugkatalog oder Freigaben haben sich geändert. evolved_browser_tools neu lesen.', 409)
        if (!permitted(body.toolName, body.mode)) throw new EvolvedError('browser_tool_denied', 'Dieses Browserwerkzeug ist für das Projektprofil nicht freigegeben.', 403)
        return c.json(grant)
    })
    app.post(`${base}/report`, async c => {
        const report = await parseBody(c, BrowserReportSchema), { project, leaseId } = await gateway(c)
        const config = configs.get(project.id), previous = runtimes.get(project.id)
        const entry: Runtime = previous?.leaseId === leaseId ? previous : { leaseId, report, at: 0, engineAt: null, engineState: 'unknown', probe: null }
        entry.report = report; entry.at = store.now()
        // Engine state changes only with an explicit probe result (startup probe or requested one).
        if (report.engine !== 'unknown' && (report.probeId === undefined || report.probeId === entry.probe)) {
            entry.engineState = report.engine; entry.engineAt = store.now()
            if (report.probeId !== undefined) entry.probe = null
        }
        if (report.service !== 'reachable') entry.engineState = 'unknown'
        if (config.enabled) runtimes.set(project.id, entry); else runtimes.delete(project.id)
        return c.json({ enabled: config.enabled, probe: config.enabled && entry.probe ? { id: entry.probe } : null })
    })
    return app
}
