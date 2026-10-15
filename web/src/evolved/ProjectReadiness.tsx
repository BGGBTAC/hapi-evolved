import { useQuery } from '@tanstack/react-query'
import type { ProjectReadiness, ReadinessState } from '@hapi/protocol/evolvedWorkspace'
import { useEvolved } from './auth'
import { canWriteProject, isProjectAdmin, projectPath } from './api'
import { ErrorNotice, Loading, Panel, formatDate } from './ui'
import { WorkspaceLink } from './workspaceNavigation'

const labels: Record<ReadinessState, string> = { ok: 'Bereit', missing: 'Fehlt', stale: 'Veraltet', denied: 'Nicht freigegeben', unknown: 'Unbekannt' }
export function ProjectReadinessPanel() {
    const { api, me, project } = useEvolved()
    const status = useQuery({ queryKey: ['evolved', 'readiness', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile],
        retry: false, gcTime: 0, queryFn: ({ signal }) => api.request<ProjectReadiness>(`${projectPath(project!.id)}/readiness`, { signal }) })
    const current = !status.error && status.data?.projectId === project!.id ? status.data : null
    const actionable = current?.items.find(item => item.state !== 'ok' && item.action && canWriteProject(project!.role) && (item.action.kind !== 'providers' || isProjectAdmin(project!.role)))
    return <Panel title="Bereit für den nächsten Schritt?" description="Planung und Codearbeit haben unterschiedliche Voraussetzungen. Diese Prüfung startet keine Dienste oder Agenten.">
        <ErrorNotice error={status.error} />{status.isPending && <Loading />}
        {current && <><p>Planen: <strong>{labels[current.purposes.plan] ?? 'Unbekannt'}</strong> · Code bearbeiten: <strong>{labels[current.purposes.code] ?? 'Unbekannt'}</strong></p>
            {actionable?.action && <WorkspaceLink tab={actionable.action.kind} projectId={project!.id}>{actionable.action.label}</WorkspaceLink>}
            <details><summary>Prüfdetails ({current.items.length})</summary><ul className="ev-list">{current.items.map(item => <li className="ev-row" key={item.key}><div><strong>{item.label}</strong><span className="ev-badge">{labels[item.state] ?? 'Unbekannt'}</span><p className="ev-muted">{item.detail}</p></div>{item.action && canWriteProject(project!.role) && (item.action.kind !== 'providers' || isProjectAdmin(project!.role)) && <WorkspaceLink tab={item.action.kind} projectId={project!.id}>{item.action.label}</WorkspaceLink>}</li>)}</ul></details>
            <p className="ev-muted">Geprüft: {formatDate(current.checkedAt)}. Bereit bedeutet keine zusätzliche Berechtigung und kein Verbrauchsversprechen.</p></>}
        <button disabled={status.isFetching} onClick={() => void status.refetch()}>Bereitschaft prüfen</button>
    </Panel>
}
