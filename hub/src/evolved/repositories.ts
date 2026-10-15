import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { EvolvedError, type EvolvedStore, type EvolvedProject } from './store'
import { authenticateEvolvedRequest, createEvolvedRequestGuard, parseBody, requireScope } from './security'
import type { VaultClient } from './vault'
import type { SyncEngine } from '../sync/syncEngine'

const repositoryId = z.string().regex(/^[1-9][0-9]{0,19}$/)
const owner = z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/)
const name = z.string().regex(/^[a-z0-9_.-]{1,100}$/).refine(value => !['.', '..', '.git'].includes(value))
const repository = z.object({ id: repositoryId, owner, name, fullName: z.string().max(201), permission: z.enum(['read', 'write']) })
const catalogSchema = z.object({ connected: z.boolean(), repositories: z.array(repository).max(200) })
const localSchema = z.object({ state: z.enum(['missing', 'ready', 'blocked', 'unknown']), branch: z.string().max(1024).nullable(), dirty: z.boolean().nullable(), message: z.string().max(500).optional() }).strict()
const statusSchema = z.array(z.object({ id: repositoryId, local: localSchema }).strict()).max(200)
const syncSchema = z.object({ action: z.enum(['clone', 'pull']), requestId: z.string().uuid() }).strict()
type Repository = z.infer<typeof repository> & { cloneUrl: string; path: string }
type Job = { id: string; project_id: string; user_id: string; request_id: string; repository_id: string; action: 'clone' | 'pull'; state: 'running' | 'succeeded' | 'failed'; message: string | null; created_at: number }
type Engine = Pick<SyncEngine, 'getOnlineMachinesByNamespace' | 'evolvedRepositories'>
const unknownLocal = () => ({ state: 'unknown' as const, branch: null, dirty: null })
const publicJob = (job: Job) => ({ id: job.id, requestId: job.request_id, repositoryId: job.repository_id, action: job.action, state: job.state, ...(job.message ? { message: job.message } : {}) })
const accessChanged = () => new EvolvedError('repository_access_changed', 'Die Projekt- oder Repositoryfreigabe wurde geändert. Bitte den Status aktualisieren.', 403)

/** Repository metadata is useful without a session or checkout. Execution stays in the unprivileged runner. */
export function createRepositoryRoutes(config: { store: EvolvedStore; vault: VaultClient; origin: string; getEngine: () => Engine | null }) {
    const { store, vault } = config, app = new Hono()
    let closed = false
    store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_repository_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, request_id TEXT NOT NULL, repository_id TEXT NOT NULL,
        action TEXT NOT NULL, state TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL,
        UNIQUE(project_id,user_id,request_id));
        CREATE INDEX IF NOT EXISTS evolved_repository_jobs_project ON evolved_repository_jobs(project_id,created_at DESC)`)
    store.db.prepare("UPDATE evolved_repository_jobs SET state='failed',message=? WHERE state='running'").run('Der Server wurde während der Aktion neu gestartet. Die Aktion kann abgeschlossen sein; bitte zuerst den lokalen Status prüfen.')
    const running = new Map<string, { projectId: string; machineId: string; authorize: () => Promise<Repository> }>()
    const preparing = new Set<string>()
    type Inspection = { key: string; expiresAt: number; result?: z.infer<typeof statusSchema>; pending?: Promise<z.infer<typeof statusSchema>> }
    const inspections = new Map<string, Inspection>()
    let inspecting = 0
    app.use('*', createEvolvedRequestGuard(config.origin))
    app.use('*', bodyLimit({ maxSize: 4096 }))

    async function access(request: Request, id: string, write = false) {
        if (closed) throw accessChanged()
        const principal = await authenticateEvolvedRequest(request, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Bitte anmelden.', 401)
        if (principal.capability) {
            if (!principal.capability.leaseId || request.headers.has('cookie')) throw accessChanged()
            requireScope(principal, 'runner:connect', id); requireScope(principal, 'git:read', id)
        }
        const project = store.requireProject(principal.user.id, id, write || principal.capability ? 'member' : 'viewer')
        if (write && project.profile === 'restricted') throw new EvolvedError('profile_denied', 'Klonen und Aktualisieren benötigen einen beschreibbaren Projektordner. Das Projektprofil ist derzeit nur lesend.', 403)
        return { principal, project }
    }
    async function catalog(request: Request, id: string, write = false) {
        const current = await access(request, id, write)
        const raw = await vault.request({ userId: current.principal.user.id, projectId: id, operation: 'github', payload: { action: 'status' } })
        const live = await access(request, id, write)
        if (live.project.rootPath !== current.project.rootPath || live.project.profile !== current.project.profile) throw accessChanged()
        const parsed = catalogSchema.safeParse(raw)
        if (!parsed.success) throw new EvolvedError('invalid_repository_catalog', 'Die Repositoryfreigaben konnten nicht gelesen werden.', 502)
        const repositories: Repository[] = parsed.data.repositories.map(repo => {
            if (repo.fullName !== `${repo.owner}/${repo.name}` || ['.', '..'].includes(repo.name)) throw accessChanged()
            return { ...repo, cloneUrl: `https://github.com/${repo.fullName}.git`, path: `${live.project.rootPath}/repositories/${repo.owner}/${repo.name}` }
        })
        return { ...live, connected: parsed.data.connected, repositories }
    }
    function runner(project: EvolvedProject) {
        const engine = config.getEngine()
        const candidates = engine?.getOnlineMachinesByNamespace(project.namespace).filter(machine => machine.metadata?.workspaceRoots?.length === 1 && machine.metadata.workspaceRoots[0] === project.rootPath) ?? []
        if (!candidates.length) return { status: 'offline' as const }
        if (candidates.length !== 1) return { status: 'ambiguous' as const }
        const machine = candidates[0]!
        if (!machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.EvolvedRepositories)) return { status: 'upgrade_required' as const }
        return { status: 'ready' as const, machineId: machine.id, engine: engine! }
    }
    async function inspect(project: EvolvedProject, repositories: Repository[], target: ReturnType<typeof runner>): Promise<z.infer<typeof statusSchema>> {
        if (target.status !== 'ready' || !repositories.length || [...running.values()].some(job => job.projectId === project.id)) return []
        const key = JSON.stringify([project.namespace, project.rootPath, project.profile, target.machineId, repositories])
        let entry = inspections.get(project.id)
        if (entry?.key !== key || !entry.pending && entry.expiresAt <= store.now()) {
            if (inspecting >= 4) return []
            for (const [id, value] of inspections) if (!value.pending && value.expiresAt <= store.now()) inspections.delete(id)
            if (inspections.size >= 64 && !inspections.has(project.id)) return []
            entry = { key, expiresAt: 0 }
            inspections.set(project.id, entry)
            const current = entry
            inspecting++
            current.pending = (async () => {
                try { return statusSchema.parse(await target.engine.evolvedRepositories(target.machineId, { action: 'status', projectId: project.id, repositories }, 15_000)) }
                catch { return [] }
            })().then(result => {
                current.result = result; current.expiresAt = store.now() + 2_000
                return result
            }).finally(() => { inspecting--; current.pending = undefined })
        }
        const result = entry.pending ? await entry.pending : entry.result ?? []
        return inspections.get(project.id) === entry ? result : []
    }
    const findJob = (id: string) => store.db.prepare('SELECT * FROM evolved_repository_jobs WHERE id=?').get(id) as Job | null
    app.get('/projects/:id/repositories', async c => {
        if (Object.keys(c.req.query()).some(key => key !== 'workspace') || ![undefined, '0', '1'].includes(c.req.query('workspace'))) throw new EvolvedError('invalid_query', 'Ungültige Statusabfrage.', 400)
        const { project, repositories } = await catalog(c.req.raw, c.req.param('id'))
        const target = runner(project)
        let statuses: z.infer<typeof statusSchema> = []
        if (c.req.query('workspace') !== '0') statuses = await inspect(project, repositories, target)
        const live = await catalog(c.req.raw, project.id)
        if (live.project.rootPath !== project.rootPath || live.project.profile !== project.profile) throw accessChanged()
        const currentTarget = runner(live.project)
        if (currentTarget.status !== target.status || currentTarget.machineId !== target.machineId) statuses = []
        const pushEligible = live.connected && live.project.role !== 'viewer' && project.profile !== 'restricted' && (!live.principal.capability || live.principal.capability.scopes.includes('git:write'))
        const jobs = store.db.prepare('SELECT * FROM evolved_repository_jobs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(project.id) as Job[]
        return c.json({ connected: live.connected, rootPath: project.rootPath,
            canSync: live.connected && live.project.role !== 'viewer' && project.profile !== 'restricted' && currentTarget.status === 'ready',
            canPush: pushEligible && live.repositories.some(repo => repo.permission === 'write'), gitHubPermissionsVerified: false,
            runner: { status: currentTarget.status }, repositories: live.repositories.map(repo => {
                const job = jobs.find(job => job.repository_id === repo.id)
                const unchanged = repositories.some(before => before.id === repo.id && before.fullName === repo.fullName)
                return { ...repo, canPush: pushEligible && repo.permission === 'write', local: unchanged ? statuses.find(status => status.id === repo.id)?.local ?? unknownLocal() : unknownLocal(), ...(job ? { job: publicJob(job) } : {}) }
            }) })
    })
    app.post('/projects/:id/repositories/:repositoryId/sync', async c => {
        const body = await parseBody(c, syncSchema), id = c.req.param('id'), repoId = repositoryId.safeParse(c.req.param('repositoryId'))
        if (!repoId.success) throw new EvolvedError('invalid_repository', 'Ungültiges Repository.', 400)
        const initial = await access(c.req.raw, id, true)
        // Serialize catalog I/O as well as job insertion. A lost POST response is safe to reconcile by request ID.
        if (preparing.has(id)) throw new EvolvedError('repository_busy', 'Für dieses Projekt wird bereits eine Git-Aktion vorbereitet.', 409)
        preparing.add(id)
        try {
            const { project, principal, connected, repositories } = await catalog(c.req.raw, id, true)
            if (principal.user.id !== initial.principal.user.id) throw accessChanged()
            const repo = repositories.find(repo => repo.id === repoId.data)
            if (!connected || !repo) throw new EvolvedError('repository_not_granted', 'Dieses Repository ist für das Projekt nicht freigegeben.', 403)
            const previous = store.db.prepare('SELECT * FROM evolved_repository_jobs WHERE project_id=? AND user_id=? AND request_id=?').get(id, principal.user.id, body.requestId) as Job | null
            if (previous) {
                if (previous.repository_id !== repo.id || previous.action !== body.action) throw new EvolvedError('idempotency_conflict', 'Diese Anfragekennung gehört zu einer anderen Aktion.', 409)
                return c.json({ job: publicJob(previous) }, 202)
            }
            if ([...running.values()].some(job => job.projectId === id)) throw new EvolvedError('repository_busy', 'In diesem Projekt läuft bereits eine Git-Aktion. Bitte deren Abschluss abwarten.', 409)
            if (running.size >= 4) throw new EvolvedError('repository_busy', 'Es laufen bereits mehrere Git-Aktionen. Bitte kurz warten.', 429)
            const target = runner(project)
            if (target.status !== 'ready') throw new EvolvedError(`runner_${target.status}`, target.status === 'upgrade_required' ? 'Der Projektdienst benötigt ein Update für Repositoryaktionen.' : target.status === 'ambiguous' ? 'Mehrere Projektdienste sind für diesen Ordner verbunden. Bitte nur einen verwenden.' : 'Der Projektdienst ist nicht verbunden. Bitte unter Anbieter & Abos verbinden.', 409)
            if (principal.capability && principal.capability.expiresAt < store.now() + 330_000) throw new EvolvedError('repository_capability_refresh_required', 'Der kurzlebige Runnerzugang muss vor dieser Git-Aktion erneuert werden. Es wurde keine Aktion gestartet.', 409)
            const job: Job = { id: randomUUID(), project_id: id, user_id: principal.user.id, request_id: body.requestId, repository_id: repo.id, action: body.action, state: 'running', message: null, created_at: store.now() }
            store.db.prepare("DELETE FROM evolved_repository_jobs WHERE state<>'running' AND created_at<?").run(store.now() - 7 * 24 * 3600_000)
            store.db.prepare('INSERT INTO evolved_repository_jobs VALUES(?,?,?,?,?,?,?,?,?)').run(job.id, id, job.user_id, job.request_id, repo.id, job.action, job.state, null, job.created_at)
            const authorize = async () => {
                const current = await catalog(c.req.raw, id, true), activeTarget = runner(current.project)
                const granted = current.repositories.find(item => item.id === repo.id)
                if (closed || !running.has(job.id) || store.now() - job.created_at > 300_000 || !current.connected || !granted || granted.fullName !== repo.fullName || current.project.rootPath !== project.rootPath || current.project.profile !== project.profile || activeTarget.status !== 'ready' || activeTarget.machineId !== target.machineId) throw accessChanged()
                return granted
            }
            running.set(job.id, { projectId: id, machineId: target.machineId, authorize })
            inspections.delete(id)
            store.audit(job.user_id, id, `repository.${job.action}_started`, repo.id)
            void (async () => {
                try {
                    await authorize()
                    const result = z.object({ local: localSchema }).strict().parse(await target.engine.evolvedRepositories(target.machineId, { action: body.action, projectId: id, jobId: job.id, repository: repo }, 300_000))
                    await authorize()
                    if (result.local.state !== 'ready') throw new EvolvedError('repository_sync_failed', result.local.message ?? 'Die Git-Aktion wurde nicht abgeschlossen. Bitte den Status prüfen.', 409)
                    store.db.prepare("UPDATE evolved_repository_jobs SET state='succeeded',message=? WHERE id=?").run(body.action === 'clone' ? 'Repository im Projektordner geklont.' : 'Repository aktualisiert; lokale Änderungen wurden erhalten.', job.id)
                    store.audit(job.user_id, id, `repository.${job.action}_completed`, repo.id)
                } catch (error) {
                    if (!closed) {
                        // RPC failures may happen after dispatch; never claim that nothing changed.
                        const message = error instanceof EvolvedError ? error.message : 'Die Git-Aktion konnte nicht bestätigt werden. Bitte zuerst den lokalen Status prüfen; vorhandene Änderungen werden nicht überschrieben.'
                        store.db.prepare("UPDATE evolved_repository_jobs SET state='failed',message=? WHERE id=?").run(message, job.id)
                        store.audit(job.user_id, id, `repository.${job.action}_failed`, repo.id)
                    }
                } finally { running.delete(job.id); inspections.delete(id) }
            })()
            return c.json({ job: publicJob(job) }, 202)
        } finally { preparing.delete(id) }
    })
    app.get('/projects/:id/repository-jobs/:jobId', async c => {
        await access(c.req.raw, c.req.param('id'))
        const job = findJob(c.req.param('jobId'))
        if (!job || job.project_id !== c.req.param('id')) throw new EvolvedError('repository_job_not_found', 'Die Git-Aktion ist nicht mehr verfügbar. Bitte den Repositorystatus prüfen.', 404)
        return c.json({ job: publicJob(job) })
    })
    app.get('/projects/:id/repositories/:repositoryId/authorization', async c => {
        const { principal, project } = await access(c.req.raw, c.req.param('id'), true)
        if (!principal.capability?.leaseId) throw accessChanged()
        const jobId = c.req.query('jobId') ?? '', entry = running.get(jobId), job = findJob(jobId)
        if (!entry || !job || entry.projectId !== project.id || job.repository_id !== c.req.param('repositoryId')) throw accessChanged()
        const repo = await entry.authorize()
        await access(c.req.raw, project.id, true)
        return c.json({ authorized: true, machineId: entry.machineId, rootPath: project.rootPath, repository: repo })
    })
    return { routes: app, async discovery(request: Request, projectId: string) {
        const { project, principal, repositories, connected } = await catalog(request, projectId)
        const pushEligible = connected && project.role !== 'viewer' && project.profile !== 'restricted' && (!principal.capability || principal.capability.scopes.includes('git:write'))
        return { repositories: repositories.map(repo => ({ ...repo, canPush: pushEligible && repo.permission === 'write' })), git: { connected, rootPath: project.rootPath,
            canPush: pushEligible && repositories.some(repo => repo.permission === 'write'), gitHubPermissionsVerified: false,
            instructions: 'Use the exact fullName and cloneUrl of a granted repository; never guess its owner. Git HTTPS uses the project broker without gh, SSH keys or tokens. The path field is the project checkout directory. Discover and clone/update through evolved_repositories / evolved_repository_sync or hapi evolved repositories / hapi evolved sync. Native git fetch, pull and push use the same project grants. canPush describes project authorization only; GitHub still checks token permissions and branch rules during each push.' } }
    }, close() { closed = true; running.clear(); inspections.clear() } }
}
