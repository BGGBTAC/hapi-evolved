import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

describe('project creation after a plugin module changed', () => {
    const noRepository = (overrides = {}) => flutterDefinition({ fields: flutterDefinition().fields!.filter(field => field.kind !== 'repository'), ...overrides })
    const r1 = () => pluginModule(noRepository())
    // R2: new required field without default, `notes` removed, `beta` option removed.
    const r2 = () => pluginModule(noRepository({ contentVersion: '2026.11.01-1', fields: [
        ...noRepository().fields!.filter(field => field.id !== 'notes' && field.kind !== 'repository').map(field => field.id === 'channel' ? { ...field, options: [{ value: 'stable', label: 'Stabil' }] } : field),
        { id: 'target', kind: 'text', label: 'Build-Ziel', required: true, default: null },
    ] }), { digestSeed: 'flutter-r2' })
    /** Hub whose installed modules can change between reads; creation refuses digests that are no longer installed. */
    function raceServer(initial: FixtureModule) {
        const state = { plugin: initial as FixtureModule | null, refusal: null as null | (() => never) }
        context.api.request.mockImplementation(async (path: string, options?: { method?: string; body?: { development?: { settings: { modules: Record<string, { moduleDigest: string }> } } } }) => {
            const modules = [builtinModule('odoo'), ...(state.plugin ? [state.plugin] : [])]
            if (path === '/teams') return { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
            if (path === '/development-modules') return { contractVersion: 2, modules: modules.map(module => module.entry) }
            const detail = modules.find(module => path === `/development-modules/${encodeURIComponent(module.entry.id)}`)
            if (detail) return { module: detail.detail }
            if (path.startsWith('/development-modules/')) throw new EvolvedApiError('missing', 404, 'development_module_not_found')
            if (path === '/projects' && options?.method === 'POST') {
                if (state.refusal) state.refusal()
                for (const [id, entry] of Object.entries(options.body?.development?.settings.modules ?? {})) {
                    if (!state.plugin || state.plugin.entry.id !== id) throw new EvolvedApiError('gone', 409, 'development_module_unavailable', false, { error: 'gone', code: 'development_module_unavailable', moduleId: id, state: 'missing' })
                    if (state.plugin.entry.state !== 'ready') throw new EvolvedApiError('disabled', 409, 'development_module_unavailable', false, { error: 'disabled', code: 'development_module_unavailable', moduleId: id, state: state.plugin.entry.state })
                    if (state.plugin.entry.digest !== entry.moduleDigest) throw new EvolvedApiError('changed', 409, 'development_module_changed', false, { error: 'changed', code: 'development_module_changed', moduleId: id, installedDigest: state.plugin.entry.digest })
                }
                return { project: { id: 'new' } }
            }
            throw new Error(`Unexpected ${path}`)
        })
        return state
    }
    const posts = () => context.api.request.mock.calls.filter(([path, options]) => path === '/projects' && options?.method === 'POST').map(([, options]) => options.body)
    const createButton = () => screen.getByRole('button', { name: 'Projekt anlegen' })

    it('blocks a stale retry after development_module_changed, reloads catalog and details and retries with the new digest', async () => {
        const first = r1(), second = r2()
        const server = raceServer(first)
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'App' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        fireEvent.change(await screen.findByLabelText(/^Kanal/), { target: { value: 'stable' } })
        fireEvent.change(screen.getByLabelText(/^Android minSdk/), { target: { value: '21' } })
        fireEvent.change(screen.getByLabelText(/^Hinweis für Übergaben/), { target: { value: 'alter Hinweis' } })
        server.plugin = second
        fireEvent.click(createButton())
        const alert = await screen.findByText('Modul nicht mehr aktuell.')
        expect(alert.closest('[role="alert"]')).toHaveTextContent('Das Entwicklungsmodul wurde inzwischen geändert')
        expect(createButton()).toBeDisabled()
        expect(screen.getByLabelText('Projektname')).toHaveValue('App')
        expect(posts()).toHaveLength(1)
        expect(posts()[0].development.settings.modules[first.entry.id].moduleDigest).toBe(first.entry.digest)
        fireEvent.click(screen.getByRole('button', { name: 'Modulliste neu laden und prüfen' }))
        const target = await screen.findByLabelText(/^Build-Ziel/)
        expect(context.api.request.mock.calls.some(([path]) => path === `/development-modules/${encodeURIComponent(second.entry.id)}`)).toBe(true)
        expect(screen.queryByText('Modul nicht mehr aktuell.')).not.toBeInTheDocument()
        expect(within(target.closest('label')!).getByText('Neu in dieser Fassung')).toBeInTheDocument()
        expect(target).toHaveAttribute('aria-invalid', 'true')
        expect(screen.getByLabelText(/^Android minSdk/)).toHaveValue(21)
        expect(screen.getByText(/notes = alter Hinweis/)).toBeInTheDocument()
        expect(createButton()).toBeDisabled()
        fireEvent.change(target, { target: { value: 'apk' } })
        expect(screen.getByText(/notes = alter Hinweis/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Hinweis bestätigen und Werte verwerfen' }))
        expect(screen.queryByText(/notes = alter Hinweis/)).not.toBeInTheDocument()
        await waitFor(() => expect(createButton()).toBeEnabled())
        expect(screen.getByLabelText('Projektname')).toHaveValue('App')
        fireEvent.click(createButton())
        await waitFor(() => expect(posts()).toHaveLength(2))
        const values = posts()[1].development.settings.modules[second.entry.id]
        expect(values.moduleDigest).toBe(second.entry.digest)
        expect(values.values).toMatchObject({ channel: 'stable', minSdk: 21, target: 'apk' })
        expect(values.values).not.toHaveProperty('notes')
        expect(posts()[1].name).toBe('App')
    })

    it('marks a removed option after reload instead of sending the stale value', async () => {
        const server = raceServer(r1())
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'App' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        fireEvent.change(await screen.findByLabelText(/^Kanal/), { target: { value: 'beta' } })
        server.plugin = r2()
        fireEvent.click(createButton())
        fireEvent.click(await screen.findByRole('button', { name: 'Modulliste neu laden und prüfen' }))
        await screen.findByLabelText(/^Build-Ziel/)
        expect(screen.getByLabelText(/^Kanal/)).toHaveAttribute('aria-invalid', 'true')
        expect(screen.getByText('Diese Auswahl gibt es in der aktuellen Fassung nicht (mehr).')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Alle Moduleinstellungen auf Vorgaben zurücksetzen' }))
        expect(screen.getByLabelText(/^Kanal/)).toHaveValue('stable')
        expect(screen.getByLabelText(/^Kanal/)).not.toHaveAttribute('aria-invalid')
    })

    it('shows a disabled module honestly after reload and lets the user create a general project without losing the draft', async () => {
        const first = r1()
        const server = raceServer(first)
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Keeps name' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        await screen.findByLabelText(/^Kanal/)
        server.plugin = pluginModule(noRepository(), { enabled: false })
        fireEvent.click(createButton())
        expect(await screen.findByText('Modul nicht mehr aktuell.')).toBeInTheDocument()
        expect(screen.getByText(/Das Plugin dieses Moduls ist deaktiviert/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Modulliste neu laden und prüfen' }))
        expect(await screen.findByText(/Flutter ist derzeit nicht verwendbar \(Plugin deaktiviert\)/)).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: /^Flutter/ })).toBeDisabled()
        expect(createButton()).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: '„Allgemein“ wählen' }))
        expect(screen.getByRole('radio', { name: /^Allgemein/ })).toBeChecked()
        expect(screen.getByLabelText('Projektname')).toHaveValue('Keeps name')
        fireEvent.click(createButton())
        await waitFor(() => expect(posts()).toHaveLength(2))
        expect(posts()[1]).not.toHaveProperty('development')
        expect(posts()[1].name).toBe('Keeps name')
    })

    it('reports a removed module after reload and offers the general choice directly from the refusal', async () => {
        const server = raceServer(r1())
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Gone' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        await screen.findByLabelText(/^Kanal/)
        server.plugin = null
        fireEvent.click(createButton())
        expect(await screen.findByText(/nicht mehr installiert/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Modulliste neu laden und prüfen' }))
        expect(await screen.findByText('Das gewählte Modul ist nicht mehr installiert. Wähle „Allgemein“ oder ein anderes Modul.')).toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: /^Flutter/ })).not.toBeInTheDocument()
        expect(createButton()).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: '„Allgemein“ wählen' }))
        await waitFor(() => expect(createButton()).toBeEnabled())
    })

    it('resets list inputs visibly to the defaults of the new revision, matching the next creation body', async () => {
        // Both revisions default flavors to ["basis"]; R2 removes `notes`, which exposes the reset action.
        const withBasis = (module: FixtureModule) => module.detail.form.kind === 'fields' ? module.detail.form.fields : []
        const basis = (fields: ReturnType<typeof withBasis>) => fields.map(field => field.id === 'flavors' ? { ...field, default: ['basis'] } : field)
        const first = pluginModule(noRepository({ fields: basis(withBasis(r1())) }))
        const second = pluginModule(noRepository({ contentVersion: '2026.11.01-1', fields: basis(withBasis(r2())) }), { digestSeed: 'flutter-r2-basis' })
        const server = raceServer(first)
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Liste' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        const flavors = await screen.findByLabelText(/^Flavors/)
        expect(flavors).toHaveValue('basis')
        fireEvent.change(flavors, { target: { value: 'erhalten\nzweite-zeile' } })
        fireEvent.change(screen.getByLabelText(/^Hinweis für Übergaben/), { target: { value: 'weg' } })
        server.plugin = second
        fireEvent.click(createButton())
        fireEvent.click(await screen.findByRole('button', { name: 'Modulliste neu laden und prüfen' }))
        await screen.findByLabelText(/^Build-Ziel/)
        expect(screen.getByLabelText(/^Flavors/)).toHaveValue('erhalten\nzweite-zeile')
        fireEvent.click(screen.getByRole('button', { name: 'Alle Moduleinstellungen auf Vorgaben zurücksetzen' }))
        expect(screen.getByLabelText(/^Flavors/)).toHaveValue('basis')
        expect(screen.queryByText(/notes = weg/)).not.toBeInTheDocument()
        // Raw editing still works after the reset (trailing newline kept while typing).
        fireEvent.change(screen.getByLabelText(/^Flavors/), { target: { value: 'basis\n' } })
        expect(screen.getByLabelText(/^Flavors/)).toHaveValue('basis\n')
        fireEvent.change(screen.getByLabelText(/^Build-Ziel/), { target: { value: 'apk' } })
        await waitFor(() => expect(createButton()).toBeEnabled())
        fireEvent.click(createButton())
        await waitFor(() => expect(posts()).toHaveLength(2))
        const entry = posts()[1].development.settings.modules[second.entry.id]
        expect(entry.moduleDigest).toBe(second.entry.digest)
        expect(entry.values.flavors).toEqual(['basis'])
        expect(entry.values).not.toHaveProperty('notes')
        expect(posts()[1].name).toBe('Liste')
    })

    it('keeps authoritative field issues of a refused creation at their field', async () => {
        const first = r1()
        const server = raceServer(first)
        server.refusal = () => { throw new EvolvedApiError('invalid', 400, 'development_module_settings_invalid', false, { error: 'invalid', code: 'development_module_settings_invalid', issues: [{ path: ['modules', first.entry.id, 'values', 'appDirectory'], message: 'Use a repository-relative path without traversal' }] }) }
        mount()
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'App' } })
        fireEvent.click(await screen.findByRole('radio', { name: /^Flutter/ }))
        await screen.findByLabelText(/^Kanal/)
        fireEvent.click(createButton())
        expect(await screen.findByText(/Relativer Pfad im Repository/)).toBeInTheDocument()
        expect(screen.getByLabelText(/^App-Verzeichnis/)).toHaveAttribute('aria-invalid', 'true')
        expect(screen.queryByText('Modul nicht mehr aktuell.')).not.toBeInTheDocument()
    })
})
