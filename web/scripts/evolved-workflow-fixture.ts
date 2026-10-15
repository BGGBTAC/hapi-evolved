// Opt-in browser test fixture. Never imported by the product runtime.
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { io, type Socket } from 'socket.io-client'
import { EvolvedStore } from '../../hub/src/evolved/store.ts'
import { createRepositoryWorkspace, RepositoryWorkspaceError } from '../../cli/src/evolved/repositoryWorkspace.ts'
import { CURRENT_MACHINE_CAPABILITIES } from '../../shared/src/runnerCapabilities.ts'
import { RPC_METHODS } from '../../shared/src/rpcMethods.ts'
import { APP_VERSION } from '../../shared/src/buildInfo.ts'
import { RepoDiffRequestSchema } from '../../shared/src/evolvedWorkspace.ts'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function requestData(value: unknown): { projectId: string; rootPath: string; namespace: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic workflow trigger')
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 3 || typeof record.projectId !== 'string' || !uuid.test(record.projectId)
        || typeof record.rootPath !== 'string' || typeof record.namespace !== 'string') throw new Error('Invalid synthetic workflow trigger')
    return { projectId: record.projectId, rootPath: record.rootPath, namespace: record.namespace }
}
const cleanEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function startWorkflowFixture(tmp: string, origin: string) {
    if (process.env.EVOLVED_TEST_WORKFLOW !== '1' || !/^\/tmp\/hapi-evolved-ui-[^/]+$/.test(tmp)) throw new Error('Isolated workflow fixture opt-in required')
    let stopped = false, busy = false, initialized = false
    const sockets: Socket[] = [], calls: Array<{ method: string; params: unknown }> = []
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let writes = Promise.resolve()
    const write = (name: string, value: unknown) => {
        const content = JSON.stringify(value, null, 2)
        writes = writes.then(async () => {
            await writeFile(join(tmp, `${name}.tmp`), content, { mode: 0o600 })
            await rename(join(tmp, `${name}.tmp`), join(tmp, name))
        })
        return writes
    }
    const setup = async () => {
        const path = join(tmp, 'workflow-request.json')
        const file = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (!file) return
        if (!file.isFile() || file.isSymbolicLink() || file.size > 4096 || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new Error('Private workflow trigger required')
        const requested = requestData(JSON.parse(await readFile(path, 'utf8')))
        const store = new EvolvedStore(join(tmp, 'evolved.db'), { managedWorkspaceRoot: join(tmp, 'managed-workspaces') })
        let token: string, root: string
        try {
            const user = store.db.query('SELECT id FROM evolved_users WHERE is_admin=1 ORDER BY created_at LIMIT 1').get() as { id: string } | null
            if (!user) throw new Error('Synthetic browser owner missing')
            const project = store.requireProject(user.id, requested.projectId, 'admin')
            root = project.rootPath
            if (root !== requested.rootPath || project.namespace !== requested.namespace || !root.startsWith(`${tmp}/`) || await realpath(root) !== root) throw new Error('Synthetic project scope mismatch')
            token = store.issueCapability(user.id, project.id, ['runner:connect', 'git:read', 'memory:read', 'codegraph:read'], [], 900).token
        } finally { store.close() }
        const repository = { id: '101', owner: 'synthetic', name: 'workflow', fullName: 'synthetic/workflow', cloneUrl: 'https://github.com/synthetic/workflow.git', path: join(root!, 'repositories/synthetic/workflow'), permission: 'read' as const }
        await mkdir(repository.path, { recursive: true, mode: 0o700 })
        const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Synthetic Browser', '-c', 'user.email=browser@example.invalid', ...args], { cwd: repository.path, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] })
        git('init', '--initial-branch=main'); git('remote', 'add', 'origin', repository.cloneUrl)
        await mkdir(join(repository.path, 'src')); await mkdir(join(repository.path, 'docs'))
        await writeFile(join(repository.path, 'src/math.ts'), 'export function add(a: number, b: number) { return a + b }\n')
        await writeFile(join(repository.path, 'src/math.test.ts'), "import { add } from './math'\nexport function verifiesAddition() { return add(1, 2) === 3 }\n")
        await writeFile(join(repository.path, 'docs/decision.md'), '# Synthetic design decision\n\nThe project stores one independent checkout per approved repository.\n')
        await writeFile(join(repository.path, '.env.example'), 'SYNTHETIC_EXCLUDED_FILE=fixture\n')
        git('add', '.'); git('commit', '-m', 'synthetic workflow baseline')
        await writeFile(join(repository.path, 'src/math.ts'), 'export function add(a: number, b: number) { return Number(a) + Number(b) }\n')
        git('add', '--', 'src/math.ts')
        await writeFile(join(repository.path, 'src/math.ts'), 'export function add(a: number, b: number) { return Number(a) + Number(b) + 0 }\n')
        await writeFile(join(repository.path, 'docs/decision.md'), '# Synthetic design decision\n\nThe project keeps reviewed changes separate from untracked notes.\n')
        await writeFile(join(repository.path, '.env.example'), 'SYNTHETIC_EXCLUDED_FILE=changed\n')
        await writeFile(join(repository.path, 'untracked.txt'), 'SYNTHETIC_UNTRACKED_CONTENT_MUST_NOT_PREVIEW\n')

        const request = async (path: string, body?: unknown) => {
            const response = await fetch(`${origin}/cli${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token!}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
            if (!response.ok) throw new Error(`Synthetic CLI fixture response ${response.status}`)
            return response.json() as Promise<any>
        }
        const connect = async (auth: { machineId: string; clientType: 'machine-scoped' } | { sessionId: string; clientType: 'session-scoped' }) => {
            const socket = io(`${origin}/cli`, { transports: ['websocket'], reconnection: false, auth: { ...auth, token: token! } }); sockets.push(socket)
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Synthetic workflow socket timeout')), 10_000)
                socket.once('connect', () => { clearTimeout(timer); resolve() }); socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Synthetic workflow socket rejected')) })
            })
            return socket
        }
        const machineId = `workflow-${requested.projectId}`
        await request('/machines', { id: machineId, metadata: { host: 'Synthetic workflow runner', platform: 'linux', happyCliVersion: APP_VERSION, displayName: 'Workflow-Testdienst', workspaceRoots: [root!], capabilities: [...CURRENT_MACHINE_CAPABILITIES] }, runnerState: { status: 'running' } })
        const socket = await connect({ machineId, clientType: 'machine-scoped' })
        const workspace = createRepositoryWorkspace()
        const actions = new Set<string>([RPC_METHODS.EvolvedRepositories, RPC_METHODS.AgentAvailability, RPC_METHODS.PathExists, RPC_METHODS.SpawnHappySession, RPC_METHODS.CursorChatStoreStatus])
        socket.on('rpc-request', (input: { method: string; params: string }, acknowledge: (value: string) => void) => {
            void (async () => {
                const method = input.method.slice(`${machineId}:`.length), params = JSON.parse(input.params)
                if (!input.method.startsWith(`${machineId}:`) || !actions.has(method)) throw new Error('Synthetic RPC unavailable')
                calls.push({ method, params }); await write('workflow-rpc.json', calls)
                if (method === RPC_METHODS.AgentAvailability) return { agents: [{ agent: 'claude', available: true }, { agent: 'codex', available: true }] }
                if (method === RPC_METHODS.CursorChatStoreStatus) return { available: false }
                if (method === RPC_METHODS.PathExists) return { exists: Object.fromEntries((params.paths as string[]).map(path => [path, [root, repository.path].includes(path)])) }
                if (method === RPC_METHODS.EvolvedRepositories) {
                    if (params.projectId !== requested.projectId) throw new Error('Synthetic project mismatch')
                    const checked = (repo: typeof repository) => {
                        for (const key of ['id', 'owner', 'name', 'fullName', 'cloneUrl', 'path'] as const) if (repo?.[key] !== repository[key]) throw new Error('Synthetic repository mismatch')
                        return repository
                    }
                    if (params.action === 'status') return workspace.inspectRepositories(root!, params.repositories.map(checked))
                    if (params.action === 'worktree') return workspace.readRepositoryWorktree(root!, checked(params.repository))
                    if (params.action === 'diff') return workspace.readRepositoryDiff(root!, checked(params.repository), RepoDiffRequestSchema.parse({ path: params.path, side: params.side, snapshotId: params.snapshotId }))
                    throw new Error('Synthetic fixture never performs Git transfers')
                }
                if (method === RPC_METHODS.SpawnHappySession) {
                    if (![root, repository.path].includes(params.directory) || params.approvedNewDirectoryCreation !== false || params.sessionType === 'worktree' || typeof params.reservedSessionId !== 'string' || !uuid.test(params.reservedSessionId)) throw new Error('Synthetic unsafe spawn request')
                    const { session } = await request('/sessions', { id: params.reservedSessionId, adopt: true, tag: `workflow-spawn-${params.reservedSessionId}`, metadata: { path: params.directory, host: 'synthetic-browser-runner', machineId, name: 'Synthetic workflow session', flavor: params.agent === 'claude' ? 'claude' : 'codex' }, agentState: null })
                    return { type: 'success', sessionId: session.id }
                }
            })().then(result => acknowledge(JSON.stringify(result))).catch(error => acknowledge(JSON.stringify({ error: { code: error instanceof RepositoryWorkspaceError && error.code === 'changed' ? 'worktree_changed' : 'repository_unavailable', message: 'Synthetic workflow fixture operation failed.' } })))
        })
        for (const method of actions) socket.emit('rpc-register', { method: `${machineId}:${method}` })
        const alive = () => socket.emit('machine-alive', { machineId, time: Date.now() })
        alive(); heartbeat = setInterval(alive, 2000)
        const { session } = await request('/sessions', { tag: `workflow-memory-${requested.projectId}`, metadata: { path: repository.path, host: 'synthetic-browser-runner', machineId, name: 'Workflow memory source', flavor: 'codex' }, agentState: null })
        const sessionSocket = await connect({ sessionId: session.id, clientType: 'session-scoped' })
        const messageText = 'Synthetic workflow decision: reviewed changes belong to their approved repository checkout.'
        sessionSocket.emit('message', { sid: session.id, message: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: messageText } } }, createdAt: Date.now() })
        let messageId: string | undefined
        for (let attempt = 0; attempt < 100; attempt++) {
            const page = await request(`/sessions/${session.id}/messages?afterSeq=0&limit=10`)
            if (page.messages?.length) { messageId = page.messages[0].id; break }
            await delay(50)
        }
        sessionSocket.disconnect()
        if (!messageId) throw new Error('Synthetic workflow message did not persist')
        await write('workflow-ready.json', { projectId: requested.projectId, machineId, repository, sessionId: session.id, messageId, messageText, files: { changed: 'src/math.ts', memory: 'docs/decision.md', excluded: '.env.example', untracked: 'untracked.txt' } })
        initialized = true
    }
    const timer = setInterval(() => {
        if (stopped || busy || initialized) return
        busy = true
        void setup().catch(async () => { initialized = true; await write('workflow-error.json', { error: 'Synthetic workflow setup failed; fixture state retained for diagnosis.' }) }).finally(() => { busy = false })
    }, 100)
    return () => { stopped = true; clearInterval(timer); clearInterval(heartbeat); for (const socket of sockets) socket.disconnect() }
}
