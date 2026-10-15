import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { z } from 'zod'
import type { SyncEngine } from '../sync/syncEngine'
import { EvolvedError, type EvolvedStore } from './store'
import { createEvolvedRequestGuard, parseBody } from './security'
import { extensionAdministrationNow, extensionHuman, extensionSessionHash } from './extensionAccess'
import { projectPermissionMode, withinProject } from './bridge'
import { agentAssignment, agentInstructionsFit, MAX_AGENT_PROMPT_BYTES, agentDefinitionSchema, modelPreferenceSchema, type AgentDefinition, type PluginManifest } from './pluginManifest'
import type { PluginService } from './plugins'

type Source = { pluginId: string; repository: string; commitSha: string }
export type CatalogAgent = AgentDefinition & { id: string; origin: 'builtin' | 'custom' | 'plugin'; source?: Source; available: boolean; invalid?: true }
export type CatalogSkill = PluginManifest['skills'][number] & { source: Source }
export type CatalogTheme = PluginManifest['themes'][number] & { source: Source }
type Engine = Pick<SyncEngine, 'getMachineByNamespace' | 'getOnlineMachinesByNamespace' | 'getSessionByNamespace' | 'spawnSession' | 'sendMessage' | 'getMessagesPage' | 'archiveSession'>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const builtins: CatalogAgent[] = [
    { id: 'builtin:architecture', name: 'Architektur', description: 'Entwirft Änderungen mit klaren Grenzen, Datenflüssen und Abnahmekriterien.', instructions: 'Untersuche zuerst vorhandenen Code und Projektdokumentation. Beschreibe den kleinsten tragfähigen Entwurf, Alternativen und konkrete Risiken. Beachte die vorhandenen Projektberechtigungen und gib überprüfbare Abnahmekriterien an.' },
    { id: 'builtin:implementation', name: 'Implementierung', description: 'Setzt konkrete Aufgaben um und prüft die betroffenen Abläufe.', instructions: 'Lies die projektspezifischen Anweisungen. Implementiere die angeforderte Änderung mit begrenztem Umfang, erhalte fremde Änderungen und prüfe die betroffenen Abläufe. Stelle Ergebnisse und nicht verifizierte Punkte klar dar.' },
    { id: 'builtin:review', name: 'Adversarielles Review', description: 'Sucht belegbare Fehler, Sicherheitslücken und Regressionen.', instructions: 'Prüfe vorhandene Änderungen adversariell auf Korrektheit, Berechtigungsgrenzen, Regressionen und praktische Nutzbarkeit. Berichte nur belegte Befunde mit Datei, Zeile, Auslöser und kleinster geeigneter Korrektur. Verändere beim Review keine Dateien, sofern der Auftrag das nicht ausdrücklich verlangt.' },
    { id: 'builtin:tests', name: 'Tests & Qualität', description: 'Prüft kritische Abläufe, Randfälle und reproduzierbare Fehler.', instructions: 'Ermittle die wichtigsten Abnahmekriterien des Auftrags. Prüfe relevante Abläufe und Randfälle, ergänze notwendige Regressionstests und dokumentiere reproduzierbare Befunde. Beachte Projektberechtigungen und bestehende Testkonventionen.' },
].map(value => ({ ...value, providerPreference: 'either', skills: [], origin: 'builtin', available: true }))

export class AgentCatalog {
    constructor(readonly store: EvolvedStore, readonly plugins: PluginService) {
        store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_agent_catalog (
            id TEXT PRIMARY KEY,definition TEXT NOT NULL,created_by TEXT REFERENCES evolved_users(id) ON DELETE SET NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
        ); CREATE TABLE IF NOT EXISTS evolved_agent_starts (
            user_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,operation_id TEXT NOT NULL,
            request_hash TEXT NOT NULL,snapshot_hash TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,created_at INTEGER NOT NULL,
            PRIMARY KEY(user_id,project_id,operation_id)
        );`)
    }
    list(): { agents: CatalogAgent[]; skills: CatalogSkill[]; themes: CatalogTheme[] } {
        const skills: CatalogSkill[] = [], themes: CatalogTheme[] = [], agents = builtins.map(item => ({ ...item, skills: [...item.skills] }))
        for (const plugin of this.plugins.list().filter(item => item.enabled)) {
            const source: Source = { pluginId: plugin.id, repository: plugin.repository, commitSha: plugin.commitSha }, key = (id: string) => `plugin:${plugin.id}:${id}`
            skills.push(...plugin.manifest.skills.map(skill => ({ ...skill, id: key(skill.id), source })))
            themes.push(...plugin.manifest.themes.map(theme => ({ ...theme, id: key(theme.id), source })))
            agents.push(...plugin.manifest.agents.map(agent => ({ ...agent, id: key(agent.id), skills: agent.skills.map(key), source, origin: 'plugin' as const, available: true })))
        }
        const availableSkills = new Set(skills.map(skill => skill.id))
        const custom = this.store.db.query('SELECT id,definition FROM evolved_agent_catalog ORDER BY created_at,id').all() as Array<{ id: string; definition: string }>
        agents.push(...custom.map((row): CatalogAgent => {
            try { const definition = agentDefinitionSchema.parse(JSON.parse(row.definition)); return { ...definition, id: row.id, origin: 'custom', available: definition.skills.every(id => availableSkills.has(id)) } }
            catch { return { id: row.id, origin: 'custom', invalid: true, available: false, name: 'Ungültige Agentenvorlage', description: 'Gespeicherte Definition ist ungültig. Bitte bearbeiten oder entfernen.', instructions: '', providerPreference: 'either', skills: [] } }
        }))
        return { agents, skills, themes }
    }
    assertSkills(definition: AgentDefinition): void {
        const available = new Set(this.list().skills.map(skill => skill.id))
        if (definition.skills.some(id => !available.has(id))) throw new EvolvedError('agent_skill_unavailable', 'One or more selected skills are unavailable.', 409)
        if (!agentInstructionsFit(definition, this.list().skills.filter(skill => definition.skills.includes(skill.id)))) throw new EvolvedError('agent_prompt_limit', 'Instructions and skills must leave at least 8 KiB for the assignment.', 400)
    }
    snapshot(id: string) {
        const catalog = this.list(), agent = catalog.agents.find(item => item.id === id)
        if (!agent) throw new EvolvedError('agent_not_found', 'Agent template not found.', 404)
        if (!agent.available) throw new EvolvedError('agent_skill_unavailable', 'An agent skill is disabled or no longer installed.', 409)
        const skills = agent.skills.map(id => catalog.skills.find(skill => skill.id === id)!)
        return { agent, skills, hash: hash({ agent, skills }) }
    }
}

export function createAgentCatalogRoutes(config: { store: EvolvedStore; plugins: PluginService; origin: string; getSyncEngine: () => Engine | null }): Hono {
    const { store, plugins, origin } = config, catalog = new AgentCatalog(store, plugins), app = new Hono()
    for (const path of ['/agent-catalog', '/agent-catalog/*', '/projects/:id/agent-catalog', '/projects/:id/agent-catalog/*']) {
        app.use(path, createEvolvedRequestGuard(origin))
        app.use(path, bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ code: 'body_too_large', error: 'Agent request is too large.' }, 413) }))
    }
    app.get('/agent-catalog', async c => { const principal = await extensionHuman(c, store); return c.json({ ...catalog.list(), canManage: principal.user.isAdmin }) })
    app.get('/projects/:id/agent-catalog', async c => {
        const principal = await extensionHuman(c, store), project = store.requireProject(principal.user.id, c.req.param('id'))
        const machines = config.getSyncEngine()?.getOnlineMachinesByNamespace(project.namespace).filter(machine => machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAvailability))
            .map(machine => ({ id: machine.id, name: machine.metadata?.displayName || machine.metadata?.host || machine.id })) ?? []
        return c.json({ ...catalog.list(), canManage: principal.user.isAdmin, projectId: project.id, profile: project.profile, machines })
    })
    app.post('/agent-catalog', async c => {
        await extensionHuman(c, store, true); const definition = await parseBody(c, agentDefinitionSchema)
        const id = store.db.transaction(() => {
            const principal = extensionAdministrationNow(c, store); catalog.assertSkills(definition)
            if ((store.db.query('SELECT COUNT(*) AS n FROM evolved_agent_catalog').get() as { n: number }).n >= 200) throw new EvolvedError('agent_limit', 'At most 200 custom agents are allowed.', 409)
            const id = randomUUID(), now = store.now()
            store.db.prepare('INSERT INTO evolved_agent_catalog VALUES(?,?,?,?,?)').run(id, JSON.stringify(definition), principal.user.id, now, now)
            store.audit(principal.user.id, null, 'agent_template.created', id); return id
        }).immediate()
        return c.json({ agent: catalog.snapshot(id).agent }, 201)
    })
    app.put('/agent-catalog/:id', async c => {
        await extensionHuman(c, store, true); const definition = await parseBody(c, agentDefinitionSchema), id = c.req.param('id')
        store.db.transaction(() => {
            const principal = extensionAdministrationNow(c, store)
            const existing = catalog.list().agents.find(agent => agent.id === id)
            if (!existing) throw new EvolvedError('agent_not_found', 'Agent template not found.', 404)
            if (existing.origin !== 'custom') throw new EvolvedError('agent_readonly', 'Builtin and plugin agent definitions are read-only.', 409)
            catalog.assertSkills(definition)
            store.db.prepare('UPDATE evolved_agent_catalog SET definition=?,updated_at=? WHERE id=?').run(JSON.stringify(definition), store.now(), id)
            store.audit(principal.user.id, null, 'agent_template.updated', id)
        }).immediate()
        return c.json({ agent: catalog.snapshot(id).agent })
    })
    app.delete('/agent-catalog/:id', async c => {
        await extensionHuman(c, store, true); const id = c.req.param('id')
        store.db.transaction(() => {
            const principal = extensionAdministrationNow(c, store), agent = catalog.list().agents.find(agent => agent.id === id)
            if (!agent) throw new EvolvedError('agent_not_found', 'Agent template not found.', 404)
            if (agent.origin !== 'custom') throw new EvolvedError('agent_readonly', 'Builtin and plugin agent definitions are read-only.', 409)
            store.db.prepare('DELETE FROM evolved_agent_catalog WHERE id=?').run(id); store.audit(principal.user.id, null, 'agent_template.deleted', id)
        }).immediate()
        return c.json({ ok: true })
    })
    const startSchema = z.object({ operationId: z.string().uuid(), machineId: z.string().min(1).max(200), task: z.string().trim().min(1).max(24_576), provider: z.enum(['claude', 'codex']).optional(), model: modelPreferenceSchema.optional() }).strict()
    app.post('/projects/:id/agent-catalog/:agentId/start', async c => {
        const principal = await extensionHuman(c, store), body = await parseBody(c, startSchema), projectId = c.req.param('id'), agentId = c.req.param('agentId'), sessionHash = extensionSessionHash(c)
        const current = () => {
            const live = store.getSessionByHash(sessionHash)
            if (!live || live.user.id !== principal.user.id) throw new EvolvedError('unauthorized', 'Session expired or was revoked.', 401)
            return store.requireProject(live.user.id, projectId, 'member')
        }
        const project = current(), engine = config.getSyncEngine()
        if (!engine) throw new EvolvedError('runner_unavailable', 'Project runner is unavailable.', 409)
        const requestHash = hash({ agentId, ...body }), keys = [principal.user.id, projectId, body.operationId] as const
        type Operation = { request_hash: string; snapshot_hash: string; state: string; session_id: string | null }
        const previous = store.db.query('SELECT * FROM evolved_agent_starts WHERE user_id=? AND project_id=? AND operation_id=?').get(...keys) as Operation | null
        if (previous) {
            if (previous.request_hash !== requestHash) throw new EvolvedError('agent_operation_conflict', 'This operation identifier belongs to a different request.', 409)
            if (previous.state === 'done' && previous.session_id && engine.getSessionByNamespace(previous.session_id, project.namespace)) return c.json({ sessionId: previous.session_id, operationId: body.operationId, acknowledged: 'persisted' })
            throw new EvolvedError('agent_start_indeterminate', 'Inspect existing project sessions before starting again. This start cannot be repeated safely.', 409)
        }
        const snapshot = catalog.snapshot(agentId), provider = body.provider ?? (snapshot.agent.providerPreference === 'either' ? 'claude' : snapshot.agent.providerPreference)
        const model = body.model ?? (!body.provider || snapshot.agent.providerPreference === body.provider ? snapshot.agent.model : undefined)
        let root: string
        try { root = realpathSync(project.rootPath) } catch { throw new EvolvedError('project_root_unavailable', 'Project directory is unavailable.', 409) }
        if (root !== project.rootPath || !withinProject(project, root)) throw new EvolvedError('project_root_unavailable', 'Project directory changed.', 409)
        const machine = engine.getMachineByNamespace(body.machineId, project.namespace)
        if (!machine?.active) throw new EvolvedError('runner_unavailable', 'Choose an online runner in this project.', 409)
        if (!machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAvailability)) throw new EvolvedError('runner_upgrade_required', 'Upgrade this runner before starting an agent.', 409)
        const prompt = agentAssignment(snapshot.agent, snapshot.skills, body.task)
        if (Buffer.byteLength(prompt) > MAX_AGENT_PROMPT_BYTES) throw new EvolvedError('agent_prompt_limit', 'Agent instructions, skills and task exceed 64 KiB.', 400)
        store.db.transaction(() => {
            current()
            if (store.db.query('SELECT 1 FROM evolved_agent_starts WHERE user_id=? AND project_id=? AND operation_id=?').get(...keys)) throw new EvolvedError('agent_start_indeterminate', 'This operation has already started. Inspect project sessions before retrying.', 409)
            const recent = store.db.query('SELECT COUNT(*) AS n FROM evolved_agent_starts WHERE project_id=? AND created_at>?').get(projectId, store.now() - 60_000) as { n: number }
            if (recent.n >= 8) throw new EvolvedError('agent_start_rate_limited', 'At most eight specialist starts per project per minute.', 429)
            store.db.prepare('INSERT INTO evolved_agent_starts VALUES(?,?,?,?,?,?,NULL,?)').run(...keys, requestHash, snapshot.hash, 'pending', store.now())
        }).immediate()
        const stillAllowed = () => {
            const live = current()
            if (live.profile !== project.profile || live.rootPath !== project.rootPath || catalog.snapshot(agentId).hash !== snapshot.hash) throw new EvolvedError('agent_start_changed', 'Project or agent definition changed during start.', 409)
            return live
        }
        let childId: string | undefined
        try {
            stillAllowed()
            const spawned = await engine.spawnSession(body.machineId, root, provider, model, undefined, false, 'simple', undefined, undefined, undefined,
                projectPermissionMode(project, provider), undefined, undefined, undefined, undefined, 'remote', project.namespace)
            if (spawned.type !== 'success') throw new EvolvedError('agent_start_indeterminate', 'Runner did not confirm the start. Inspect project sessions before trying again.', 409)
            childId = spawned.sessionId; stillAllowed()
            if (!engine.getSessionByNamespace(childId, project.namespace)) throw new EvolvedError('agent_start_indeterminate', 'Started session could not be verified in this project.', 409)
            const localId = `catalog:${body.operationId}`
            await engine.sendMessage(childId, { text: prompt, localId, sentFrom: 'webapp' })
            stillAllowed()
            if (!engine.getMessagesPage(childId, { limit: 50 }).messages.some(message => message.localId === localId)) throw new EvolvedError('agent_start_indeterminate', 'Initial assignment could not be verified.', 409)
            store.db.transaction(() => {
                stillAllowed()
                store.db.prepare("UPDATE evolved_agent_starts SET state='done',session_id=? WHERE user_id=? AND project_id=? AND operation_id=?").run(childId!, ...keys)
                store.audit(principal.user.id, projectId, 'agent_template.started', `${agentId}@${snapshot.hash}`)
            }).immediate()
            return c.json({ sessionId: childId, operationId: body.operationId, acknowledged: 'persisted' }, 201)
        } catch (error) {
            store.db.prepare("UPDATE evolved_agent_starts SET state='indeterminate',session_id=? WHERE user_id=? AND project_id=? AND operation_id=?").run(childId ?? null, ...keys)
            if (childId && engine.getSessionByNamespace(childId, project.namespace)) try { await engine.archiveSession(childId) } catch { /* Existing session remains visible for manual diagnosis. */ }
            if (error instanceof EvolvedError) throw error
            throw new EvolvedError('agent_start_indeterminate', 'Start outcome is uncertain. Inspect project sessions before starting again.', 409)
        }
    })
    return app
}
