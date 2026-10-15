import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { getSessionTitle } from '@/lib/sessionTitle'
import type { SessionSummary } from '@/types/api'
import { useEvolved } from './auth'
import { canWriteProject, isProjectAdmin } from './api'
import { ErrorNotice, Loading, formatDate } from './ui'
import { CapacityPanel } from './Capacity'
import { WorkspaceIcon, WorkspaceLink } from './workspaceNavigation'

export function summarizeSessions(sessions: SessionSummary[]) {
    return {
        active: sessions.filter(session => session.active).length,
        pending: sessions.reduce((sum, session) => sum + session.pendingRequestsCount, 0),
        attention: sessions.filter(session => session.pendingRequestsCount > 0).sort((a, b) => b.pendingRequestsCount - a.pendingRequestsCount),
        recent: [...sessions].sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt)).slice(0, 5),
    }
}
function SessionRow({ session }: { session: SessionSummary }) {
    return <Link className="ew-session-row" to="/sessions/$sessionId" params={{ sessionId: session.id }}>
        <span className={`ew-activity-dot ${session.active ? 'is-active' : ''}`} aria-hidden="true" />
        <span className="ew-session-detail"><strong>{getSessionTitle(session)}</strong><span>{session.metadata?.flavor ?? 'Agent'}{session.model ? ` · ${session.model}` : ''}</span></span>
        <span className={`ew-status ${session.pendingRequestsCount ? 'ew-status-warning' : ''}`}>{session.pendingRequestsCount ? `${session.pendingRequestsCount} offen` : session.thinking ? 'Arbeitet' : session.active ? 'Bereit' : 'Inaktiv'}</span>
        <WorkspaceIcon name="arrow" />
    </Link>
}

export function Dashboard() {
    const { project, me } = useEvolved()
    if (!project || !me.accessibleProjects.some(item => item.id === project.id)) return <div className="ev-stack"><section className="ev-panel ew-onboarding"><span className="ew-eyebrow">Dein erster Arbeitsplatz</span><h2>Alles beginnt mit einem Projekt.</h2><p>Ein eigener Ordner, klare Zugriffsrechte und ein gemeinsames Gedächtnis geben deinen Agenten den richtigen Rahmen.</p><ol className="ew-setup-steps"><li><strong>Team anlegen</strong><span>Bestimme, mit wem du zusammenarbeitest.</span></li><li><strong>Projekt erstellen</strong><span>Dein eigener Projektordner entsteht automatisch.</span></li><li><strong>Runner verbinden</strong><span>Starte deine erste Agentensitzung im Projekt.</span></li></ol><div className="ev-actions"><WorkspaceLink tab="team" className="ew-button ew-button-primary">Team & Konto öffnen</WorkspaceLink><WorkspaceLink tab="projects" className="ew-button">Projekt anlegen</WorkspaceLink></div></section></div>
    return <ProjectDashboard key={`${me.user.id}:${project.id}:${project.role}:${project.profile}`} />
}

function ProjectDashboard() {
    const { api: evolvedApi, me, project } = useEvolved()
    const { api } = useAppContext()
    const sessions = useQuery({
        queryKey: ['evolved', 'dashboard-sessions', evolvedApi.baseUrl, me.user.id, project!.id, project!.role, project!.profile],
        retry: false, gcTime: 0, refetchInterval: 30_000,
        queryFn: async ({ signal }) => { signal.throwIfAborted(); const result = await api.getSessions(); signal.throwIfAborted(); return result },
    })
    const machines = useQuery({
        queryKey: ['evolved', 'dashboard-machines', evolvedApi.baseUrl, me.user.id, project!.id, project!.role, project!.profile],
        retry: false, gcTime: 0, refetchInterval: 30_000,
        queryFn: async ({ signal }) => { signal.throwIfAborted(); const result = await api.getMachines(); signal.throwIfAborted(); return result },
    })
    // An error (including revoked access) must not leave an earlier successful response visible.
    const summary = !sessions.error && sessions.data ? summarizeSessions(sessions.data.sessions) : null
    const runners = !machines.error && machines.data ? machines.data.machines.filter(machine => machine.active) : null
    const writable = canWriteProject(project!.role)
    const admin = isProjectAdmin(project!.role)
    return <div className="ev-stack ew-dashboard">
        <section className="ew-project-intro" aria-label="Schnellaktionen"><p>Starte eine Sitzung oder setze deine Arbeit fort.</p><div className="ev-actions">{writable && <Link to="/sessions/new" className="ew-button ew-button-primary"><WorkspaceIcon name="sessions" />Neue Sitzung</Link>}<Link to="/sessions" className="ew-button">Alle Sessions<WorkspaceIcon name="arrow" /></Link></div></section>
        <dl className="ew-metrics" aria-label="Projektstatus"><div><dt>Aktive Sitzungen</dt><dd>{summary?.active ?? '—'}</dd><span>{sessions.isPending ? 'Wird geladen' : sessions.error ? 'Nicht verfügbar' : 'Mit dem Hub verbunden'}</span></div><div><dt>Offene Freigaben & Antworten</dt><dd>{summary?.pending ?? '—'}</dd><span>{sessions.isPending ? 'Wird geladen' : sessions.error ? 'Nicht verfügbar' : summary?.pending ? 'Deine Aufmerksamkeit ist gefragt' : 'Keine offenen Anfragen'}</span></div><div><dt>Runner online</dt><dd>{runners?.length ?? '—'}</dd><span>{machines.isPending ? 'Wird geladen' : machines.error ? 'Nicht verfügbar' : 'In diesem Projekt verbunden'}</span></div></dl>
        <CapacityPanel compact />
        <section className="ev-panel"><div className="ew-section-heading"><div><h2>{summary?.attention.length ? 'Benötigt Aufmerksamkeit' : 'Letzte Sitzungen'}</h2><p>{summary?.attention.length ? 'Öffne eine Sitzung, um die Anfrage im Kontext zu prüfen.' : 'Steige dort wieder ein, wo du zuletzt gearbeitet hast.'}</p></div><Link to="/sessions" className="ew-text-link">Alle anzeigen</Link></div>
            <ErrorNotice error={sessions.error} />{sessions.isPending && <Loading />}
            {summary && (summary.attention.length || summary.recent.length ? <div className="ew-session-list">{(summary.attention.length ? summary.attention.slice(0, 5) : summary.recent).map(session => <SessionRow key={session.id} session={session} />)}</div> : <div className="ew-empty-state"><WorkspaceIcon name="sessions" /><h3>Noch keine Sitzung in diesem Projekt</h3><p>{runners?.length ? 'Ein Runner ist bereit. Starte eine Sitzung, um mit deinem Agenten zu arbeiten.' : 'Verbinde zuerst einen Runner mit diesem Projekt. Danach kannst du hier Agentensitzungen starten.'}</p>{admin && !runners?.length && <WorkspaceLink tab="runner" projectId={project!.id} className="ew-button">Runner einrichten</WorkspaceLink>}{!admin && !runners?.length && <p>Dein Projektadministrator kann einen Runner-Zugang anlegen.</p>}</div>)}
            <div className="ew-data-footer"><span className="ew-caption">{summary ? `Stand: ${formatDate(sessions.dataUpdatedAt)}` : 'Sitzungsstatus momentan nicht verfügbar.'}</span><button disabled={sessions.isFetching} onClick={() => void sessions.refetch()}>Sitzungen aktualisieren</button></div>
        </section>
        <section className="ev-panel"><div className="ew-section-heading"><div><h2>Verbundene Runner</h2><p>Nur tatsächlich verbundene Runner werden als online gezählt.</p></div>{admin && <WorkspaceLink tab="runner" projectId={project!.id} className="ew-text-link">Zugänge verwalten</WorkspaceLink>}</div><ErrorNotice error={machines.error} />{machines.isPending && <Loading />}
            {runners && (runners.length ? <ul className="ew-runner-list">{runners.map(machine => <li key={machine.id}><span className="ew-activity-dot is-active" aria-hidden="true" /><div><strong>{machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id.slice(0, 8)}</strong><span>{machine.metadata?.platform ?? 'Plattform nicht gemeldet'}{machine.metadata?.happyCliVersion ? ` · CLI ${machine.metadata.happyCliVersion}` : ''}</span></div><span className="ew-status">Online</span></li>)}</ul> : <p className="ew-empty-inline">Noch kein Runner verbunden. Ein gültiger Zugang allein bedeutet nicht, dass ein Runner läuft.</p>)}
            <div className="ew-data-footer"><span className="ew-caption">{runners ? `Stand: ${formatDate(machines.dataUpdatedAt)}` : 'Runnerstatus momentan nicht verfügbar.'}</span><button disabled={machines.isFetching} onClick={() => void machines.refetch()}>Runner aktualisieren</button></div>
        </section>
        <section className="ew-shortcuts" aria-label="Projektwerkzeuge"><WorkspaceLink tab="providers" projectId={project!.id}><WorkspaceIcon name="providers" /><span><strong>Abos verbinden</strong><small>Codex und Claude anmelden</small></span><WorkspaceIcon name="arrow" /></WorkspaceLink><WorkspaceLink tab="github" projectId={project!.id}><WorkspaceIcon name="github" /><span><strong>Code verbinden</strong><small>GitHub-Repositories und Freigaben</small></span><WorkspaceIcon name="arrow" /></WorkspaceLink><WorkspaceLink tab="memory" projectId={project!.id}><WorkspaceIcon name="memory" /><span><strong>Wissen bewahren</strong><small>Quellen und überprüfte Erkenntnisse</small></span><WorkspaceIcon name="arrow" /></WorkspaceLink></section>
    </div>
}
