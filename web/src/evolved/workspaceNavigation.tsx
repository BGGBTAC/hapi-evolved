import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

export const workspacePages = [
    { id: 'overview', label: 'Übersicht', group: 'Arbeitsplatz', description: 'Sitzungen, Freigaben und nächste Schritte.' },
    { id: 'projects', label: 'Projekte', group: 'Arbeitsplatz', description: 'Deine Projekte, Ordner und Ausführungsprofile.' },
    { id: 'agents', label: 'Agenten & Plugins', group: 'Arbeitsplatz', description: 'Agenten für alle Projekte und geprüfte Erweiterungen.' },
    { id: 'capacity', label: 'Kapazität', group: 'Arbeitsplatz', description: 'Gemeldete Nutzungslimits deiner Agentenanbieter.' },
    { id: 'github', label: 'GitHub', group: 'Projektwerkzeuge', description: 'Repositories verbinden und gezielt freigeben.' },
    { id: 'mcp', label: 'MCP-Shop', group: 'Projektwerkzeuge', description: 'Externe Werkzeuge zentral für deine Projektagenten verbinden.' },
    { id: 'memory', label: 'Gedächtnis', group: 'Projektwerkzeuge', description: 'Wissen mit nachvollziehbaren Quellen bewahren.' },
    { id: 'codegraph', label: 'Codegraph', group: 'Projektwerkzeuge', description: 'Code, Zusammenhänge und Auswirkungen erkunden.' },
    { id: 'previews', label: 'Vorschauen', group: 'Projektwerkzeuge', description: 'Anwendungen aus deinem Projekt ansehen.' },
    { id: 'automation', label: 'Automatisierung', group: 'Verwaltung', description: 'Wiederkehrende Aufgaben und Agenten koordinieren.' },
    { id: 'runner', label: 'Runner', group: 'Verwaltung', description: 'Projektgebundene Zugänge für deine Agenten.' },
    { id: 'providers', label: 'Abos verbinden', group: 'Verwaltung', description: 'Codex und Claude mit deinem bestehenden Abo anmelden.' },
    { id: 'vault', label: 'Tresor', group: 'Verwaltung', description: 'Zugangsdaten geschützt und gezielt bereitstellen.' },
    { id: 'team', label: 'Team & Konto', group: 'Verwaltung', description: 'Zusammenarbeit, Rollen und deinen Zugang verwalten.' },
] as const
export type WorkspaceTab = typeof workspacePages[number]['id']
export type WorkspaceSearch = { tab?: WorkspaceTab; project?: string; repository?: string }
export const workspaceGroups = ['Arbeitsplatz', 'Projektwerkzeuge', 'Verwaltung'] as const
export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
    return typeof value === 'string' && workspacePages.some(page => page.id === value)
}
// TanStack decodes unquoted numeric query values as numbers. Accept only exact
// safe integers; larger repository IDs must remain strings to avoid rounding.
export function repositorySearchId(value: unknown): string | undefined {
    const id = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value
    return typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id) ? id : undefined
}
export function parseWorkspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
    return {
        ...(isWorkspaceTab(search.tab) ? { tab: search.tab } : {}),
        ...(typeof search.project === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(search.project) ? { project: search.project } : {}),
        ...(search.tab === 'github' && repositorySearchId(search.repository) ? { repository: repositorySearchId(search.repository) } : {}),
    }
}
export function requiresProject(tab: WorkspaceTab) { return !['overview', 'projects', 'team', 'providers', 'agents'].includes(tab) }
export const workspaceStorageKey = (baseUrl: string, userId: string) => `hapi.evolved.workspace:${baseUrl}:${userId}`
export function readWorkspaceTab(baseUrl: string, userId: string): WorkspaceTab {
    try {
        const stored = localStorage.getItem(workspaceStorageKey(baseUrl, userId))
        return isWorkspaceTab(stored) ? stored : 'overview'
    } catch { return 'overview' }
}

const icons: Record<WorkspaceTab | 'sessions' | 'more' | 'close' | 'arrow', ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    projects: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />,
    agents: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8M2 11v5m20-5v5" /></>,
    capacity: <><path d="M4 18a9 9 0 1 1 16 0M12 13l4-5" /><circle cx="12" cy="13" r="1" /></>,
    github: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9v2a5 5 0 0 1-5 5H6" /></>,
    mcp: <><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4m0-4a6 6 0 0 1-6-6Z" /></>,
    memory: <><path d="M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2Zm0 0v16" /></>,
    codegraph: <><circle cx="5" cy="5" r="2" /><circle cx="19" cy="8" r="2" /><circle cx="10" cy="19" r="2" /><path d="m7 5 10 2M6 7l3 10m3 0 6-7" /></>,
    previews: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8m-4-3v3M3 8h18" /></>,
    automation: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></>,
    runner: <><path d="m6 5 14 7-14 7Z" /></>,
    providers: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18m-13 5h4" /></>,
    vault: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    team: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2" /></>,
    sessions: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
}
export function WorkspaceIcon({ name }: { name: keyof typeof icons }) {
    return <svg className="ew-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>
}
export function WorkspaceLink({ tab, projectId, children, className, onClick, current }: {
    tab: WorkspaceTab; projectId?: string; children: ReactNode; className?: string; onClick?: () => void; current?: boolean
}) {
    return <Link to="/evolved" search={{ tab, ...(projectId ? { project: projectId } : {}) }} className={className} onClick={onClick} aria-current={current ? 'page' : undefined}>{children}</Link>
}
