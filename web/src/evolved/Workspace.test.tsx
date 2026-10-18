import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvolvedMe, EvolvedProject } from './api'
import EvolvedWorkspace from './Workspace'
import { parseWorkspaceSearch, repositorySearchId, readWorkspaceTab, workspaceStorageKey } from './workspaceNavigation'

const state = vi.hoisted(() => ({ version: 0, listeners: new Set<() => void>(), value: { api: { baseUrl: 'https://hub.example' }, me: { user: { id: 'user-1', displayName: 'Test User', isAdmin: false }, accessibleProjects: [] } as EvolvedMe, project: null as EvolvedProject | null, selectProject: vi.fn(), logout: vi.fn() } }))
vi.mock('./auth', async () => {
    const { useSyncExternalStore } = await import('react')
    const useContext = () => { useSyncExternalStore(listener => { state.listeners.add(listener); return () => { state.listeners.delete(listener) } }, () => state.version); return state.value }
    return { useEvolved: useContext, useOptionalEvolved: useContext }
})
const pendingCreation = vi.hoisted(() => ({ callback: null as null | ((id: string) => void) }))
vi.mock('./ProjectsTeam', () => ({ ProjectsPanel: ({ onSelectProject, onProjectCreated }: { onSelectProject: (id: string) => void; onProjectCreated: (id: string) => void }) => <><button onClick={() => onSelectProject('project-2')}>Choose second project</button><button onClick={() => onProjectCreated('project-3')}>Simulate created project</button><button onClick={() => { pendingCreation.callback = onProjectCreated }}>Start slow creation</button></>, TeamPanel: () => <p>Team panel content</p> }))
vi.mock('./ProjectSetup', () => ({ ProjectSetupPanel: ({ step, onStep }: { step?: string; onStep: (step: string) => void }) => <><p>Setup {state.value.project?.id} step {step ?? 'auto'}</p><button onClick={() => onStep('github')}>Setup next</button></> }))
vi.mock('./Dashboard', () => ({ Dashboard: () => <p>Dashboard {state.value.project?.id ?? 'onboarding'}</p> }))
vi.mock('./Capacity', () => ({ CapacityPanel: () => <p>Capacity {state.value.project?.id}</p> }))
vi.mock('./Github', () => ({ GithubPanel: () => <p>GitHub {state.value.project?.id}</p> }))
vi.mock('./ProjectDevelopment', () => ({ ProjectDevelopmentPanel: () => <p>Development {state.value.project?.id}</p> }))
vi.mock('./Vault', () => ({ VaultPanel: () => <p>Vault content</p> }))
vi.mock('./McpShop', () => ({ McpShopPanel: () => <p>MCP shop {state.value.project?.id}</p> }))
vi.mock('./Memory', () => ({ MemoryPanel: () => <p>Memory content</p> }))
vi.mock('./Codegraph', () => ({ CodegraphPanel: () => <p>Codegraph content</p> }))
vi.mock('./Runner', () => ({ RunnerPanel: () => <p>Runner content</p> }))
vi.mock('./Automation', () => ({ AutomationPanel: () => <p>Automation content</p> }))
vi.mock('./Previews', () => ({ PreviewsPanel: () => <p>Previews content</p> }))
vi.mock('./AgentsPlugins', () => ({ AgentsPluginsPanel: () => <p>Global agent catalog</p> }))
const project = (id: string): EvolvedProject => ({ id, teamId: 'team-1', name: id, role: 'admin', profile: 'restricted' })
function update() { state.version++; state.listeners.forEach(listener => listener()) }
async function mount(url = '/evolved') {
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: '/evolved', component: EvolvedWorkspace, validateSearch: parseWorkspaceSearch })
    const history = createMemoryHistory({ initialEntries: [url] })
    const router = createRouter({ routeTree: root.addChildren([route]), history })
    await router.load()
    const view = render(<RouterProvider router={router} />)
    await screen.findByRole('navigation', { name: 'Arbeitsbereich' })
    return { ...view, router, history }
}
beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    localStorage.clear(); state.value.api.baseUrl = 'https://hub.example'; state.value.me = { user: { id: 'user-1', displayName: 'Test User', isAdmin: false }, accessibleProjects: [project('project-1'), project('project-2')] }; state.value.project = state.value.me.accessibleProjects[0]; state.value.selectProject.mockReset(); state.value.logout.mockReset(); state.version++
})
describe('project setup navigation', () => {
    it('keeps only known setup steps and a bare return marker in the URL', () => {
        expect(parseWorkspaceSearch({ tab: 'setup', project: 'p', step: 'github' })).toEqual({ tab: 'setup', project: 'p', step: 'github' })
        expect(parseWorkspaceSearch({ tab: 'setup', step: 'install-everything' })).toEqual({ tab: 'setup' })
        expect(parseWorkspaceSearch({ tab: 'mcp', from: 'setup', step: 'summary' })).toEqual({ tab: 'mcp', from: 'setup', step: 'summary' })
        expect(parseWorkspaceSearch({ tab: 'mcp', from: 'elsewhere' })).toEqual({ tab: 'mcp' })
    })
    it('enters a created project in the setup only once the authorized context lists it, and steps are browser history', async () => {
        const { router, history } = await mount('/evolved?tab=projects&project=project-1')
        fireEvent.click(await screen.findByRole('button', { name: 'Simulate created project' }))
        expect(await screen.findByText(/Dieses Projekt ist für dein Konto nicht verfügbar/)).toBeInTheDocument()
        expect(state.value.selectProject).not.toHaveBeenCalled()
        // The refreshed account context now lists the project: the URL selects it, nothing else.
        state.value.me = { ...state.value.me, accessibleProjects: [...state.value.me.accessibleProjects, project('project-3')] }
        act(() => update())
        await waitFor(() => expect(state.value.selectProject).toHaveBeenCalledWith('project-3'))
        state.value.project = state.value.me.accessibleProjects[2]!
        act(() => update())
        expect(await screen.findByText('Setup project-3 step profile')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Setup next' }))
        expect(await screen.findByText('Setup project-3 step github')).toBeInTheDocument()
        expect(router.state.location.search).toEqual({ tab: 'setup', project: 'project-3', step: 'github' })
        await act(async () => history.back())
        expect(await screen.findByText('Setup project-3 step profile')).toBeInTheDocument()
    })
    it('ignores a creation that completes after the account changed: no navigation for the new account', async () => {
        const { router } = await mount('/evolved?tab=projects&project=project-1')
        fireEvent.click(await screen.findByRole('button', { name: 'Start slow creation' }))
        // Account switch while the creation's refresh is still pending.
        state.value.me = { user: { id: 'user-2', displayName: 'Other', isAdmin: false }, accessibleProjects: [project('project-1'), project('project-3')] }
        act(() => update())
        await screen.findByRole('navigation', { name: 'Arbeitsbereich' })
        const before = router.state.location.href
        act(() => pendingCreation.callback!('project-3'))
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(router.state.location.href).toBe(before)
        expect(screen.queryByText(/Setup project-3/)).not.toBeInTheDocument()
    })
    it('offers the way back to the setup step on a tool opened from it', async () => {
        await mount('/evolved?tab=mcp&project=project-1&from=setup&step=summary')
        const back = await screen.findByRole('link', { name: 'Zurück zur Einrichtung' })
        expect(back.getAttribute('href')).toContain('tab=setup')
        expect(back.getAttribute('href')).toContain('step=summary')
    })
})

describe('workspace navigation', () => {
    it('validates query values and scopes remembered pages by account and hub', () => {
        expect(parseWorkspaceSearch({ tab: '<script>', project: '../foreign' })).toEqual({})
        expect(parseWorkspaceSearch({ tab: 'capacity', project: 'project-2', ignored: 'value' })).toEqual({ tab: 'capacity', project: 'project-2' })
        localStorage.setItem(workspaceStorageKey('hub-a', 'user-a'), 'github')
        expect(readWorkspaceTab('hub-a', 'user-a')).toBe('github')
        expect(readWorkspaceTab('hub-a', 'user-b')).toBe('overview')
        expect(readWorkspaceTab('hub-b', 'user-a')).toBe('overview')
    })
    it('restores an allowed remembered tab using real router search state', async () => {
        localStorage.setItem(workspaceStorageKey(state.value.api.baseUrl, 'user-1'), 'capacity')
        const { router } = await mount()
        await screen.findByRole('heading', { name: 'Kapazität', level: 1 })
        await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'capacity', project: 'project-1' }))
    })
    it('supports browser back and forward between links and keeps every tool reachable', async () => {
        const { history } = await mount('/evolved?tab=overview&project=project-1')
        const nav = screen.getByRole('navigation', { name: 'Arbeitsbereich' })
        for (const label of ['Projekte', 'Agenten & Plugins', 'Kapazität', 'Entwicklung', 'GitHub', 'MCP-Shop', 'Gedächtnis', 'Codegraph', 'Vorschauen', 'Automatisierung', 'Runner', 'Abos verbinden', 'Tresor', 'Team & Konto', 'Sessions']) expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument()
        fireEvent.click(within(nav).getByRole('link', { name: 'Entwicklung' }))
        await screen.findByText('Development project-1')
        fireEvent.click(within(nav).getByRole('link', { name: 'Gedächtnis' }))
        await screen.findByText('Memory content')
        fireEvent.click(within(nav).getByRole('link', { name: 'Kapazität' }))
        await screen.findByText('Capacity project-1')
        await act(async () => history.back())
        await screen.findByText('Memory content')
        await act(async () => history.forward())
        expect(await screen.findByRole('heading', { name: 'Kapazität', level: 1 })).toHaveFocus()
    })
    it('does not mount data for the old project while an authorized deep link selects another', async () => {
        await mount('/evolved?tab=github&project=project-2')
        expect(state.value.selectProject).toHaveBeenCalledWith('project-2')
        expect(screen.queryByText('GitHub project-1')).not.toBeInTheDocument()
        await act(async () => { state.value.project = project('project-2'); update() })
        expect(await screen.findByText('GitHub project-2')).toBeInTheDocument()
    })
    it('mounts the MCP shop only after the authorized deep-linked project is selected', async () => {
        await mount('/evolved?tab=mcp&project=project-2')
        expect(state.value.selectProject).toHaveBeenCalledWith('project-2')
        expect(screen.queryByText('MCP shop project-1')).not.toBeInTheDocument()
        await act(async () => { state.value.project = project('project-2'); update() })
        expect(await screen.findByText('MCP shop project-2')).toBeInTheDocument()
    })
    it('does not mount the MCP shop for an unauthorized project', async () => {
        await mount('/evolved?tab=mcp&project=foreign-project')
        expect(screen.queryByText(/MCP shop/)).not.toBeInTheDocument()
        expect(state.value.selectProject).not.toHaveBeenCalled()
        expect(screen.getByRole('status')).toHaveTextContent('Wähle ausdrücklich ein anderes Projekt')
    })
    it('does not override a project-only deep link with the previous project', async () => {
        const { router } = await mount('/evolved?project=project-2')
        await waitFor(() => expect(router.state.location.search.project).toBe('project-2'))
        expect(state.value.selectProject).toHaveBeenCalledWith('project-2')
        expect(screen.queryByText('Dashboard project-1')).not.toBeInTheDocument()
    })
    it('keeps an unauthorized project URL blocked until an explicit project choice', async () => {
        const { router } = await mount('/evolved?tab=overview&project=foreign-project')
        expect(router.state.location.search.project).toBe('foreign-project')
        expect(state.value.selectProject).not.toHaveBeenCalled()
        expect(screen.getByRole('status')).toHaveTextContent('Wähle ausdrücklich ein anderes Projekt')
        expect(screen.queryByText('Dashboard project-1')).not.toBeInTheDocument()
        expect(screen.getByRole('combobox', { name: 'Aktives Projekt' })).toHaveValue('')
        fireEvent.click(within(screen.getByRole('navigation', { name: 'Arbeitsbereich' })).getByRole('link', { name: 'Projekte' }))
        await waitFor(() => expect(router.state.location.search.tab).toBe('projects'))
        expect(router.state.location.search.project).toBe('foreign-project')
        expect(screen.queryByRole('button', { name: 'Choose second project' })).not.toBeInTheDocument()
        fireEvent.change(screen.getByRole('combobox', { name: 'Aktives Projekt' }), { target: { value: 'project-1' } })
        await waitFor(() => expect(router.state.location.search.project).toBe('project-1'))
        fireEvent.click(within(screen.getByRole('navigation', { name: 'Arbeitsbereich' })).getByRole('link', { name: 'Übersicht' }))
        expect(await screen.findByText('Dashboard project-1')).toBeInTheDocument()
    })
    it('normalizes a project-only page when no project exists and keeps team onboarding available', async () => {
        state.value.project = null; state.value.me.accessibleProjects = []
        await mount('/evolved?tab=capacity')
        expect(await screen.findByText('Dashboard onboarding')).toBeInTheDocument()
        const nav = screen.getByRole('navigation', { name: 'Arbeitsbereich' })
        expect(within(nav).queryByRole('link', { name: 'Kapazität' })).not.toBeInTheDocument()
        expect(within(nav).queryByRole('link', { name: 'MCP-Shop' })).not.toBeInTheDocument()
        expect(within(nav).getByRole('link', { name: 'Team & Konto' })).toBeInTheDocument()
        expect(within(nav).getByRole('link', { name: 'Agenten & Plugins' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Darstellung' })).toHaveAttribute('href', '/settings/display')
    })
    it('changes project cards through router navigation so a stale URL cannot switch back', async () => {
        const { router } = await mount('/evolved?tab=projects&project=project-1')
        fireEvent.click(screen.getByRole('button', { name: 'Choose second project' }))
        await waitFor(() => expect(router.state.location.search.project).toBe('project-2'))
        expect(state.value.selectProject).toHaveBeenLastCalledWith('project-2')
    })
    it('provides an accessible More dialog and returns focus after Escape', async () => {
        await mount('/evolved?tab=overview')
        const trigger = screen.getByRole('button', { name: 'Mehr' })
        trigger.focus(); fireEvent.click(trigger)
        const dialog = await screen.findByRole('dialog', { name: 'Dein Arbeitsplatz' })
        expect(within(dialog).getByRole('link', { name: 'Gedächtnis' })).toBeInTheDocument()
        expect(within(dialog).getByRole('link', { name: 'Einstellungen' })).toBeInTheDocument()
        fireEvent.keyDown(dialog, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        await waitFor(() => expect(trigger).toHaveFocus())
    })
    it('continues with a safe default if local storage is unavailable', async () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
        try { await mount(); expect(await screen.findByText('Dashboard project-1')).toBeInTheDocument() } finally { get.mockRestore(); set.mockRestore() }
    })
    it('shows subscription setup before a first project exists', async () => {
        state.value.project = null
        state.value.me.accessibleProjects = []
        const { router } = await mount('/evolved?tab=providers')
        expect(await screen.findByRole('heading', { name: 'Abos verbinden', level: 1 })).toBeInTheDocument()
        expect(screen.getByText(/Wähle zuerst ein Projekt/)).toBeInTheDocument()
        expect(router.state.location.search.tab).toBe('providers')
    })
})

it('accepts unquoted numeric repository links only without numeric precision loss or path syntax', () => {
    expect(parseWorkspaceSearch({ tab: 'github', project: 'project-1', repository: 101 })).toEqual({ tab: 'github', project: 'project-1', repository: '101' })
    expect(repositorySearchId('18446744073709551615')).toBe('18446744073709551615')
    for (const value of [9007199254740992, -1, 1.5, 0, '../101', '01', {}, ['101']]) expect(repositorySearchId(value)).toBeUndefined()
})
