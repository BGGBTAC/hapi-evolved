import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { ProjectReadiness, ReadinessState } from '@hapi/protocol/evolvedWorkspace'
import { EvolvedError, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, requireHuman, createEvolvedRequestGuard } from './security'
import { existingWorkspace } from './workspaces'
import type { CodegraphStatusSnapshot } from './codegraph'
import type { SyncEngine } from '../sync/syncEngine'

export type ReadinessResource = 'providers' | 'repositories'
type Resource = { status: number; body: unknown }
type Item = ProjectReadiness['items'][number]
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const values = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : []
const folded = (states: ReadinessState[]): ReadinessState => states.includes('denied') ? 'denied' : states.includes('missing') ? 'missing' : states.includes('stale') ? 'stale' : states.includes('unknown') ? 'unknown' : 'ok'

/** A diagnostic view only: never prepare, log in, fetch Git or register a Codegraph worker. */
export function createReadinessRoutes(options: {
    store: EvolvedStore; origin: string
    getEngine: () => Pick<SyncEngine, 'getOnlineMachinesByNamespace' | 'evolvedRepositories' | 'getAgentAvailability'> | null
    readResource: (request: Request, projectId: string, resource: ReadinessResource) => Promise<Resource>
    graphConfigured?: boolean
    graphStatus: (projectId: string) => CodegraphStatusSnapshot | undefined
    memoryAvailable: () => Promise<boolean>
}) {
    const app = new Hono(), { store } = options
    let active = 0
    const cache = new Map<string, { expiresAt: number; value: ProjectReadiness }>()
    app.use('*', createEvolvedRequestGuard(options.origin))
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ error: error.message, code: error.code }, error.status as 400) : c.json({ error: 'Projektbereitschaft konnte nicht geprüft werden.' }, 500))
    app.get('/projects/:id/readiness', async c => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Bitte anmelden.', 401)
        requireHuman(principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'))
        if (active >= 4) throw new EvolvedError('readiness_busy', 'Die Statusprüfung ist ausgelastet. Bitte kurz warten.', 429)
        active++
        try {
            const items: Item[] = []
            const add = (key: string, label: string, state: ReadinessState, reasonCode: string, detail: string, action?: Item['action']) => { items.push({ key, label, state, reasonCode, detail, ...(action ? { action } : {}) }); return state }
            const providerAction: Item['action'] = { kind: 'providers', label: 'Abos verbinden' }
            let folder: ReadinessState = 'missing'
            try { folder = existingWorkspace(project.rootPath) === project.rootPath ? 'ok' : 'missing' } catch { /* Missing is distinct from a successful check. */ }
            add('workspace', 'Projektordner', folder, folder === 'ok' ? 'workspace_ready' : 'workspace_unavailable', folder === 'ok' ? 'Der gespeicherte Projektordner ist zugänglich.' : 'Der gespeicherte Projektordner ist nicht verfügbar.', { kind: 'projects', label: 'Projekt öffnen' })
            const engine = options.getEngine()
            const candidates = engine?.getOnlineMachinesByNamespace(project.namespace).filter(machine => machine.metadata?.workspaceRoots?.length === 1 && machine.metadata.workspaceRoots[0] === project.rootPath) ?? []
            const machine = candidates.length === 1 ? candidates[0] : undefined
            const cacheKey = JSON.stringify([principal.user.id, project.id, project.role, project.profile, project.rootPath, project.namespace, candidates.map(item => [item.id, item.metadata?.capabilities])])
            for (const [key, entry] of cache) if (entry.expiresAt <= store.now()) cache.delete(key)
            const cached = cache.get(cacheKey)
            if (cached) { c.header('Cache-Control', 'private, no-store'); return c.json(cached.value) }
            const capabilities = machine?.metadata?.capabilities ?? []
            const capable = capabilities.includes(MACHINE_CAPABILITIES.EvolvedRepositories)
            const runnerState: ReadinessState = !candidates.length ? 'missing' : !machine || !capable ? 'stale' : 'ok'
            add('runner', 'Projektdienst', runnerState, !candidates.length ? 'runner_offline' : !machine ? 'runner_ambiguous' : !capable ? 'runner_upgrade_required' : 'runner_connected', !candidates.length ? 'Noch kein Projektdienst verbunden.' : !machine ? 'Mehrere Projektdienste sind für diesen Ordner verbunden.' : !capable ? 'Der Projektdienst benötigt ein Update.' : 'Der Projektdienst ist verbunden.', providerAction)
            const worktreeState: ReadinessState = runnerState !== 'ok' ? runnerState : capabilities.includes(MACHINE_CAPABILITIES.EvolvedRepositoryWorktree) ? 'ok' : 'stale'
            add('worktree', 'Änderungsansicht', worktreeState, worktreeState === 'ok' ? 'worktree_ready' : 'runner_upgrade_required', worktreeState === 'ok' ? 'Der Projektdienst unterstützt die lokale Änderungsansicht.' : 'Für die Änderungsansicht ist ein erreichbarer, aktueller Projektdienst nötig. Bestehende Sitzungsfunktionen bleiben unabhängig davon.', providerAction)
            const settled = await Promise.allSettled([
                machine && capable && engine ? engine.evolvedRepositories(machine.id, { action: 'status', projectId: project.id, repositories: [] }, 3000) : Promise.reject(new Error('unavailable')),
                machine && engine && project.role !== 'viewer' && capabilities.includes(MACHINE_CAPABILITIES.AgentAvailability) ? engine.getAgentAvailability(machine.id) : Promise.reject(new Error('unavailable')),
                project.role === 'admin' ? options.readResource(c.req.raw, project.id, 'providers') : Promise.resolve({ status: 403, body: null }),
                options.readResource(c.req.raw, project.id, 'repositories'),
                options.memoryAvailable(),
            ])
            const [probe, agentReply, providerReply, repoReply, memoryReply] = settled
            const rpc = probe.status === 'fulfilled' && Array.isArray(probe.value) && probe.value.length === 0 ? 'ok' : machine ? 'stale' : 'missing'
            add('rpc', 'Verbindung geprüft', rpc, rpc === 'ok' ? 'rpc_ready' : 'rpc_unavailable', rpc === 'ok' ? 'Der Projektdienst beantwortet Anfragen.' : 'Die Verbindung zum Projektdienst konnte nicht bestätigt werden.', providerAction)
            const agents = agentReply.status === 'fulfilled' ? agentReply.value.agents : []
            const installed = ['claude', 'codex'].filter(provider => agents.some(agent => agent.agent === provider && agent.available))
            const agentState: ReadinessState = project.role === 'viewer' ? 'denied' : agentReply.status === 'rejected' ? 'unknown' : installed.length ? 'ok' : 'missing'
            add('agents', 'Agenten verfügbar', agentState, agentState === 'ok' ? 'agent_available' : agentState === 'denied' ? 'member_required' : 'agent_unavailable', installed.length ? `Installiert: ${installed.join(', ')}.` : project.role === 'viewer' ? 'Die Agentenprüfung ist Mitgliedern vorbehalten.' : 'Es konnte kein unterstützter Agent bestätigt werden.', providerAction)
            const providerData = providerReply.status === 'fulfilled' && providerReply.value.status === 200 ? record(providerReply.value.body) : {}
            const nativeProviders = values(providerData.providers)
            const providerRunner = record(providerData.runner).status
            const providerState: ReadinessState = project.role !== 'admin' ? 'denied' : providerRunner === 'unconfigured' ? 'missing' : providerRunner === 'offline' || providerRunner === 'starting' ? 'stale' : !nativeProviders.length ? 'unknown' : nativeProviders.some(provider => provider.status === 'connected' && installed.includes(String(provider.provider))) ? 'ok' : nativeProviders.every(provider => provider.status === 'disconnected') ? 'missing' : 'unknown'
            add('providers', 'Anbieter-Anmeldung', providerState, providerState === 'ok' ? 'provider_connected' : providerState === 'denied' ? 'admin_required' : providerRunner === 'unconfigured' ? 'provider_unconfigured' : providerRunner === 'offline' ? 'provider_offline' : 'provider_unconfirmed', providerState === 'ok' ? 'Ein installierter Agent ist beim Anbieter angemeldet.' : providerState === 'denied' ? 'Den Anmeldestatus kann ein Projektadministrator prüfen.' : providerRunner === 'unconfigured' ? 'Noch kein Anbieter verbunden. Die Browser-Anmeldung richtet den Projektdienst ein.' : providerRunner === 'offline' ? 'Der Anmeldedienst ist derzeit nicht erreichbar.' : 'Eine nutzbare Anmeldung wurde nicht bestätigt.', providerAction)
            const repoData = repoReply.status === 'fulfilled' && repoReply.value.status === 200 ? record(repoReply.value.body) : null
            const repositories = values(repoData?.repositories)
            const ready = repositories.filter(repo => record(repo.local).state === 'ready' && record(repo.job).state !== 'running').length
            const repoState: ReadinessState = !repoData ? 'unknown' : ready ? 'ok' : repositories.some(repo => record(repo.job).state === 'running' || record(repo.local).state === 'unknown') ? 'stale' : 'missing'
            add('repositories', 'Repository im Projekt', repoState, ready ? 'checkout_ready' : repoState === 'stale' ? 'checkout_unconfirmed' : 'checkout_missing', ready ? `${ready} Checkout${ready === 1 ? '' : 's'} bereit. GitHub-Rechte werden weiterhin bei jedem Git-Vorgang geprüft.` : repoData ? 'Noch kein bereiter Checkout bestätigt. Ein Repository kann unter GitHub freigegeben und geklont werden.' : 'Repositoryfreigaben konnten nicht geprüft werden.', { kind: 'github', label: 'Repositories öffnen' })
            const graph = options.graphStatus(project.id)
            const freshGraph = graph?.rootPath === project.rootPath && store.now() - graph.checkedAt <= 90_000
            const graphState: ReadinessState = options.graphConfigured === false ? 'missing' : !freshGraph ? graph ? 'stale' : 'unknown' : graph.status === 200 && graph.result.state === 'ready' && graph.result.available === true ? 'ok' : graph.result.state === 'unconfigured' ? 'missing' : graph.result.state === 'indexing' ? 'stale' : 'unknown'
            add('codegraph', 'Codegraph', graphState, options.graphConfigured === false ? 'codegraph_unconfigured' : freshGraph ? `codegraph_${String(graph?.result.state ?? 'unknown')}` : 'codegraph_unobserved', options.graphConfigured === false ? 'Codegraph ist auf diesem Server nicht eingerichtet.' : graphState === 'ok' ? 'Der zuletzt geprüfte Index ist bereit.' : graphState === 'stale' ? 'Der Index wird aufgebaut oder sein Status ist veraltet.' : 'Noch kein aktueller Indexstatus bestätigt.', { kind: 'codegraph', label: 'Codegraph öffnen' })
            const graphMemory = memoryReply.status === 'fulfilled' && memoryReply.value
            add('memory', 'Persistentes Wissen', 'ok', graphMemory ? 'memory_graph_ready' : 'memory_ledger_ready', graphMemory ? 'Lokales Wissensregister und Graphdienst sind erreichbar.' : 'Das lokale Wissensregister ist verfügbar. Der optionale Graphdienst ist nicht bestätigt.', { kind: 'memory', label: 'Wissen öffnen' })
            add('profile', 'Bearbeitungsrechte', project.profile === 'restricted' || project.role === 'viewer' ? 'denied' : 'ok', project.profile === 'restricted' ? 'profile_read_only' : project.role === 'viewer' ? 'viewer' : 'profile_writable', project.profile === 'restricted' ? 'Dieses Projekt ist nur lesend.' : project.role === 'viewer' ? 'Du hast lesenden Zugriff auf dieses Projekt.' : 'Das Projektprofil erlaubt Bearbeitung.')
            const live = await authenticateEvolvedRequest(c.req.raw, store)
            if (!live || live.user.id !== principal.user.id) throw new EvolvedError('unauthorized', 'Die Anmeldung wurde geändert.', 401)
            const current = store.requireProject(live.user.id, project.id)
            if (current.role !== project.role || current.profile !== project.profile || current.rootPath !== project.rootPath || current.namespace !== project.namespace) throw new EvolvedError('project_changed', 'Der Projektzugriff wurde geändert. Bitte neu laden.', 403)
            const nowMachines = options.getEngine()?.getOnlineMachinesByNamespace(project.namespace).filter(item => item.metadata?.workspaceRoots?.length === 1 && item.metadata.workspaceRoots[0] === project.rootPath) ?? []
            if (nowMachines.length !== candidates.length || nowMachines[0]?.id !== machine?.id) {
                for (const item of items) if (['runner', 'worktree', 'rpc', 'agents', 'providers', 'repositories'].includes(item.key)) { item.state = 'stale'; item.reasonCode = 'runner_changed'; item.detail = 'Der Projektdienst hat sich während der Prüfung geändert.' }
            }
            const states = (keys: string[]) => items.filter(item => keys.includes(item.key)).map(item => item.state)
            const plan = folded(states(['workspace', 'runner', 'rpc', 'agents', ...(providerState === 'denied' ? [] : ['providers'])]))
            const result: ProjectReadiness = { projectId: project.id, checkedAt: store.now(), purposes: { plan, code: folded([plan, ...states(['repositories', 'profile'])]) }, items }
            if (cache.size >= 64) cache.delete(cache.keys().next().value!)
            cache.set(cacheKey, { expiresAt: store.now() + 10_000, value: result })
            c.header('Cache-Control', 'private, no-store')
            return c.json(result)
        } finally { active-- }
    })
    return app
}
