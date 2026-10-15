import { join } from 'node:path'
import { closeSync } from 'node:fs'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { EvolvedError, EvolvedStore, privateFile } from './store'
import { createEvolvedRoutes } from './api'
import { RemoteVaultClient } from './vault'
import { createSessionTokenRoutes } from './bridge'
import { createCodegraphRoutes, startCodegraphSync, enqueueCodegraphDeletion, queryCodegraph, type CodegraphStatusSnapshot } from './codegraph'
import { createReadinessRoutes } from './readiness'
import { createMemoryRoutes, proposeMemoryFile, type MemoryMessageResolver } from './memory'
import { HttpMemoryBackend, MemoryService } from './memoryService'
import { createEvolvedRequestGuard } from './security'
import { createPreviewRoutes } from './previews'
import { createPeerRoutes } from './peers'
import { createGithubPrRunnerRoutes } from './githubPr'
import { createGithubGitTransport, createGithubRoutes } from './github'
import { createRepositoryRoutes } from './repositories'
import { createCapacityRoutes } from './capacity'
import { createProviderRoutes, UnixProviderControl } from './providers'
import { PluginService, createPluginRoutes } from './plugins'
import { createAgentCatalogRoutes } from './agentCatalog'
import { createSidechannelRoutes, SidechannelService, sidechannelConfig } from './sidechannel'
import { createScheduleRoutes, ScheduleService } from './schedules'
import { PeerCompletionReporter } from './peerReports'
import { assertManagedWorkspaceSeparation, openManagedWorkspaceRoot, workspaceBindingsOverlap, existingWorkspace } from './workspaces'
import type { SyncEngine } from '../sync/syncEngine'

export type EvolvedRuntime = ReturnType<typeof createEvolvedRuntime>
export function createEvolvedRuntime(dataDir: string, secret: Uint8Array) {
    let getSyncEngine: () => SyncEngine | null = () => null
    let resolveMessage: MemoryMessageResolver = () => null
    const originValue = process.env.EVOLVED_ORIGIN
    if (!originValue) throw new Error('EVOLVED_ORIGIN is required in Evolved mode')
    const url = new URL(originValue)
    if (url.origin !== originValue || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('EVOLVED_ORIGIN must be an HTTPS origin (localhost HTTP is allowed for development)')
    const origin = url.origin
    const roots: unknown = JSON.parse(process.env.EVOLVED_CODE_ROOTS ?? '[]')
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new Error('EVOLVED_CODE_ROOTS must be a JSON array of absolute directories')
    const managedWorkspaceRoot = process.env.EVOLVED_MANAGED_WORKSPACE_ROOT ?? join(dataDir, 'project-workspaces')
    const databaseFile = process.env.EVOLVED_DB_PATH ?? join(dataDir, 'evolved.db'), bootstrapFile = process.env.EVOLVED_BOOTSTRAP_FILE ?? join(dataDir, 'bootstrap.token')
    const credentialFiles = [process.env.EVOLVED_VAULT_SIGNING_KEY_FILE, process.env.EVOLVED_SERVICE_TOKEN_FILE, process.env.EVOLVED_RUNNER_CONTROL_KEY_FILE].filter((file): file is string => !!file)
    assertManagedWorkspaceSeparation(managedWorkspaceRoot, dataDir, databaseFile, bootstrapFile, credentialFiles)
    const managed = openManagedWorkspaceRoot(managedWorkspaceRoot)
    try {
        assertManagedWorkspaceSeparation(managed.path, dataDir, databaseFile, bootstrapFile, credentialFiles)
        if (roots.some(root => workspaceBindingsOverlap(existingWorkspace(root as string), managed.path))) throw new Error('Managed and manually attached workspace roots must be separate directories')
    } finally { closeSync(managed.fd) }
    const store = new EvolvedStore(databaseFile, {
        bootstrapFile,
        managedWorkspaceRoot
    })
    const vaultUrl = process.env.EVOLVED_VAULT_URL
    const signingKeyFile = process.env.EVOLVED_VAULT_SIGNING_KEY_FILE
    if (!vaultUrl || !signingKeyFile) throw new Error('The isolated vault URL and signing-key file are required')
    const vault = new RemoteVaultClient({ url: vaultUrl, signingKeyFile })
    const serviceToken = process.env.EVOLVED_SERVICE_TOKEN_FILE ? privateFile(process.env.EVOLVED_SERVICE_TOKEN_FILE).toString('utf8').trim() : undefined
    const memory = new MemoryService(store, new HttpMemoryBackend(process.env.EVOLVED_MEMORY_URL, serviceToken))
    const graphStatus = new Map<string, CodegraphStatusSnapshot>()
    const graphOptions = { store, origin, adapterUrl: process.env.EVOLVED_CODEGRAPH_URL, serviceToken, statusCache: graphStatus }
    const routes = new Hono()
    routes.use('*', createEvolvedRequestGuard(origin))
    const gitTransport = createGithubGitTransport({ store, vault, origin })
    routes.route('/', gitTransport.routes)
    routes.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'Request body exceeds 1 MiB.', code: 'body_too_large' }, 413) }))
    routes.onError((error, c) => error instanceof EvolvedError
        ? c.json({ error: error.message, code: error.code }, error.status as 400)
        : c.json({ error: 'Evolved request failed.' }, 500))
    routes.route('/', createSessionTokenRoutes(store, secret, origin))
    routes.route('/', createPreviewRoutes({ store, origin }))
    routes.route('/', createPeerRoutes(store, () => getSyncEngine()))
    routes.route('/', createGithubPrRunnerRoutes(store, () => getSyncEngine(), dataDir))
    routes.route('/', createGithubRoutes({ store, vault, origin }))
    const repositories = createRepositoryRoutes({ store, vault, origin, getEngine: () => getSyncEngine(),
        queryCodegraph: (project, operation, params) => queryCodegraph(graphOptions, project, operation, params),
        intakeFile: (request, projectId, path, recheck) => proposeMemoryFile({ store, service: memory, request, projectId, path, recheck })
    })
    routes.route('/', repositories.routes)
    routes.route('/', createReadinessRoutes({ store, origin, getEngine: () => getSyncEngine(),
        graphConfigured: !!graphOptions.adapterUrl && !!serviceToken, graphStatus: id => graphStatus.get(id), memoryAvailable: () => memory.backend.available(),
        readResource: async (request, projectId, resource) => {
            // Only fixed internal diagnostic routes. No caller-supplied URL or mutation method.
            const response = await routes.request(new Request(`${origin}/projects/${encodeURIComponent(projectId)}/${resource}`, { headers: request.headers }))
            return { status: response.status, body: await response.json().catch(() => null) }
        }
    }))
    routes.route('/', createCapacityRoutes(store, () => getSyncEngine(), origin))
    const controlSocket = process.env.EVOLVED_RUNNER_CONTROL_SOCKET
    const controlKeyFile = process.env.EVOLVED_RUNNER_CONTROL_KEY_FILE
    const controlKey = controlKeyFile ? privateFile(controlKeyFile) : undefined
    if (controlKey && controlKey.length !== 32) throw new Error('Runner control key must contain exactly 32 bytes')
    routes.route('/', createProviderRoutes(store, { key: controlKey, control: controlSocket && controlKey ? new UnixProviderControl(controlSocket, controlKey) : undefined }))
    const plugins = new PluginService(store)
    routes.route('/', createPluginRoutes(plugins, origin))
    routes.route('/', createAgentCatalogRoutes({ store, plugins, origin, getSyncEngine: () => getSyncEngine(), repositoryStart: repositories.resolveStart, repositoryReview: repositories.reviewContext }))
    routes.route('/', createSidechannelRoutes(new SidechannelService(store, sidechannelConfig()), () => getSyncEngine(), origin))
    const schedules = new ScheduleService(store, () => getSyncEngine())
    routes.route('/', createScheduleRoutes(schedules, () => getSyncEngine()))
    routes.route('/', createEvolvedRoutes({ store, vault, origin, allowedWorkspaceRoots: roots as string[], repositoryDiscovery: repositories.discovery,
        onProjectDelete: projectId => { memory.forgetProject(projectId); enqueueCodegraphDeletion(store, projectId) } }))
    routes.route('/', createMemoryRoutes({ store, service: memory, origin, resolveMessage: (...args) => resolveMessage(...args) }))
    routes.route('/', createCodegraphRoutes(graphOptions))
    const stopMemory = memory.start()
    const stopGraph = startCodegraphSync(graphOptions)
    const stopSchedules = schedules.start()
    let stopReports: (() => void) | undefined
    return { store, origin, routes, memory, repositoryStart: repositories.resolveStart, onSessionRemoved: repositories.onSessionRemoved, setMemoryMessageResolver(resolver: MemoryMessageResolver) { resolveMessage = resolver }, setSyncEngineProvider(provider: () => SyncEngine | null) {
        getSyncEngine = provider; stopReports?.()
        const engine = provider()
        stopReports = engine ? new PeerCompletionReporter(store, engine).start() : undefined
    }, close() { repositories.close(); gitTransport.close(); stopReports?.(); stopSchedules(); stopMemory(); stopGraph(); store.close() } }
}
