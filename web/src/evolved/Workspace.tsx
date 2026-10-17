import { ProviderLoginPanel } from './ProviderLogin'
import { AgentsPluginsPanel } from './AgentsPlugins'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { useOptionalEvolved, useEvolved } from './auth'
import { ProjectsPanel, TeamPanel } from './ProjectsTeam'
import { VaultPanel } from './Vault'
import { MemoryPanel } from './Memory'
import { McpShopPanel } from './McpShop'
import { CodegraphPanel } from './Codegraph'
import { RunnerPanel } from './Runner'
import { AutomationPanel } from './Automation'
import { PreviewsPanel } from './Previews'
import { GithubPanel } from './Github'
import { ProjectDevelopmentPanel } from './ProjectDevelopment'
import { Dashboard } from './Dashboard'
import { ProjectWorkflowProvider } from './ProjectWorkflowContext'
import { CapacityPanel } from './Capacity'
import { EvolvedBrand } from './Brand'
import { ErrorNotice, Loading, useAction } from './ui'
import { parseWorkspaceSearch, readWorkspaceTab, requiresProject, workspaceGroups, workspacePages, workspaceStorageKey, WorkspaceIcon, WorkspaceLink } from './workspaceNavigation'
import './evolved.css'
import './workspace.css'

export { parseWorkspaceSearch } from './workspaceNavigation'
const roleLabels = { admin: 'Administrator', member: 'Mitglied', viewer: 'Lesend' }
const profileLabels = { restricted: 'Eingeschränkt', workspace: 'Arbeitsbereich', extended: 'Erweitert' }

export default function EvolvedWorkspace() {
    const context = useOptionalEvolved()
    if (!context) return <main className="evolved ev-login"><h1>HAPI-eVolved</h1><p>Dieser Hub hat den Evolved-Arbeitsbereich nicht aktiviert.</p><Link to="/sessions">Zu den Sessions</Link></main>
    return <WorkspaceForAccount key={`${context.api.baseUrl}:${context.me.user.id}`} />
}

function WorkspaceForAccount() {
    const { api, me, project, selectProject, logout } = useEvolved()
    const search = parseWorkspaceSearch(useSearch({ strict: false }))
    const navigate = useNavigate()
    const [rememberedTab] = useState(() => readWorkspaceTab(api.baseUrl, me.user.id))
    const [moreOpen, setMoreOpen] = useState(false)
    const heading = useRef<HTMLHeadingElement>(null)
    const content = useRef<HTMLElement>(null)
    const sheetNavigation = useRef(false)
    const keyboardNavigation = useRef(false)
    const action = useAction()
    const authorizedProject = project && me.accessibleProjects.find(item => item.id === project.id)
    const linkedProject = search.project && me.accessibleProjects.find(item => item.id === search.project)
    const unavailableProject = !!search.project && !linkedProject
    const changingProject = !!linkedProject && project?.id !== linkedProject.id
    const navigationProject = unavailableProject ? undefined : authorizedProject
    const navigationProjectId = unavailableProject ? search.project : authorizedProject?.id
    const requestedTab = search.tab ?? rememberedTab
    const tab = !authorizedProject && !linkedProject && requiresProject(requestedTab) ? 'overview' : requestedTab
    const page = workspacePages.find(item => item.id === tab)!
    const focusHeading = () => {
        if (!heading.current) return
        heading.current.dataset.keyboardFocus = String(keyboardNavigation.current)
        heading.current.focus({ preventScroll: true })
    }
    useEffect(() => {
        const keyboard = (event: KeyboardEvent) => { if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboardNavigation.current = true }
        const pointer = () => { keyboardNavigation.current = false }
        document.addEventListener('keydown', keyboard, true)
        document.addEventListener('pointerdown', pointer, true)
        return () => { document.removeEventListener('keydown', keyboard, true); document.removeEventListener('pointerdown', pointer, true) }
    }, [])

    // A URL selects a project; it never grants access. Wait for the authorized
    // context to match the selection before mounting any project data views.
    useEffect(() => {
        if (linkedProject && project?.id !== linkedProject.id) selectProject(linkedProject.id)
        if (!unavailableProject && (!search.tab || tab !== requestedTab)) {
            const destination = linkedProject || authorizedProject
            void navigate({ to: '/evolved', search: { tab, ...(destination ? { project: destination.id } : {}) }, replace: true })
        }
    }, [linkedProject, project?.id, selectProject, unavailableProject, search.tab, tab, requestedTab, authorizedProject, navigate])
    useEffect(() => {
        try { localStorage.setItem(workspaceStorageKey(api.baseUrl, me.user.id), tab) } catch { /* Storage can be disabled. */ }
    }, [api.baseUrl, me.user.id, tab])
    useEffect(() => {
        setMoreOpen(false)
        content.current?.scrollTo?.({ top: 0 })
        focusHeading()
    }, [tab, project?.id])

    const changeProject = (id: string) => {
        if (!me.accessibleProjects.some(item => item.id === id)) return
        void navigate({ to: '/evolved', search: { tab, project: id } })
    }
    const chooseFromSheet = () => { sheetNavigation.current = true; setMoreOpen(false) }
    const navigation = (inSheet = false) => <nav aria-label={inSheet ? 'Weitere Bereiche' : 'Arbeitsbereich'} className="ew-navigation">
        {workspaceGroups.map(group => <div className="ew-nav-group" key={group}><p>{group}</p>{workspacePages.filter(item => item.group === group).map(item => !navigationProject && requiresProject(item.id)
            ? <span key={item.id} className="ew-nav-link is-disabled" aria-disabled="true" title="Wähle zuerst ein Projekt"><WorkspaceIcon name={item.id} /><span>{item.label}</span></span>
            : <WorkspaceLink key={item.id} tab={item.id} projectId={navigationProjectId} current={tab === item.id} className="ew-nav-link" onClick={inSheet ? chooseFromSheet : undefined}><WorkspaceIcon name={item.id} /><span>{item.label}</span></WorkspaceLink>)}{group === 'Arbeitsplatz' && navigationProject && <Link to="/sessions" className="ew-nav-link"><WorkspaceIcon name="sessions" /><span>Sessions</span><WorkspaceIcon name="arrow" /></Link>}</div>)}
    </nav>
    const identity = <div className="ew-identity"><div className="ew-avatar" aria-hidden="true">{me.user.displayName.slice(0, 1).toLocaleUpperCase()}</div><div><strong>{me.user.displayName}</strong><span>{navigationProject ? roleLabels[navigationProject.role] : 'Dein Konto'}</span></div><Link to="/settings/display" className="ew-settings-link">Darstellung</Link>{authorizedProject && <Link to="/settings" className="ew-settings-link">Einstellungen</Link>}<button disabled={action.busy} onClick={() => void action.run(logout)}>Abmelden</button></div>

    return <div className="evolved ew-shell" lang="de"><a className="ew-skip-link" href="#workspace-content">Zum Inhalt</a>
        <aside className="ew-sidebar"><div className="ew-sidebar-brand"><EvolvedBrand compact /></div>{navigation()}<div className="ew-sidebar-footer">{identity}</div></aside>
        <div className="ew-workspace"><header className="ew-topbar"><div className="ew-mobile-brand"><EvolvedBrand compact /></div><div className="ew-topbar-label"><span>Bereich</span><strong>{page.group}</strong></div><div className="ew-project-context">{me.accessibleProjects.length ? <label className="ew-project-picker"><span>Aktives Projekt</span><select aria-label="Aktives Projekt" value={navigationProject?.id ?? ''} onChange={event => changeProject(event.target.value)}>{!navigationProject && <option value="">Projekt wählen</option>}{me.accessibleProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <span className="ew-caption">Noch kein Projekt</span>}{navigationProject && <span className="ew-profile-label">{profileLabels[navigationProject.profile]}</span>}</div></header>
            <main className="ew-content" id="workspace-content" ref={content}><div className="ew-content-inner"><div className="ew-page-heading"><div><span className="ew-eyebrow">{unavailableProject ? 'Projekt nicht verfügbar' : navigationProject?.name ?? 'Willkommen bei HAPI-eVolved'}</span><h1 ref={heading} tabIndex={-1}>{page.label}</h1><p>{page.description}</p></div>{navigationProject && <span className="ew-role-label">{roleLabels[navigationProject.role]}</span>}</div>
                <ErrorNotice error={action.error} />
                {unavailableProject ? <p className="ev-callout" role="status">Dieses Projekt ist für dein Konto nicht verfügbar. Wähle ausdrücklich ein anderes Projekt, um fortzufahren.</p> : changingProject ? <Loading /> : <ProjectWorkflowProvider key={`${api.baseUrl}:${me.user.id}:${authorizedProject?.id}:${authorizedProject?.role}:${authorizedProject?.profile}`}><div key={`${authorizedProject?.id ?? 'none'}:${tab}`}>
                    {tab === 'overview' ? <Dashboard /> : tab === 'projects' ? <ProjectsPanel onSelectProject={changeProject} /> : tab === 'agents' ? <AgentsPluginsPanel /> : tab === 'team' ? <TeamPanel /> : authorizedProject && tab === 'capacity' ? <CapacityPanel /> : authorizedProject && tab === 'development' ? <ProjectDevelopmentPanel /> : authorizedProject && tab === 'github' ? <GithubPanel initialRepositoryId={search.repository} onRepositorySelect={repository => void navigate({ to: '/evolved', search: { tab: 'github', project: authorizedProject.id, ...(repository ? { repository } : {}) } })} /> : authorizedProject && tab === 'vault' ? <VaultPanel /> : authorizedProject && tab === 'mcp' ? <McpShopPanel /> : authorizedProject && tab === 'memory' ? <MemoryPanel /> : authorizedProject && tab === 'codegraph' ? <CodegraphPanel /> : authorizedProject && tab === 'automation' ? <AutomationPanel /> : tab === 'providers' ? <ProviderLoginPanel /> : authorizedProject && tab === 'runner' ? <RunnerPanel /> : authorizedProject && tab === 'previews' ? <PreviewsPanel /> : null}
                </div></ProjectWorkflowProvider>}
                <footer className="ew-page-footer">HAPI-eVolved <span>Dein Projekt. Dein Kontext.</span></footer>
            </div></main>
        </div>
        <Dialog.Root open={moreOpen} onOpenChange={open => { sheetNavigation.current = false; setMoreOpen(open) }}><nav className="ew-bottom-nav" aria-label="Mobile Navigation"><WorkspaceLink tab="overview" projectId={navigationProjectId} current={tab === 'overview'}><WorkspaceIcon name="overview" /><span>Übersicht</span></WorkspaceLink>{navigationProject ? <Link to="/sessions"><WorkspaceIcon name="sessions" /><span>Sessions</span></Link> : <span aria-disabled="true"><WorkspaceIcon name="sessions" /><span>Sessions</span></span>}<WorkspaceLink tab="projects" projectId={navigationProjectId} current={tab === 'projects'}><WorkspaceIcon name="projects" /><span>Projekte</span></WorkspaceLink><Dialog.Trigger className={tab !== 'overview' && tab !== 'projects' ? 'is-current' : undefined}><WorkspaceIcon name="more" /><span>Mehr</span></Dialog.Trigger></nav>
            <Dialog.Portal><Dialog.Overlay className="ew-sheet-overlay" /><Dialog.Content lang="de" className="evolved ew-sheet" onCloseAutoFocus={event => { if (sheetNavigation.current) { event.preventDefault(); focusHeading() } }}><div className="ew-sheet-header"><div><Dialog.Title>Dein Arbeitsplatz</Dialog.Title><Dialog.Description>Alle Werkzeuge und Kontoeinstellungen.</Dialog.Description></div><Dialog.Close aria-label="Menü schließen"><WorkspaceIcon name="close" /></Dialog.Close></div>{navigation(true)}{identity}</Dialog.Content></Dialog.Portal>
        </Dialog.Root>
    </div>
}
