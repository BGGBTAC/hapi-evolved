import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    DEVELOPMENT_DATA_NOTICE, defaultDevelopmentSettings, defaultOdooSettings,
    type DevelopmentContext, type DevelopmentSettings, type ProjectDevelopmentConfig,
} from '@hapi/protocol/evolvedDevelopment'
import { applicablePack, developmentCatalog } from '@hapi/protocol/developmentPacks'
import { EvolvedApiError, type EvolvedProject } from './api'
import { ProjectDevelopmentPanel } from './ProjectDevelopment'
import { effectLabels } from './developmentApi'

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

const project = (id: string, role: EvolvedProject['role'] = 'admin'): EvolvedProject => ({ id, teamId: 'team-1', name: `Projekt ${id}`, role, profile: 'workspace', rootPath: `/w/${id}` })
const odoo = (major: 19 | 20, extra: Partial<DevelopmentSettings> = {}): DevelopmentSettings => ({ ...defaultDevelopmentSettings('odoo'), odoo: defaultOdooSettings(major), repositoryId: '101', ...extra })
const config = (revision: number, settings: DevelopmentSettings, projectId = 'p1', extra: Partial<ProjectDevelopmentConfig> = {}): ProjectDevelopmentConfig => ({
    projectId, revision, settings, savedPackRevision: null, updatedAt: revision ? 1_760_000_000_000 : null, updatedBy: revision ? { id: 'user-2', displayName: 'Alex' } : null, androidSdkLicenseAcknowledgement: null, ...extra,
})
function contextFor(current: ProjectDevelopmentConfig, repositoryState: DevelopmentContext['repository']['state'] = 'granted'): DevelopmentContext {
    const applicable = applicablePack(current.settings)
    return {
        contractVersion: 1, projectId: current.projectId, revision: current.revision, mode: current.settings.mode, observedAt: 1_760_000_100_000, dataNotice: DEVELOPMENT_DATA_NOTICE, settings: current.settings,
        pack: applicable && { id: applicable.pack.id, version: applicable.pack.version, revision: applicable.revision, title: applicable.pack.title, verifiedAt: applicable.pack.verifiedAt, brief: applicable.pack.brief, constraints: applicable.pack.constraints,
            topics: applicable.topics.map(({ body: _body, ...topic }) => topic), recipes: applicable.recipes, tasks: applicable.tasks, doctorChecks: applicable.doctorChecks },
        repository: { state: repositoryState, repositoryId: current.settings.repositoryId, fullName: current.settings.repositoryId ? 'acme/odoo-addons' : null, permission: 'write', checkoutPath: null, relativePath: null },
        integrations: [], lastDoctor: null,
    }
}
const repositoryCatalog = (ids = ['101'], local: 'ready' | 'missing' = 'ready') => ({
    connected: true, rootPath: '/w/p1', canSync: true, canPush: true, runner: { status: 'ready' },
    repositories: ids.map(id => ({ id, owner: 'acme', name: `repo${id}`, fullName: `acme/repo${id}`, permission: 'write', path: `/w/p1/repositories/acme/repo${id}`, cloneUrl: `https://github.com/acme/repo${id}.git`, local: { state: local, branch: 'main', dirty: false } })),
})

let server: { config: ProjectDevelopmentConfig; canEdit: boolean; repositories: ReturnType<typeof repositoryCatalog>; put?: (body: { expectedRevision: number; settings: DevelopmentSettings }, options: Options) => unknown; other?: (path: string, options: Options) => unknown }
function route(path: string, options: Options = {}) {
    const base = `/projects/${server.config.projectId}`
    if (path === `${base}/development` && !options.method) return { config: server.config, catalog: developmentCatalog(), canEdit: server.canEdit }
    if (path === `${base}/development` && options.method === 'PUT') {
        if (server.put) return server.put(options.body as never, options)
        const body = options.body as { settings: DevelopmentSettings }
        server.config = config(server.config.revision + 1, body.settings, server.config.projectId)
        return { config: server.config }
    }
    if (path === `${base}/development/context`) return contextFor(server.config)
    if (path === `${base}/repositories`) return server.repositories
    if (server.other) { const value = server.other(path, options); if (value !== undefined) return value }
    throw new EvolvedApiError(`Unexpected ${options.method ?? 'GET'} ${path}`, 500)
}
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    const view = render(<QueryClientProvider client={client}><ProjectDevelopmentPanel /></QueryClientProvider>)
    return { ...view, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><ProjectDevelopmentPanel /></QueryClientProvider>) }
}
const calls = (fragment: string, method?: string) => state.request.mock.calls.filter(([path, options]) => String(path).includes(fragment) && (method === undefined || (options as Options | undefined)?.method === method))
const saveButton = () => screen.getByRole('button', { name: 'Speichern' })

beforeEach(() => {
    state.project = project('p1'); state.userId = 'user-1'
    state.navigate.mockReset()
    server = { config: config(0, defaultDevelopmentSettings()), canEdit: true, repositories: repositoryCatalog() }
    state.request.mockReset().mockImplementation(async (path: string, options?: Options) => route(path, options))
})

describe('development mode configuration', () => {
    it('activates a mode with compact choices, saves with the seen revision and runs no checks', async () => {
        mount()
        expect(await screen.findByText(/Noch nicht eingerichtet/)).toBeInTheDocument()
        expect(saveButton()).toBeDisabled()
        expect(screen.getByText('Keine ungespeicherten Änderungen.')).toBeInTheDocument()
        expect(screen.getAllByRole('radio').map(radio => radio.closest('label')?.textContent)).toEqual(expect.arrayContaining(['Allgemein', 'Odoo', 'iOS', 'Android']))
        fireEvent.click(screen.getByRole('radio', { name: 'Odoo' }))
        expect(screen.getByRole('radio', { name: '20.0' })).toBeChecked()
        expect(screen.getByText('Ungespeicherter Entwurf')).toBeInTheDocument()
        expect(screen.getByText(/kein Sicherheitsprofil/)).toBeInTheDocument()
        await waitFor(() => expect(saveButton()).toBeEnabled())
        expect(calls('/doctor')).toHaveLength(0)
        expect(calls('/inspect')).toHaveLength(0)
        expect(calls('/build-status')).toHaveLength(0)
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Gespeichert als Revision 1/)).toBeInTheDocument()
        const [, put] = calls('/development', 'PUT')[0]!
        expect((put as Options).body).toEqual({ expectedRevision: 0, settings: { ...defaultDevelopmentSettings('odoo'), odoo: defaultOdooSettings(20) } })
        expect(await screen.findByRole('heading', { name: 'Handbuch · Odoo 19 / 20' })).toBeInTheDocument()
        expect(calls('/doctor')).toHaveLength(0)
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
        expect((calls('/development', 'PUT')[0]![1] as Options).body).toMatchObject({ expectedRevision: 3, settings: { odoo: { major: 19 } } })
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

    it('shows the persisted mode read-only for non-admins and states the human-only licence rule', async () => {
        state.project = project('p1', 'viewer')
        server.canEdit = false
        server.config = config(4, { ...defaultDevelopmentSettings('android'), repositoryId: null })
        mount()
        expect(await screen.findByText('Nur Projektadministratoren können den Entwicklungsmodus ändern.')).toBeInTheDocument()
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
        await waitFor(() => expect(calls('/development', 'PUT')).toHaveLength(1))
        expect((calls('/development', 'PUT')[0]![1] as Options).body).toMatchObject({ expectedRevision: 1, settings: { android: { sdkLicensesAcknowledged: true } } })
    })

    it('keeps the draft after a stale-tab conflict and lets the human choose', async () => {
        server.config = config(4, odoo(20))
        const newer = config(5, odoo(19, { repositoryId: null }))
        let conflicts = 1
        server.put = (body) => {
            if (conflicts-- > 0) throw new EvolvedApiError('stale', 409, 'development_revision_conflict', false, { error: 'stale', code: 'development_revision_conflict', config: newer })
            server.config = config(6, body.settings); return { config: server.config }
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
        expect((calls('/development', 'PUT')[1]![1] as Options).body).toMatchObject({ expectedRevision: 5, settings: { odoo: { major: 20, developmentBranch: 'my-branch' } } })
    })

    it('never lets a late GET roll the known revision back after a CAS conflict', async () => {
        server.config = config(4, { ...defaultDevelopmentSettings('android'), repositoryId: null })
        const r5 = config(5, { ...defaultDevelopmentSettings('android'), repositoryId: null, android: { ...defaultDevelopmentSettings('android').android!, variant: 'fromFive' } })
        const r6 = config(6, { ...defaultDevelopmentSettings('android'), repositoryId: null, android: { ...defaultDevelopmentSettings('android').android!, variant: 'fromSix' } })
        mount()
        const variant = await screen.findByLabelText('Variante')
        fireEvent.change(variant, { target: { value: 'myDraft' } })
        let deliverLateRead!: () => void
        let puts = 0
        state.request.mockImplementation(async (path: string, options?: Options) => {
            if (path === '/projects/p1/development' && !options?.method) return new Promise(resolve => { deliverLateRead = () => resolve({ config: r5, catalog: developmentCatalog(), canEdit: true }) })
            if (path === '/projects/p1/development' && options?.method === 'PUT') {
                puts++
                if (puts === 1) throw new EvolvedApiError('stale', 409, 'development_revision_conflict', false, { error: 'stale', code: 'development_revision_conflict', config: r6 })
                server.config = config(7, (options.body as { settings: DevelopmentSettings }).settings); return { config: server.config }
            }
            return route(path, options)
        })
        fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' }))
        await waitFor(() => expect(deliverLateRead).toBeTypeOf('function'))
        fireEvent.click(saveButton())
        expect(await screen.findByRole('alert')).toHaveTextContent('Die Konfiguration wurde inzwischen geändert (Revision 6')
        await act(async () => deliverLateRead())
        // The late read has been applied once the refetch settles and the reload button is usable again.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' })).toBeEnabled())
        expect(screen.getByRole('alert')).toHaveTextContent('(Revision 6')
        expect(screen.getByText(/^Gespeichert: Android · Revision 6/)).toBeInTheDocument()
        expect(screen.queryByText(/Revision 5/)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Variante')).toHaveValue('myDraft')
        fireEvent.click(screen.getByRole('button', { name: 'Entwurf behalten und auf Revision 6 aufbauen' }))
        fireEvent.click(saveButton())
        expect(await screen.findByText(/Gespeichert als Revision 7/)).toBeInTheDocument()
        const lastPut = state.request.mock.calls.filter(([path, options]) => path === '/projects/p1/development' && (options as Options | undefined)?.method === 'PUT').at(-1)!
        expect((lastPut[1] as Options).body).toMatchObject({ expectedRevision: 6, settings: { android: { variant: 'myDraft' } } })
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

    it('keeps the dirty draft and last validated config when a background refresh fails, then recovers', async () => {
        server.config = config(4, odoo(20))
        mount()
        const branch = await screen.findByLabelText('Entwicklungs-Branch (optional)')
        fireEvent.change(branch, { target: { value: 'unsaved-work' } })
        state.request.mockImplementation(async (path: string, options?: Options) => {
            if (path === '/projects/p1/development' && !options?.method) throw new EvolvedApiError('upstream', 503)
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
            if (path === '/projects/p1/development' && !options?.method) throw new EvolvedApiError('denied', 403)
            return route(path, options)
        })
        fireEvent.click(screen.getByRole('button', { name: 'Gespeicherte Fassung neu laden' }))
        expect(await screen.findByRole('heading', { name: 'Entwicklungsmodus nicht geladen' })).toBeInTheDocument()
        expect(screen.queryByLabelText('Entwicklungs-Branch (optional)')).not.toBeInTheDocument()
    })

    it('discards drafts on project change and ignores a late save response', async () => {
        let resolveSave!: (value: unknown) => void
        let signal: AbortSignal | undefined
        server.put = (_body, options) => { signal = options.signal; return new Promise(resolve => { resolveSave = resolve }) }
        const view = mount()
        fireEvent.click(await screen.findByRole('radio', { name: 'Odoo' }))
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
        expect(calls('/doctor')).toHaveLength(0)
    })
})

describe('development checks and status', () => {
    it('runs the doctor only on an explicit click and shows real per-check states', async () => {
        server.config = config(2, odoo(20))
        let doctorBody: unknown
        server.other = (path, options) => {
            if (!path.endsWith('/development/doctor')) return undefined
            doctorBody = options.body
            return { projectId: 'p1', revision: 2, mode: 'odoo', runner: { status: 'ready', machineId: 'm1' }, result: { contractVersion: 1, mode: 'odoo', observedAt: 1_760_000_200_000, durationMs: 1200, host: { os: 'linux', arch: 'x64', image: null }, truncated: false,
                checks: [
                    { id: 'python', label: 'Python', category: 'runtime', state: 'ready', version: 'Python 3.13.5' },
                    { id: 'postgresql.server', label: 'PostgreSQL server', category: 'database', state: 'missing', remedy: { kind: 'operator', text: 'Use the development runner image.', url: 'https://www.postgresql.org/download/' } },
                    { id: 'odoo.source', label: 'Odoo source', category: 'toolchain', state: 'unknown' },
                    { id: 'browser', label: 'Headless browser', category: 'runtime', state: 'unsupported' },
                ] } }
        }
        const { container } = mount()
        expect(await screen.findByText('Noch keine Werkzeugprüfung für diese Revision.')).toBeInTheDocument()
        expect(calls('/doctor')).toHaveLength(0)
        fireEvent.change(screen.getByLabelText('Entwicklungs-Branch (optional)'), { target: { value: 'draft' } })
        expect(screen.getByRole('button', { name: 'Werkzeuge prüfen' })).toBeDisabled()
        expect(screen.getAllByText(/Prüfungen nutzen nur die gespeicherte Konfiguration/).length).toBeGreaterThan(0)
        fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }))
        fireEvent.click(screen.getByRole('button', { name: 'Werkzeuge prüfen' }))
        const result = await screen.findByLabelText('Ergebnis der Werkzeugprüfung')
        expect(doctorBody).toEqual({})
        expect(calls('/doctor', 'POST')).toHaveLength(1)
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
        expect(calls('/doctor', 'POST')).toHaveLength(1)
    })

    it('reports a not-ready runner honestly instead of a green result', async () => {
        server.config = config(2, odoo(20))
        server.other = path => path.endsWith('/doctor') ? { projectId: 'p1', revision: 2, mode: 'odoo', runner: { status: 'upgrade_required', machineId: null }, result: null } : undefined
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Werkzeuge prüfen' }))
        expect(await screen.findByText(/kennt diese Prüfung noch nicht/)).toBeInTheDocument()
        expect(screen.queryByText('Gefunden')).not.toBeInTheDocument()
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
        let refs: string[] = []
        server.other = path => {
            if (!path.includes('/build-status')) return undefined
            refs.push(path)
            return { projectId: 'p1', revision: 2, repositoryId: '101', fullName: 'acme/odoo-addons', ref: 'main', observedAt: 1_760_000_300_000, truncated: false, ...responses.shift()! }
        }
        const { container } = mount()
        const button = await screen.findByRole('button', { name: 'Status abrufen' })
        fireEvent.click(button)
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
        refs = []
    })
})

describe('development handbook and tasks', () => {
    it('lists bundled topics and loads a topic with its versioned sources', async () => {
        server.config = config(2, odoo(19))
        server.other = path => {
            if (path.includes('/knowledge?topic=odoo-versions')) {
                const topic = applicablePack(server.config.settings)!.topics.find(item => item.id === 'odoo-versions')!
                return { projectId: 'p1', revision: 2, mode: 'odoo', packId: 'odoo', packRevision: 'fnv1a64:0000000000000000', topic, results: [], total: 1, truncated: false, dataNotice: DEVELOPMENT_DATA_NOTICE }
            }
            if (path.includes('/knowledge?q=')) return { projectId: 'p1', revision: 2, mode: 'odoo', packId: 'odoo', packRevision: null, topic: null, total: 0, truncated: false, dataNotice: DEVELOPMENT_DATA_NOTICE, results: [] }
            return undefined
        }
        mount()
        const heading = await screen.findByText('Odoo 19 and 20: versions and runtime minimums')
        expect(screen.getByText(/Funktioniert ohne Graph-Gedächtnis/)).toBeInTheDocument()
        const details = heading.closest('details')!
        details.open = true
        fireEvent(details, new Event('toggle'))
        await waitFor(() => expect(calls('/knowledge?topic=odoo-versions')).toHaveLength(1))
        const links = await within(details).findAllByRole('link')
        expect(links.length).toBeGreaterThan(1)
        for (const link of links) expect(link).toHaveAttribute('href', expect.stringMatching(/^https:\/\//))
        expect(within(details).getAllByText(/· 20\.0|· 19\.0/).length).toBeGreaterThan(0)
        expect(within(details).getAllByText(/geprüft am 2026-10-17/).length).toBeGreaterThan(0)
        fireEvent.change(screen.getByLabelText('Handbuch durchsuchen'), { target: { value: 'xyz' } })
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        expect(await screen.findByText(/0 Treffer für „xyz“/)).toBeInTheDocument()
        expect(calls('/knowledge?q=xyz')).toHaveLength(1)
    })

    it('starts a task once with explicit operation, revision and repository and opens the session', async () => {
        server.config = config(2, odoo(20))
        let finish!: (value: unknown) => void
        server.other = (path) => {
            if (path.endsWith('/agent-catalog')) return { agents: [{ id: 'builtin:implementation', available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] }
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
        const effects = applicablePack(server.config.settings)!.tasks.find(item => item.id === 'odoo-develop-module')!.effects
        expect(within(form).getByText(/^Auswirkungen:/)).toHaveTextContent(effects.map(effect => effectLabels[effect]).join(' · '))
        expect(within(form).queryByRole('checkbox')).not.toBeInTheDocument()
        const submit = within(form).getByRole('button', { name: 'Sitzung starten' })
        await waitFor(() => expect(submit).toBeEnabled())
        fireEvent.click(submit); fireEvent.click(submit); fireEvent.submit(form)
        const starts = calls('/start', 'POST')
        expect(starts).toHaveLength(1)
        const body = (starts[0]![1] as Options).body as Record<string, unknown>
        expect(body).toMatchObject({ machineId: 'm1', provider: 'claude', repositoryId: '101', development: { taskId: 'odoo-develop-module', revision: 2 } })
        expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/)
        expect(body.task).toContain('Follow the conventions of the configured Odoo major')
        await act(async () => finish({ sessionId: 'session-42', operationId: body.operationId, acknowledged: 'persisted' }))
        await waitFor(() => expect(state.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'session-42' } }))
    })

    it('keeps the operation after an uncertain start and retries without a new session id', async () => {
        server.config = config(2, odoo(20))
        let attempts = 0
        server.other = (path) => {
            if (path.endsWith('/agent-catalog')) return { agents: [{ id: 'builtin:review', available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] }
            if (path.includes('/start')) { attempts++; throw new EvolvedApiError('timeout', 504) }
            return undefined
        }
        mount()
        const card = (await screen.findByText('Review module changes')).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form')
        await waitFor(() => expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeEnabled())
        fireEvent.click(within(form).getByRole('button', { name: 'Sitzung starten' }))
        expect(await within(form).findByText(/Die Startbestätigung fehlt/)).toBeInTheDocument()
        expect(within(form).getByLabelText('Aufgabe')).toBeDisabled()
        fireEvent.click(within(form).getByRole('button', { name: 'Startbestätigung erneut prüfen' }))
        await waitFor(() => expect(attempts).toBe(2))
        const [first, second] = calls('/start', 'POST').map(([, options]) => ((options as Options).body as { operationId: string }).operationId)
        expect(second).toBe(first)
        expect(state.navigate).not.toHaveBeenCalled()
    })

    it('shows the actual folder for an explicit alternate repository and the project root without a binding', async () => {
        server.config = config(2, odoo(20))
        server.repositories = repositoryCatalog(['101', '102'])
        server.other = path => path.endsWith('/agent-catalog') ? { agents: [{ id: 'builtin:review', available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] } : undefined
        mount()
        const card = (await screen.findByText('Review module changes')).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form')
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
        server.other = path => path.endsWith('/agent-catalog') ? { agents: [{ id: 'builtin:implementation', available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] } : undefined
        mount()
        const card = (await screen.findByText(applicablePack(server.config.settings)!.tasks.find(task => !task.requiresRepository)!.title)).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form')
        await waitFor(() => expect(within(form).getByLabelText('Arbeitsordner')).toHaveTextContent('Arbeitsordner (Projektordner)/w/p1'))
        expect(within(form).getByRole('option', { name: 'Projektordner' })).toBeInTheDocument()
    })

    it('refuses an unavailable bound default instead of falling back to the project root', async () => {
        server.config = config(2, odoo(20, { repositoryId: '999' }))
        server.other = path => path.endsWith('/agent-catalog') ? { agents: [{ id: 'builtin:review', available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] } : undefined
        mount()
        const card = (await screen.findByText('Review module changes')).closest('article')!
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form')
        expect(await within(form).findByText(/Das Standard-Repository ist nicht \(mehr\) freigegeben. Es wird nicht auf den Projektordner ausgewichen/)).toBeInTheDocument()
        expect(within(form).getByLabelText('Arbeitsordner')).toHaveTextContent('nicht verfügbar')
        expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeDisabled()
    })

    it('blocks the Android SDK setup task until a human acknowledged licences', async () => {
        server.config = config(3, { ...defaultDevelopmentSettings('android'), repositoryId: null })
        server.other = path => path.endsWith('/agent-catalog') ? { agents: [{ id: 'builtin:implementation', available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] } : undefined
        mount()
        const card = (await screen.findByText('Set up Android SDK')).closest('article')!
        expect(within(card).getByText('Lizenzbestätigung nötig')).toBeInTheDocument()
        fireEvent.click(within(card).getByRole('button', { name: 'Sitzung vorbereiten' }))
        const form = await screen.findByRole('form')
        expect(await within(form).findByText('Ein Projektadministrator muss zuerst die Android-SDK-Lizenzprüfung bestätigen.')).toBeInTheDocument()
        expect(within(form).getByRole('button', { name: 'Sitzung starten' })).toBeDisabled()
        expect(calls('/start')).toHaveLength(0)
    })
})
