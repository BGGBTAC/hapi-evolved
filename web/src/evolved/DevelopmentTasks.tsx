import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { DEVELOPMENT_CONSEQUENTIAL_EFFECTS, DEVELOPMENT_MODULE_CONTRACT_VERSION, developmentTaskEffects, developmentTaskRequiresWritableProfile, type DevelopmentModuleContext, type DevelopmentModuleRecipe, type DevelopmentModuleResolvedTask, type ProjectDevelopmentModuleConfig } from '@hapi/protocol/developmentModules'
import { useEvolved } from './auth'
import { canWriteProject, EvolvedApiError, projectPath } from './api'
import { useProjectRepositories } from './repositoryCatalog'
import { RepositoryPicker } from './RepositoryPicker'
import { ModelCatalogInput } from './ModelCatalogInput'
import { ConfirmButton } from './ui'
import { WorkspaceLink } from './workspaceNavigation'
import { consequentialEffects, describeDevelopmentError, effectLabels, kindLabels, moduleOriginLabel } from './developmentApi'

type CatalogAgent = { id: string; available: boolean }
type AgentCatalog = { agents: CatalogAgent[]; machines?: { id: string; name: string }[] }
// The displayed module id/digest and config revision are frozen when the form opens; a retry sends exactly the same body.
type Start = { taskId: string; revision: number; moduleId: string; moduleDigest: string; operationId: string; machineId: string; provider: 'claude' | 'codex'; model: string; task: string; repositoryId: string }
type ModuleView = NonNullable<DevelopmentModuleContext['module']>

export function DevelopmentTasks({ config, module, unsaved, onModuleChanged, requestedTask }: {
    config: ProjectDevelopmentModuleConfig; module: ModuleView; unsaved: boolean; onModuleChanged: () => void
    /** A task whose start form should open (from a doctor remedy); the nonce lets the same task be requested again. */
    requestedTask?: { id: string; nonce: number } | null
}) {
    const { api, me, project } = useEvolved()
    const navigate = useNavigate()
    const writable = canWriteProject(project!.role)
    const [start, setStart] = useState<Start | null>(null)
    const [uncertain, setUncertain] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inFlight = useRef<AbortController | null>(null)
    useEffect(() => () => inFlight.current?.abort(), [])
    const catalog = useQuery({
        queryKey: ['evolved', 'agent-catalog', api.baseUrl, me.user.id, project!.id],
        enabled: !!start, retry: false,
        queryFn: ({ signal }) => api.request<AgentCatalog>(`${projectPath(project!.id)}/agent-catalog`, { signal }),
    })
    const repositories = useProjectRepositories({ api, me, project }, !!start)
    const machines = !catalog.error ? catalog.data?.machines ?? [] : []
    useEffect(() => {
        if (start && !start.machineId && machines[0]) setStart({ ...start, machineId: machines[0].id })
    }, [start, machines])
    const recipes = new Map(module.recipes.map(recipe => [recipe.id, recipe]))
    const task = start ? module.tasks.find(item => item.id === start.taskId) : undefined
    // Effective effects include those of the referenced recipes; the hub enforces the same rule on start.
    const effectsOf = (item: DevelopmentModuleResolvedTask) => developmentTaskEffects(item, module.recipes)
    const restricted = project!.profile === 'restricted'
    const profileBlocked = (item: DevelopmentModuleResolvedTask) => restricted && developmentTaskRequiresWritableProfile(effectsOf(item))
    const form = useRef<HTMLFormElement>(null)
    const handled = useRef(0)
    useEffect(() => {
        if (!requestedTask || requestedTask.nonce === handled.current) return
        handled.current = requestedTask.nonce
        const item = module.tasks.find(entry => entry.id === requestedTask.id)
        if (!item || !writable || busy || uncertain) return
        if (start?.taskId !== item.id) open(item)
        requestAnimationFrame(() => { form.current?.scrollIntoView?.({ block: 'start' }); form.current?.querySelector<HTMLElement>('h3')?.focus() })
    }, [requestedTask])
    const boundRepository = config.settings.repositoryId

    const open = (item: DevelopmentModuleResolvedTask) => {
        setError(null); setUncertain(false)
        setStart({ taskId: item.id, revision: config.revision, moduleId: module.id, moduleDigest: module.digest, operationId: crypto.randomUUID(), machineId: machines[0]?.id ?? '', provider: 'claude', model: '', task: item.defaultTask, repositoryId: boundRepository ?? '' })
    }
    const selected = start?.repositoryId ? repositories.current?.repositories.find(item => item.id === start.repositoryId) : undefined
    const repositoryReady = !start?.repositoryId || (selected?.local.state === 'ready' && selected.job?.state !== 'running' && repositories.current?.runner.status === 'ready')
    // The folder comes from the hub's authorised repository catalog (or the project root); never derived client-side.
    const effectiveFolder = !start ? null : start.repositoryId ? repositoryReady && selected ? selected.path : null : repositories.current?.rootPath ?? project!.rootPath ?? null
    const agent = task ? catalog.data?.agents.find(item => item.id === task.specialist) : undefined
    const needsLicense = !!task && (task.preconditions?.includes('android_sdk_license_acknowledged') || task.effects.includes('requires_license_acknowledgement'))
    const blocker = !start || !task ? null
        : uncertain ? null
            : unsaved ? 'Speichere oder verwirf zuerst deine Änderungen. Aufgaben nutzen nur die gespeicherte Konfiguration.'
                : profileBlocked(task) ? `Das Profil „Eingeschränkt“ erlaubt diese Aufgabe nicht (${effectsOf(task).filter(effect => DEVELOPMENT_CONSEQUENTIAL_EFFECTS.includes(effect)).map(effect => effectLabels[effect]).join(', ')}). Ein Projektadministrator kann das Profil in der Einrichtung bewusst auf „Arbeitsbereich“ ändern.`
                : start.revision !== config.revision ? 'Die Konfiguration hat sich geändert. Schließe das Formular und öffne die Aufgabe erneut.'
                    : start.moduleId !== module.id || start.moduleDigest !== module.digest ? 'Die Modulfassung hat sich geändert. Schließe das Formular und öffne die Aufgabe erneut.'
                    : catalog.isPending ? 'Runner und Spezialisten werden geladen …'
                        : catalog.error ? describeDevelopmentError(catalog.error)
                            : !machines.length ? 'Kein ausführender Runner für dieses Projekt verbunden.'
                                : !agent?.available ? 'Der benötigte Spezialist ist derzeit nicht verfügbar.'
                                    : task.requiresRepository && !start.repositoryId ? 'Diese Aufgabe braucht ein freigegebenes, geklontes Repository.'
                                        : repositories.isPending || repositories.isFetching ? 'Arbeitsort wird geprüft …'
                                            : repositories.error ? describeDevelopmentError(repositories.error)
                                                : start.repositoryId && !selected ? `${start.repositoryId === boundRepository ? 'Das Standard-Repository' : 'Das gewählte Repository'} ist nicht (mehr) freigegeben. Es wird nicht auf den Projektordner ausgewichen; wähle ein freigegebenes Repository.`
                                                    : !repositoryReady ? 'Das gewählte Repository ist noch nicht geklont oder nicht bereit.'
                                                        : !effectiveFolder ? 'Der Projektordner ist nicht bekannt.'
                                                            : needsLicense && !config.androidSdkLicenseAcknowledgement ? 'Ein Projektadministrator muss zuerst die Android-SDK-Lizenzprüfung bestätigen.'
                                                                : !start.task.trim() ? 'Beschreibe die Aufgabe.'
                                                                    : !start.machineId ? 'Wähle einen Runner.' : null

    const launch = () => {
        if (!start || !task || blocker || inFlight.current) return
        const saved = start
        const controller = new AbortController(); inFlight.current = controller
        setBusy(true); setError(null)
        void (async () => {
            try {
                const result = await api.request<{ sessionId: string; operationId: string; acknowledged: 'persisted' }>(`${projectPath(project!.id)}/agent-catalog/${encodeURIComponent(task.specialist)}/start`, {
                    method: 'POST', signal: controller.signal,
                    body: { operationId: saved.operationId, machineId: saved.machineId, task: saved.task, provider: saved.provider, ...(saved.model.trim() ? { model: saved.model.trim() } : {}),
                        ...(saved.repositoryId ? { repositoryId: saved.repositoryId } : {}),
                        development: { contractVersion: DEVELOPMENT_MODULE_CONTRACT_VERSION, moduleId: saved.moduleId, moduleDigest: saved.moduleDigest, taskId: saved.taskId, revision: saved.revision } },
                })
                if (result?.operationId !== saved.operationId || result.acknowledged !== 'persisted' || typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('Startbestätigung konnte nicht geprüft werden.')
                if (controller.signal.aborted) return
                setStart(null); setUncertain(false)
                void navigate({ to: '/sessions/$sessionId', params: { sessionId: result.sessionId } })
            } catch (failure) {
                if (controller.signal.aborted) return
                // Only an explicit server marker proves that no session was reserved.
                const safe = !uncertain && failure instanceof EvolvedApiError && failure.reserved === false
                setUncertain(!safe)
                setError(describeDevelopmentError(failure))
                // A refused start for a changed module or configuration refreshes the shown state; the open form keeps its old binding and stays blocked.
                if (safe && failure instanceof EvolvedApiError && ['development_module_changed', 'development_module_unavailable', 'development_revision_conflict', 'agent_start_changed'].includes(failure.code ?? '')) onModuleChanged()
            } finally {
                if (inFlight.current === controller) inFlight.current = null
                if (!controller.signal.aborted) setBusy(false)
            }
        })()
    }
    const locked = busy || uncertain
    return <section className="ev-panel" aria-labelledby="ev-dev-tasks">
        <h2 id="ev-dev-tasks">Aufgaben</h2>
        <p className="ev-muted">Jede Aufgabe startet eine Agentensitzung mit passendem Spezialisten. Aufgaben aus {module.title}, Fassung {module.contentVersion}.</p>
        {!writable && <p className="ev-callout">Mit lesendem Zugang kannst du Aufgaben ansehen, aber nicht starten.</p>}
        <div className="ev-dev-recipes">{module.tasks.map(item => <article className="ev-dev-recipe" key={item.id} aria-labelledby={`ev-dev-task-${item.id}`}>
            <header><strong id={`ev-dev-task-${item.id}`}>{item.title}</strong><span className="ev-dev-pill">{kindLabels[item.kind]}</span></header>
            <p>{item.description}</p>
            {effectsOf(item).length > 0 && <div className="ev-dev-pills" aria-label="Auswirkungen">{effectsOf(item).map(effect => <span key={effect} className="ev-dev-pill" data-tone={consequentialEffects.includes(effect) ? 'warn' : undefined}>{effectLabels[effect]}</span>)}</div>}
            {profileBlocked(item) && <p className="ev-muted">Braucht das Profil „Arbeitsbereich“ oder „Erweitert“. <WorkspaceLink tab="setup" projectId={project!.id} step="profile">Profil in der Einrichtung prüfen</WorkspaceLink></p>}
            {item.notes.length > 0 && <ul>{item.notes.map(note => <li key={note}>{note}</li>)}</ul>}
            {item.recipeIds.length > 0 && <details><summary>Ablauf ansehen ({item.recipeIds.length})</summary>{item.recipeIds.map(id => recipes.get(id)).filter((recipe): recipe is DevelopmentModuleRecipe => !!recipe).map(recipe => <RecipeDetails key={recipe.id} recipe={recipe} />)}</details>}
            <button type="button" disabled={!writable || unsaved || locked || start?.taskId === item.id} onClick={() => open(item)}>{start?.taskId === item.id ? 'Formular geöffnet' : 'Sitzung vorbereiten'}</button>
        </article>)}</div>
        {!module.tasks.length && <p className="ev-muted">Für diese Fassung und die gespeicherten Einstellungen gibt es keine Aufgaben.</p>}

        {start && task && <form ref={form} className="ev-dev-start" aria-label={`Sitzung starten: ${task.title}`} onSubmit={event => { event.preventDefault(); launch() }}>
            <h3 tabIndex={-1}>{task.title}</h3>
            <p className="ev-muted">Modul: {module.title} · Fassung {module.contentVersion}{module.source.kind === 'plugin' ? ` · ${moduleOriginLabel(module.source)}` : ''}</p>
            {effectsOf(task).length > 0 && <p className="ev-muted">Auswirkungen: {effectsOf(task).map(effect => effectLabels[effect]).join(' · ')}</p>}
            <RepositoryPicker choices={repositories} value={start.repositoryId} onChange={repositoryId => setStart({ ...start, repositoryId })} projectId={project!.id} disabled={locked}
                allowProjectRoot={!boundRepository} defaultRepositoryId={boundRepository}
                hint={boundRepository ? 'Standard-Repository vorausgewählt; ein anderes freigegebenes Repository ist möglich.' : 'Ohne Auswahl startet die Sitzung im Projektordner.'} />
            <div className="ev-dev-folder" role="group" aria-label="Arbeitsordner"><span>Arbeitsordner{start.repositoryId ? start.repositoryId === boundRepository ? ' (Standard-Repository)' : ' (eigene Auswahl)' : ' (Projektordner)'}</span><code>{effectiveFolder ?? 'nicht verfügbar'}</code></div>
            <label className="ev-field"><span>Runner</span><select required value={start.machineId} disabled={locked || !machines.length} onChange={event => setStart({ ...start, machineId: event.target.value })}>{!machines.length && <option value="">Kein Runner verbunden</option>}{machines.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
            {!catalog.isPending && !machines.length && <p className="ev-muted"><WorkspaceLink tab="providers" projectId={project!.id}>Abo verbinden und Projektdienst vorbereiten</WorkspaceLink></p>}
            <label className="ev-field"><span>Anbieter</span><select value={start.provider} disabled={locked} onChange={event => setStart({ ...start, provider: event.target.value as Start['provider'], model: '' })}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
            <ModelCatalogInput key={start.provider} provider={start.provider} projectId={project!.id} value={start.model} defaultValue="" label="Modell (optional)" disabled={locked} onChange={model => setStart({ ...start, model })} />
            <label className="ev-field"><span>Aufgabe</span><textarea rows={4} maxLength={16384} value={start.task} disabled={locked} onChange={event => setStart({ ...start, task: event.target.value })} /></label>
            {blocker && <p className="ev-muted" role="status" id="ev-dev-start-blocker">{blocker}</p>}
            {error && <p className="ev-error" role="alert">{error}</p>}
            {uncertain && <p className="ev-callout" role="status">Die Startbestätigung fehlt. Eine Wiederholung verwendet dieselbe Vorgangskennung und erzeugt keine zweite Sitzung. <Link to="/sessions">Sitzungen ansehen</Link></p>}
            <div className="ev-actions">
                <button type="submit" className="ev-primary" disabled={busy || !!blocker} aria-describedby={blocker ? 'ev-dev-start-blocker' : undefined}>{busy ? 'Wird gestartet …' : uncertain ? 'Startbestätigung erneut prüfen' : 'Sitzung starten'}</button>
                {!uncertain && <button type="button" disabled={busy} onClick={() => { setStart(null); setError(null) }}>Abbrechen</button>}
            </div>
            {uncertain && <ConfirmButton label="Nach Sitzungsprüfung neuen Auftrag vorbereiten" detail="Ich habe die Projektsitzungen geprüft. Ein neuer Auftrag erhält eine neue Kennung und kann eine weitere Sitzung erzeugen." disabled={busy}
                onConfirm={() => { setStart({ ...start, operationId: crypto.randomUUID(), revision: config.revision, moduleId: module.id, moduleDigest: module.digest }); setUncertain(false); setError(null) }} />}
        </form>}
    </section>
}

function RecipeDetails({ recipe }: { recipe: DevelopmentModuleRecipe }) {
    return <div className="ev-stack" style={{ gap: 6, marginTop: 8 }}>
        <strong>{recipe.title}</strong><p>{recipe.summary}</p>
        <ol>{recipe.steps.map(step => <li key={step.title}><span>{step.title}: {step.detail}</span>{step.argv && <><br /><code>{step.argv.join(' ')}</code></>}</li>)}</ol>
        {recipe.outputs.length > 0 && <p>Lokale Ergebnisse im Projekt (kein Download-Dienst): {recipe.outputs.join(', ')}</p>}
        {recipe.guardrails.length > 0 && <ul>{recipe.guardrails.map(rule => <li key={rule}>{rule}</li>)}</ul>}
    </div>
}
