import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { EvolvedApiError, isProjectAdmin, projectPath } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, submit, useAction } from './ui'

type GithubRepository = { id: string; owner: string; name: string; fullName: string; permission: 'read' | 'write' }
type GithubStatus = { connected: boolean; account?: { id: number; login: string }; repositories: GithubRepository[] }

export function GithubPanel() {
    const { api, me, project } = useEvolved()
    if (!project) return <Panel title="GitHub"><Empty>Wähle zuerst ein Projekt.</Empty></Panel>
    return <GithubForProject key={`${api.baseUrl}:${me.user.id}:${project.id}:${project.role}:${project.profile}`} />
}

function GithubForProject() {
    const { api, me, project } = useEvolved()
    const queryClient = useQueryClient()
    const path = `${projectPath(project!.id)}/github`
    const queryKey = ['evolved', 'github', api.baseUrl, me.user.id, project!.id]
    const status = useQuery({ queryKey, retry: false, gcTime: 0, queryFn: ({ signal }) => api.request<GithubStatus>(path, { signal }) })
    const admin = isProjectAdmin(project?.role)
    const canPush = project?.profile === 'workspace' || project?.profile === 'extended'
    const [token, setToken] = useState('')
    const [replaceConfirmed, setReplaceConfirmed] = useState(false)
    const [repository, setRepository] = useState('')
    const [permission, setPermission] = useState<'read' | 'write'>('read')
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
        } catch (error) {
            if (!controller.signal.aborted && error instanceof EvolvedApiError && [401, 403].includes(error.status)) {
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
        {admin && connection && <Panel title={connection.connected ? 'Verbindung ersetzen' : 'GitHub verbinden'} description="Verwende ein Fine-grained Personal Access Token. Änderungen verlangen eine aktuelle Passkey-Bestätigung.">
            <ol className="ev-github-steps">
                <li>Erstelle bei GitHub ein <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Fine-grained Token ↗</a> mit Ablaufdatum und nur den benötigten Repositorys.</li>
                <li>Erlaube „Contents: Read-only“ für Clone/Fetch oder „Contents: Read and write“ für Push. „Metadata: Read-only“ bleibt erforderlich. Organisationen müssen das Token gegebenenfalls freigeben.</li>
                <li>Trage das Token hier ein und gib anschließend jedes Repository für dieses Projekt frei.</li>
            </ol>
            <p className="ev-muted">Das Token wird verschlüsselt gespeichert und nicht an Projekt-Agenten ausgegeben. Es lässt sich hier nicht wieder anzeigen.</p>
            <form className="ev-stack" onSubmit={submit(connect)}>
                <Field label="Fine-grained Personal Access Token"><input type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} maxLength={1024} required disabled={busy} placeholder="github_pat_…" /></Field>
                {connection.connected && <label className="ev-check"><input type="checkbox" checked={replaceConfirmed} onChange={event => setReplaceConfirmed(event.target.checked)} disabled={busy} />Ich ersetze die Verbindung und entferne bisherige Repository-Freigaben.</label>}
                <button className="ev-primary" disabled={busy || !token.trim() || (connection.connected && !replaceConfirmed)}>{connection.connected ? 'Verbindung ersetzen' : 'GitHub verbinden'}</button>
            </form>
        </Panel>}
        {connection?.connected && <Panel title="Freigegebene Repositorys" description="Nur diese Repositorys stehen den Projekt-Agenten über die GitHub-Verbindung zur Verfügung.">
            {!connection.repositories.length ? <Empty>Noch kein Repository freigegeben.</Empty> : <div className="ev-list">{connection.repositories.map(repo => <div className="ev-row" key={repo.id}>
                <div><strong>{repo.fullName}</strong><small>{repo.permission === 'write' ? 'Lesen und Push freigegeben' : 'Nur lesen'}</small><code>git clone https://github.com/{repo.owner}/{repo.name}.git</code>{repo.permission === 'write' && !canPush && <small>Push ist im aktuellen eingeschränkten Profil gesperrt.</small>}</div>
                {admin && <div className="ev-actions">
                    <select aria-label={`Git-Berechtigung für ${repo.fullName}`} value={repo.permission} disabled={busy} onChange={event => {
                        const nextPermission = event.target.value as 'read' | 'write'
                        if (nextPermission === 'write' && !canPush) return
                        run(() => mutate('PUT', '/repositories', { repository: repo.fullName, permission: nextPermission }), 'Repository-Freigabe aktualisiert.')
                    }}><option value="read">Nur lesen</option><option value="write" disabled={!canPush}>Lesen und Push</option></select>
                    <ConfirmButton label="Repository-Freigabe widerrufen" detail={`${repo.fullName} für dieses Projekt sperren? Bereits geklonte lokale Dateien bleiben erhalten.`} disabled={busy} onConfirm={() => run(() => mutate('DELETE', `/repositories/${encodeURIComponent(repo.id)}`), 'Repository-Freigabe widerrufen.')} />
                </div>}
            </div>)}</div>}
            {!canPush && <p className="ev-muted">Das Profil „Eingeschränkt“ erlaubt nur lesenden Git-Zugriff. Push verlangt ein freigegebenes Repository, ein passendes Projektprofil und einen Runner-Zugang mit Schreibrecht.</p>}
            {admin && <form className="ev-inline-form" onSubmit={submit(() => {
                if (busy || !repository.trim() || (permission === 'write' && !canPush)) return
                run(async () => { await mutate('PUT', '/repositories', { repository: repository.trim(), permission }); setRepository(''); setPermission('read') }, 'Repository für dieses Projekt freigegeben.')
            })}>
                <Field label="GitHub-Repository" hint="Exakter Name als Eigentümer/Repository. Das Repository muss im Token freigegeben sein."><input value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/repository" maxLength={240} required disabled={busy} /></Field>
                <Field label="Git-Berechtigung"><select value={permission} onChange={event => setPermission(event.target.value as 'read' | 'write')} disabled={busy}><option value="read">Nur lesen</option><option value="write" disabled={!canPush}>Lesen und Push</option></select></Field>
                <button disabled={busy || !repository.trim() || (permission === 'write' && !canPush)}>Repository freigeben</button>
            </form>}
            <p className="ev-muted">Neue Runner-Zugänge erhalten standardmäßig Git-Leserechte und, wenn das Profil es erlaubt, Schreibrechte. Bestehende Zugänge ohne diese Rechte müssen neu ausgestellt werden. GitHub-Branchregeln gelten weiterhin.</p>
        </Panel>}
        <ActionStatus action={action} />
    </div>
}
