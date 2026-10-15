import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useOptionalEvolved, type EvolvedSession } from './auth'
import { projectPath } from './api'

export function SessionRepositoryLink({ sessionId }: { sessionId: string }) {
    const evolved = useOptionalEvolved()
    if (!evolved?.project) return null
    return <ScopedSessionRepositoryLink key={JSON.stringify([evolved.api.baseUrl, evolved.me.user.id, evolved.project.id, evolved.project.role, evolved.project.profile, sessionId])} evolved={evolved} sessionId={sessionId} />
}
function ScopedSessionRepositoryLink({ evolved, sessionId }: { evolved: EvolvedSession; sessionId: string }) {
    const { api, me, project } = evolved
    const status = useQuery({ queryKey: ['evolved', 'session-repository', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile, sessionId],
        retry: false, gcTime: 0, queryFn: ({ signal }) => api.request<{ repository: { id: string; fullName: string; path: string } | null }>(`${projectPath(project!.id)}/sessions/${encodeURIComponent(sessionId)}/repository`, { signal }) })
    const repository = !status.error ? status.data?.repository : null
    if (status.error) return <button className="text-xs text-[var(--app-hint)]" onClick={() => void status.refetch()}>Repository-Zuordnung erneut prüfen</button>
    return repository && /^[1-9][0-9]{0,19}$/.test(repository.id) ? <Link className="block truncate text-xs text-[var(--app-link)]" to="/evolved" search={{ tab: 'github', project: project!.id, repository: repository.id }}>Repository: {repository.fullName} · Änderungen</Link> : null
}
