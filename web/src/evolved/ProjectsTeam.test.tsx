import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolvedApiError, type EvolvedProject } from './api'
import { builtinModule, flutterDefinition, pluginModule, type FixtureModule } from '../test/developmentModules'
import { ProjectsPanel } from './ProjectsTeam'
const context = vi.hoisted(() => ({ api: { request: vi.fn(), baseUrl: 'https://hub.example' }, me: { user: { id: 'user-1', isAdmin: false }, accessibleProjects: [] as EvolvedProject[] }, project: null as EvolvedProject | null, selectProject: vi.fn(), refresh: vi.fn() }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('./Capacity', () => ({ CapacityPanel: () => <p>Selected project capacity</p> }))
vi.mock('./ProjectDevelopment', () => ({ DevelopmentOverviewCard: () => <p>Development overview</p> }))
function creationServer(plugins: FixtureModule[] = [], onCreate?: () => unknown, catalogFails = false) {
    const modules = [builtinModule('odoo'), builtinModule('ios'), builtinModule('android'), ...plugins]
    context.api.request.mockImplementation(async (path: string, options?: { method?: string }) => {
        if (path === '/teams') return { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
        if (path === '/development-modules') { if (catalogFails) throw new EvolvedApiError('down', 503); return { contractVersion: 2, modules: modules.map(module => module.entry) } }
        const detail = modules.find(module => path === `/development-modules/${encodeURIComponent(module.entry.id)}`)
        if (detail) return { module: detail.detail }
        if (path === '/projects' && options?.method === 'POST') return onCreate ? onCreate() : { project: { id: 'new' } }
        throw new Error(`Unexpected ${path}`)
    })
}
const postedProject = () => context.api.request.mock.calls.find(([path, options]) => path === '/projects' && options?.method === 'POST')?.[1].body
const projects: EvolvedProject[] = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((name, index) => ({ id: `project-${index}`, teamId: 'team-1', name, role: 'viewer', profile: 'restricted', rootPath: `/work/${name}` }))
function mount(onSelectProject?: (id: string) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><ProjectsPanel onSelectProject={onSelectProject} /></QueryClientProvider>)
    return { ...view, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><ProjectsPanel onSelectProject={onSelectProject} /></QueryClientProvider>) }
}
beforeEach(() => { context.me.user.id = 'user-1'; context.me.accessibleProjects = [...projects]; context.project = projects[0]; context.api.request.mockReset().mockResolvedValue({ teams: [] }); context.selectProject.mockReset(); context.refresh.mockReset().mockResolvedValue(undefined) })
describe('project overview', () => {
    it('offers name search only when useful and restores the full list after an empty result', async () => {
        mount()
        await screen.findByLabelText('Projekte durchsuchen')
        fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'aLPHa' } })
        expect(screen.getByRole('button', { name: /Alpha Lesend/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Beta Lesend/ })).not.toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'does-not-exist' } })
        expect(screen.getByText(/Kein Projekt passt/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }))
        expect(screen.getByRole('button', { name: /Epsilon Lesend/ })).toBeInTheDocument()
        expect(screen.getByText('5 von 5 Projekten')).toBeInTheDocument()
    })
    it('keeps small project lists simple and preserves role restrictions', async () => {
        context.me.accessibleProjects = projects.slice(0, 2)
        mount()
        await screen.findByRole('heading', { name: 'Ausführungsprofil' })
        expect(screen.queryByLabelText('Projekte durchsuchen')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Eingeschränkt Schreib-/ })).toBeDisabled()
        expect(screen.getByText('Selected project capacity')).toBeInTheDocument()
    })
    it('delegates selection to URL-aware workspace navigation when provided', () => {
        const select = vi.fn()
        mount(select)
        fireEvent.click(screen.getByRole('button', { name: /Beta Lesend/ }))
        expect(select).toHaveBeenCalledWith('project-1')
        expect(context.selectProject).not.toHaveBeenCalled()
    })
    it('disables the current profile and explains runner and GitHub consequences before a real change', async () => {
        context.project = { ...projects[0], role: 'admin', profile: 'workspace' }
        mount()
        const active = await screen.findByRole('button', { name: /^Arbeitsbereich Projektbezogene/ })
        expect(active).toBeDisabled()
        expect(active).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(active)
        expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/profile'))).toBe(false)
        expect(screen.getByText(/macht alle bisherigen Runner-Zugänge ungültig/)).toBeInTheDocument()
        expect(screen.getByText(/Gespeicherte GitHub-Repository-Freigaben bleiben erhalten/)).toBeInTheDocument()
        const restricted = screen.getByRole('button', { name: /^Eingeschränkt Schreib-/ })
        expect(restricted).not.toBeDisabled()
        fireEvent.click(restricted)
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project-0/profile', { method: 'PUT', body: { profile: 'restricted' } }))
        expect(await screen.findByText('Profil gespeichert.')).toBeInTheDocument()
        expect(context.refresh).toHaveBeenCalledTimes(1)
    })
    it('drops removed projects immediately and resets search across accounts', () => {
        const { rerenderPanel } = mount()
        fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'Alpha' } })
        context.me.accessibleProjects = projects.slice(1)
        rerenderPanel()
        expect(screen.queryByRole('button', { name: /Alpha Lesend/ })).not.toBeInTheDocument()
        expect(screen.queryByText('Selected project capacity')).not.toBeInTheDocument()
        context.me.user.id = 'another-user'; context.me.accessibleProjects = [...projects]
        rerenderPanel()
        expect(screen.getByLabelText('Projekte durchsuchen')).toHaveValue('')
    })
    it('creates a project with an explicit builtin module and Odoo version through the v2 creation body, without repository', async () => {
        context.me.user.isAdmin = false
        creationServer()
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'ERP' } })
        expect(await screen.findByRole('radio', { name: /^Allgemein/ })).toBeChecked()
        fireEvent.click(screen.getByRole('radio', { name: /^Odoo/ }))
        fireEvent.click(screen.getByRole('radio', { name: '19.0' }))
        expect(screen.getByText(/Das Modul ändert keine Rechte und installiert nichts/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects', expect.objectContaining({ method: 'POST' })))
        const body = postedProject()
        expect(body).toMatchObject({ name: 'ERP', teamId: 'team-1', development: { contractVersion: 2, settings: { activeModuleId: 'builtin:odoo', repositoryId: null, modules: {}, odoo: { major: 19, enterpriseRepositoryId: null } } } })
        expect(body.development.settings.ios).toBeNull()
        // Builtins need no detail request; nothing project-scoped is read while creating.
        expect(context.api.request.mock.calls.some(([path]) => String(path).startsWith('/development-modules/'))).toBe(false)
    })

    it('creates a project with a plugin module using the shown revision, its defaults and typed values including false and 0', async () => {
        const flutter = pluginModule(flutterDefinition({ fields: flutterDefinition().fields!.filter(field => field.kind !== 'repository') }))
        creationServer([flutter])
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'App' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        expect(await screen.findByLabelText(/^App-Verzeichnis/)).toHaveValue('.')
        expect(screen.getByLabelText(/^Android minSdk/)).toHaveValue(0)
        expect(screen.getByLabelText('Web-Ziel')).not.toBeChecked()
        fireEvent.change(screen.getByLabelText(/^Kanal/), { target: { value: 'beta' } })
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(postedProject()).toBeDefined())
        expect(postedProject().development).toEqual({ contractVersion: 2, settings: { activeModuleId: flutter.entry.id, repositoryId: null, odoo: null, ios: null, android: null,
            modules: { [flutter.entry.id]: { moduleDigest: flutter.entry.digest, values: { appDirectory: '.', channel: 'beta', minSdk: 0, web: false, flavors: [], platforms: [], notes: null, docs: null, branch: null, signing: null } } } } })
        expect(context.api.request.mock.calls.filter(([path]) => String(path).startsWith('/development-modules/'))).toHaveLength(1)
    })

    it('blocks an invalid plugin value at its field and shows authoritative server issues there', async () => {
        const flutter = pluginModule(flutterDefinition({ fields: flutterDefinition().fields!.filter(field => field.kind !== 'repository') }))
        creationServer([flutter], () => { throw new EvolvedApiError('invalid', 400, 'development_module_settings_invalid', false, { error: 'invalid', code: 'development_module_settings_invalid', issues: [{ path: ['modules', flutter.entry.id, 'values', 'notes'], message: 'Invalid format' }] }) })
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'App' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        const minSdk = await screen.findByLabelText(/^Android minSdk/)
        fireEvent.change(minSdk, { target: { value: '120' } })
        expect(minSdk).toHaveAttribute('aria-invalid', 'true')
        expect(screen.getByText('Erlaubt sind Werte von 0 bis 99.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Projekt anlegen' })).toBeDisabled()
        fireEvent.change(minSdk, { target: { value: '21' } })
        fireEvent.change(screen.getByLabelText(/^Hinweis für Übergaben/), { target: { value: 'Server sagt nein' } })
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        expect(await screen.findByText('Kein gültiges Format.')).toBeInTheDocument()
        expect(screen.getByLabelText(/^Hinweis für Übergaben/)).toHaveAttribute('aria-invalid', 'true')
    })

    it('explains that a module with a required repository field is chosen after creation', async () => {
        const flutter = pluginModule(flutterDefinition({ fields: [{ id: 'assets', kind: 'repository', label: 'Asset-Repository', required: true }], recipes: [], tasks: [], inspect: null }))
        creationServer([flutter])
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'App' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        expect(await screen.findByText(/braucht ein Repository, das ein neues Projekt noch nicht hat/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Projekt anlegen' })).toBeDisabled()
    })

    it('keeps general creation possible and honest when the module catalog cannot be loaded', async () => {
        creationServer([], undefined, true)
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Plain' } })
        expect(await screen.findByText(/Modulkatalog nicht geladen/)).toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: /^Odoo/ })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(postedProject()).toBeDefined())
        expect(postedProject()).not.toHaveProperty('development')
    })

    it('omits the development field for a general project', async () => {
        creationServer()
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Plain' } })
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request.mock.calls.some(([path, options]) => path === '/projects' && options?.method === 'POST')).toBe(true))
        expect(context.api.request.mock.calls.find(([path, options]) => path === '/projects' && options?.method === 'POST')![1].body).not.toHaveProperty('development')
    })
})
