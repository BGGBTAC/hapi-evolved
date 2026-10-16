import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { RepositoryPicker } from './RepositoryPicker'
import { useProjectRepositories } from './repositoryCatalog'
import { useProjectWorkflow } from './ProjectWorkflowContext'
import { canWriteProject, EvolvedApiError, projectPath } from './api'
import { ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate } from './ui'
import { WorkspaceLink } from './workspaceNavigation'
import { ModelCatalogInput } from './ModelCatalogInput'
import './agents-plugins.css'

type Definition = { name: string; description: string; instructions: string; providerPreference: 'either' | 'claude' | 'codex'; model?: string; skills: string[] }
type Source = { pluginId: string; repository: string; commitSha: string }
type Agent = Definition & { id: string; origin: 'builtin' | 'custom' | 'plugin'; source?: Source; available: boolean; invalid?: boolean }
type Skill = { id: string; name: string; description: string; instructions: string; available?: boolean; source?: Source }
type Theme = { id: string; name: string; mode: 'light' | 'dark'; colors: Record<string, string> }
type Manifest = { schemaVersion: 1; id: string; name: string; description: string; version: string; agents: (Definition & { id: string })[]; skills: Skill[]; themes: Theme[] }
type Plugin = { id: string; repository: string; repositoryId: string; commitSha: string; manifestSha256: string; manifest: Manifest; enabled: boolean; installedAt: number; updatedAt: number; invalid?: boolean }
type Preview = Omit<Plugin, 'id' | 'enabled' | 'installedAt' | 'updatedAt'> & { previewId: string; pluginId: string | null; expiresAt: number }
type Catalog = { agents: Agent[]; skills: Skill[]; themes: Theme[]; canManage: boolean; machines?: { id: string; name: string }[] }
type Start = { agentId: string; operationId: string; machineId: string; task: string; provider: 'codex' | 'claude'; model: string; repositoryId?: string; review?: { snapshotId: string; paths: string[] } }
const emptyDefinition = (): Definition => ({ name: '', description: '', instructions: '', providerPreference: 'either', skills: [] })
const originLabels = { builtin: 'Mitgeliefert', custom: 'Eigener Agent', plugin: 'Plugin' }

export function AgentsPluginsPanel() {
    const { api, me, project } = useEvolved()
    return <AgentsPluginsForContext key={`${api.baseUrl}:${me.user.id}:${project?.id ?? 'global'}:${project?.role}:${project?.profile}`} />
}

function AgentsPluginsForContext() {
    const { api, me, project } = useEvolved(), client = useQueryClient()
    const workflow = useProjectWorkflow()
    const mounted = useRef(true), request = useRef<AbortController | null>(null)
    const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [notice, setNotice] = useState('')
    const [search, setSearch] = useState(''), [editor, setEditor] = useState<(Definition & { id?: string }) | null>(null)
    const [start, setStart] = useState<Start | null>(null), [startUncertain, setStartUncertain] = useState(false), [sessionId, setSessionId] = useState('')
    const repositories = useProjectRepositories({ api, me, project }, !!start)
    const selectedRepository = repositories.current?.repositories.find(item => item.id === start?.repositoryId)
    const repositoryReady = !start?.repositoryId || selectedRepository?.local.state === 'ready' && selectedRepository.job?.state !== 'running' && repositories.current?.runner.status === 'ready'
    const [repository, setRepository] = useState(''), [ref, setRef] = useState('HEAD'), [preview, setPreview] = useState<Preview | null>(null)
    const catalog = useQuery({ queryKey: ['evolved', 'agent-catalog', api.baseUrl, me.user.id, project?.id ?? 'global'], queryFn: ({ signal }) => api.request<Catalog>(project ? `${projectPath(project.id)}/agent-catalog` : '/agent-catalog', { signal }) })
    const plugins = useQuery({ queryKey: ['evolved', 'plugins', api.baseUrl, me.user.id], queryFn: ({ signal }) => api.request<{ plugins: Plugin[] }>('/plugins', { signal }) })
    const canManage = catalog.data?.canManage === true
    const machines = catalog.data?.machines ?? []
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort() } }, [])
    const refresh = async () => {
        await Promise.all([client.invalidateQueries({ queryKey: ['evolved', 'agent-catalog'] }), client.invalidateQueries({ queryKey: ['evolved', 'plugins'] })])
        window.dispatchEvent(new Event('evolved:plugins-changed'))
    }
    const run = async (work: (signal: AbortSignal) => Promise<void>, mutation = false) => {
        if (request.current) return
        const controller = new AbortController(); request.current = controller
        setBusy(true); setError(null); setNotice('')
        try { await work(controller.signal) }
        catch (failure) { if (!controller.signal.aborted && mounted.current) setError(failure) }
        finally {
            // A lost response may have committed a change. Read the authoritative catalog again.
            if (mutation && !controller.signal.aborted) {
                try { await refresh() } catch (failure) { if (mounted.current) setError(failure) }
            }
            if (mounted.current) setBusy(false)
            if (request.current === controller) request.current = null
        }
    }
    const saveAgent = () => {
        if (!editor) return
        const { id, ...definition } = editor
        void run(async signal => {
            await api.request(`/agent-catalog${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: { ...definition, model: definition.providerPreference === 'either' ? undefined : definition.model?.trim() || undefined }, signal })
            if (mounted.current) { setEditor(null); setNotice('Agent wurde gespeichert und ist in allen Projekten verfügbar.') }
        }, true)
    }
    const beginStart = (agent: Agent) => {
        setError(null); setNotice(''); setSessionId(''); setStartUncertain(false)
        setStart({ agentId: agent.id, operationId: crypto.randomUUID(), machineId: machines[0]?.id ?? '', task: '', provider: agent.providerPreference === 'codex' ? 'codex' : 'claude', model: agent.providerPreference === 'either' ? '' : agent.model ?? '', ...(workflow?.repositoryId ? { repositoryId: workflow.repositoryId } : {}) })
        workflow?.setRepositoryId(null)
    }
    useEffect(() => {
        if (!workflow?.review || !project || start || !canWriteProject(project.role)) return
        const reviewer = catalog.data?.agents.find(agent => agent.id === 'builtin:review' && agent.available)
        if (!reviewer || !machines.length) return
        const { repositoryId, ...review } = workflow.review
        setStart({ agentId: reviewer.id, operationId: crypto.randomUUID(), machineId: machines[0]!.id, task: 'Prüfe die ausgewählten Änderungen auf belegbare Fehler, Sicherheitslücken und Regressionen. Berichte Befunde mit Datei und Zeile.', provider: 'claude', model: '', repositoryId, review })
        workflow.setReview(null)
    }, [workflow?.review, project, start, catalog.data, machines])
    const launch = () => {
        if (!start || !project || (!startUncertain && !repositoryReady)) return
        const saved = start
        void run(async signal => {
            try {
                const result = await api.request<{ sessionId: string; operationId: string; acknowledged: 'persisted' }>(`${projectPath(project.id)}/agent-catalog/${encodeURIComponent(saved.agentId)}/start`, {
                    method: 'POST', signal, body: { operationId: saved.operationId, machineId: saved.machineId, task: saved.task, provider: saved.provider, ...(saved.model.trim() ? { model: saved.model.trim() } : {}), ...(saved.repositoryId ? { repositoryId: saved.repositoryId } : {}), ...(saved.review ? { review: saved.review } : {}) },
                })
                if (result.operationId !== saved.operationId || result.acknowledged !== 'persisted' || typeof result.sessionId !== 'string') throw new Error('Startbestätigung konnte nicht geprüft werden.')
                if (mounted.current) { setSessionId(result.sessionId); setStart(null); setStartUncertain(false); setNotice('Aufgabe wurde dauerhaft an die Sitzung übergeben.') }
            } catch (failure) {
                // Codes can recur after a child has started. Only the explicit
                // server reservation marker proves a new attempt is safe to edit.
                // A previously uncertain operation never loses that protection.
                const safeToEdit = !startUncertain && failure instanceof EvolvedApiError && failure.reserved === false
                if (mounted.current && !signal.aborted) setStartUncertain(!safeToEdit)
                throw failure
            }
        })
    }
    const loadPreview = (plugin?: Plugin) => {
        setPreview(null)
        void run(async signal => {
            const result = await api.request<{ preview: Preview }>(plugin ? `/plugins/${encodeURIComponent(plugin.id)}/preview-update` : '/plugins/preview', { method: 'POST', body: plugin ? { ref: ref.trim() || 'HEAD' } : { repository: repository.trim(), ref: ref.trim() || 'HEAD' }, signal })
            if (mounted.current) setPreview(result.preview)
        })
    }
    const commitPreview = () => {
        if (!preview) return
        const chosen = preview
        void run(async signal => {
            await api.request(chosen.pluginId ? `/plugins/${encodeURIComponent(chosen.pluginId)}/update` : '/plugins', { method: 'POST', body: { previewId: chosen.previewId, commitSha: chosen.commitSha, manifestSha256: chosen.manifestSha256 }, signal })
            if (mounted.current) { setPreview(null); setNotice(chosen.pluginId ? 'Plugin wurde aktualisiert.' : 'Plugin wurde installiert.') }
        }, true)
    }

    return <div className="ev-agent-layout">{workflow?.repositoryId && !start && <p className="ev-callout">Repository-ID {workflow.repositoryId} ist für den nächsten Start vorausgewählt. Wähle einen Spezialisten; Freigabe und lokaler Ordner werden vor dem Start erneut geprüft. <button type="button" onClick={() => workflow.setRepositoryId(null)}>Repo-Vorauswahl verwerfen</button></p>}<ErrorNotice error={error || catalog.error || plugins.error} />{notice && <p className="ev-success" role="status">{notice}</p>}{sessionId && <Link to="/sessions/$sessionId" params={{ sessionId }} className="ev-primary">Sitzung öffnen</Link>}
        <Panel title="Agenten für alle Projekte" description="Wiederverwendbare Rollen, Anweisungen und Fähigkeiten. Jeder Start übernimmt die Berechtigungen und den Ordner des gewählten Projekts.">
            <div className="ev-agent-toolbar"><input aria-label="Agenten durchsuchen" placeholder="Agenten durchsuchen …" value={search} onChange={event => setSearch(event.target.value)} />{canManage && <button disabled={busy} onClick={() => setEditor(emptyDefinition())}>Agent erstellen</button>}<button disabled={busy || catalog.isFetching} onClick={() => void catalog.refetch()}>Aktualisieren</button></div>
            {!project && <p className="ev-callout">Wähle oben ein Projekt, um einen Agenten darin zu starten. Der Katalog gilt für alle Projekte.</p>}
            {project && !canWriteProject(project.role) && <p className="ev-callout">Mit lesendem Projektzugang kannst du den Katalog ansehen. Zum Starten ist die Rolle Mitglied oder Administrator nötig.</p>}
            {project && canWriteProject(project.role) && !machines.length && !catalog.isPending && !catalog.error && <p className="ev-callout">Noch kein ausführender Runner für dieses Projekt verbunden. <WorkspaceLink tab="providers" projectId={project.id}>Abo verbinden und Projektdienst vorbereiten</WorkspaceLink></p>}
            {catalog.isPending ? <Loading /> : <div className="ev-agent-grid">{(catalog.data?.agents ?? []).filter(agent => `${agent.name} ${agent.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(agent => <article className="ev-agent-card" key={agent.id}>
                <div className="ev-agent-card-header"><strong>{agent.name}</strong><span className="ev-agent-badge">{originLabels[agent.origin]}</span></div><p>{agent.description}</p><p className="ev-muted">{agent.providerPreference === 'either' ? 'Claude oder Codex · Modell beim Start wählen' : agent.providerPreference === 'claude' ? 'Claude' : 'Codex'}{agent.providerPreference !== 'either' && agent.model ? ` · ${agent.model}` : ''}</p>
                {agent.source && <p className="ev-agent-source">{agent.source.repository} · <code>{agent.source.commitSha.slice(0, 12)}</code></p>}
                <details><summary>Anweisungen und Fähigkeiten</summary><pre>{agent.instructions}</pre>{agent.skills.length ? <ul>{agent.skills.map(id => <li key={id}>{catalog.data?.skills.find(skill => skill.id === id)?.name ?? id}</li>)}</ul> : <p className="ev-muted">Keine zusätzlichen Fähigkeiten ausgewählt.</p>}</details>
                {!agent.available && <p role="status" className="ev-muted">{agent.invalid ? 'Gespeicherte Vorlage ist ungültig. Bitte bearbeiten oder entfernen.' : 'Derzeit nicht verfügbar: benötigtes Plugin oder eine Fähigkeit ist deaktiviert.'}</p>}
                <div className="ev-agent-actions"><button className="ev-primary" disabled={busy || startUncertain || !project || !canWriteProject(project?.role) || !machines.length || !agent.available} onClick={() => beginStart(agent)}>Aufgabe starten</button>{canManage && agent.origin === 'custom' && <><button disabled={busy} onClick={() => { const { id, name, description, instructions, providerPreference, model, skills } = agent; setEditor({ id, name, description, instructions, providerPreference, model, skills }) }}>Bearbeiten</button><ConfirmButton label="Agent löschen" detail="Diesen eigenen Agenten aus dem globalen Katalog entfernen? Bereits gestartete Sitzungen bleiben erhalten." disabled={busy} onConfirm={() => void run(async signal => { await api.request(`/agent-catalog/${encodeURIComponent(agent.id)}`, { method: 'DELETE', signal }) }, true)} /></>}</div>
            </article>)}</div>}
            {!catalog.isPending && !catalog.data?.agents.length && <Empty>Noch keine Agenten vorhanden.</Empty>}
            {!canManage && <p className="ev-muted">Eigene globale Agenten und Plugins verwaltet der Installationsadministrator.</p>}
        </Panel>
        {editor && canManage && <Panel title={editor.id ? 'Agent bearbeiten' : 'Eigenen Agenten erstellen'} description="Anweisungen gelten in jedem Projekt, das diesen Agenten nutzt. Sie erteilen keine zusätzlichen System- oder Geheimnisrechte."><form className="ev-form" onSubmit={event => { event.preventDefault(); saveAgent() }}>
            <Field label="Name"><input required maxLength={100} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></Field><Field label="Beschreibung"><textarea aria-label="Beschreibung" required maxLength={500} rows={2} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} /></Field><Field label="Anweisungen"><textarea aria-label="Anweisungen" required maxLength={16384} rows={8} value={editor.instructions} onChange={event => setEditor({ ...editor, instructions: event.target.value })} /></Field>
            <Field label="Bevorzugter Anbieter"><select value={editor.providerPreference} onChange={event => setEditor({ ...editor, providerPreference: event.target.value as Definition['providerPreference'], model: undefined })}><option value="either">Claude oder Codex</option><option value="claude">Claude</option><option value="codex">Codex</option></select></Field>{editor.providerPreference === 'either' ? <p className="ev-muted">Bei freier Anbieterwahl legst du das Modell beim Start fest. Eine gespeicherte Modellpräferenz gilt nur für einen ausdrücklich gewählten Anbieter.</p> : <ModelCatalogInput provider={editor.providerPreference} projectId={project?.id ?? null} value={editor.model ?? ''} defaultValue="" label="Modell (optional)" disabled={busy} onChange={model => setEditor({ ...editor, model: model || undefined })} />}
            {!!catalog.data?.skills.length && <fieldset className="ev-agent-skills"><legend>Fähigkeiten</legend>{catalog.data.skills.map(skill => <label key={skill.id}><input type="checkbox" disabled={skill.available === false && !editor.skills.includes(skill.id)} checked={editor.skills.includes(skill.id)} onChange={event => setEditor({ ...editor, skills: event.target.checked ? [...editor.skills, skill.id] : editor.skills.filter(id => id !== skill.id) })} /><span>{skill.name}<small>{skill.description}</small></span></label>)}</fieldset>}
            {editor.skills.filter(id => !catalog.data?.skills.some(skill => skill.id === id)).map(id => <label className="ev-callout" key={id}><input type="checkbox" checked onChange={() => setEditor({ ...editor, skills: editor.skills.filter(skill => skill !== id) })} /> Nicht verfügbare Fähigkeit: {id}. Abwählen, um diese Abhängigkeit zu entfernen.</label>)}
            <div className="ev-agent-actions"><button className="ev-primary" disabled={busy}>Agent speichern</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>Abbrechen</button></div>
        </form></Panel>}
        {start && project && <Panel title={`Aufgabe für ${catalog.data?.agents.find(agent => agent.id === start.agentId)?.name ?? 'Agent'}`} description={`Die Sitzung wird im Projekt „${project.name}“ gestartet. Profil und vorhandene Freigaben begrenzen weiterhin alle Aktionen.`}><form className="ev-form" onSubmit={event => { event.preventDefault(); launch() }}>
            <RepositoryPicker choices={repositories} value={start.repositoryId ?? ''} onChange={repositoryId => setStart({ ...start, repositoryId: repositoryId || undefined, review: undefined })} projectId={project.id} disabled={busy || startUncertain || !!start.review} />
            {start.review && <p className="ev-callout">Review der ausgewählten {start.review.paths.length} Dateien. Der Server prüft den Arbeitsstand erneut und startet den Review mit eingeschränktem Schreibmodus. <WorkspaceLink tab="github" projectId={project.id}>Arbeitsstand erneut prüfen</WorkspaceLink></p>}
            <Field label="Runner"><select required disabled={busy || startUncertain} value={start.machineId} onChange={event => setStart({ ...start, machineId: event.target.value, model: '' })}>{machines.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></Field><Field label="Aufgabe"><textarea aria-label="Aufgabe" required rows={5} maxLength={16384} disabled={busy || startUncertain} value={start.task} onChange={event => setStart({ ...start, task: event.target.value })} /></Field><Field label="Anbieter"><select disabled={busy || startUncertain} value={start.provider} onChange={event => setStart({ ...start, provider: event.target.value as Start['provider'], model: '' })}><option value="codex">Codex</option><option value="claude">Claude</option></select></Field><p className="ev-muted">Der gewählte Anbieter muss auf diesem Runner angemeldet sein. <WorkspaceLink tab="providers" projectId={project.id}>Abos verbinden</WorkspaceLink></p><ModelCatalogInput key={start.provider} provider={start.provider} projectId={project.id} value={start.model} defaultValue="" label="Modell für diesen Start (optional)" disabled={busy || startUncertain} onChange={model => setStart({ ...start, model })} />
            {startUncertain && <p className="ev-callout" role="status">Die Startbestätigung fehlt. Eine Wiederholung verwendet dieselbe Vorgangskennung und prüft die bestehende Übergabe. Aufgabe und Runner bleiben dafür unverändert. <Link to="/sessions">Sitzungen ansehen</Link></p>}
            <div className="ev-agent-actions"><button className="ev-primary" disabled={busy || !start.task.trim() || !start.machineId || (!startUncertain && !repositoryReady)}>{startUncertain ? 'Startbestätigung erneut prüfen' : 'Jetzt starten'}</button>{!startUncertain && <button type="button" disabled={busy} onClick={() => setStart(null)}>Abbrechen</button>}</div>
        </form>{startUncertain && <div className="ev-agent-actions"><ConfirmButton label="Nach Sitzungsprüfung neuen Auftrag vorbereiten" detail="Ich habe die Projektsitzungen geprüft. Ein neuer Auftrag erhält eine neue Kennung und kann eine weitere Sitzung erzeugen; ein schon laufender Auftrag wird dadurch nicht abgebrochen." disabled={busy} onConfirm={() => { setStart({ ...start, operationId: crypto.randomUUID() }); setStartUncertain(false); setError(null) }} /></div>}</Panel>}
        <Panel title="Plugins" description="Öffentliche GitHub-Repositories können geprüfte Agentenvorlagen, Fähigkeiten und Themes beitragen. Vor jeder Installation oder Aktualisierung siehst du die genaue Fassung und ihren Inhalt.">
            {canManage && <form className="ev-form" onSubmit={event => { event.preventDefault(); loadPreview() }}><Field label="GitHub-Repository" hint="Öffentliches Repository im Format owner/repo mit hapi-evolved.plugin.json."><input required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" placeholder="owner/repo" value={repository} onChange={event => { setRepository(event.target.value); setPreview(null) }} /></Field><Field label="Branch, Tag oder Commit" hint="Diese Referenz wird für neue Plugins und die nächste Update-Vorschau verwendet."><input maxLength={200} value={ref} onChange={event => { setRef(event.target.value); setPreview(null) }} /></Field><button disabled={busy || !repository.trim()}>Plugin prüfen</button></form>}
            {preview && canManage && <section className="ev-plugin-preview" aria-label="Plugin-Vorschau"><h3>{preview.pluginId ? 'Update prüfen' : 'Installation prüfen'}: {preview.manifest.name} {preview.manifest.version}</h3><p>{preview.manifest.description}</p><dl><dt>Repository</dt><dd>{preview.repository}</dd><dt>Commit</dt><dd><code>{preview.commitSha}</code></dd><dt>Manifest-Prüfsumme</dt><dd><code>{preview.manifestSha256}</code></dd><dt>Bestätigung gültig bis</dt><dd>{formatDate(preview.expiresAt)}</dd></dl><ManifestDetails manifest={preview.manifest} /><p className="ev-callout">Die Inhalte gelten nach der Installation global. Prüfe besonders Agenten- und Skill-Anweisungen. Plugins enthalten ausschließlich die angezeigten Vorlagen und Theme-Farben; ausführbare Erweiterungen sind nicht vorgesehen.</p><div className="ev-agent-actions"><button className="ev-primary" disabled={busy || preview.expiresAt <= Date.now()} onClick={commitPreview}>{preview.pluginId ? 'Diese Fassung aktualisieren' : 'Diese Fassung installieren'}</button><button disabled={busy} onClick={() => setPreview(null)}>Vorschau verwerfen</button></div></section>}
            {plugins.isPending ? <Loading /> : <div className="ev-agent-grid">{plugins.data?.plugins.map(plugin => <article className="ev-agent-card" key={plugin.id}><div className="ev-agent-card-header"><strong>{plugin.manifest.name}</strong><span className="ev-agent-badge">{plugin.invalid ? 'Ungültig' : plugin.enabled ? 'Aktiv' : 'Deaktiviert'}</span></div><p>{plugin.manifest.description}</p><p className="ev-agent-source">{plugin.repository} · Version {plugin.manifest.version} · <code>{plugin.commitSha.slice(0, 12)}</code></p><ManifestDetails manifest={plugin.manifest} />{plugin.invalid && <p role="status">Die gespeicherten Inhalte sind ungültig. Entferne dieses Plugin und prüfe vor einer erneuten Installation eine gültige Fassung.</p>}{canManage && <div className="ev-agent-actions">{!plugin.invalid && <><button disabled={busy} onClick={() => loadPreview(plugin)}>Update prüfen</button><button disabled={busy} onClick={() => void run(async signal => { await api.request(`/plugins/${encodeURIComponent(plugin.id)}`, { method: 'PUT', body: { enabled: !plugin.enabled }, signal }) }, true)}>{plugin.enabled ? 'Deaktivieren' : 'Aktivieren'}</button></>}<ConfirmButton label="Deinstallieren" detail="Dieses Plugin mit seinen Agenten, Fähigkeiten und Themes global entfernen? Agenten, die seine Fähigkeiten benötigen, können danach nicht starten." disabled={busy} onConfirm={() => void run(async signal => { await api.request(`/plugins/${encodeURIComponent(plugin.id)}`, { method: 'DELETE', signal }) }, true)} /></div>}</article>)}</div>}
            {!plugins.isPending && !plugins.error && !plugins.data?.plugins.length && <Empty>Noch keine Plugins installiert.</Empty>}
        </Panel>
    </div>
}

function ManifestDetails({ manifest }: { manifest: Manifest }) {
    return <details><summary>{manifest.agents.length} Agenten · {manifest.skills.length} Fähigkeiten · {manifest.themes.length} Themes ansehen</summary>{manifest.agents.map(agent => <section key={`agent:${agent.id}`}><h4>Agent: {agent.name}</h4><p>{agent.description}</p><pre>{agent.instructions}</pre><p className="ev-muted">Anbieter: {agent.providerPreference} · Fähigkeiten: {agent.skills.join(', ') || 'Keine'}</p></section>)}{manifest.skills.map(skill => <section key={`skill:${skill.id}`}><h4>Fähigkeit: {skill.name}</h4><p>{skill.description}</p><pre>{skill.instructions}</pre></section>)}{manifest.themes.map(theme => <section key={`theme:${theme.id}`}><h4>Theme: {theme.name}</h4><p>{theme.mode === 'dark' ? 'Dunkel' : 'Hell'}</p><pre>{JSON.stringify(theme.colors, null, 2)}</pre></section>)}</details>
}
