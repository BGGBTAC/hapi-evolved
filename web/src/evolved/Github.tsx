import { Link } from '@tanstack/react-router'
import { useProjectWorkflow } from './ProjectWorkflowContext'
import { useEffect, useRef, useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { canWriteProject, EvolvedApiError, isProjectAdmin, projectPath } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, submit, useAction } from './ui'
import { WorkspaceLink } from './workspaceNavigation'
import { RepositoryWorktreePanel } from './RepositoryWorktree'

type GithubRepository = { id: string; owner: string; name: string; fullName: string; permission: 'read' | 'write' }
type GithubStatus = { connected: boolean; account?: { id: number; login: string }; repositories: GithubRepository[] }
type RepositoryJob = { id: string; requestId?: string; repositoryId: string; action: 'clone' | 'pull'; state: 'running' | 'succeeded' | 'failed'; message?: string }
type LocalRepository = GithubRepository & {
    cloneUrl: string
    path: string
    local: { state: 'missing' | 'ready' | 'blocked' | 'unknown'; branch: string | null; dirty: boolean | null; message?: string }
    job?: RepositoryJob
}
type RepositoryWorkspace = {
    connected: boolean
    rootPath: string | null
    canSync: boolean
    canPush: boolean
    runner: { status: 'ready' | 'offline' | 'upgrade_required' | 'ambiguous' }
    repositories: LocalRepository[]
}

type PendingRepositoryRequest = { repositoryId: string; action: 'clone' | 'pull'; requestId: string }
function readPendingRepositoryRequest(key: string): PendingRepositoryRequest | null {
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem(key) || 'null')
        if (!value || typeof value !== 'object') return null
        const item = value as Partial<PendingRepositoryRequest>
        return typeof item.repositoryId === 'string' && /^[0-9]{1,32}$/.test(item.repositoryId)
            && (item.action === 'clone' || item.action === 'pull')
            && typeof item.requestId === 'string' && /^[0-9a-f-]{36}$/.test(item.requestId)
            ? item as PendingRepositoryRequest : null
    } catch { return null }
}

function useRepositoryWorkspace(enabled: boolean) {
    const { api, me, project } = useEvolved()
    const client = useQueryClient()
    const path = projectPath(project!.id)
    const scope = [api.baseUrl, me.user.id, project!.id]
    const queryKey = ['evolved', 'repositories', ...scope]
    // No credentials or paths: retain only an unresolved idempotency key, scoped
    // to this browser tab, Hub, human and project, including across a remount.
    const pendingKey = `evolved:repository-request:${JSON.stringify(scope)}`
    const [unresolved, setUnresolved] = useState(() => readPendingRepositoryRequest(pendingKey))
    const remember = (value: PendingRepositoryRequest | null) => {
        if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value))
        else { try { sessionStorage.removeItem(pendingKey) } catch { /* A retained key only repeats the acknowledged request. */ } }
        setUnresolved(value)
    }
    const status = useQuery({ queryKey, enabled, retry: false, gcTime: 0,
        queryFn: ({ signal }) => api.request<RepositoryWorkspace>(`${path}/repositories`, { signal }) })
    const [submitted, setSubmitted] = useState<RepositoryJob[]>([])
    const [posting, setPosting] = useState<string | null>(null)
    const [postingAction, setPostingAction] = useState<'clone' | 'pull'>('clone')
    const [error, setError] = useState<unknown>(null)
    const [notices, setNotices] = useState<Record<string, string>>({})
    const pending = useRef<AbortController | null>(null)
    const completed = useRef(new Set<string>())
    useEffect(() => () => pending.current?.abort(), [])
    useEffect(() => {
        if (!enabled) { pending.current?.abort(); setSubmitted([]); setPosting(null); setNotices({}); setError(null) }
    }, [enabled])
    const current = enabled && !status.error ? status.data : undefined
    useEffect(() => {
        if (unresolved && current?.repositories.some(repository => repository.job?.requestId === unresolved.requestId
            && repository.id === unresolved.repositoryId && repository.job.action === unresolved.action)) {
            remember(null)
        }
    }, [current, unresolved])
    const jobs = new Map<string, RepositoryJob>()
    for (const repository of current?.repositories ?? []) {
        if (repository.job?.state === 'running') jobs.set(repository.job.id, repository.job)
    }
    for (const job of submitted) jobs.set(job.id, job)
    const tracked = [...jobs.values()]
    const queries = useQueries({ queries: tracked.map(job => ({
        queryKey: ['evolved', 'repository-job', ...scope, job.id],
        enabled: enabled && !status.error,
        retry: false, gcTime: 0,
        queryFn: ({ signal }: { signal: AbortSignal }) => api.request<{ job: RepositoryJob }>(`${path}/repository-jobs/${encodeURIComponent(job.id)}`, { signal }),
        refetchInterval: (query: { state: { data?: { job: RepositoryJob }; error: unknown } }) => query.state.error ? false : query.state.data?.job.state === 'running' ? 1000 : false,
    })) })
    const latest = tracked.map((job, index) => queries[index]?.data?.job ?? job)
    useEffect(() => {
        const finished = latest.filter(job => job.state !== 'running' && !completed.current.has(job.id))
        if (!finished.length) return
        for (const job of finished) completed.current.add(job.id)
        setSubmitted(previous => previous.filter(job => !completed.current.has(job.id)))
        setNotices(previous => ({ ...previous, ...Object.fromEntries(finished.map(job => [job.repositoryId,
            job.state === 'succeeded' ? job.action === 'clone' ? 'Repository geklont.' : 'Repository aktualisiert.' : '',
        ])) }))
        const failed = finished.find(job => job.state === 'failed')
        if (failed) setError(new Error(failed.message || 'Der Git-Vorgang ist fehlgeschlagen. Prüfe den Repository-Status.'))
        void client.invalidateQueries({ queryKey, exact: true })
    })
    const refresh = async () => {
        setError(null)
        const [result] = await Promise.all([status.refetch(), ...queries.map(query => query.refetch())])
        if (!result.error && result.data) {
            const stillRunning = new Set(result.data.repositories.flatMap(repository => repository.job?.state === 'running' ? [repository.job.id] : []))
            setSubmitted(previous => previous.filter(job => stillRunning.has(job.id)))
        }
    }
    const sync = async (repositoryId: string, action: 'clone' | 'pull') => {
        const repository = current?.repositories.find(item => item.id === repositoryId)
        const retry = unresolved?.repositoryId === repositoryId && unresolved.action === action
        if (pending.current || latest.some(job => job.state === 'running') || status.isFetching || !current?.canSync
            || current.runner?.status !== 'ready' || !canWriteProject(project!.role) || project!.profile === 'restricted'
            || unresolved && !retry
            || !retry && (repository?.local?.state !== (action === 'clone' ? 'missing' : 'ready') || action === 'pull' && repository.local.dirty === true)) return
        const controller = new AbortController()
        pending.current = controller
        setPosting(repositoryId); setPostingAction(action); setError(null); setNotices(previous => ({ ...previous, [repositoryId]: '' }))
        try {
            const request = retry ? unresolved! : { repositoryId, action, requestId: crypto.randomUUID() }
            // If the browser cannot retain the key, do not start an operation
            // whose acknowledgement could be lost.
            remember(request)
            const result = await api.request<{ job: RepositoryJob }>(`${path}/repositories/${encodeURIComponent(repositoryId)}/sync`, {
                method: 'POST', body: { action, requestId: request.requestId }, signal: controller.signal,
            }, false)
            controller.signal.throwIfAborted()
            remember(null)
            setSubmitted(previous => [...previous, result.job])
        } catch (failure) {
            if (!controller.signal.aborted) {
                setError(failure)
                // A lost response may still have started a job. Read its state;
                // never replay the mutation automatically.
                await client.invalidateQueries({ queryKey, exact: true })
            }
        } finally {
            if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setPosting(null) }
        }
    }
    const uncertain = new Set(tracked.filter((_, index) => queries[index]?.error).map(job => job.id))
    const denied = queries.some(query => query.error instanceof EvolvedApiError && [401, 403].includes(query.error.status))
    return { status, current: denied ? undefined : current, unresolved, posting, postingAction, latest, notices, uncertain, error: error || queries.find(query => query.error)?.error,
        busy: !!posting || latest.some(job => job.state === 'running'), refresh, sync }
}

export function GithubPanel(props: { initialRepositoryId?: string; onRepositorySelect?: (id: string | undefined) => void } = {}) {
    const { api, me, project } = useEvolved()
    if (!project) return <Panel title="GitHub"><Empty>Wähle zuerst ein Projekt.</Empty></Panel>
    return <GithubForProject key={`${api.baseUrl}:${me.user.id}:${project.id}:${project.role}:${project.profile}`} {...props} />
}

function GithubForProject({ initialRepositoryId, onRepositorySelect }: { initialRepositoryId?: string; onRepositorySelect?: (id: string | undefined) => void }) {
    const { api, me, project, refresh } = useEvolved()
    const workflow = useProjectWorkflow()
    const queryClient = useQueryClient()
    const path = `${projectPath(project!.id)}/github`
    const queryKey = ['evolved', 'github', api.baseUrl, me.user.id, project!.id]
    const status = useQuery({ queryKey, retry: false, gcTime: 0, queryFn: ({ signal }) => api.request<GithubStatus>(path, { signal }) })
    const workspace = useRepositoryWorkspace(!!status.data?.connected && !status.error)
    const admin = isProjectAdmin(project?.role)
    const canPush = project?.profile === 'workspace' || project?.profile === 'extended'
    const [token, setToken] = useState('')
    const [replaceConfirmed, setReplaceConfirmed] = useState(false)
    const [repository, setRepository] = useState('')
    const [openedRepository, setOpenedRepository] = useState(initialRepositoryId)
    useEffect(() => setOpenedRepository(initialRepositoryId), [initialRepositoryId])
    const openRepository = (id: string | undefined) => { setOpenedRepository(id); onRepositorySelect?.(id) }
    const [permission, setPermission] = useState<'read' | 'write'>('read')
    const [profileNeedsRefresh, setProfileNeedsRefresh] = useState(false)
    const action = useAction()
    const pending = useRef<AbortController | null>(null)
    const changing = useRef(false)
    useEffect(() => () => pending.current?.abort(), [])
    useEffect(() => {
        if (status.error instanceof EvolvedApiError && [401, 403].includes(status.error.status)) {
            setToken(''); setReplaceConfirmed(false); setRepository('')
        }
    }, [status.error])
    // Keep credentials in the submit closure only, never in a mutation/query cache.
    const mutate = async (method: 'POST' | 'PUT' | 'DELETE', suffix = '', body?: unknown) => {
        const controller = new AbortController()
        pending.current = controller
        try {
            const result = await api.request<GithubStatus>(`${path}${suffix}`, { method, ...(body === undefined ? {} : { body }), signal: controller.signal })
            await queryClient.cancelQueries({ queryKey, exact: true })
            controller.signal.throwIfAborted()
            queryClient.setQueryData(queryKey, result)
            await queryClient.invalidateQueries({ queryKey: ['evolved', 'repositories', api.baseUrl, me.user.id, project!.id], exact: true })
        } catch (error) {
            // Network failures and conflicts may occur after the grant was saved.
            // Reconcile with the server before presenting the previous metadata again.
            if (!controller.signal.aborted) {
                await queryClient.invalidateQueries({ queryKey, exact: true })
            }
            throw error
        } finally { if (pending.current === controller) pending.current = null }
    }
    const run = (operation: () => Promise<void>, success: string) => {
        if (changing.current) return
        changing.current = true
        void action.run(operation, success).finally(() => { changing.current = false })
    }
    const activateWorkspace = async () => {
        const controller = new AbortController()
        pending.current = controller
        // A lost response may still have changed the profile. Recheck before allowing
        // another profile mutation, which would otherwise revoke newly issued leases.
        setProfileNeedsRefresh(true)
        try {
            await api.request(`${projectPath(project!.id)}/profile`, { method: 'PUT', body: { profile: 'workspace' }, signal: controller.signal })
            controller.signal.throwIfAborted()
            await refresh()
        } finally { if (pending.current === controller) pending.current = null }
    }
    // A failed or pending permission check must not expose a stale connection as usable.
    const connection = !status.error && !status.isFetching ? status.data : undefined
    const busy = action.busy || status.isFetching
    const connect = () => {
        if (busy || changing.current || !token.trim() || !connection || (connection.connected && !replaceConfirmed)) return
        const submittedToken = token.trim()
        setToken('')
        setReplaceConfirmed(false)
        run(() => mutate('POST', '', { token: submittedToken }), 'GitHub-Verbindung gespeichert. Gib jetzt die gewünschten Repositorys für dieses Projekt frei.')
    }
    if (openedRepository) {
        const chosen = connection?.repositories.find(item => item.id === openedRepository)
        return chosen ? <RepositoryWorktreePanel repositoryId={chosen.id} name={chosen.fullName} onClose={() => openRepository(undefined)} />
            : <Panel title="Repository-Arbeitsstand"><ErrorNotice error={status.error} />{status.isPending ? <Loading /> : <p>Dieses Repository ist für das aktuelle Projekt nicht verfügbar.</p>}<button onClick={() => openRepository(undefined)}>Zurück zu den Repositorys</button></Panel>
    }
    return <div className="ev-stack">
        <Panel title="GitHub für dieses Projekt" description="Verbinde ein GitHub-Konto und gib einzelne Repositorys frei. Die Agenten dieses Projekts verwenden Git über ihren Runner.">
            <ErrorNotice error={status.error} />
            {status.isFetching && <Loading />}
            {status.error && <button disabled={busy} onClick={() => void status.refetch()}>Erneut versuchen</button>}
            {connection && <>
                <p>{connection.connected ? <>Verbindung eingerichtet für <strong>{connection.account?.login}</strong>.</> : 'Noch kein GitHub-Konto verbunden.'}</p>
                {connection.connected && <p className="ev-muted">Dies ist die gespeicherte Verbindung. GitHub prüft Token, Ablauf und Repository-Rechte bei der Nutzung erneut.</p>}
                {!admin && <p className="ev-muted">Projektadministratoren verwalten die Verbindung und Repository-Freigaben.</p>}
                {admin && connection.connected && <ConfirmButton label="GitHub-Verbindung trennen" detail="Token aus diesem Projekt entfernen und alle Repository-Freigaben widerrufen? Ein bei GitHub erstelltes Token wird dadurch nicht bei GitHub gelöscht." disabled={busy} onConfirm={() => run(async () => { setToken(''); setReplaceConfirmed(false); await mutate('DELETE') }, 'GitHub-Verbindung getrennt und Repository-Freigaben widerrufen.')} />}
            </>}
        </Panel>
        {connection?.connected && <Panel title="Freigegebene Repositorys" description="Nur diese Repositorys stehen den Projekt-Agenten über die GitHub-Verbindung zur Verfügung.">
            {!!connection.repositories.length && <>
                <div className="ev-repository-toolbar"><p>Hole den Code direkt in deinen Projektordner. „Aktualisieren“ übernimmt nur passende Folge-Commits (Fast-forward); lokale Arbeit wird nicht überschrieben.</p><button disabled={workspace.status.isFetching || !!workspace.posting} onClick={() => void workspace.refresh()}>Repository-Status prüfen</button></div>
                <ErrorNotice error={workspace.status.error || workspace.error} />
                {workspace.status.error && <p className="ev-muted">Der lokale Status ist unbekannt. Eine fehlgeschlagene Prüfung bedeutet nicht, dass das Repository fehlt.</p>}
                {!canWriteProject(project!.role) ? <p className="ev-muted">Als Betrachter kannst du Repositorys ansehen. Zum Klonen oder Aktualisieren brauchst du die Rolle Mitglied oder Administrator.</p>
                    : !canPush ? <p className="ev-muted">Das Profil „Eingeschränkt“ erlaubt keine Änderungen im Projektordner. Zum Klonen oder Aktualisieren ist „Arbeitsbereich“ oder „Erweitert“ erforderlich.</p>
                        : workspace.current?.runner?.status !== 'ready' && workspace.current && <p className="ev-muted">{workspace.current.runner?.status === 'upgrade_required'
                            ? 'Der Projektdienst muss aktualisiert werden, bevor er Repositorys verwalten kann.'
                            : workspace.current.runner?.status === 'ambiguous' ? 'Mehrere Projektdienste kommen infrage. Der Betreiber muss die Zuordnung klären.'
                                : 'Der Projektdienst ist nicht erreichbar. Starte oder verbinde ihn und prüfe den Status erneut.'}</p>}
            </>}
            {!connection.repositories.length ? <Empty>Noch kein Repository freigegeben.</Empty> : <div className="ev-list">{connection.repositories.map(repo => {
                const local = workspace.current?.repositories.find(item => item.id === repo.id)
                const job = workspace.latest.find(item => item.repositoryId === repo.id) ?? local?.job
                const running = workspace.posting === repo.id || job?.state === 'running'
                const unresolved = workspace.unresolved?.repositoryId === repo.id ? workspace.unresolved : null
                const allowed = canWriteProject(project!.role) && canPush && workspace.current?.canSync && workspace.current.runner?.status === 'ready'
                return <div className="ev-row ev-repository-row" key={repo.id}>
                <div className="ev-repository-info"><strong>{repo.fullName}</strong><small>{repo.permission === 'write' ? 'Lesen und Push freigegeben' : 'Nur lesen'}</small>{repo.permission === 'write' && !canPush && <small>Push durch Projektprofil gesperrt</small>}
                    {workspace.status.isFetching ? <small role="status">Lokaler Status wird geprüft …</small> : <>
                        <p className="ev-repository-location">{local?.path && <code>{local.path}</code>}</p>
                        <small>{local?.local?.state === 'ready' ? <>Im Projektordner · Branch: {local.local.branch || 'Kein Branch ausgecheckt'}{local.local.dirty ? ' · Lokale Änderungen vorhanden' : ''}</>
                            : local?.local?.state === 'missing' ? 'Noch nicht im Projektordner'
                                : local?.local?.state === 'blocked' ? 'Dieser Ordner kann nicht automatisch verwendet werden.' : 'Lokaler Status unbekannt'}</small>
                        {local?.local?.message && <small>{local.local.message}</small>}
                    </>}
                    {running && <p role="status" className="ev-repository-progress">{job && workspace.uncertain.has(job.id) ? 'Der aktuelle Stand des Git-Vorgangs ist unbekannt. Prüfe den Repository-Status.'
                        : (job?.action ?? workspace.postingAction) === 'pull' ? 'Repository wird aktualisiert …' : 'Repository wird geklont …'}</p>}
                    {job?.state === 'failed' && job.message && <small>{job.message}</small>}
                    {!running && workspace.notices[repo.id] && <p role="status" className="ev-repository-progress">{workspace.notices[repo.id]}</p>}
                </div>
                <button onClick={() => openRepository(repo.id)} aria-label={`Änderungen ansehen: ${repo.fullName}`}>Änderungen ansehen</button>
                {canWriteProject(project!.role) && local?.local?.state === 'ready' && !running && workspace.current?.runner.status === 'ready' && <>
                    <Link to="/sessions/new" search={{ projectId: project!.id, repositoryId: repo.id }}>Sitzung in diesem Repo starten</Link>
                    {workflow && <WorkspaceLink tab="agents" projectId={project!.id} onClick={() => { workflow.setReview(null); workflow.setRepositoryId(repo.id) }}>Spezialist für dieses Repo</WorkspaceLink>}
                </>}
                {unresolved && !running && <><p className="ev-repository-hint">Die Annahme des letzten Auftrags ist unklar. Prüfe den Status oder ordne denselben Auftrag erneut zu; es wird keine neue Auftragsnummer erzeugt.</p>
                    <button className="ev-primary" disabled={busy || workspace.busy || workspace.status.isFetching || !allowed}
                        aria-label={`Auftrag erneut zuordnen: ${repo.fullName}`} onClick={() => void workspace.sync(repo.id, unresolved.action)}>Auftrag erneut zuordnen</button></>}
                {(!unresolved || running) && local?.local && ['missing', 'ready'].includes(local.local.state) && <button className="ev-primary" disabled={busy || workspace.busy || !!workspace.unresolved || workspace.status.isFetching || !allowed || (local.local.state === 'ready' && local.local.dirty === true)}
                    aria-label={`${local.local.state === 'missing' ? 'Ins Projekt klonen' : 'Aktualisieren'}: ${repo.fullName}`}
                    onClick={() => void workspace.sync(repo.id, local.local.state === 'missing' ? 'clone' : 'pull')}>
                    {local.local.state === 'missing' ? 'Ins Projekt klonen' : 'Aktualisieren'}
                </button>}
                {local?.local?.dirty && <p className="ev-repository-hint">Sichere oder committe lokale Änderungen im Repository, bevor du es aktualisierst. Hier werden keine Änderungen verworfen.</p>}
                {admin && <div className="ev-actions">
                    <select aria-label={`Git-Berechtigung für ${repo.fullName}`} value={repo.permission} disabled={busy} onChange={event => {
                        const nextPermission = event.target.value as 'read' | 'write'
                        run(() => mutate('PUT', '/repositories', { repository: repo.fullName, permission: nextPermission }), 'Repository-Freigabe aktualisiert.')
                    }}><option value="read">Nur lesen</option><option value="write">Lesen und Push</option></select>
                    <ConfirmButton label="Repository-Freigabe widerrufen" detail={`${repo.fullName} für dieses Projekt sperren? Bereits geklonte lokale Dateien bleiben erhalten.`} disabled={busy} onConfirm={() => run(() => mutate('DELETE', `/repositories/${encodeURIComponent(repo.id)}`), 'Repository-Freigabe widerrufen.')} />
                </div>}
            </div>})}</div>}
            {admin && <form className="ev-inline-form" onSubmit={submit(() => {
                if (busy || !repository.trim()) return
                run(async () => { await mutate('PUT', '/repositories', { repository: repository.trim(), permission }); setRepository(''); setPermission('read') }, 'Repository für dieses Projekt freigegeben.')
            })}>
                <Field label="GitHub-Repository" hint="Exakter Name als Eigentümer/Repository. Das Repository muss im Token freigegeben sein."><input value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/repository" maxLength={240} required disabled={busy} /></Field>
                <Field label="Git-Berechtigung" hint="Die Repository-Freigabe lässt sich in jedem Profil speichern. Sie ändert weder das Projektprofil noch bestehende Runner-Zugänge."><select aria-label="Git-Berechtigung" value={permission} onChange={event => setPermission(event.target.value as 'read' | 'write')} disabled={busy}><option value="read">Nur lesen</option><option value="write">Lesen und Push</option></select></Field>
                <button disabled={busy || !repository.trim()}>Repository freigeben</button>
            </form>}
            <div className="ev-stack">
                <h3>Was für Push erforderlich ist</h3>
                <ol className="ev-github-steps">
                    <li><strong>Repository:</strong> Wähle oben „Lesen und Push“. Das speichert die Freigabe für genau dieses Repository.</li>
                    <li><strong>Projektprofil:</strong> „Arbeitsbereich“ oder „Erweitert“ erlaubt Schreibarbeit. „Eingeschränkt“ blockiert Push auch bei gespeicherter Schreibfreigabe.</li>
                    <li><strong>Runner:</strong> Der verwendete Zugang braucht „Agenten verbinden“ und „In GitHub-Repositorys pushen“. Neue Zugänge erhalten diese Rechte im passenden Profil standardmäßig; bestehende Zugänge werden nicht automatisch erweitert. Der Runner muss mit diesem Profil und einem beschreibbaren Projektordner eingerichtet sein.</li>
                    <li><strong>GitHub:</strong> Das Token braucht für dieses Repository „Contents: Read and write“. GitHub prüft diese Rechte und seine Branchregeln bei jedem Push. Die gespeicherte Freigabe bestätigt keine GitHub-Schreibrechte.</li>
                </ol>
                <p className="ev-muted">{canPush
                    ? `Projektprofil: „${project!.profile === 'workspace' ? 'Arbeitsbereich' : 'Erweitert'}“. Das Profil erlaubt Schreibarbeit. Der Runner-Zugang und die Rechte bei GitHub müssen zusätzlich passen.`
                    : 'Aktuell: „Eingeschränkt“. Schreibfreigaben werden gespeichert, Push bleibt bis zur ausdrücklichen Änderung des Projektprofils gesperrt.'}</p>
                {admin && <div className="ev-actions">
                    {!canPush && (profileNeedsRefresh
                        ? <button disabled={busy} onClick={() => run(async () => { await refresh(); setProfileNeedsRefresh(false) }, 'Projektstatus aktualisiert.')}>Projektstatus aktualisieren</button>
                        : <ConfirmButton label="Arbeitsbereich für Push aktivieren" detail="Das gesamte Projekt auf „Arbeitsbereich“ umstellen? Dadurch werden auch lokale Schreib- und Ausführungsrechte im Projekt erweitert. Alle bisherigen Runner-Zugänge dieses Projekts werden ungültig; du musst neue Zugänge ausstellen und die Runner mit dem neuen Profil und beschreibbarem Projektordner einrichten. Repository- und GitHub-Rechte bleiben zusätzlich erforderlich." disabled={busy} onConfirm={() => run(activateWorkspace, 'Projektprofil aktualisiert. Richte jetzt einen neuen Runner-Zugang ein.')} />)}
                    <WorkspaceLink tab="runner" projectId={project!.id}>Runner für Push einrichten</WorkspaceLink>
                </div>}
                {profileNeedsRefresh && <p className="ev-muted">Prüfe den aktuellen Projektstatus, bevor du die Profiländerung erneut versuchst. Der letzte Versuch kann bereits wirksam sein.</p>}
            </div>
        </Panel>}
        {admin && connection && <Panel title={connection.connected ? 'Verbindung ersetzen' : 'GitHub verbinden'} description="Verwende ein Fine-grained Personal Access Token. Änderungen verlangen eine aktuelle Passkey-Bestätigung.">
            <ol className="ev-github-steps">
                <li>Erstelle bei GitHub ein <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Fine-grained Token ↗</a> mit Ablaufdatum und nur den benötigten Repositorys.</li>
                <li>Erlaube „Contents: Read-only“ für Clone/Fetch oder „Contents: Read and write“ für Push. „Metadata: Read-only“ bleibt erforderlich. Organisationen müssen das Token gegebenenfalls freigeben.</li>
                <li>Optional „Commit statuses: Read-only“, wenn HAPI Build-Statusmeldungen (z. B. von Odoo.sh) lesen soll. Dass Odoo.sh solche Meldungen sendet, richtest du in Odoo.sh mit einem eigenen Token ein.</li>
                <li>Trage das Token hier ein und gib anschließend jedes Repository für dieses Projekt frei.</li>
            </ol>
            <p className="ev-muted">Das Token wird verschlüsselt gespeichert und nicht an Projekt-Agenten ausgegeben. Es lässt sich hier nicht wieder anzeigen.</p>
            <form className="ev-stack" onSubmit={submit(connect)}>
                <Field label="Fine-grained Personal Access Token"><input type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} maxLength={1024} required disabled={busy} placeholder="github_pat_…" /></Field>
                {connection.connected && <label className="ev-check"><input type="checkbox" checked={replaceConfirmed} onChange={event => setReplaceConfirmed(event.target.checked)} disabled={busy} />Ich ersetze die Verbindung und entferne bisherige Repository-Freigaben.</label>}
                <button className="ev-primary" disabled={busy || !token.trim() || (connection.connected && !replaceConfirmed)}>{connection.connected ? 'Verbindung ersetzen' : 'GitHub verbinden'}</button>
            </form>
        </Panel>}
        <ActionStatus action={action} />
    </div>
}
