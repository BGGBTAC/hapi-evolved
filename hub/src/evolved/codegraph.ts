import { Hono } from 'hono'
import { EvolvedError, EvolvedStore, type EvolvedPrincipal } from './store'
import { authenticateEvolvedRequest, requireScope } from './security'

type CodegraphEnv = { Variables: { principal: EvolvedPrincipal } }
export type CodegraphOptions = { store: EvolvedStore; adapterUrl?: string; serviceToken?: string; origin?: string }
function cleanupSchema(store: EvolvedStore): void {
    store.db.exec('CREATE TABLE IF NOT EXISTS evolved_codegraph_cleanup(project_id TEXT PRIMARY KEY,root_path TEXT NOT NULL,created_at INTEGER NOT NULL)')
}
export function enqueueCodegraphDeletion(store: EvolvedStore, projectId: string): void {
    cleanupSchema(store)
    // Internal deletion hook runs after ACL revocation but before the project row is removed.
    const project = store.db.query('SELECT root_path FROM evolved_projects WHERE id=?').get(projectId) as { root_path: string } | null
    if (project?.root_path) store.db.query('INSERT OR REPLACE INTO evolved_codegraph_cleanup VALUES(?,?,?)').run(projectId, project.root_path, Date.now())
}
export async function queryCodegraph(options: CodegraphOptions, project: { id: string; rootPath: string }, operation: string, params: Record<string, unknown> = {}) {
    if (!options.adapterUrl || !options.serviceToken || !project.rootPath) return { status: 503, result: { available: false, state: 'unconfigured', code: 'codegraph_unconfigured', error: 'Codegraph service or project workspace is not configured' } }
    try {
        const response = await fetch(`${options.adapterUrl}/query`, {
            method: 'POST', headers: { authorization: `Bearer ${options.serviceToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: project.id, root: project.rootPath, operation, params }), signal: AbortSignal.timeout(32_000)
        })
        const result = await response.json() as Record<string, unknown>
        return { status: response.status, result }
    } catch { return { status: 503, result: { available: false, state: 'error', code: 'codegraph_unavailable', error: 'Codegraph service unavailable' } } }
}
export function createCodegraphRoutes(options: CodegraphOptions) {
    const app = new Hono<CodegraphEnv>()
    app.use('*', async (c, next) => {
        const principal = await authenticateEvolvedRequest(c.req.raw, options.store)
        if (!principal) return c.json({ error: 'Authentication required' }, 401)
        if (c.req.method === 'POST' && !principal.capability && c.req.header('origin') !== (options.origin ?? new URL(c.req.url).origin)) return c.json({ error: 'Origin rejected' }, 403)
        c.set('principal', principal); return next()
    })
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ error: error.message }, error.status as 400) : c.json({ error: 'Codegraph request failed' }, 500))
    for (const operation of ['status', 'search', 'graph', 'node', 'impact', 'affected']) {
        app.get(`/projects/:id/codegraph/${operation}`, async c => {
            const principal = c.get('principal'); const projectId = c.req.param('id')!
            requireScope(principal, 'codegraph:read', projectId)
            const project = options.store.requireProject(principal.user.id, projectId)
            const response = await queryCodegraph(options, project, operation, c.req.query())
            const refreshed = await authenticateEvolvedRequest(c.req.raw, options.store)
            if (!refreshed) return c.json({ error: 'Authentication expired' }, 401)
            requireScope(refreshed, 'codegraph:read', projectId)
            options.store.requireProject(refreshed.user.id, projectId)
            return c.json(response.result, response.status as 200)
        })
    }
    app.post('/projects/:id/codegraph/reindex', async c => {
        const principal = c.get('principal'); const projectId = c.req.param('id')
        requireScope(principal, 'codegraph:read', projectId)
        const project = options.store.requireProject(principal.user.id, projectId, 'member')
        const response = await queryCodegraph(options, project, 'reindex')
        options.store.audit(principal.user.id, project.id, 'codegraph.reindex')
        return c.json(response.result, response.status as 200)
    })
    return app
}

/** Register project workspaces after creation/restart; the adapter owns bounded incremental watchers. */
export function startCodegraphSync(options: CodegraphOptions): () => void {
    cleanupSchema(options.store)
    let running = false
    const sync = async () => {
        if (running || !options.adapterUrl || !options.serviceToken) return
        running = true
        try {
            const removals = options.store.db.query('SELECT project_id,root_path FROM evolved_codegraph_cleanup').all() as { project_id: string; root_path: string }[]
            for (const removal of removals) {
                const response = await queryCodegraph(options, { id: removal.project_id, rootPath: removal.root_path }, 'drop')
                if (response.status === 200) options.store.db.query('DELETE FROM evolved_codegraph_cleanup WHERE project_id=?').run(removal.project_id)
            }
            for (const project of options.store.listProjectsForService()) {
                if (project.rootPath) await queryCodegraph(options, project, 'status')
            }
        } finally { running = false }
    }
    void sync()
    const timer = setInterval(() => { void sync() }, 30_000); timer.unref()
    return () => clearInterval(timer)
}
