import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    DEVELOPMENT_DATA_NOTICE, defaultDevelopmentSettings, defaultOdooSettings,
    type DevelopmentSettings,
} from '@hapi/protocol/evolvedDevelopment'
import {
    developmentSettingsToModuleSettings,
    type DevelopmentModuleSettings, type DevelopmentModuleSettingsInput, type ProjectDevelopmentModuleConfig,
} from '@hapi/protocol/developmentModules'
import { applicablePack } from '@hapi/protocol/developmentPacks'
import { EvolvedApiError, type EvolvedProject } from './api'
import { DevelopmentOverviewCard, ProjectDevelopmentPanel } from './ProjectDevelopment'
import { effectLabels } from './developmentApi'
import {
    adoptedEntry, builtinModule, digestOf, emptySettings, flutterDefinition, moduleConfig, moduleContext, pluginModule, statusFor, type FixtureModule,
} from '../test/developmentModules'

type Options = { method?: string; body?: unknown; signal?: AbortSignal }
const state = vi.hoisted(() => ({
    request: vi.fn(),
    navigate: vi.fn(),
    project: null as unknown as EvolvedProject,
    userId: 'user-1',
}))
vi.mock('./auth', () => ({ useEvolved: () => ({ api: { baseUrl: 'https://hub.example', request: state.request }, me: { user: { id: state.userId, displayName: 'Ada', isAdmin: false }, accessibleProjects: [state.project] }, project: state.project }) }))
vi.mock('@tanstack/react-router', () => ({
    Link: ({ children, to, search, params: _params, ...props }: React.PropsWithChildren<{ to: string; search?: Record<string, string>; params?: unknown }>) => <a href={`${to}?${new URLSearchParams(search)}`} {...props}>{children}</a>,
    useNavigate: () => state.navigate,
}))
vi.mock('./ModelCatalogInput', () => ({ ModelCatalogInput: () => null }))

const builtins = [builtinModule('odoo'), builtinModule('ios'), builtinModule('android')]
const project = (id: string, role: EvolvedProject['role'] = 'admin'): EvolvedProject => ({ id, teamId: 'team-1', name: `Projekt ${id}`, role, profile: 'workspace', rootPath: `/w/${id}` })
const odoo = (major: 19 | 20, extra: Partial<DevelopmentSettings> = {}): DevelopmentSettings => ({ ...defaultDevelopmentSettings('odoo'), odoo: defaultOdooSettings(major), repositoryId: '101', ...extra })
/** Builtin configuration written with the v1 helpers (lossless legacy adapter), served through contract v2. */
const config = (revision: number, settings: DevelopmentSettings, projectId = 'p1', extra: Partial<ProjectDevelopmentModuleConfig> = {}) =>
    moduleConfig(revision, developmentSettingsToModuleSettings(settings), builtins.map(module => module.entry), projectId, extra)
const repositoryCatalog = (ids = ['101'], local: 'ready' | 'missing' = 'ready') => ({
    connected: true, rootPath: '/w/p1', canSync: true, canPush: true, runner: { status: 'ready' },
    repositories: ids.map(id => ({ id, owner: 'acme', name: `repo${id}`, fullName: `acme/repo${id}`, permission: 'write', path: `/w/p1/repositories/acme/repo${id}`, cloneUrl: `https://github.com/acme/repo${id}.git`, local: { state: local, branch: 'main', dirty: false } })),
})

type Put = { expectedRevision: number; settings: DevelopmentModuleSettingsInput }
let server: { config: ProjectDevelopmentModuleConfig; canEdit: boolean; repositories: ReturnType<typeof repositoryCatalog>; modules: FixtureModule[]; put?: (body: Put, options: Options) => unknown; other?: (path: string, options: Options) => unknown }
/** What the hub stores for a PUT: unchanged plugin entries are kept, changed ones get fresh provenance. */
function stored(input: DevelopmentModuleSettingsInput): DevelopmentModuleSettings {
    const modules: DevelopmentModuleSettings['modules'] = {}
    for (const [id, entry] of Object.entries(input.modules)) {
        const previous = server.config.settings.modules[id]
        const fixture = server.modules.find(module => module.entry.id === id)
        modules[id] = previous && previous.moduleDigest === entry.moduleDigest && JSON.stringify(previous.values) === JSON.stringify(entry.values) ? previous : adoptedEntry(fixture!, entry.values, entry.moduleDigest)
    }
    return { ...input, modules }
}
const catalogEntries = () => server.modules.map(module => module.entry)
function route(path: string, options: Options = {}) {
    const base = `/projects/${server.config.projectId}/development`
    // The web app speaks contract v2 only; the legacy v1 configuration routes must never be used.
    if (path === base || path === `${base}/context` || path.startsWith(`${base}/knowledge`) || path === `${base}/doctor` || path === `${base}/inspect`) throw new Error(`v1 route used: ${path}`)
    if (path === `${base}/modules` && !options.method) return { contractVersion: 2, config: { ...server.config, active: statusFor(server.config.settings, catalogEntries()) }, catalog: { modules: catalogEntries() }, canEdit: server.canEdit }
    if (path === `${base}/modules` && options.method === 'PUT') {
        if (server.put) return server.put(options.body as Put, options)
        const body = options.body as Put
        server.config = moduleConfig(server.config.revision + 1, stored(body.settings), catalogEntries(), server.config.projectId)
        return { config: server.config }
    }
    if (path === `${base}/modules-context`) return moduleContext({ ...server.config, active: statusFor(server.config.settings, catalogEntries()) }, server.modules)
    const detail = server.modules.find(module => path === `${base}/modules/${encodeURIComponent(module.entry.id)}`)
    if (detail) return { module: detail.detail }
    if (path === `/projects/${server.config.projectId}/repositories`) return server.repositories
    if (server.other) { const value = server.other(path, options); if (value !== undefined) return value }
    throw new EvolvedApiError(`Unexpected ${options.method ?? 'GET'} ${path}`, 500)
}
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    const view = render(<QueryClientProvider client={client}><ProjectDevelopmentPanel /></QueryClientProvider>)
    return { ...view, client, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><ProjectDevelopmentPanel /></QueryClientProvider>) }
}
const calls = (fragment: string, method?: string) => state.request.mock.calls.filter(([path, options]) => String(path).includes(fragment) && (method === undefined || (options as Options | undefined)?.method === method))
const putBodies = () => calls('/development/modules', 'PUT').map(([, options]) => (options as Options).body as Put)
const saveButton = () => screen.getByRole('button', { name: 'Speichern' })
const agentCatalog = (id: string) => ({ agents: [{ id, available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] })

beforeEach(() => {
    state.project = project('p1'); state.userId = 'user-1'
    state.navigate.mockReset()
    server = { config: config(0, defaultDevelopmentSettings()), canEdit: true, repositories: repositoryCatalog(), modules: [...builtins] }
    state.request.mockReset().mockImplementation(async (path: string, options?: Options) => route(path, options))
})

describe('development module configuration (builtins)', () => {
    it('activates a module with a compact choice, saves the contract-v2 body with the seen revision and runs no checks', async () => {
        mount()
        expect(await screen.findByText(/Noch nicht eingerichtet/)).toBeInTheDocument()
        expect(saveButton()).toBeDisabled()
        expect(screen.getByText('Keine ungespeicherten Änderungen.')).toBeInTheDocument()
        expect(screen.getAllByRole('radio').map(radio => radio.getAttribute('aria-labelledby') && document.getElementById(radio.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Allgemein', 'Odoo 19 / 20', 'iOS', 'Android'])
        fireEvent.click(screen.getByRole('radio', { name: 'Odoo 19 / 20' }))
        expect(screen.getByRole('radio', { name: '20.0' })).toBeChecked()
        expect(screen.getByText('Ungespeicherter Entwurf')).toBeInTheDocument()
        expect(screen.getByText(/kein Sicherheitsprofil/)).toBeInTheDocument()
        await waitFor(() => expect(saveButton()).toBeEnabled())
        expect(calls('modules-doctor')).toHaveLength(0)
        expect(calls('modules-inspect')).toHaveLength(0)
        expect(calls('/build-status')).toHaveLength(0)
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Gespeichert als Revision 1/)).toBeInTheDocument()
        expect(putBodies()[0]).toEqual({ expectedRevision: 0, settings: { activeModuleId: 'builtin:odoo', repositoryId: null, odoo: defaultOdooSettings(20), ios: null, android: null, modules: {} } })
        expect(await screen.findByRole('heading', { name: 'Handbuch · Odoo 19 / 20' })).toBeInTheDocument()
        expect(calls('modules-doctor')).toHaveLength(0)
        expect(calls('/profile')).toHaveLength(0)
    })

    it('switches Odoo 19 and 20 knowledge only after saving the version', async () => {
        server.config = config(3, odoo(20))
        mount()
        expect(await screen.findByText('Local Odoo 20 runtime from source')).toBeInTheDocument()
        expect(screen.getByText('Prepare 19 -> 20 migration')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: '19.0' }))
        expect(screen.getByText(/Odoo 19 braucht Python ≥ 3.10/)).toBeInTheDocument()
        expect(screen.getByText('Local Odoo 20 runtime from source')).toBeInTheDocument()
        fireEvent.click(saveButton())
        expect(await screen.findByText('Local Odoo 19 runtime from source')).toBeInTheDocument()
        expect(screen.queryByText('Local Odoo 20 runtime from source')).not.toBeInTheDocument()
        expect(screen.queryByText('Prepare 19 -> 20 migration')).not.toBeInTheDocument()
        expect(putBodies()[0]).toMatchObject({ expectedRevision: 3, settings: { activeModuleId: 'builtin:odoo', odoo: { major: 19 } } })
    })

    it('keeps the save button disabled with a visible reason for invalid input', async () => {
        server.config = config(2, odoo(20))
        mount()
        const branch = await screen.findByLabelText('Entwicklungs-Branch (optional)')
        fireEvent.change(branch, { target: { value: 'feature..bad' } })
        expect(saveButton()).toBeDisabled()
        expect(screen.getByText('Entwicklungs-Branch: ist kein gültiger Branch-Name.')).toBeInTheDocument()
        expect(branch).toHaveAttribute('aria-invalid', 'true')
        fireEvent.change(branch, { target: { value: 'dev-feature' } })
        expect(saveButton()).toBeEnabled()
        fireEvent.change(screen.getByLabelText(/^Addon-Pfade im Repository/), { target: { value: '../outside' } })
        expect(screen.getByText(/Addon-Pfade \(Eintrag 1\): muss ein relativer Pfad/)).toBeInTheDocument()
        expect(saveButton()).toBeDisabled()
    })

    it('shows the persisted module read-only for non-admins and states the human-only licence rule', async () => {
        state.project = project('p1', 'viewer')
        server.canEdit = false
        server.config = config(4, { ...defaultDevelopmentSettings('android'), repositoryId: null })
        mount()
        expect(await screen.findByText('Nur Projektadministratoren können das Entwicklungsmodul ändern.')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Speichern' })).not.toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Android' })).toBeDisabled()
        expect(screen.getByText('Android-SDK-Lizenzen · nur durch Menschen')).toBeInTheDocument()
        expect(screen.queryByRole('checkbox', { name: /Lizenzbedingungen gelesen/ })).not.toBeInTheDocument()
        expect(screen.getByText(/Nur ein Projektadministrator kann diese Prüfung bestätigen, Agenten nicht/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Offizielle Android-SDK-Lizenzbedingungen lesen' })).toHaveAttribute('href', 'https://developer.android.com/studio/terms')
        expect(await screen.findByRole('button', { name: 'Werkzeuge prüfen' })).toBeDisabled()
    })

    it('records the Android licence acknowledgement only through an explicit admin save', async () => {
        server.config = config(1, { ...defaultDevelopmentSettings('android'), repositoryId: null })
        mount()
        const checkbox = await screen.findByRole('checkbox', { name: /Lizenzbedingungen gelesen/ })
        expect(checkbox).not.toBeChecked()
        expect(screen.getByText('Noch keine gespeicherte Bestätigung.')).toBeInTheDocument()
        fireEvent.click(checkbox)
        fireEvent.click(saveButton())
        await waitFor(() => expect(putBodies()).toHaveLength(1))
        expect(putBodies()[0]).toMatchObject({ expectedRevision: 1, settings: { activeModuleId: 'builtin:android', android: { sdkLicensesAcknowledged: true } } })
    })

    it('keeps the draft after a stale-tab conflict and lets the human choose', async () => {
        server.config = config(4, odoo(20))
        const newer = config(5, odoo(19, { repositoryId: null }))
        let conflicts = 1
        server.put = (body) => {
            if (conflicts-- > 0) throw new EvolvedApiError('stale', 409, 'development_revision_conflict', false, { error: 'stale', code: 'development_revision_conflict', config: newer })
            server.config = moduleConfig(6, stored(body.settings), catalogEntries()); return { config: server.config }
        }
        mount()
        fireEvent.change(await screen.findByLabelText('Entwicklungs-Branch (optional)'), { target: { value: 'my-branch' } })
        fireEvent.click(saveButton())
        const alert = await screen.findByRole('alert')
        expect(alert).toHaveTextContent('Die Konfiguration wurde inzwischen geändert (Revision 5 von Alex')
        expect(alert).toHaveTextContent('Dein Entwurf wurde nicht gespeichert und ist erhalten.')
        expect(screen.getByLabelText('Entwicklungs-Branch (optional)')).toHaveValue('my-branch')
        expect(saveButton()).toBeDisabled()
        fireEvent.click(within(alert).getByRole('button', { name: 'Entwurf behalten und auf Revision 5 aufbauen' }))
        expect(saveButton()).toBeEnabled()
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Gespeichert als Revision 6/)).toBeInTheDocument()
        expect(putBodies()[1]).toMatchObject({ expectedRevision: 5, settings: { odoo: { major: 20, developmentBranch: 'my-branch' } } })
    })

    it('never lets a late GET roll the known revision back after a CAS conflict', async () => {
        const android = (variant: string) => ({ ...defaultDevelopmentSettings('android'), repositoryId: null, android: { ...defaultDevelopmentSettings('android').android!, variant } })
        server.config = config(4, { ...defaultDevelopmentSettings('android'), repositoryId: null })
        const r5 = config(5, android('fromFive')), r6 = config(6, android('fromSix'))
        mount()
        const variant = await screen.findByLabelText('Variante')
        fireEvent.change(variant, { target: { value: 'myDraft' } })
        let deliverLateRead!: () => void
        let puts = 0
        state.request.mockImplementation(async (path: string, options?: Options) => {
            if (path === '/projects/p1/development/modules' && !options?.method) return new Promise(resolve => { deliverLateRead = () => resolve({ contractVersion: 2, config: r5, catalog: { modules: catalogEntries() }, canEdit: true }) })
            if (path === '/projects/p1/development/modules' && options?.method === 'PUT') {
                puts++
                if (puts === 1) throw new EvolvedApiError('stale', 409, 'development_revision_conflict', false, { error: 'stale', code: 'development_revision_conflict', config: r6 })
                server.config = moduleConfig(7, stored((options.body as Put).settings), catalogEntries()); return { config: server.config }
            }
            return route(path, options)
        })
        fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' }))
        await waitFor(() => expect(deliverLateRead).toBeTypeOf('function'))
        fireEvent.click(saveButton())
        expect(await screen.findByRole('alert')).toHaveTextContent('Die Konfiguration wurde inzwischen geändert (Revision 6')
        await act(async () => deliverLateRead())
        await waitFor(() => expect(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' })).toBeEnabled())
        expect(screen.getByRole('alert')).toHaveTextContent('(Revision 6')
        expect(screen.getByText(/^Gespeichert: Android · Revision 6/)).toBeInTheDocument()
        expect(screen.queryByText(/Revision 5/)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Variante')).toHaveValue('myDraft')
        fireEvent.click(screen.getByRole('button', { name: 'Entwurf behalten und auf Revision 6 aufbauen' }))
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Gespeichert als Revision 7/)).toBeInTheDocument()
        expect(putBodies().at(-1)).toMatchObject({ expectedRevision: 6, settings: { android: { variant: 'myDraft' } } })
    })

    it('can drop the draft in favour of the newer saved configuration', async () => {
        server.config = config(4, odoo(20))
        const newer = config(5, odoo(19, { repositoryId: null }))
        server.put = () => { throw new EvolvedApiError('stale', 409, 'development_revision_conflict', false, { error: 'stale', code: 'development_revision_conflict', config: newer }) }
        mount()
        fireEvent.change(await screen.findByLabelText('Entwicklungs-Branch (optional)'), { target: { value: 'mine' } })
        fireEvent.click(saveButton())
        fireEvent.click(await screen.findByRole('button', { name: 'Gespeicherte Fassung übernehmen (Entwurf verwerfen)' }))
        expect(screen.getByLabelText('Entwicklungs-Branch (optional)')).toHaveValue('')
        expect(screen.getByRole('radio', { name: '19.0' })).toBeChecked()
        expect(screen.queryByText('Ungespeicherter Entwurf')).not.toBeInTheDocument()
    })

    it('renders load and save failures as plain text without stale or assumed data', async () => {
        state.request.mockRejectedValueOnce(new EvolvedApiError('Not found', 404))
        const view = mount()
        expect(await screen.findByText('Nicht gefunden: Projekt oder Entwicklungsfunktion sind auf diesem Hub nicht verfügbar.')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Speichern' })).not.toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: 'Allgemein' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }))
        await screen.findByText(/Noch nicht eingerichtet/)
        server.put = () => { throw new EvolvedApiError('upstream', 503, 'development_repository_unverified') }
        fireEvent.click(screen.getByRole('radio', { name: 'iOS' }))
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Repository-Freigaben konnten gerade nicht geprüft werden/)).toBeInTheDocument()
        server.put = () => { throw { error: { nested: 'object' } } }
        fireEvent.click(saveButton())
        expect(await screen.findByText('Unbekannter Fehler.')).toBeInTheDocument()
        expect(view.container.textContent).not.toContain('[object Object]')
    })

    it('reports a configuration written by a newer HAPI instead of showing an empty module', async () => {
        state.request.mockImplementation(async (path: string, options?: Options) => {
            if (path === '/projects/p1/development/modules' && !options?.method) throw new EvolvedApiError('newer', 409, 'development_config_version_unsupported', undefined, { error: 'newer', code: 'development_config_version_unsupported', revision: 9, schemaVersion: 3 })
            return route(path, options)
        })
        mount()
        expect(await screen.findByText(/stammen von einer neueren HAPI-Fassung/)).toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: 'Allgemein' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Speichern' })).not.toBeInTheDocument()
    })

    it('keeps the dirty draft and last validated config when a background refresh fails, then recovers', async () => {
        server.config = config(4, odoo(20))
        mount()
        const branch = await screen.findByLabelText('Entwicklungs-Branch (optional)')
        fireEvent.change(branch, { target: { value: 'unsaved-work' } })
        state.request.mockImplementation(async (path: string, options?: Options) => {
            if (path === '/projects/p1/development/modules' && !options?.method) throw new EvolvedApiError('upstream', 503)
            return route(path, options)
        })
        fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' }))
        const alert = await screen.findByRole('alert')
        expect(alert).toHaveTextContent('Aktualisieren fehlgeschlagen: Der Dienst ist vorübergehend nicht verfügbar.')
        expect(alert).toHaveTextContent('(Revision 4); dein Entwurf bleibt erhalten')
        expect(screen.getByLabelText('Entwicklungs-Branch (optional)')).toHaveValue('unsaved-work')
        expect(screen.getByText('Ungespeicherter Entwurf')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: /Handbuch · Odoo/ })).toBeInTheDocument()
        state.request.mockImplementation(async (path: string, options?: Options) => route(path, options))
        fireEvent.click(within(alert).getByRole('button', { name: 'Erneut versuchen' }))
        await waitFor(() => expect(screen.queryByText(/Aktualisieren fehlgeschlagen/)).not.toBeInTheDocument())
        expect(screen.getByLabelText('Entwicklungs-Branch (optional)')).toHaveValue('unsaved-work')
        fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }))
        expect(screen.getByLabelText('Entwicklungs-Branch (optional)')).toHaveValue('')
    })

    it('drops cached data when a refresh reports lost access', async () => {
        server.config = config(4, odoo(20))
        mount()
        await screen.findByLabelText('Entwicklungs-Branch (optional)')
        state.request.mockImplementation(async (path: string, options?: Options) => {
            if (path === '/projects/p1/development/modules' && !options?.method) throw new EvolvedApiError('denied', 403)
            return route(path, options)
        })
        fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' }))
        expect(await screen.findByRole('heading', { name: 'Entwicklungsmodul nicht geladen' })).toBeInTheDocument()
        expect(screen.queryByLabelText('Entwicklungs-Branch (optional)')).not.toBeInTheDocument()
    })

    it('discards drafts on project change and ignores a late save response', async () => {
        let resolveSave!: (value: unknown) => void
        let signal: AbortSignal | undefined
        server.put = (_body, options) => { signal = options.signal; return new Promise(resolve => { resolveSave = resolve }) }
        const view = mount()
        fireEvent.click(await screen.findByRole('radio', { name: 'Odoo 19 / 20' }))
        await waitFor(() => expect(saveButton()).toBeEnabled())
        fireEvent.click(saveButton())
        await waitFor(() => expect(signal).toBeDefined())
        state.project = project('p2')
        server = { ...server, put: undefined, config: config(7, { ...defaultDevelopmentSettings('ios'), repositoryId: null }, 'p2') }
        view.rerenderPanel()
        expect(signal!.aborted).toBe(true)
        expect(await screen.findByText(/Gespeichert: iOS · Revision 7/)).toBeInTheDocument()
        await act(async () => resolveSave({ config: config(1, odoo(20), 'p1') }))
        expect(screen.queryByText(/Gespeichert als Revision 1/)).not.toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'iOS' })).toBeChecked()
        expect(screen.queryByText('Ungespeicherter Entwurf')).not.toBeInTheDocument()
    })

    it('explains a revoked or uncloned default repository instead of accepting it', async () => {
        server.config = config(2, odoo(20, { repositoryId: '999' }))
        mount()
        expect(await screen.findByText(/Repository 999 ist nicht mehr freigegeben/)).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Repository 999 · nicht verfügbar' })).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText(/^Standard-Repository für Sitzungen/), { target: { value: '101' } })
        expect(await screen.findByText(/acme\/repo101 · lesen und schreiben · geklont/)).toBeInTheDocument()
    })

    it('explains an uncloned default repository and links to the existing GitHub workflow', async () => {
        server.config = config(2, odoo(20))
        server.repositories = repositoryCatalog(['101'], 'missing')
        mount()
        const text = await screen.findByText(/acme\/repo101 ist freigegeben, aber noch nicht im Projekt geklont/)
        expect(within(text).getByRole('link', { name: 'Im Bereich GitHub öffnen' })).toHaveAttribute('href', expect.stringContaining('tab=github'))
    })

    it('states native iOS limits and that Xcode Cloud is not a live connection', async () => {
        server.config = config(1, { ...defaultDevelopmentSettings('ios'), repositoryId: null })
        mount()
        expect(await screen.findByText(/Linux-Runner können iOS-Apps weder mit Xcode bauen noch UIKit\/SwiftUI ausführen/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Xcode Cloud' }))
        expect(screen.getByText(/keine aktive Verbindung/)).toBeInTheDocument()
        expect(calls('modules-doctor')).toHaveLength(0)
    })
})

// ---------------------------------------------------------------- generic plugin modules

const flutter = () => pluginModule(flutterDefinition())
const flutterDefaults = { appDirectory: '.', channel: 'stable', minSdk: 0, web: false, flavors: [], platforms: [], notes: null, docs: null, branch: null, assets: null, signing: null }
/** R2 of the same module: a new required field, a removed option and a removed field. */
const flutterR2 = () => pluginModule(flutterDefinition({
    contentVersion: '2026.11.01-1',
    fields: [
        ...flutterDefinition().fields!.filter(field => field.id !== 'notes').map(field => field.id === 'channel' ? { ...field, options: [{ value: 'stable', label: 'Stabil' }] } : field),
        { id: 'target', kind: 'text', label: 'Build-Ziel', required: true, default: 'apk' },
    ],
}), { pluginVersion: '2.0.0', commitSha: 'e'.repeat(40), digestSeed: 'flutter-r2' })
function pluginProject(module: FixtureModule, values: Record<string, unknown>, extra: { digest?: string; revision?: number; settings?: Partial<DevelopmentModuleSettings> } = {}) {
    const settings = emptySettings({ activeModuleId: module.entry.id, repositoryId: '101', modules: { [module.entry.id]: adoptedEntry(module, values, extra.digest) }, ...extra.settings })
    server.config = moduleConfig(extra.revision ?? 3, settings, catalogEntries())
}

describe('generic plugin modules', () => {
    it('renders every field kind from the definition and saves typed values with false, 0 and empty optionals; inactive builtin values stay', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        server.config = config(2, odoo(20, { odoo: { ...defaultOdooSettings(20), developmentBranch: 'keep-me' } }))
        mount()
        fireEvent.click(await screen.findByRole('radio', { name: 'Flutter' }))
        expect(await screen.findByLabelText(/^App-Verzeichnis/)).toHaveValue('.')
        // Catalog entries carry no fields; only the selected module's detail is fetched.
        expect(calls('/development/modules/')).toHaveLength(1)
        expect(calls(`/development/modules/${encodeURIComponent(module.entry.id)}`)).toHaveLength(1)
        expect(screen.getByLabelText(/^Kanal/)).toHaveValue('stable')
        expect(screen.getByLabelText(/^Android minSdk/)).toHaveValue(0)
        expect(screen.getByText('Null ist erlaubt.')).toBeInTheDocument()
        expect(screen.getByLabelText(/^Android minSdk/)).toHaveAccessibleDescription('Null ist erlaubt.')
        expect(screen.getByLabelText('Web-Ziel')).not.toBeChecked()
        expect(screen.getByRole('group', { name: /Plattformen/ })).toBeInTheDocument()
        expect(screen.getByLabelText(/^Dokumentation/)).toHaveAttribute('type', 'url')
        expect(within(screen.getByLabelText(/^Asset-Repository/)).getByRole('option', { name: 'acme/repo101' })).toBeInTheDocument()
        fireEvent.click(screen.getByLabelText('Web-Ziel'))
        fireEvent.click(screen.getByLabelText('Web-Ziel'))
        fireEvent.change(screen.getByLabelText(/^Flavors/), { target: { value: 'free\npaid\n' } })
        fireEvent.click(within(screen.getByRole('group', { name: /Plattformen/ })).getByLabelText('Android'))
        fireEvent.change(screen.getByLabelText(/^Hinweis für Übergaben/), { target: { value: 'Übergabe für Jürgen' } })
        fireEvent.change(screen.getByLabelText(/^Hinweis für Übergaben/), { target: { value: '' } })
        fireEvent.change(screen.getByLabelText(/^Asset-Repository/), { target: { value: '101' } })
        await waitFor(() => expect(saveButton()).toBeEnabled())
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Gespeichert als Revision 3/)).toBeInTheDocument()
        expect(putBodies()[0]).toEqual({ expectedRevision: 2, settings: {
            activeModuleId: module.entry.id, repositoryId: '101', ios: null, android: null, odoo: { ...defaultOdooSettings(20), developmentBranch: 'keep-me' },
            modules: { [module.entry.id]: { moduleDigest: module.entry.digest, values: { ...flutterDefaults, web: false, minSdk: 0, flavors: ['free', 'paid'], platforms: ['android'], notes: null, assets: '101' } } },
        } })
    })

    it('marks invalid fields accessibly, focuses the first one on Enter and sends nothing', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        mount()
        const directory = await screen.findByLabelText(/^App-Verzeichnis/)
        fireEvent.change(directory, { target: { value: '   ' } })
        fireEvent.change(screen.getByLabelText(/^Android minSdk/), { target: { value: '120' } })
        const error = screen.getByText('Pflichtfeld: bitte ausfüllen.')
        expect(directory).toHaveAttribute('aria-invalid', 'true')
        expect(directory.getAttribute('aria-describedby')).toContain(error.id)
        expect(screen.getByText('Erlaubt sind Werte von 0 bis 99.')).toBeInTheDocument()
        expect(saveButton()).toBeDisabled()
        expect(screen.getByText(/2 Felder sind ungültig: App-Verzeichnis, Android minSdk/)).toBeInTheDocument()
        const minSdk = screen.getByLabelText(/^Android minSdk/)
        minSdk.focus()
        fireEvent.keyDown(minSdk, { key: 'Enter' })
        expect(document.activeElement).toBe(directory)
        fireEvent.submit(directory.closest('form')!)
        expect(document.activeElement).toBe(directory)
        expect(putBodies()).toHaveLength(0)
        expect(screen.queryByText(/Gespeichert als/)).not.toBeInTheDocument()
        fireEvent.change(directory, { target: { value: '../escape' } })
        expect(screen.getByText(/Relativer Pfad im Repository/)).toBeInTheDocument()
        fireEvent.change(directory, { target: { value: 'apps/mobile' } })
        fireEvent.change(screen.getByLabelText(/^Android minSdk/), { target: { value: '' } })
        await waitFor(() => expect(saveButton()).toBeEnabled())
        fireEvent.submit(directory.closest('form')!)
        await waitFor(() => expect(putBodies()).toHaveLength(1))
        expect(putBodies()[0]!.settings.modules[module.entry.id]!.values).toMatchObject({ appDirectory: 'apps/mobile', minSdk: null })
    })

    it('keeps an authoritative server field error visible at its field until that field changes', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        server.put = () => { throw new EvolvedApiError('invalid', 400, 'development_module_settings_invalid', false, { error: 'invalid', code: 'development_module_settings_invalid', issues: [
            { path: ['modules', module.entry.id, 'values', 'branch'], message: 'Invalid branch name' }, { path: ['repositoryId'], message: 'Server-only rule' }] }) }
        mount()
        const branch = await screen.findByLabelText(/^Arbeits-Branch/)
        fireEvent.change(branch, { target: { value: 'release' } })
        fireEvent.click(saveButton())
        expect(await screen.findByText('Kein gültiger Branch-Name.')).toBeInTheDocument()
        expect(branch).toHaveAttribute('aria-invalid', 'true')
        await waitFor(() => expect(document.activeElement).toBe(branch))
        expect(screen.getByText(/Die Moduleinstellungen wurden vom Server abgelehnt/)).toBeInTheDocument()
        expect(screen.getByText(/Standard-Repository: hat kein gültiges Format/)).toBeInTheDocument()
        expect(screen.queryByText(/Gespeichert als/)).not.toBeInTheDocument()
        fireEvent.change(branch, { target: { value: 'release-2' } })
        expect(screen.queryByText('Kein gültiger Branch-Name.')).not.toBeInTheDocument()
        expect(branch).not.toHaveAttribute('aria-invalid')
    })

    it('preserves inactive plugin values when switching modules and back', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, { ...flutterDefaults, channel: 'beta', minSdk: 21 })
        mount()
        expect(await screen.findByLabelText(/^Kanal/)).toHaveValue('beta')
        fireEvent.click(screen.getByRole('radio', { name: 'Odoo 19 / 20' }))
        expect(screen.queryByLabelText(/^Kanal/)).not.toBeInTheDocument()
        expect(screen.getByText('Aufbewahrte Einstellungen anderer Module (1)')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Flutter' }))
        expect(await screen.findByLabelText(/^Kanal/)).toHaveValue('beta')
        expect(screen.getByLabelText(/^Android minSdk/)).toHaveValue(21)
        fireEvent.click(screen.getByRole('radio', { name: 'Odoo 19 / 20' }))
        await waitFor(() => expect(saveButton()).toBeEnabled())
        fireEvent.click(saveButton())
        await waitFor(() => expect(putBodies()).toHaveLength(1))
        const body = putBodies()[0]!.settings
        expect(body.activeModuleId).toBe('builtin:odoo')
        expect(body.modules[module.entry.id]).toEqual({ moduleDigest: module.entry.digest, values: { ...flutterDefaults, channel: 'beta', minSdk: 21 } })
    })

    it('drops an entry that was only looked at, and removes a kept configuration only by an explicit save', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        server.config = config(2, odoo(20))
        mount()
        fireEvent.click(await screen.findByRole('radio', { name: 'Flutter' }))
        await screen.findByLabelText(/^Kanal/)
        fireEvent.click(screen.getByRole('radio', { name: 'Odoo 19 / 20' }))
        expect(screen.queryByText(/Aufbewahrte Einstellungen anderer Module/)).not.toBeInTheDocument()
        expect(screen.getByText('Keine ungespeicherten Änderungen.')).toBeInTheDocument()
        server.config = moduleConfig(3, { ...server.config.settings, modules: { [module.entry.id]: adoptedEntry(module, flutterDefaults) } }, catalogEntries())
        fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Aufbewahrte Einstellungen von Flutter entfernen' }))
        fireEvent.click(saveButton())
        await waitFor(() => expect(putBodies()).toHaveLength(1))
        expect(putBodies()[0]).toMatchObject({ expectedRevision: 3, settings: { activeModuleId: 'builtin:odoo', modules: {} } })
    })

    it('serves two previously unknown modules with the same bundle without mixing their similar fields', async () => {
        const first = pluginModule(flutterDefinition({ id: `m${Math.random().toString(36).slice(2, 8)}`, title: 'Zufallsmodul A', recipes: [], tasks: [], inspect: null,
            fields: [{ id: 'path', kind: 'text', label: 'Pfad A', required: true, default: 'a' }, { id: 'paths', kind: 'boolean', label: 'Mehrere A', default: false }] }), { pluginId: crypto.randomUUID() })
        const second = pluginModule(flutterDefinition({ id: `n${Math.random().toString(36).slice(2, 8)}`, title: 'Zufallsmodul B', recipes: [], tasks: [], inspect: null,
            fields: [{ id: 'paths', kind: 'number', label: 'Anzahl B', min: 0, max: 5, default: 0 }, { id: 'path', kind: 'select', label: 'Pfad B', options: [{ value: 'x', label: 'X' }], default: null }] }), { pluginId: crypto.randomUUID() })
        server.modules = [...builtins, first, second]
        server.config = config(1, defaultDevelopmentSettings())
        mount()
        fireEvent.click(await screen.findByRole('radio', { name: 'Zufallsmodul A' }))
        fireEvent.change(await screen.findByLabelText(/^Pfad A/), { target: { value: 'eigener-pfad' } })
        fireEvent.click(screen.getByRole('radio', { name: 'Zufallsmodul B' }))
        fireEvent.change(await screen.findByLabelText(/^Anzahl B/), { target: { value: '3' } })
        expect(screen.queryByLabelText(/^Pfad A/)).not.toBeInTheDocument()
        await waitFor(() => expect(saveButton()).toBeEnabled())
        fireEvent.click(saveButton())
        await waitFor(() => expect(putBodies()).toHaveLength(1))
        expect(putBodies()[0]!.settings).toMatchObject({ activeModuleId: second.entry.id, modules: {
            [first.entry.id]: { moduleDigest: first.entry.digest, values: { path: 'eigener-pfad', paths: false } },
            [second.entry.id]: { moduleDigest: second.entry.digest, values: { paths: 3, path: null } },
        } })
    })

    it('requires explicit adoption of a plugin update, explains new and removed fields and saves the new digest only on demand', async () => {
        const r1 = flutter(), r2 = flutterR2()
        server.modules = [...builtins, r2]
        pluginProject(r2, { ...flutterDefaults, channel: 'beta', notes: 'alter Hinweis' }, { digest: r1.entry.digest })
        mount()
        expect(await screen.findByText('Neue Modulfassung installiert.', { exact: false })).toBeInTheDocument()
        expect(screen.getAllByText('Neue Fassung muss übernommen werden').length).toBeGreaterThan(0)
        expect(screen.getByRole('heading', { name: 'Aufgaben, Prüfungen und Handbuch gesperrt' })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: /^Handbuch ·/ })).not.toBeInTheDocument()
        expect(screen.queryByLabelText(/^Kanal/)).not.toBeInTheDocument()
        expect(putBodies()).toHaveLength(0)
        fireEvent.click(await screen.findByRole('button', { name: 'Installierte Fassung übernehmen und Werte prüfen' }))
        expect(screen.getByText(/Übernahme vorbereitet \(noch nicht gespeichert\)/)).toBeInTheDocument()
        expect(screen.getByText(/notes = alter Hinweis/)).toBeInTheDocument()
        const target = screen.getByLabelText(/^Build-Ziel/)
        expect(target).toHaveValue('apk')
        expect(within(target.closest('label')!).getByText('Neu in dieser Fassung')).toBeInTheDocument()
        const channel = screen.getByLabelText(/^Kanal/)
        expect(channel).toHaveValue('beta')
        expect(channel).toHaveAttribute('aria-invalid', 'true')
        expect(screen.getByText('Diese Auswahl gibt es in der aktuellen Fassung nicht (mehr).')).toBeInTheDocument()
        expect(saveButton()).toBeDisabled()
        fireEvent.change(channel, { target: { value: 'stable' } })
        await waitFor(() => expect(saveButton()).toBeEnabled())
        fireEvent.click(saveButton())
        await waitFor(() => expect(putBodies()).toHaveLength(1))
        const { notes: _removed, ...kept } = { ...flutterDefaults, channel: 'stable', notes: null }
        expect(putBodies()[0]!.settings.modules[r2.entry.id]).toEqual({ moduleDigest: r2.entry.digest, values: { ...kept, target: 'apk' } })
        expect(await screen.findByRole('heading', { name: 'Handbuch · Flutter' })).toBeInTheDocument()
    })

    it('reports a changed module on save, reloads the catalog and keeps the draft', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        server.put = () => { throw new EvolvedApiError('changed', 409, 'development_module_changed', false, { error: 'changed', code: 'development_module_changed', moduleId: module.entry.id, installedDigest: digestOf('newer') }) }
        mount()
        const channel = await screen.findByLabelText(/^Kanal/)
        fireEvent.change(channel, { target: { value: 'beta' } })
        const catalogReads = () => calls('/development/modules').filter(([path, options]) => path === '/projects/p1/development/modules' && !(options as Options | undefined)?.method).length
        const before = catalogReads()
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Das Entwicklungsmodul wurde inzwischen geändert/)).toBeInTheDocument()
        await waitFor(() => expect(catalogReads()).toBeGreaterThan(before))
        expect(screen.getByLabelText(/^Kanal/)).toHaveValue('beta')
        expect(screen.getByText('Ungespeicherter Entwurf')).toBeInTheDocument()
    })

    it('keeps a disabled plugin module visible and read-only without falling back, while other settings stay editable', async () => {
        const module = pluginModule(flutterDefinition(), { enabled: false })
        const other = pluginModule(flutterDefinition({ id: 'other', title: 'Anderes Modul' }), { enabled: false, pluginId: '00000000-0000-4000-8000-0000000000b2' })
        server.modules = [...builtins, module, other]
        pluginProject(module, { ...flutterDefaults, channel: 'beta' })
        server.repositories = repositoryCatalog(['101', '102'])
        mount()
        expect(await screen.findByText(/Das Plugin dieses Moduls ist deaktiviert. Die Einstellungen bleiben erhalten/)).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Flutter' })).toBeChecked()
        expect(screen.getByRole('radio', { name: 'Allgemein' })).not.toBeChecked()
        expect(screen.getByRole('radio', { name: 'Anderes Modul' })).toBeDisabled()
        expect(await screen.findByLabelText(/^Kanal/)).toBeDisabled()
        expect(screen.getByLabelText(/^Kanal/)).toHaveValue('beta')
        expect(screen.queryByRole('button', { name: 'Sitzung vorbereiten' })).not.toBeInTheDocument()
        fireEvent.change(screen.getByLabelText(/^Standard-Repository für Sitzungen/), { target: { value: '102' } })
        await waitFor(() => expect(saveButton()).toBeEnabled())
        fireEvent.click(saveButton())
        await waitFor(() => expect(putBodies()).toHaveLength(1))
        expect(putBodies()[0]!.settings).toMatchObject({ activeModuleId: module.entry.id, repositoryId: '102', modules: { [module.entry.id]: { moduleDigest: module.entry.digest, values: { channel: 'beta' } } } })
    })

    it('shows a no longer installed module with its stored values instead of an empty or general state', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, { ...flutterDefaults, channel: 'beta' })
        server.modules = [...builtins]
        mount()
        expect(await screen.findByText('Dieses Modul ist nicht installiert.')).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Plugin-Modul „flutter“' })).toBeChecked()
        expect(screen.getByRole('radio', { name: 'Allgemein' })).not.toBeChecked()
        expect(screen.getByText(/channel:/)).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Aufgaben, Prüfungen und Handbuch gesperrt' })).toBeInTheDocument()
        expect(calls('/development/modules/')).toHaveLength(0)
    })

    it('shows plugin provenance, adopted revision and the honest overview state', async () => {
        const r1 = flutter(), r2 = flutterR2()
        server.modules = [...builtins, r2]
        pluginProject(r2, flutterDefaults, { digest: r1.entry.digest })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><DevelopmentOverviewCard /></QueryClientProvider>)
        expect(await screen.findByText(/Flutter · Neue Fassung muss übernommen werden · mit Standard-Repository/)).toBeInTheDocument()
        expect(screen.getByText('Status ansehen')).toBeInTheDocument()
    })
})

describe('development checks and status', () => {
    const doctorResult = (moduleId: string, moduleDigest: string, provider: { id: string; version: number }) => ({ contractVersion: 2, moduleId, moduleDigest, provider, observedAt: 1_760_000_200_000, durationMs: 1200, host: { os: 'linux', arch: 'x64', image: null }, truncated: false,
        checks: [
            { id: 'python', label: 'Python', category: 'runtime', state: 'ready', version: 'Python 3.13.5' },
            { id: 'postgresql.server', label: 'PostgreSQL server', category: 'database', state: 'missing', remedy: { kind: 'operator', text: 'Use the development runner image.', url: 'https://www.postgresql.org/download/' } },
            { id: 'odoo.source', label: 'Odoo source', category: 'toolchain', state: 'unknown' },
            { id: 'browser', label: 'Headless browser', category: 'runtime', state: 'unsupported' },
        ] })

    it('runs the doctor only on an explicit click, binds the shown module revision and shows real per-check states', async () => {
        server.config = config(2, odoo(20))
        const odooModule = builtins[0]!.entry
        let doctorBody: unknown
        server.other = (path, options) => {
            if (!path.endsWith('/development/modules-doctor')) return undefined
            doctorBody = options.body
            return { projectId: 'p1', revision: server.config.revision, moduleId: odooModule.id, moduleDigest: odooModule.digest, runner: { status: 'ready', machineId: 'm1', missingCapabilities: [] }, result: doctorResult(odooModule.id, odooModule.digest, { id: 'builtin.odoo', version: 1 }) }
        }
        const { container } = mount()
        expect(await screen.findByText('Noch keine Werkzeugprüfung für diese Revision.')).toBeInTheDocument()
        expect(calls('modules-doctor')).toHaveLength(0)
        fireEvent.change(screen.getByLabelText('Entwicklungs-Branch (optional)'), { target: { value: 'draft' } })
        expect(screen.getByRole('button', { name: 'Werkzeuge prüfen' })).toBeDisabled()
        expect(screen.getAllByText(/Prüfungen nutzen nur die gespeicherte Konfiguration/).length).toBeGreaterThan(0)
        fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }))
        fireEvent.click(screen.getByRole('button', { name: 'Werkzeuge prüfen' }))
        const result = await screen.findByLabelText('Ergebnis der Werkzeugprüfung')
        expect(doctorBody).toEqual({ moduleId: 'builtin:odoo', moduleDigest: odooModule.digest })
        expect(calls('modules-doctor', 'POST')).toHaveLength(1)
        expect(within(result).getByText('Gefunden')).toBeInTheDocument()
        expect(within(result).getByText('Fehlt')).toBeInTheDocument()
        expect(within(result).getByText('Unbekannt')).toBeInTheDocument()
        expect(within(result).getByText('Nicht unterstützt')).toBeInTheDocument()
        expect(within(result).getByText(/Image: unbekannt/)).toBeInTheDocument()
        expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
        fireEvent.change(screen.getByLabelText('Entwicklungs-Branch (optional)'), { target: { value: 'next' } })
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Gespeichert als Revision 3/)).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByLabelText('Ergebnis der Werkzeugprüfung')).not.toBeInTheDocument())
        expect(calls('modules-doctor', 'POST')).toHaveLength(1)
    })

    it('reports a not-ready or unsupported runner honestly instead of a green result', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        const responses = [{ status: 'upgrade_required', missingCapabilities: ['evolvedDevelopment.provider.hapi.toolchain.v1'] }, { status: 'unsupported', missingCapabilities: [] }]
        server.other = path => {
            if (!path.endsWith('/modules-doctor')) return undefined
            return { projectId: 'p1', revision: 3, moduleId: module.entry.id, moduleDigest: module.entry.digest, runner: { machineId: null, ...responses.shift()! }, result: null }
        }
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Werkzeuge prüfen' }))
        expect(await screen.findByText(/kennt diese Prüfung noch nicht/)).toBeInTheDocument()
        expect(screen.getByText(/Dem Runner fehlt die passende Prüffähigkeit/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Werkzeuge prüfen' }))
        expect(await screen.findByText(/wird von diesem HAPI nicht unterstützt/)).toBeInTheDocument()
        expect(screen.queryByText('Gefunden')).not.toBeInTheDocument()
    })

    it('refuses to show a doctor answer for another module revision', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        server.other = path => path.endsWith('/modules-doctor') ? { projectId: 'p1', revision: 3, moduleId: module.entry.id, moduleDigest: digestOf('other'), runner: { status: 'ready', machineId: 'm1', missingCapabilities: [] }, result: doctorResult(module.entry.id, digestOf('other'), { id: 'hapi.toolchain', version: 1 }) } : undefined
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Werkzeuge prüfen' }))
        expect(await screen.findByText(/gehört zu einer anderen Modulfassung/)).toBeInTheDocument()
        expect(screen.queryByLabelText('Ergebnis der Werkzeugprüfung')).not.toBeInTheDocument()
    })

    it('distinguishes a missing status permission from no status and renders only https links', async () => {
        server.config = config(2, odoo(20, { odoo: { ...defaultOdooSettings(20), hosting: 'odoo_sh' } }))
        const responses = [
            { state: 'permission_missing', sha: null, statuses: [], totalCount: 0, message: 'GitHub denied the status read.' },
            { state: 'no_status', sha: 'a'.repeat(40), statuses: [], totalCount: 0, message: 'No status reported.' },
            { state: 'failure', sha: 'b'.repeat(40), totalCount: 2, message: 'Combined status.', statuses: [
                { context: 'odoo.sh', state: 'failure', description: 'Build failed', targetUrl: 'https://www.odoo.sh/project/acme/build/1', updatedAt: '2026-10-17T10:00:00Z' },
                { context: 'other', state: 'success', description: null, targetUrl: null, updatedAt: null },
            ] },
            { state: 'success', sha: 'c'.repeat(40), totalCount: 1, message: 'Combined status.', statuses: [
                { context: 'evil', state: 'success', description: null, targetUrl: 'javascript:alert(1)', updatedAt: null },
            ] },
        ]
        const refs: string[] = []
        server.other = path => {
            if (!path.includes('/build-status')) return undefined
            refs.push(path)
            return { projectId: 'p1', revision: 2, repositoryId: '101', fullName: 'acme/odoo-addons', ref: 'main', observedAt: 1_760_000_300_000, truncated: false, ...responses.shift()! }
        }
        const { container } = mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Status abrufen' }))
        expect(await screen.findByText('Berechtigung fehlt')).toBeInTheDocument()
        expect(screen.getByText(/Commit statuses: Read-only/)).toBeInTheDocument()
        expect(screen.getByText(/Schreibrechte auf Inhalte sind dafür nicht nötig/)).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('Branch oder Commit (optional)'), { target: { value: 'bad ref' } })
        expect(screen.getByRole('button', { name: 'Status abrufen' })).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Branch oder Commit (optional)'), { target: { value: 'main' } })
        fireEvent.click(screen.getByRole('button', { name: 'Status abrufen' }))
        expect(await screen.findByText('Keine Statusmeldung')).toBeInTheDocument()
        expect(screen.getByText(/Das ist kein Erfolg/)).toBeInTheDocument()
        expect(screen.getByText('aaaaaaaaaaaa')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Status abrufen' }))
        expect(await screen.findByText('Build failed')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute('href', 'https://www.odoo.sh/project/acme/build/1')
        fireEvent.click(screen.getByRole('button', { name: 'Status abrufen' }))
        expect(await screen.findByText(/Antwort des Servers hat ein unerwartetes Format/)).toBeInTheDocument()
        expect(screen.queryByText('Build failed')).not.toBeInTheDocument()
        expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
        expect(refs[0]).toBe('/projects/p1/development/build-status')
        expect(refs[1]).toBe('/projects/p1/development/build-status?ref=main')
    })
})

describe('development handbook and tasks', () => {
    it('lists bundled topics and loads a topic with its versioned sources through the module knowledge route', async () => {
        server.config = config(2, odoo(19))
        const odooModule = builtins[0]!.entry
        server.other = path => {
            const base = { projectId: 'p1', revision: 2, moduleId: odooModule.id, moduleDigest: odooModule.digest, dataNotice: DEVELOPMENT_DATA_NOTICE }
            if (path.includes('/modules-knowledge?topic=odoo-versions')) {
                const { appliesTo: _appliesTo, ...topic } = applicablePack(developmentSettingsToV1(server.config.settings))!.topics.find(item => item.id === 'odoo-versions')!
                return { ...base, topic: { ...topic, when: null }, results: [], total: 1, truncated: false }
            }
            if (path.includes('/modules-knowledge?q=')) return { ...base, topic: null, total: 0, truncated: false, results: [] }
            return undefined
        }
        mount()
        const heading = await screen.findByText('Odoo 19 and 20: versions and runtime minimums')
        expect(screen.getByText(/Funktioniert ohne Graph-Gedächtnis/)).toBeInTheDocument()
        expect(screen.getByText(/Mitgeliefert mit HAPI, Fassung/)).toBeInTheDocument()
        const details = heading.closest('details')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        await waitFor(() => expect(calls('/modules-knowledge?topic=odoo-versions')).toHaveLength(1))
        const links = await within(details).findAllByRole('link')
        expect(links.length).toBeGreaterThan(1)
        for (const link of links) expect(link).toHaveAttribute('href', expect.stringMatching(/^https:\/\//))
        expect(within(details).getAllByText(/· 20\.0|· 19\.0/).length).toBeGreaterThan(0)
        expect(within(details).getAllByText(/geprüft am 2026-10-17/).length).toBeGreaterThan(0)
        fireEvent.change(screen.getByLabelText('Handbuch durchsuchen'), { target: { value: 'xyz' } })
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        expect(await screen.findByText(/0 Treffer für „xyz“/)).toBeInTheDocument()
        expect(calls('/modules-knowledge?q=xyz')).toHaveLength(1)
    })

    it('starts a builtin task once with explicit operation, module revision and repository and opens the session', async () => {
        server.config = config(2, odoo(20))
        const odooModule = builtins[0]!.entry
        let finish!: (value: unknown) => void
        server.other = (path) => {
            if (path.endsWith('/agent-catalog')) return agentCatalog('builtin:implementation')
            if (path.includes('/agent-catalog/builtin%3Aimplementation/start')) return new Promise(resolve => { finish = resolve })
            return undefined
        }
        mount()
        const card = (await screen.findByText('Develop a module change')).closest('article')!
        expect(within(card).getByText('Führt Projektcode aus')).toBeInTheDocument()
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: 'Sitzung starten: Develop a module change' })
        await waitFor(() => expect(within(form).getByLabelText('Runner')).toHaveValue('m1'))
        expect(within(form).getByLabelText(/^Arbeitsort/)).toHaveValue('101')
        expect(within(form).queryByRole('option', { name: 'Projektordner' })).not.toBeInTheDocument()
        expect(within(form).getByLabelText('Arbeitsordner')).toHaveTextContent('Arbeitsordner (Standard-Repository)/w/p1/repositories/acme/repo101')
        const effects = applicablePack(developmentSettingsToV1(server.config.settings))!.tasks.find(item => item.id === 'odoo-develop-module')!.effects
        expect(within(form).getByText(/^Auswirkungen:/)).toHaveTextContent(effects.map(effect => effectLabels[effect]).join(' · '))
        expect(within(form).queryByRole('checkbox')).not.toBeInTheDocument()
        const submit = within(form).getByRole('button', { name: 'Sitzung starten' })
        await waitFor(() => expect(submit).toBeEnabled())
        fireEvent.click(submit); fireEvent.click(submit); fireEvent.submit(form)
        const starts = calls('/start', 'POST')
        expect(starts).toHaveLength(1)
        const body = (starts[0]![1] as Options).body as Record<string, unknown>
        expect(body).toMatchObject({ machineId: 'm1', provider: 'claude', repositoryId: '101', development: { contractVersion: 2, moduleId: 'builtin:odoo', moduleDigest: odooModule.digest, taskId: 'odoo-develop-module', revision: 2 } })
        expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/)
        expect(body.task).toContain('Follow the conventions of the configured Odoo major')
        await act(async () => finish({ sessionId: 'session-42', operationId: body.operationId, acknowledged: 'persisted' }))
        await waitFor(() => expect(state.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'session-42' } }))
    })

    it('starts a plugin module task with the displayed module id and digest, without an extra approval step', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        server.other = path => {
            if (path.endsWith('/agent-catalog')) return agentCatalog('builtin:tests')
            if (path.includes('/agent-catalog/builtin%3Atests/start')) return { sessionId: 'session-7', operationId: (state.request.mock.calls.at(-1)![1] as Options & { body: { operationId: string } }).body.operationId, acknowledged: 'persisted' }
            return undefined
        }
        mount()
        const card = (await screen.findByText('Flutter-Tests ausführen')).closest('article')!
        expect(within(card).getByText('Führt Projektcode aus')).toBeInTheDocument()
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: 'Sitzung starten: Flutter-Tests ausführen' })
        expect(within(form).getByText(/Modul: Flutter · Fassung 2026.10.17-1 · Plugin Beispiel-Plugin 1.0.0/)).toBeInTheDocument()
        expect(within(form).queryByRole('checkbox')).not.toBeInTheDocument()
        const submit = within(form).getByRole('button', { name: 'Sitzung starten' })
        await waitFor(() => expect(submit).toBeEnabled())
        fireEvent.click(submit)
        await waitFor(() => expect(state.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'session-7' } }))
        expect((calls('/start', 'POST')[0]![1] as Options).body).toMatchObject({ repositoryId: '101', task: 'Führe die Flutter-Tests aus.',
            development: { contractVersion: 2, moduleId: module.entry.id, moduleDigest: module.entry.digest, taskId: 'tests', revision: 3 } })
    })

    it('refuses a start for a changed module revision, refreshes and never retries on its own', async () => {
        const module = flutter(), r2 = flutterR2()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        server.other = path => {
            if (path.endsWith('/agent-catalog')) return agentCatalog('builtin:tests')
            if (path.includes('/start')) {
                // The plugin was updated after the form was opened: the hub refuses before reserving anything.
                server.modules = [...builtins, r2]
                throw new EvolvedApiError('changed', 409, 'development_module_changed', false, { error: 'changed', code: 'development_module_changed', reserved: false, moduleId: module.entry.id, installedDigest: r2.entry.digest })
            }
            return undefined
        }
        mount()
        fireEvent.click(within((await screen.findByText('Flutter-Tests ausführen')).closest('article')!).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: /^Sitzung starten/ })
        await waitFor(() => expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeEnabled())
        fireEvent.click(within(form).getByRole('button', { name: 'Sitzung starten' }))
        expect(await screen.findByRole('heading', { name: 'Aufgaben, Prüfungen und Handbuch gesperrt' })).toBeInTheDocument()
        expect(screen.queryByText('Flutter-Tests ausführen')).not.toBeInTheDocument()
        expect(screen.getByText('Neue Modulfassung installiert.', { exact: false })).toBeInTheDocument()
        expect(calls('/start', 'POST')).toHaveLength(1)
        expect(state.navigate).not.toHaveBeenCalled()
    })

    it('hides tasks whose context belongs to another module revision than the configuration reports', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        pluginProject(module, flutterDefaults)
        state.request.mockImplementation(async (path: string, options?: Options) => {
            const value = route(path, options)
            if (path.endsWith('/modules-context')) return { ...value as object, module: { ...(value as { module: object }).module, digest: digestOf('stale-context') } }
            return value
        })
        mount()
        expect(await screen.findByText(/oder einer anderen Modulfassung/)).toBeInTheDocument()
        expect(screen.queryByText('Flutter-Tests ausführen')).not.toBeInTheDocument()
    })

    it('keeps the operation and module binding after an uncertain start and retries with the identical body', async () => {
        server.config = config(2, odoo(20))
        let attempts = 0
        server.other = (path) => {
            if (path.endsWith('/agent-catalog')) return agentCatalog('builtin:review')
            if (path.includes('/start')) { attempts++; throw new EvolvedApiError('timeout', 504) }
            return undefined
        }
        mount()
        const card = (await screen.findByText('Review module changes')).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: /^Sitzung starten/ })
        await waitFor(() => expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeEnabled())
        fireEvent.click(within(form).getByRole('button', { name: 'Sitzung starten' }))
        expect(await within(form).findByText(/Die Startbestätigung fehlt/)).toBeInTheDocument()
        expect(within(form).getByLabelText('Aufgabe')).toBeDisabled()
        fireEvent.click(within(form).getByRole('button', { name: 'Startbestätigung erneut prüfen' }))
        await waitFor(() => expect(attempts).toBe(2))
        const [first, second] = calls('/start', 'POST').map(([, options]) => (options as Options).body)
        expect(second).toEqual(first)
        expect(state.navigate).not.toHaveBeenCalled()
    })

    it('shows the actual folder for an explicit alternate repository and the project root without a binding', async () => {
        server.config = config(2, odoo(20))
        server.repositories = repositoryCatalog(['101', '102'])
        server.other = path => path.endsWith('/agent-catalog') ? agentCatalog('builtin:review') : undefined
        mount()
        const card = (await screen.findByText('Review module changes')).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: /^Sitzung starten/ })
        await waitFor(() => expect(within(form).getByLabelText('Arbeitsordner')).toHaveTextContent('/w/p1/repositories/acme/repo101'))
        fireEvent.change(within(form).getByLabelText(/^Arbeitsort/), { target: { value: '102' } })
        expect(within(form).getByLabelText('Arbeitsordner')).toHaveTextContent('Arbeitsordner (eigene Auswahl)/w/p1/repositories/acme/repo102')
        await waitFor(() => expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeEnabled())
        fireEvent.click(within(form).getByRole('button', { name: 'Sitzung starten' }))
        await waitFor(() => expect(calls('/start', 'POST')).toHaveLength(1))
        expect((calls('/start', 'POST')[0]![1] as Options).body).toMatchObject({ repositoryId: '102' })
    })

    it('uses the project root as visible folder when no repository is bound', async () => {
        server.config = config(2, { ...defaultDevelopmentSettings('ios'), repositoryId: null })
        server.other = path => path.endsWith('/agent-catalog') ? agentCatalog('builtin:implementation') : undefined
        mount()
        const card = (await screen.findByText(applicablePack(developmentSettingsToV1(server.config.settings))!.tasks.find(task => !task.requiresRepository)!.title)).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: /^Sitzung starten/ })
        await waitFor(() => expect(within(form).getByLabelText('Arbeitsordner')).toHaveTextContent('Arbeitsordner (Projektordner)/w/p1'))
        expect(within(form).getByRole('option', { name: 'Projektordner' })).toBeInTheDocument()
    })

    it('refuses an unavailable bound default instead of falling back to the project root', async () => {
        server.config = config(2, odoo(20, { repositoryId: '999' }))
        server.other = path => path.endsWith('/agent-catalog') ? agentCatalog('builtin:review') : undefined
        mount()
        const card = (await screen.findByText('Review module changes')).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: /^Sitzung starten/ })
        expect(await within(form).findByText(/Das Standard-Repository ist nicht \(mehr\) freigegeben. Es wird nicht auf den Projektordner ausgewichen/)).toBeInTheDocument()
        expect(within(form).getByLabelText('Arbeitsordner')).toHaveTextContent('nicht verfügbar')
        expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeDisabled()
    })

    it('blocks the Android SDK setup task until a human acknowledged licences', async () => {
        server.config = config(3, { ...defaultDevelopmentSettings('android'), repositoryId: null })
        server.other = path => path.endsWith('/agent-catalog') ? agentCatalog('builtin:implementation') : undefined
        mount()
        const card = (await screen.findByText('Set up Android SDK')).closest('article')!
        expect(within(card).getByText('Lizenzbestätigung nötig')).toBeInTheDocument()
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form', { name: /^Sitzung starten/ })
        expect(await within(form).findByText('Ein Projektadministrator muss zuerst die Android-SDK-Lizenzprüfung bestätigen.')).toBeInTheDocument()
        expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeDisabled()
        expect(calls('/start')).toHaveLength(0)
    })
})

describe('scope changes', () => {
    it('discards module drafts and ignores a late module detail after the account changes', async () => {
        const module = flutter()
        server.modules = [...builtins, module]
        server.config = config(1, defaultDevelopmentSettings())
        let deliverDetail!: () => void
        state.request.mockImplementation(async (path: string, options?: Options) => {
            if (path.includes(`/modules/${encodeURIComponent(module.entry.id)}`)) return new Promise(resolve => { deliverDetail = () => resolve(route(path, options)) })
            return route(path, options)
        })
        const view = mount()
        fireEvent.click(await screen.findByRole('radio', { name: 'Flutter' }))
        await waitFor(() => expect(deliverDetail).toBeTypeOf('function'))
        state.userId = 'user-2'
        view.rerenderPanel()
        expect(await screen.findByRole('radio', { name: 'Allgemein' })).toBeChecked()
        await act(async () => deliverDetail())
        expect(screen.queryByLabelText(/^Kanal/)).not.toBeInTheDocument()
        expect(screen.queryByText('Ungespeicherter Entwurf')).not.toBeInTheDocument()
    })
})

function developmentSettingsToV1(settings: DevelopmentModuleSettings): DevelopmentSettings {
    const mode = settings.activeModuleId?.startsWith('builtin:') ? settings.activeModuleId.slice('builtin:'.length) as DevelopmentSettings['mode'] : 'none'
    return { mode, repositoryId: settings.repositoryId, odoo: settings.odoo, ios: settings.ios, android: settings.android }
}
