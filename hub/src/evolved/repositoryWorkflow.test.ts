import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PluginService } from './plugins'
import { createAgentCatalogRoutes } from './agentCatalog'
import { RpcTargetMissingError } from '../sync/rpcGateway'
import { join } from 'node:path'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { RepoWorktree } from '@hapi/protocol/evolvedWorkspace'
import { EvolvedStore, EvolvedError } from './store'
import { createRepositoryRoutes } from './repositories'
import { proposeMemoryFile } from './memory'
import { MemoryService } from './memoryService'
import { createProjectAuthMiddleware, createSessionTokenRoutes, verifyProjectToken } from './bridge'
import { createMachinesRoutes } from '../web/routes/machines'
import type { SyncEngine } from '../sync/syncEngine'
import type { WebAppEnv } from '../web/middleware/auth'

const cleanups: (() => void)[] = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })
const repo = { id: '123', owner: 'example', name: 'code', fullName: 'example/code', permission: 'read' }
const snapshotId = 'a'.repeat(64)
const listing = (): RepoWorktree => ({ repositoryId: repo.id, state: 'ready', branch: 'main', detached: false, head: 'b'.repeat(40), snapshotId, observedAt: 100, files: [{ path: 'src/main.ts', index: 'M', worktree: ' ', kind: 'file' }], truncated: false })
function barrier() {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
}
function setup() {
    const store = new EvolvedStore(':memory:')
    for (const id of ['admin', 'member', 'viewer']) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, id === 'admin' ? 1 : 0, Date.now())
    const team = store.createTeam('admin', 'Team'); store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    const project = store.createProject('admin', team.id, 'Project'), second = store.createProject('admin', team.id, 'Second')
    const checkout = join(project.rootPath, 'repositories', repo.fullName); mkdirSync(join(checkout, '.git'), { recursive: true })
    const cookies = Object.fromEntries(['admin', 'member', 'viewer'].map(id => [id, store.createSession(id)]))
    let granted = true, connected = true, machineId = 'machine', capable = true
    const messages = new Map<string, any[]>(), archived: string[] = []
    let afterSpawn: (() => void) | undefined, afterAssignment: (() => void) | undefined
    const calls: any[] = [], starts: Parameters<SyncEngine['spawnSession']>[] = [], graphCalls: any[] = [], liveSessions = new Set<string>()
    let run: (params: any) => Promise<unknown> = async params => params.action === 'worktree' ? listing() : { path: params.path, side: params.side, patch: '@@ -1 +1 @@\n-old\n+new', binary: false, truncated: false, observedAt: 101 }
    let grantRead: (() => void) | undefined
    let fileRecheck: (() => Promise<void>) | undefined, fileStored: (() => Promise<void>) | undefined
    const memory = new MemoryService(store, { available: async () => false, request: async () => { throw new Error('No cloud backend in this fixture') } })
    const engine = {
        getMachineByNamespace: (id: string, namespace: string) => id === machineId && namespace === project.namespace ? { id, active: true, metadata: { capabilities: [MACHINE_CAPABILITIES.AgentAvailability] } } : undefined,
        sendMessage: async (id: string, body: any) => { messages.set(id, [body]); afterAssignment?.() },
        getMessagesPage: (id: string) => ({ messages: messages.get(id) ?? [] }),
        archiveSession: async (id: string) => { archived.push(id) },
        getMachine: () => ({ namespace: project.namespace, metadata: { capabilities: [MACHINE_CAPABILITIES.AgentAvailability] } }),
        getOnlineMachinesByNamespace: (namespace: string) => namespace !== project.namespace ? [] : [{ id: machineId, metadata: { workspaceRoots: [project.rootPath], capabilities: [MACHINE_CAPABILITIES.EvolvedRepositories, ...(capable ? [MACHINE_CAPABILITIES.EvolvedRepositoryWorktree] : [])] } }],
        getSessionByNamespace: (id: string, namespace: string) => namespace === project.namespace && liveSessions.has(id) ? { id, namespace } : undefined,
        evolvedRepositories: async (_id: string, params: any) => { calls.push(params); return run(params) },
        spawnSession: async (...args: Parameters<SyncEngine['spawnSession']>) => { starts.push(args); args[18]?.('reserved-session'); liveSessions.add('reserved-session'); afterSpawn?.(); return { type: 'success', sessionId: 'reserved-session' } }
    } as unknown as SyncEngine
    const origin = 'https://workflow.example.test', secret = new Uint8Array(32).fill(5)
    const routes = createRepositoryRoutes({ store, origin, getEngine: () => engine, vault: { request: async () => { grantRead?.(); return { connected, repositories: granted ? [repo] : [] } } },
        intakeFile: async (request, projectId, path, recheck) => {
            const result = await proposeMemoryFile({ store, service: memory, request, projectId, path,
                recheck: async () => { await fileRecheck?.(); await recheck() } })
            await fileStored?.()
            return result
        },
        queryCodegraph: async (_project, operation, params) => { graphCalls.push({ operation, params }); return { status: 200, result: { nodes: [{ id: 'test', name: 'works', kind: 'function', file: 'repositories/example/code/tests/main.test.ts', line: 1 }], edges: [], lastIndexedAt: 200, pendingFiles: 0 } } } })
    const app = new Hono<WebAppEnv>()
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code, error: error.message }, error.status as 400) : c.json({ code: 'internal' }, 500))
    app.route('/api/evolved', routes.routes)
    app.get('/api/evolved/unrelated', c => c.json({ ok: true }))
    app.route('/api/evolved', createAgentCatalogRoutes({ store, origin, plugins: new PluginService(store), getSyncEngine: () => engine, repositoryStart: routes.resolveStart, repositoryReview: routes.reviewContext }))
    app.route('/api/evolved', createSessionTokenRoutes(store, secret, origin))
    app.use('/api/*', createProjectAuthMiddleware(store, secret, origin))
    app.route('/api', createMachinesRoutes(() => engine, { repositoryStart: routes.resolveStart }))
    const request = (suffix: string, body?: unknown, user = 'member', originValue = origin) => app.request(`${origin}/api/evolved/projects/${project.id}${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `__Host-hapi-evolved=${cookies[user]}`, origin: originValue, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const load = () => request(`/repositories/${repo.id}/worktree`)
    const diff = (body: unknown = { path: 'src/main.ts', side: 'staged', snapshotId }, user?: string) => request(`/repositories/${repo.id}/worktree/diff`, body, user)
    const token = async (user = 'member') => { const res = await app.request(`/api/evolved/session-token?projectId=${project.id}`, { headers: { cookie: `__Host-hapi-evolved=${cookies[user]}` } }); return (await res.json() as any).token as string }
    const spawn = async (body: unknown) => app.request('/api/machines/machine/spawn', { method: 'POST', headers: { authorization: `Bearer ${await token()}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const sync = (action: 'clone' | 'pull' = 'pull') => request(`/repositories/${repo.id}/sync`, { action, requestId: randomUUID() })
    const waitJob = async (jobId: string) => {
        for (let i = 0; i < 50; i++) {
            const body = await (await request(`/repository-jobs/${jobId}`)).json() as { job: { state: string } }
            if (body.job.state !== 'running') return body.job
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        throw new Error('Job did not settle')
    }
    cleanups.push(() => { routes.close(); store.close() })
    return { store, project, second, checkout, cookies, routes, request, load, diff, token, spawn, starts, calls, graphCalls, liveSessions, secret, messages, archived, app, memory, sync, waitJob,
        onFileRecheck: (fn: () => Promise<void>) => { fileRecheck = fn }, onFileStored: (fn: () => Promise<void>) => { fileStored = fn }, restoreGrant: () => { granted = true },
        afterSpawn: (fn: () => void) => { afterSpawn = fn },
        afterAssignment: (fn: () => void) => { afterAssignment = fn },
        setRun: (value: typeof run) => { run = value }, revoke: () => { granted = false }, disconnect: () => { connected = false }, switchMachine: () => { machineId = 'replacement' }, downgrade: () => { capable = false }, onGrant: (fn: () => void) => { grantRead = fn } }
}
describe('repository workflow boundary', () => {
    test('viewer reads are no-store and listings are scoped to the same human and machine', async () => {
        const t = setup()
        expect((await t.load()).headers.get('cache-control')).toContain('no-store')
        expect((await t.diff(undefined, 'viewer')).status).toBe(409)
        expect((await t.diff()).status).toBe(200)
        t.switchMachine(); expect((await t.diff()).status).toBe(409)
        expect((await t.request(`/repositories/${repo.id}/worktree`, undefined, 'viewer')).status).toBe(200)
    })
    test('origin, capability and listing path gates precede any diff RPC', async () => {
        const t = setup(); await t.load()
        expect((await t.request(`/repositories/${repo.id}/worktree/diff`, { path: 'src/main.ts', side: 'staged', snapshotId }, 'member', 'https://foreign.test')).status).toBe(403)
        for (const path of ['../main.ts', 'unlisted.ts', '/src/main.ts']) expect((await t.diff({ path, side: 'staged', snapshotId })).status).toBe(409)
        expect(t.calls).toHaveLength(1)
    })
    test('hub withholds secrets even if a runner claims its patch is safe', async () => {
        const t = setup(); await t.load()
        t.setRun(async params => ({ path: params.path, side: params.side, patch: '+api_key = "synthetic-long-sensitive-value"', binary: false, truncated: false, observedAt: 101 }))
        const response = await t.diff(), body = await response.json() as any
        expect(response.status).toBe(200); expect(body.patch).toBeNull(); expect(body.withheld).toBe('credential_pattern')
        expect(JSON.stringify(body)).not.toContain('synthetic-long')
    })
    test('hub sanitizes secret paths and rejects mismatched responses without echoing runner data', async () => {
        const t = setup()
        t.setRun(async () => ({ ...listing(), files: [{ path: '.env', index: 'M', worktree: ' ', kind: 'file' }, { path: 'api_key=synthetic-credential-value-long', index: 'M', worktree: ' ', kind: 'file' }] }))
        const body = await (await t.load()).json() as any
        expect(body.files[0].excluded).toBe('sensitive_path'); expect(body.files[1].path).toBe(''); expect(body.files[1].pathRef).toHaveLength(64)
        expect((await t.diff({ path: '.env', side: 'staged', snapshotId })).status).toBe(403)
        t.setRun(async () => ({ ...listing(), repositoryId: '999' })); expect((await t.load()).status).toBe(403)
    })
    test.each(['grant', 'session', 'profile', 'machine'] as const)('revocation during RPC (%s) discards the result', async kind => {
        const t = setup()
        t.setRun(async () => { if (kind === 'grant') t.revoke(); if (kind === 'session') t.store.revokeSession(t.cookies.member!); if (kind === 'profile') t.store.setProfile('admin', t.project.id, 'workspace'); if (kind === 'machine') t.switchMachine(); return listing() })
        expect((await t.load()).status).toBe(403)
    })
    test('old runners receive no unknown operation', async () => { const t = setup(); t.downgrade(); expect((await t.load()).status).toBe(409); expect(t.calls).toHaveLength(0) })
    test('impact passes exact array paths including commas and skips deleted and sensitive files', async () => {
        const t = setup()
        t.setRun(async () => ({ ...listing(), files: ['src/a,b.ts', 'deleted.ts', '.env'].map(path => ({ path, index: path === 'deleted.ts' ? 'D' : 'M', worktree: ' ', kind: 'file' })) }))
        await t.load()
        const response = await t.request(`/repositories/${repo.id}/impact`, { snapshotId, paths: ['.env', 'src/a,b.ts', 'deleted.ts'] }), body = await response.json() as any
        expect(response.status).toBe(200)
        expect(t.graphCalls[0].params.files).toEqual(['repositories/example/code/src/a,b.ts'])
        expect(body.skipped).toEqual([{ path: '.env', reason: 'sensitive' }, { path: 'deleted.ts', reason: 'deleted' }])
        expect(body.candidateTests).toEqual([{ path: 'repositories/example/code/tests/main.test.ts', reason: 'filename_pattern' }])
    })
    test('normal JWT spawn uses only the granted checkout and saves a server-owned link', async () => {
        const t = setup()
        expect((await t.spawn({ repositoryId: repo.id, agent: 'claude' })).status).toBe(200)
        expect(t.starts[0]![1]).toBe(t.checkout); expect(t.starts[0]![10]).toBe('plan'); expect(t.starts[0]![17]).toBe(false)
        expect(t.store.db.query('SELECT repository_id,checkout_path FROM evolved_session_repository_links WHERE session_id=?').get('reserved-session')).toEqual({ repository_id: repo.id, checkout_path: t.checkout })
        expect((await t.request('/sessions/reserved-session/repository')).status).toBe(200)
        expect((await (await t.request(`/repositories/${repo.id}/sessions`)).json() as any).sessions[0].id).toBe('reserved-session')
        t.liveSessions.delete('reserved-session')
        expect((await (await t.request(`/repositories/${repo.id}/sessions`)).json() as any).sessions).toEqual([])
        t.liveSessions.add('reserved-session')
        t.revoke(); expect((await t.request('/sessions/reserved-session/repository')).status).toBe(403)
    })
    test('repository selection never falls back to root, arbitrary cwd or a worktree', async () => {
        const t = setup()
        for (const body of [{ repositoryId: repo.id, directory: t.project.rootPath }, { repositoryId: repo.id, sessionType: 'worktree' }, { repositoryId: '999' }]) expect((await t.spawn(body)).status).toBeGreaterThanOrEqual(400)
        renameSync(t.checkout, t.checkout + '-old'); symlinkSync(t.checkout + '-old', t.checkout)
        expect((await t.spawn({ repositoryId: repo.id })).status).toBe(409); expect(t.starts).toHaveLength(0)
    })
    test('grant loss after resolving and before dispatch fails closed', async () => {
        const t = setup(), authority = await verifyProjectToken(await t.token(), t.secret, t.store, true)
        const target = await t.routes.resolveStart(authority, repo.id, 'machine'); t.revoke()
        await expect(target.recheck()).rejects.toMatchObject({ code: 'repository_access_changed' })
    })
    test('fresh snapshots protect impact and review instead of relying on the five-minute listing', async () => {
        const t = setup(); await t.load(); t.setRun(async () => ({ ...listing(), snapshotId: 'c'.repeat(64) }))
        expect((await t.request(`/repositories/${repo.id}/impact`, { snapshotId, paths: ['src/main.ts'] })).status).toBe(409)
        expect((await t.request('/agent-catalog/builtin:review/start', { operationId: randomUUID(), machineId: 'machine', task: 'Review', repositoryId: repo.id, review: { snapshotId, paths: ['src/main.ts'] } })).status).toBe(409)
        expect(t.graphCalls).toHaveLength(0); expect(t.starts).toHaveLength(0)
    })
    test.each(['claude', 'codex'] as const)('review %s is read-only even in an extended project, linked and idempotent', async provider => {
        const t = setup(); t.store.setProfile('admin', t.project.id, 'extended'); await t.load()
        const body = { operationId: randomUUID(), machineId: 'machine', task: 'Review', provider, repositoryId: repo.id, review: { snapshotId, paths: ['src/main.ts'] } }
        const response = await t.request('/agent-catalog/builtin:review/start', body)
        expect(response.status).toBe(201); expect(t.starts[0]![1]).toBe(t.checkout)
        expect(t.starts[0]![10]).toBe(provider === 'claude' ? 'plan' : 'read-only'); expect(t.starts[0]![17]).toBe(false)
        expect(t.messages.get('reserved-session')![0].text).toContain('"coverageVerified":false')
        expect((await t.request('/agent-catalog/builtin:review/start', body)).status).toBe(200); expect(t.starts).toHaveLength(1)
    })
    test('grant loss after specialist spawn sends no assignment and archives the known child', async () => {
        const t = setup(); t.afterSpawn(() => t.revoke())
        expect((await t.request('/agent-catalog/builtin:review/start', { operationId: randomUUID(), machineId: 'machine', task: 'Review', repositoryId: repo.id })).status).toBe(403)
        expect(t.messages.size).toBe(0); expect(t.archived).toEqual(['reserved-session'])
    })
    test.each(['spawn', 'assignment'] as const)('a transient Vault failure after %s never archives the known child', async phase => {
        const t = setup(), body = { operationId: randomUUID(), machineId: 'machine', task: 'Review', repositoryId: repo.id }
        const fail = () => t.onGrant(() => { throw new EvolvedError('vault_unavailable', 'Temporary vault failure.', 502) })
        if (phase === 'spawn') t.afterSpawn(fail); else t.afterAssignment(fail)
        const response = await t.request('/agent-catalog/builtin:review/start', body)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'agent_start_indeterminate', reserved: true })
        expect(t.archived).toEqual([])
        expect(t.messages.size).toBe(phase === 'assignment' ? 1 : 0)
        expect(t.store.db.query('SELECT state,session_id FROM evolved_agent_starts WHERE operation_id=?').get(body.operationId)).toEqual({ state: 'indeterminate', session_id: 'reserved-session' })
        expect((await t.request('/agent-catalog/builtin:review/start', body)).status).toBe(409)
        expect(t.starts).toHaveLength(1)
    })
    test('specialist preparation errors prove no reservation; known reservations never do', async () => {
        const t = setup(), body = { operationId: randomUUID(), machineId: 'other', task: 'Review', repositoryId: repo.id }
        let response = await t.request('/agent-catalog/builtin:review/start', body)
        expect(await response.json()).toMatchObject({ code: 'runner_unavailable', reserved: false })
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_agent_starts').get()).toEqual({ n: 0 })
        body.machineId = 'machine'; t.afterSpawn(() => t.revoke())
        response = await t.request('/agent-catalog/builtin:review/start', body)
        expect(await response.json()).toMatchObject({ code: 'repository_access_changed', reserved: true })
    })
    test('concurrent specialist preparation cannot mislabel another reservation as editable', async () => {
        const t = setup(), body = { operationId: randomUUID(), machineId: 'machine', task: 'Review', repositoryId: repo.id }
        const responses = await Promise.all([t.request('/agent-catalog/builtin:review/start', body), t.request('/agent-catalog/builtin:review/start', body)])
        expect(t.starts).toHaveLength(1)
        const conflict = responses.find(response => response.status === 409)
        expect(conflict).toBeDefined()
        expect(await conflict!.json()).toMatchObject({ code: 'agent_start_indeterminate', reserved: true })
    })
    test('a live diff rejects sync before inserting a job', async () => {
        const t = setup(); t.store.setProfile('admin', t.project.id, 'workspace'); await t.load()
        let release!: () => void
        t.setRun(async params => { await new Promise<void>(resolve => { release = resolve }); return { path: params.path, side: params.side, patch: null, binary: false, truncated: false, observedAt: 101 } })
        const diff = t.diff()
        for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
        try {
            const response = await t.request(`/repositories/${repo.id}/sync`, { action: 'pull', requestId: randomUUID() })
            expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'repository_busy' })
            expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_repository_jobs').get()).toEqual({ n: 0 })
            expect(t.calls.map(call => call.action)).toEqual(['worktree', 'diff'])
        } finally { release() }
        expect((await diff).status).toBe(200)
    })
    test.each(['clone', 'pull'] as const)('file intake excludes concurrent %s through source revalidation and ledger completion', async action => {
        const t = setup(); t.store.setProfile('admin', t.project.id, 'workspace')
        writeFileSync(join(t.checkout, 'note.md'), 'A synthetic project decision.')
        const sourceRead = barrier(), resumeRecheck = barrier(), stored = barrier(), resumeResponse = barrier()
        t.onFileRecheck(async () => { sourceRead.release(); await resumeRecheck.promise })
        t.onFileStored(async () => { stored.release(); await resumeResponse.promise })
        t.setRun(async () => ({ local: { state: 'ready', branch: 'main', dirty: false } }))
        const intake = t.request(`/repositories/${repo.id}/memory-intake`, { path: 'note.md' })
        try {
            await sourceRead.promise
            for (const phase of ['recheck', 'stored']) {
                if (phase === 'stored') { resumeRecheck.release(); await stored.promise }
                const response = await t.sync(action)
                expect(response.status).toBe(409)
                expect(await response.json()).toMatchObject({ code: 'repository_busy' })
                expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_repository_jobs').get()).toEqual({ n: 0 })
                expect(t.calls).toHaveLength(0)
            }
            expect(t.memory.ledger.list(t.project.id)).toHaveLength(1)
        } finally { resumeRecheck.release(); resumeResponse.release(); await intake }
        expect((await intake).status).toBe(200)
        expect(await (await intake).json()).toMatchObject({ item: { status: 'proposed', body: 'A synthetic project decision.' } })
        const response = await t.sync(action), body = await response.json() as { job: { id: string } }
        expect(response.status).toBe(202)
        expect((await t.waitJob(body.job.id)).state).toBe('succeeded')
        expect(t.calls.map(call => call.action)).toEqual([action])
    })
    test.each(['source', 'grant'] as const)('file intake releases its reservation after %s failure without storing knowledge', async failure => {
        const t = setup(); t.store.setProfile('admin', t.project.id, 'workspace')
        if (failure === 'grant') {
            writeFileSync(join(t.checkout, 'note.md'), 'A synthetic project decision.')
            t.onFileRecheck(async () => { t.revoke() })
        }
        const intake = await t.request(`/repositories/${repo.id}/memory-intake`, { path: 'note.md' })
        expect(intake.status).toBe(failure === 'source' ? 404 : 403)
        expect(t.memory.ledger.list(t.project.id)).toHaveLength(0)
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_repository_jobs').get()).toEqual({ n: 0 })
        t.restoreGrant(); t.setRun(async () => ({ local: { state: 'ready', branch: 'main', dirty: false } }))
        const response = await t.sync(), body = await response.json() as { job: { id: string } }
        expect(response.status).toBe(202)
        expect((await t.waitJob(body.job.id)).state).toBe('succeeded')
    })
    test.each(['clone', 'pull'] as const)('a running %s blocks file intake without reading or storing a source', async action => {
        const t = setup(); t.store.setProfile('admin', t.project.id, 'workspace')
        writeFileSync(join(t.checkout, 'note.md'), 'A synthetic project decision.')
        const dispatched = barrier(), finish = barrier(); let sourceRead = false
        t.onFileRecheck(async () => { sourceRead = true })
        t.setRun(async () => { dispatched.release(); await finish.promise; return { local: { state: 'ready', branch: 'main', dirty: false } } })
        const response = await t.sync(action), body = await response.json() as { job: { id: string } }
        expect(response.status).toBe(202)
        try {
            await dispatched.promise
            const intake = await t.request(`/repositories/${repo.id}/memory-intake`, { path: 'note.md' })
            expect(intake.status).toBe(409); expect(await intake.json()).toMatchObject({ code: 'repository_busy' })
            expect(sourceRead).toBe(false); expect(t.memory.ledger.list(t.project.id)).toHaveLength(0)
        } finally { finish.release(); await t.waitJob(body.job.id) }
    })
    test('session deletion removes only the matching namespace link and the project listing is indexed', async () => {
        const t = setup(); await t.spawn({ repositoryId: repo.id, agent: 'claude' })
        t.routes.onSessionRemoved('reserved-session', t.second.namespace)
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_session_repository_links').get()).toEqual({ n: 1 })
        t.routes.onSessionRemoved('reserved-session', t.project.namespace)
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_session_repository_links').get()).toEqual({ n: 0 })
        const plan = t.store.db.query('EXPLAIN QUERY PLAN SELECT session_id FROM evolved_session_repository_links WHERE project_id=? AND repository_id=? ORDER BY created_at DESC LIMIT 100').all(t.project.id, repo.id)
        expect(JSON.stringify(plan)).toContain('evolved_session_repository_links_project')
    })
    test('workflow cache headers stay on workflow routes', async () => {
        const t = setup()
        expect((await t.load()).headers.get('cache-control')).toContain('no-store')
        // The repository router's pre-existing generic guard supplies no-store;
        // the workflow-specific "private" policy must not leak to siblings.
        expect((await t.app.request('/api/evolved/unrelated')).headers.get('cache-control')).toBe('no-store')
    })
    test.each(['bad\u202ename', 'main\nspoof', '-option', 'bad..name', 'branch.lock'])('hub clears unsafe branch/upstream names: %j', async value => {
        const t = setup(); t.setRun(async () => ({ ...listing(), branch: value, upstream: { name: value, ahead: 0, behind: 0 } }))
        const response = await t.load(), body = await response.json() as any
        expect(response.status).toBe(200); expect(body.branch).toBeNull(); expect(body.upstream).toBeNull()
    })
    test('one read per project prevents concurrent worktree and review reads', async () => {
        const t = setup(); let release!: () => void
        t.setRun(async () => { await new Promise<void>(resolve => { release = resolve }); return listing() })
        const first = t.load()
        for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
        expect((await t.load()).status).toBe(429); release(); expect((await first).status).toBe(200)
    })
    test('disconnected registry and timeout are actionable, never raw runner exceptions', async () => {
        const t = setup()
        t.setRun(async () => { throw new RpcTargetMissingError('private-machine:method', 'handler-not-registered') })
        let response = await t.load(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-machine')
        t.setRun(async () => { throw new Error('operation timed out') }); response = await t.load(); expect(response.status).toBe(504)
    })
    test('opaque path IDs survive and symlink previews contain only the bounded Git patch', async () => {
        const t = setup()
        t.setRun(async params => params.action === 'worktree' ? { ...listing(), files: [{ path: '', pathRef: 'c'.repeat(64), display: 'hidden', excluded: 'unrepresentable', index: 'M', worktree: ' ', kind: 'unknown' }, { path: 'link', index: 'M', worktree: ' ', kind: 'symlink' }] } : { path: 'link', side: 'staged', patch: '@@ -1 +1 @@\n-old-target\n+new-target', binary: false, truncated: false, observedAt: 101 })
        const body = await (await t.load()).json() as any
        expect(body.files[0].pathRef).toBe('c'.repeat(64)); expect(body.files[0].display).toBe('[nicht anzeigbarer Pfad]')
        expect((await (await t.diff({ snapshotId, path: 'link', side: 'staged' })).json() as any).patch).toContain('new-target')
    })

})
