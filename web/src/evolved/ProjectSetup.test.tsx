import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDevelopmentSettings, defaultOdooSettings, emptyOdooShEnvironment, type DevelopmentSettings, type OdooSettings } from '@hapi/protocol/evolvedDevelopment'
import { developmentSettingsToModuleSettings, type DevelopmentModuleSettings, type DevelopmentModuleSettingsInput, type ProjectDevelopmentModuleConfig } from '@hapi/protocol/developmentModules'
import type { ProjectReadiness } from '@hapi/protocol/evolvedWorkspace'
import { EvolvedApiError, type EvolvedProject } from './api'
import { ProjectSetupPanel } from './ProjectSetup'
import { ProjectDevelopmentPanel } from './ProjectDevelopment'
import { readSetupIntent, writeSetupIntent } from './setupIntent'
import { settingsInput as settingsInputOf } from './developmentApi'
import type { SetupStep } from './workspaceNavigation'
import { adoptedEntry, builtinModule, emptySettings, flutterDefinition, moduleConfig, moduleContext, pluginModule, statusFor, type FixtureModule } from '../test/developmentModules'

type Options = { method?: string; body?: unknown; signal?: AbortSignal }
const state = vi.hoisted(() => ({ request: vi.fn(), refresh: vi.fn(), project: null as unknown as EvolvedProject }))
vi.mock('./auth', () => ({ useEvolved: () => ({ api: { baseUrl: 'https://hub.example', request: state.request }, me: { user: { id: 'user-1', displayName: 'Ada', isAdmin: false }, accessibleProjects: [state.project] }, project: state.project, refresh: state.refresh }) }))
vi.mock('@tanstack/react-router', () => ({
    Link: ({ children, to, search, params: _params, ...props }: React.PropsWithChildren<{ to: string; search?: Record<string, string>; params?: unknown }>) => <a href={`${to}?${new URLSearchParams(search)}`} {...props}>{children}</a>,
    useNavigate: () => vi.fn(),
}))
vi.mock('./ModelCatalogInput', () => ({ ModelCatalogInput: () => null }))
// The embedded panels have their own suites; here only their placement and project scope matter.
vi.mock('./Github', () => ({ GithubPanel: () => <p>GitHub panel for {state.project.id}</p> }))
vi.mock('./ProviderLogin', () => ({ ProviderLoginPanel: () => <p>Provider panel for {state.project.id}</p> }))

const builtins = [builtinModule('odoo'), builtinModule('ios'), builtinModule('android')]
const repo = (id: string, local: 'ready' | 'missing' | 'blocked', branch: string | null = 'main', owner = 'acme', name = `repo${id}`) => ({ id, owner, name, fullName: `${owner}/${name}`, permission: 'read' as const,
    path: `/w/p1/repositories/${owner}/${name}`, cloneUrl: `https://github.com/${owner}/${name}.git`, local: { state: local, branch: local === 'ready' ? branch : null, dirty: false } })
const catalog = (repositories: ReturnType<typeof repo>[], connected = true) => ({ connected, rootPath: '/w/p1', canSync: true, canPush: false, runner: { status: 'ready' as const }, repositories })
const readiness = (states: Partial<Record<string, ProjectReadiness['items'][number]['state']>> = {}): ProjectReadiness => ({
    projectId: 'p1', checkedAt: 1_760_000_000_000, configRevision: null, purposes: { plan: 'ok', code: 'ok', module: null },
    items: ['runner', 'rpc', 'agents', 'providers'].map(key => ({ key, label: key, state: states[key] ?? 'ok', reasonCode: key, detail: `${key} detail` })),
})
let server: {
    config: ProjectDevelopmentModuleConfig; modules: FixtureModule[]; repositories: ReturnType<typeof catalog>; readiness: ProjectReadiness
    other?: (path: string, options: Options) => unknown
    readinessRevision?: number | null
}
function stored(input: DevelopmentModuleSettingsInput): DevelopmentModuleSettings {
    const modules: DevelopmentModuleSettings['modules'] = {}
    for (const [id, entry] of Object.entries(input.modules)) modules[id] = adoptedEntry(server.modules.find(module => module.entry.id === id)!, entry.values, entry.moduleDigest)
    return { ...input, modules }
}
const entries = () => server.modules.map(module => module.entry)
function route(path: string, options: Options = {}) {
    const base = '/projects/p1/development'
    if (path === `${base}/modules` && !options.method) return { contractVersion: 2, config: { ...server.config, active: statusFor(server.config.settings, entries()) }, catalog: { modules: entries() }, canEdit: state.project.role === 'admin' }
    if (path === `${base}/modules` && options.method === 'PUT') {
        server.config = moduleConfig(server.config.revision + 1, stored((options.body as { settings: DevelopmentModuleSettingsInput }).settings), entries())
        return { config: server.config }
    }
    if (path === `${base}/modules-context`) return moduleContext({ ...server.config, active: statusFor(server.config.settings, entries()) }, server.modules)
    const detail = server.modules.find(module => path === `${base}/modules/${encodeURIComponent(module.entry.id)}`)
    if (detail) return { module: detail.detail }
    if (path === '/projects/p1/repositories') return server.repositories
    // Like the hub: readiness is computed for the currently saved configuration revision unless a test pins another one.
    if (path === '/projects/p1/readiness') return { ...server.readiness, configRevision: server.readinessRevision !== undefined ? server.readinessRevision : server.config.revision || null }
    if (server.other) { const value = server.other(path, options); if (value !== undefined) return value }
    throw new EvolvedApiError(`Unexpected ${options.method ?? 'GET'} ${path}`, 500)
}
const odooConfig = (revision: number, odoo: Partial<OdooSettings> = {}, extra: Partial<DevelopmentSettings> = {}) =>
    moduleConfig(revision, developmentSettingsToModuleSettings({ ...defaultDevelopmentSettings('odoo'), odoo: { ...defaultOdooSettings(20), ...odoo }, repositoryId: '101', ...extra }), builtins.map(module => module.entry))
const mutations = () => state.request.mock.calls.filter(([, options]) => (options as Options | undefined)?.method && (options as Options).method !== 'GET')
const calls = (fragment: string) => state.request.mock.calls.filter(([path]) => String(path).includes(fragment))

/** URL-like step state: the wizard only reports a requested step; the host decides (as the router does). */
function Host({ initial }: { initial?: SetupStep }) {
    const [step, setStep] = useState<SetupStep | undefined>(initial)
    return <ProjectSetupPanel step={step} onStep={setStep} />
}
function mount(initial?: SetupStep) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    return render(<QueryClientProvider client={client}><Host initial={initial} /></QueryClientProvider>)
}
function mountDevelopment() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    return render(<QueryClientProvider client={client}><ProjectDevelopmentPanel /></QueryClientProvider>)
}
const stepButton = (name: RegExp) => within(screen.getByRole('navigation', { name: 'Einrichtungsschritte' })).getByRole('button', { name })

beforeEach(() => {
    localStorage.clear()
    state.project = { id: 'p1', teamId: 't1', name: 'ERP Neu', role: 'admin', profile: 'workspace', rootPath: '/w/p1' }
    state.refresh.mockReset().mockResolvedValue(undefined)
    server = { config: odooConfig(2), modules: [...builtins], repositories: catalog([repo('101', 'ready')]), readiness: readiness() }
    state.request.mockReset().mockImplementation(async (path: string, options?: Options) => route(path, options))
})

describe('setup wizard', () => {
    it('resumes at the first open step of the saved state and moves with back/next without any mutation', async () => {
        state.project = { ...state.project, profile: 'restricted' }
        mount()
        expect(await screen.findByRole('heading', { name: 'Einrichtung · ERP Neu' })).toBeInTheDocument()
        expect(await screen.findByRole('heading', { name: 'Profil', level: 2 })).toBeInTheDocument()
        expect(stepButton(/Profil/)).toHaveAttribute('aria-current', 'step')
        expect(screen.getByText(/Klonen, Einrichtungs- und Testaufgaben brauchen „Arbeitsbereich“/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Weiter: Anbieter und Runner' }))
        expect(await screen.findByText('Provider panel for p1')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Anbieter und Runner' })).toHaveFocus()
        fireEvent.click(screen.getByRole('button', { name: 'Weiter: GitHub und Repository' }))
        expect(await screen.findByText('GitHub panel for p1')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Zurück: Anbieter und Runner' }))
        expect(await screen.findByText('Provider panel for p1')).toBeInTheDocument()
        fireEvent.click(stepButton(/Prüfen und einrichten/))
        expect(await screen.findByRole('button', { name: 'Werkzeuge prüfen' })).toBeInTheDocument()
        expect(mutations()).toEqual([])
        expect(calls('modules-doctor')).toHaveLength(0)
        expect(calls('/agent-catalog')).toHaveLength(0)
    })

    it('judges the GitHub step by the bound repository, not by any other ready checkout', async () => {
        server.repositories = catalog([repo('101', 'missing'), repo('202', 'ready')])
        mount('github')
        const status = await screen.findByText(/acme\/repo101 ist Standard-Repository, aber noch nicht geklont/)
        expect(within(status.closest('p')!).getByText('Offen')).toBeInTheDocument()
        expect(stepButton(/GitHub und Repository/)).toHaveTextContent('Offen')
        server.repositories = catalog([repo('101', 'blocked'), repo('202', 'ready')])
        fireEvent.click(screen.getByRole('button', { name: 'Stand neu prüfen' }))
        expect(await screen.findByText(/acme\/repo101 kann nicht verwendet werden/)).toBeInTheDocument()
        expect(stepButton(/GitHub und Repository/)).toHaveTextContent('Blockiert')
    })

    it('never counts an unknown readiness as done and shows the admin boundary for members', async () => {
        state.project = { ...state.project, role: 'member' }
        server.readiness = readiness({ providers: 'denied', rpc: 'stale' })
        mount('provider')
        expect((await screen.findAllByText(/rpc detail/)).length).toBeGreaterThan(0)
        expect(stepButton(/Anbieter und Runner/)).toHaveTextContent('Nicht geprüft')
        server.readiness = readiness({ providers: 'denied' })
        fireEvent.click(screen.getByRole('button', { name: 'Bereitschaft erneut prüfen' }))
        await waitFor(() => expect(stepButton(/Anbieter und Runner/)).toHaveTextContent('Erledigt'))
        expect(screen.getAllByText(/den Anbieterstatus prüft ein Projektadministrator/).length).toBeGreaterThan(0)
    })

    it('changes the profile only after an explicit confirmation and rechecks after a lost response', async () => {
        state.project = { ...state.project, profile: 'restricted' }
        let fail = true
        server.other = (path, options) => {
            if (path !== '/projects/p1/profile' || options.method !== 'PUT') return undefined
            if (fail) { fail = false; throw new TypeError('Failed to fetch') }
            return {}
        }
        mount('profile')
        expect(await screen.findByText(/Für dieses Projekt besteht bereits ein Projektdienst/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '„Arbeitsbereich“ wählen' }))
        expect(calls('/profile')).toHaveLength(0)
        expect(screen.getByText(/Bisherige Runner-Zugänge werden ungültig/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(await screen.findByText(/Ob die letzte Änderung wirksam wurde, ist unklar/)).toBeInTheDocument()
        // No second profile change can be sent before the state was rechecked.
        expect(screen.queryByRole('button', { name: '„Arbeitsbereich“ wählen' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projektstatus aktualisieren' }))
        await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1))
        expect(calls('/profile')).toHaveLength(1)
    })

    it('turns a creation draft into an explicitly saved module after the repository is cloned and chosen', async () => {
        const plugin = pluginModule(flutterDefinition({ fields: [...flutterDefinition().fields!.filter(field => field.id !== 'assets'), { id: 'assets', kind: 'repository', label: 'Asset-Repository', required: true }] }))
        server.modules = [...builtins, plugin]
        server.config = moduleConfig(0, emptySettings(), entries())
        server.repositories = catalog([repo('101', 'ready')])
        writeSetupIntent('https://hub.example', 'user-1', 'p1', { moduleId: plugin.entry.id, moduleDigest: plugin.entry.digest, values: { appDirectory: 'app', channel: 'beta', minSdk: 0, web: false, flavors: [], platforms: [], notes: null, docs: null, branch: null, assets: null, signing: null }, repositoryId: null, createdAt: 1 })
        mount()
        // The draft is never shown as configured.
        expect(await screen.findByRole('heading', { name: 'GitHub und Repository', level: 2 })).toBeInTheDocument()
        expect(stepButton(/Modul und Einstellungen/)).toHaveTextContent('Entwurf')
        fireEvent.click(screen.getByRole('button', { name: 'Als Standard vormerken und zum Modul' }))
        expect(await screen.findByText(/Vorgemerkt, noch nicht gespeichert/)).toBeInTheDocument()
        expect(screen.getByText(/ist nur ein Entwurf und noch nicht aktiv/)).toBeInTheDocument()
        expect(screen.getByLabelText(/^App-Verzeichnis/)).toHaveValue('app')
        const save = screen.getByRole('button', { name: 'Speichern' })
        expect(save).toBeDisabled()
        expect(screen.getByText(/Asset-Repository/, { selector: '#ev-dev-save-state' })).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText(/^Asset-Repository/), { target: { value: '101' } })
        await waitFor(() => expect(save).toBeEnabled())
        expect(mutations()).toEqual([])
        fireEvent.click(save)
        expect(await screen.findByText(/Gespeichert als Revision 1/)).toBeInTheDocument()
        const body = mutations()[0]![1] as { body: { expectedRevision: number; settings: DevelopmentModuleSettingsInput } }
        expect(body.body).toMatchObject({ expectedRevision: 0, settings: { activeModuleId: plugin.entry.id, repositoryId: '101', modules: { [plugin.entry.id]: { moduleDigest: plugin.entry.digest, values: { appDirectory: 'app', channel: 'beta', assets: '101' } } } } })
        expect(readSetupIntent('https://hub.example', 'user-1', 'p1')).toBeNull()
    })

    it('requires an explicit adoption when the intended plugin module changed since it was noted', async () => {
        const r1 = pluginModule(flutterDefinition())
        const r2 = pluginModule(flutterDefinition({ contentVersion: '2026.11.01-1' }), { digestSeed: 'r2' })
        server.modules = [...builtins, r2]
        server.config = moduleConfig(0, emptySettings(), entries())
        writeSetupIntent('https://hub.example', 'user-1', 'p1', { moduleId: r1.entry.id, moduleDigest: r1.entry.digest, values: { appDirectory: 'app' }, repositoryId: null, createdAt: 1 })
        mount('module')
        expect(await screen.findByText(/Neue Modulfassung installiert/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Installierte Fassung übernehmen und Werte prüfen' }))
        expect(await screen.findByLabelText(/^App-Verzeichnis/)).toHaveValue('app')
        expect(mutations()).toEqual([])
    })

    it('explains the optional Enterprise source with its real limits and the matching branch', async () => {
        server.config = odooConfig(2, { edition: 'enterprise', enterpriseRepositoryId: '303', hosting: 'odoo_sh' })
        server.repositories = catalog([repo('101', 'ready'), repo('303', 'ready', '19.0', 'acme', 'enterprise')])
        mount('github')
        const guide = (await screen.findByText('Odoo Enterprise-Quelle')).closest('div')!
        expect(within(guide).getByText(/gewählt: acme\/enterprise \(geklont, Branch 19.0\)/)).toBeInTheDocument()
        expect(within(guide).getByText(/Ausgecheckt ist 19.0, erwartet für Odoo 20 wird 20.0/)).toBeInTheDocument()
        expect(within(guide).getByText(/Odoo.sh stellt die Enterprise-Addons selbst bereit/)).toBeInTheDocument()
        expect(within(guide).getByText(/genau einen Eigentümer/)).toBeInTheDocument()
        expect(within(guide).getByText(/nicht automatisch in die Addon-Pfade/)).toBeInTheDocument()
        expect(within(guide).getByText(/„Nur lesen“ genügt/)).toBeInTheDocument()
        expect(screen.getByText(/Commit statuses: Read-only/)).toBeInTheDocument()
        expect(screen.getByText(/Odoo.sh selbst in seinen Projekteinstellungen ein eigenes GitHub-Token/)).toBeInTheDocument()
    })
})

describe('Odoo.sh staging and production', () => {
    const env = (values: Partial<ReturnType<typeof emptyOdooShEnvironment>>) => ({ ...emptyOdooShEnvironment(), ...values })
    const putSettings = () => (mutations().at(-1)![1] as { body: { settings: DevelopmentModuleSettingsInput } }).body.settings

    it('edits both stages independently with derived links and keeps them when the hosting changes', async () => {
        server.config = odooConfig(2, { hosting: 'odoo_sh' })
        mountDevelopment()
        const staging = await screen.findByRole('region', { name: 'Staging' })
        const production = screen.getByRole('region', { name: 'Produktion' })
        fireEvent.change(within(staging).getByLabelText(/^Staging-Branch/), { target: { value: 'staging' } })
        fireEvent.change(within(staging).getByLabelText(/^Staging · Build-ID/), { target: { value: '25004381' } })
        fireEvent.change(within(staging).getByLabelText(/^Staging · Build-Host/), { target: { value: 'erp-staging-25004381.dev.odoo.com' } })
        fireEvent.change(within(production).getByLabelText(/^Produktion-Branch/), { target: { value: 'main' } })
        expect(within(staging).getByRole('link', { name: 'Online-Editor ↗' })).toHaveAttribute('href', 'https://erp-staging-25004381.dev.odoo.com/odoo-sh/editor')
        expect(within(staging).getByText('ssh 25004381@erp-staging-25004381.dev.odoo.com')).toBeInTheDocument()
        expect(within(production).queryByRole('link', { name: /Build öffnen|Online-Editor/ })).not.toBeInTheDocument()
        // Switching hosting away and back keeps the draft values.
        fireEvent.click(screen.getByRole('radio', { name: 'Lokal' }))
        expect(screen.queryByRole('region', { name: 'Staging' })).not.toBeInTheDocument()
        expect(screen.getByText(/Odoo.sh-Angaben bleiben gespeichert/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Odoo.sh' }))
        expect(within(await screen.findByRole('region', { name: 'Staging' })).getByLabelText(/^Staging · Build-ID/)).toHaveValue('25004381')
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
        expect(await screen.findByText(/Gespeichert als Revision 3/)).toBeInTheDocument()
        expect(putSettings().odoo!.odooSh).toEqual({ dashboardUrl: null, unassigned: null,
            staging: env({ branch: 'staging', buildId: '25004381', buildHost: 'erp-staging-25004381.dev.odoo.com' }), production: env({ branch: 'main' }) })
    })

    it('warns when the working branch is the production branch and allows a deliberately shared SSH resource', async () => {
        server.config = odooConfig(2, { hosting: 'odoo_sh', odooSh: { dashboardUrl: null, unassigned: null,
            staging: env({ branch: 'staging', buildId: '1', buildHost: 'erp-staging-1.dev.odoo.com', sshResourceId: 'odoo-sh-ssh' }), production: env({ branch: 'main', buildId: '2', buildHost: 'erp-main-2.dev.odoo.com', sshResourceId: 'odoo-sh-ssh' }) } })
        mountDevelopment()
        expect(await screen.findByText(/dieselbe SSH-Ressource/)).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText(/^Arbeitsbranch für Sitzungen/), { target: { value: 'main' } })
        expect(screen.getByText(/Das ist der Produktions-Branch: Ein Push dorthin kann sofort in Produktion deployen/)).toBeInTheDocument()
    })

    it('shows legacy values without a stage and assigns them only on an explicit choice', async () => {
        const unassigned = { declaredStage: null, branch: 'old-branch', buildId: '777', buildHost: 'erp-old-777.dev.odoo.com', sshResourceId: 'legacy-ssh', applicationResourceId: null }
        server.config = odooConfig(2, { hosting: 'odoo_sh', developmentBranch: 'old-branch', odooSh: { dashboardUrl: null, staging: env({}), production: env({}), unassigned } })
        mountDevelopment()
        const legacy = (await screen.findByText(/Ältere Odoo.sh-Angaben ohne Stufe/)).closest('div')!
        expect(within(legacy).getByText('erp-old-777.dev.odoo.com')).toBeInTheDocument()
        expect(within(screen.getByRole('region', { name: 'Produktion' })).getByLabelText(/^Produktion · Build-ID/)).toHaveValue('')
        expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
        fireEvent.click(within(legacy).getByRole('button', { name: 'Als Staging übernehmen' }))
        expect(within(screen.getByRole('region', { name: 'Staging' })).getByLabelText(/^Staging · Build-ID/)).toHaveValue('777')
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
        expect(await screen.findByText(/Gespeichert als Revision 3/)).toBeInTheDocument()
        expect(putSettings().odoo).toMatchObject({ developmentBranch: 'old-branch', odooSh: { unassigned: null, production: env({}), staging: env({ branch: 'old-branch', buildId: '777', buildHost: 'erp-old-777.dev.odoo.com', sshResourceId: 'legacy-ssh' }) } })
    })

    it('requests build status per stage and discards an answer for another stage', async () => {
        server.config = odooConfig(2, { hosting: 'odoo_sh', odooSh: { dashboardUrl: null, unassigned: null, staging: env({ branch: 'staging' }), production: env({ branch: 'main' }) } })
        const answers = [{ environment: 'staging', ref: 'staging' }, { environment: 'production', ref: 'main' }]
        server.other = path => path.includes('/build-status') ? { projectId: 'p1', revision: 2, repositoryId: '101', fullName: 'acme/repo101', sha: 'a'.repeat(40), observedAt: 1, totalCount: 1, truncated: false, state: 'success', message: 'ok',
            statuses: [{ context: 'ci/odoo.sh (staging)', state: 'success', description: null, targetUrl: null, updatedAt: null }], ...answers.shift()! } : undefined
        mountDevelopment()
        fireEvent.click(await screen.findByRole('radio', { name: 'Produktion (main)' }))
        fireEvent.click(screen.getByRole('button', { name: 'Status abrufen' }))
        expect(await screen.findByText(/gehört zu einem anderen Ziel/)).toBeInTheDocument()
        expect(screen.queryByText('Erfolgreich')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Status abrufen' }))
        expect(await screen.findByText('Produktion ·')).toBeInTheDocument()
        expect(calls('/build-status').map(([path]) => path)).toEqual(Array(2).fill('/projects/p1/development/build-status?environment=production'))
    })
})

describe('checks, remedies and tasks', () => {
    const plugin = () => pluginModule(flutterDefinition({ recipes: [
        { id: 'test', title: 'Tests ausführen', summary: 'flutter test', kind: 'test', effects: ['runs_project_code'], prerequisites: ['git'], steps: [{ title: 'Test', detail: 'Tests.', argv: ['flutter', 'test'] }] },
        { id: 'sdk', title: 'SDK holen', summary: 'SDK', kind: 'setup', effects: ['network_download'], prerequisites: [], steps: [{ title: 'Holen', detail: 'SDK laden.' }] },
    ], tasks: [
        { id: 'tests', title: 'Flutter-Tests ausführen', description: 'Tests.', kind: 'test', specialist: 'builtin:tests', recipeIds: ['test'], topicIds: [], defaultTask: 'Teste.', requiresRepository: true },
        { id: 'review', title: 'Code lesen', description: 'Nur lesen.', kind: 'review', specialist: 'builtin:review', recipeIds: [], topicIds: [], defaultTask: 'Lies.', requiresRepository: true },
    ] }))
    function project(module: FixtureModule) {
        server.modules = [...builtins, module]
        server.config = moduleConfig(3, emptySettings({ activeModuleId: module.entry.id, repositoryId: '101', modules: { [module.entry.id]: adoptedEntry(module, { appDirectory: '.', channel: 'stable', minSdk: 0, web: false, flavors: [], platforms: [], notes: null, docs: null, branch: null, assets: null, signing: null }) } }), entries())
        server.other = path => path.endsWith('/modules-doctor') ? { projectId: 'p1', revision: 3, moduleId: module.entry.id, moduleDigest: module.entry.digest, runner: { status: 'ready', machineId: 'm1', missingCapabilities: [] },
            result: { contractVersion: 2, moduleId: module.entry.id, moduleDigest: module.entry.digest, provider: { id: 'hapi.toolchain', version: 1 }, observedAt: 1, durationMs: 10, host: { os: 'linux', arch: 'x64', image: null }, truncated: false, checks: [
                { id: 'git', label: 'Git', category: 'runtime', state: 'missing', remedy: { kind: 'recipe', text: 'Test-Ablauf einrichten.', recipeId: 'test' } },
                { id: 'java', label: 'Java', category: 'runtime', state: 'missing', remedy: { kind: 'recipe', text: 'SDK holen.', recipeId: 'sdk' } },
            ] } }
            : path.endsWith('/agent-catalog') ? { agents: [{ id: 'builtin:tests', available: true }, { id: 'builtin:review', available: true }], machines: [{ id: 'm1', name: 'Runner 1' }] } : undefined
    }

    it('opens the matching task form from a doctor remedy, says when none matches and starts nothing', async () => {
        project(plugin())
        mount('checks')
        fireEvent.click(await screen.findByRole('button', { name: 'Werkzeuge prüfen' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe öffnen: Flutter-Tests ausführen' }))
        const form = await screen.findByRole('form', { name: 'Sitzung starten: Flutter-Tests ausführen' })
        expect(within(form).getByText(/Auswirkungen: Führt Projektcode aus/)).toBeInTheDocument()
        expect(screen.getByText(/Keine Aufgabe dieses Moduls führt den Ablauf „SDK holen“ aus/)).toBeInTheDocument()
        expect(calls('/start')).toHaveLength(0)
        expect(mutations().map(([path]) => path)).toEqual(['/projects/p1/development/modules-doctor'])
    })

    it('offers the remedy task from the last doctor summary of the same revision without running the doctor again', async () => {
        const module = plugin()
        project(module)
        state.request.mockImplementation(async (path: string, options?: Options) => {
            const value = route(path, options) as Record<string, unknown>
            return path.endsWith('/modules-context') ? { ...value, lastDoctor: { observedAt: 1, revision: 3, moduleId: module.entry.id, moduleDigest: module.entry.digest, ready: 0, missing: 1, unsupported: 0, unknown: 0, warning: 0,
                missingRequired: [{ id: 'git', state: 'missing', remedyKind: 'recipe', recipeId: 'test' }] } } : value
        })
        mount('checks')
        const open = within(await screen.findByRole('list', { name: 'Offene Pflichtprüfungen der letzten Prüfung' })).getByRole('button', { name: 'Aufgabe öffnen: Flutter-Tests ausführen' })
        fireEvent.click(open)
        expect(await screen.findByRole('form', { name: 'Sitzung starten: Flutter-Tests ausführen' })).toBeInTheDocument()
        expect(calls('modules-doctor')).toHaveLength(0)
        expect(mutations()).toEqual([])
    })

    it('blocks consequential tasks under the restricted profile and keeps read-only tasks possible', async () => {
        state.project = { ...state.project, profile: 'restricted' }
        project(plugin())
        mountDevelopment()
        const tests = (await screen.findByText('Flutter-Tests ausführen')).closest('article')!
        expect(within(tests).getByText(/Braucht das Profil „Arbeitsbereich“ oder „Erweitert“/)).toBeInTheDocument()
        fireEvent.click(within(tests).getByRole('button', { name: 'Sitzung vorbereiten' }))
        expect(await screen.findByText(/Das Profil „Eingeschränkt“ erlaubt diese Aufgabe nicht \(Führt Projektcode aus\)/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Sitzung starten' })).toBeDisabled()
        const review = screen.getByText('Code lesen').closest('article')!
        expect(within(review).queryByText(/Braucht das Profil/)).not.toBeInTheDocument()
    })

    it('names the Odoo 20 access file correctly when a module has none', async () => {
        server.config = odooConfig(2)
        const odoo = builtins[0]!.entry
        server.other = path => path.endsWith('/modules-inspect') ? { projectId: 'p1', revision: 2, moduleId: odoo.id, moduleDigest: odoo.digest, runner: { status: 'ready', machineId: 'm1', missingCapabilities: [] }, repository: { state: 'granted', repositoryId: '101', fullName: 'acme/repo101', permission: 'read', checkoutPath: null, relativePath: null },
            result: { contractVersion: 2, moduleId: odoo.id, moduleDigest: odoo.digest, provider: { id: 'builtin.odoo', version: 1 }, repositoryId: '101', observedAt: 1, state: 'ready', branch: 'main', head: null, warnings: [], buildFiles: [], scanned: { files: 3, directories: 1, limitReached: false },
                odooModules: [{ path: 'sale_x', technicalName: 'sale_x', manifest: 'valid', name: 'Sale X', version: '20.0.1.0.0', versionMatchesMajor: true, license: null, installable: true, application: false, autoInstall: false, depends: ['sale'], externalPython: [], data: [], demo: [], assetsBundles: [], missingDataFiles: [], security: { accessCsv: false, accessRules: null, securityXmlFiles: 0 }, counts: { python: 1, xml: 0, csv: 0, js: 0, tests: 0 }, hasMigrations: false, issues: [] }] } } : undefined
        mountDevelopment()
        fireEvent.click(await screen.findByRole('button', { name: 'Odoo-Module prüfen' }))
        expect(await screen.findByText(/keine Zugriffsdatei \(Odoo 20: security\/ir.access.csv\)/)).toBeInTheDocument()
        expect(within(screen.getByLabelText('Ergebnis der Projektprüfung')).queryByText(/ir.model.access.csv/)).not.toBeInTheDocument()
    })
})

describe('final review regressions', () => {
    const values = (extra: Record<string, unknown> = {}) => ({ appDirectory: '.', channel: 'stable', minSdk: 0, web: false, flavors: [], platforms: [], notes: null, docs: null, branch: null, assets: null, signing: null, ...extra })
    const storedIntent = () => readSetupIntent('https://hub.example', 'user-1', 'p1')

    it('uses readiness only for the saved revision, rereads a stale one and rereads after any settings save', async () => {
        server.readinessRevision = 1
        mount('provider')
        await waitFor(() => expect(calls('/readiness').length).toBeGreaterThanOrEqual(2))
        // The hub still answers for revision 1: never shown as current evidence.
        expect(stepButton(/Anbieter und Runner/)).toHaveTextContent('Nicht geprüft')
        expect(screen.getByText(/gehört zu einer anderen Konfigurationsrevision/)).toBeInTheDocument()
        server.readinessRevision = undefined
        fireEvent.click(screen.getByRole('button', { name: 'Stand neu prüfen' }))
        await waitFor(() => expect(stepButton(/Anbieter und Runner/)).toHaveTextContent('Erledigt'))
        const before = calls('/readiness').length
        fireEvent.click(stepButton(/Modul und Einstellungen/))
        fireEvent.change(await screen.findByLabelText(/^Arbeitsbranch für Sitzungen/), { target: { value: 'feature-a' } })
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
        expect(await screen.findByText(/Gespeichert als Revision 3/)).toBeInTheDocument()
        await waitFor(() => expect(calls('/readiness').length).toBeGreaterThan(before))
    })

    it('derives the checks step from the doctor summary of exactly the saved revision; optional findings never block', async () => {
        const odoo = builtins[0]!.entry
        let last: Record<string, unknown> | null = { observedAt: 1, revision: 2, moduleId: odoo.id, moduleDigest: odoo.digest, ready: 3, missing: 1, unsupported: 0, unknown: 0, warning: 1, missingRequired: [] }
        state.request.mockImplementation(async (path: string, options?: Options) => {
            const value = route(path, options) as Record<string, unknown>
            return path.endsWith('/modules-context') ? { ...value, lastDoctor: last } : value
        })
        const view = mount('summary')
        await waitFor(() => expect(stepButton(/Prüfen und einrichten/)).toHaveTextContent('Erledigt'))
        expect(screen.getAllByText(/Alle Pflichtprüfungen bestanden.*Optionale Prüfungen haben Hinweise/).length).toBeGreaterThan(0)
        view.unmount()
        last = { ...last!, missingRequired: [{ id: 'postgresql.server', state: 'missing', remedyKind: 'operator', recipeId: null }] }
        const second = mount('summary')
        await waitFor(() => expect(stepButton(/Prüfen und einrichten/)).toHaveTextContent('Offen'))
        second.unmount()
        last = { ...last!, revision: 1, missingRequired: [] }
        mount('summary')
        await waitFor(() => expect(stepButton(/Prüfen und einrichten/)).toHaveTextContent('Nicht geprüft'))
        expect(mutations()).toEqual([])
    })

    it('does not treat a module without repository needs as requiring GitHub', async () => {
        const handbook = pluginModule(flutterDefinition({ id: 'handbook', title: 'Nur Handbuch', fields: [{ id: 'notes', kind: 'text', label: 'Notiz', default: null }], recipes: [], tasks: [], inspect: null, doctor: null }))
        server.modules = [...builtins, handbook]
        server.config = moduleConfig(1, emptySettings({ activeModuleId: handbook.entry.id, modules: { [handbook.entry.id]: adoptedEntry(handbook, { notes: null }) } }), entries())
        server.repositories = catalog([], false)
        mount('github')
        await waitFor(() => expect(stepButton(/GitHub und Repository/)).toHaveTextContent('Optional'))
        expect(screen.getByText(/braucht kein Repository/)).toBeInTheDocument()
        expect(stepButton(/Prüfen und einrichten/)).toHaveTextContent('Optional')
    })

    it('never blocks on an optional Enterprise source, also when a chosen one is no longer granted', async () => {
        server.config = odooConfig(2, { edition: 'enterprise', hosting: 'odoo_sh' })
        const first = mount('github')
        await waitFor(() => expect(stepButton(/GitHub und Repository/)).toHaveTextContent('Erledigt'))
        first.unmount()
        server.config = odooConfig(2, { edition: 'enterprise', enterpriseRepositoryId: '303' })
        mount('github')
        await waitFor(() => expect(stepButton(/GitHub und Repository/)).toHaveTextContent('Erledigt'))
        expect(screen.getAllByText(/Optionale Enterprise-Quelle: nicht mehr freigegeben/).length).toBeGreaterThan(0)
    })

    it('keeps a noted module whose id is saved with other values or another revision, and resolves only an exact match', async () => {
        const plugin = pluginModule(flutterDefinition())
        server.modules = [...builtins, plugin]
        server.config = moduleConfig(4, emptySettings({ activeModuleId: plugin.entry.id, modules: { [plugin.entry.id]: adoptedEntry(plugin, values({ channel: 'stable', notes: 'Andere Konfiguration' })) } }), entries())
        writeSetupIntent('https://hub.example', 'user-1', 'p1', { moduleId: plugin.entry.id, moduleDigest: plugin.entry.digest, values: values({ channel: 'beta', notes: 'Benutzerentwurf' }), repositoryId: null, createdAt: 1 })
        const view = mount('module')
        expect(await screen.findByText(/Inzwischen ist dieses Modul mit anderen Werten oder einer anderen Fassung gespeichert/)).toBeInTheDocument()
        expect(screen.getByLabelText(/^Hinweis für Übergaben/)).toHaveValue('Benutzerentwurf')
        expect(storedIntent()?.draft?.settings.modules[plugin.entry.id]?.values).toMatchObject({ notes: 'Benutzerentwurf' })
        expect(mutations()).toEqual([])
        view.unmount()
        // Exactly what is saved: the note is fulfilled and removed without any write.
        localStorage.clear()
        writeSetupIntent('https://hub.example', 'user-1', 'p1', { moduleId: plugin.entry.id, moduleDigest: plugin.entry.digest, values: values({ channel: 'stable', notes: 'Andere Konfiguration' }), repositoryId: null, createdAt: 1 })
        mount('module')
        await waitFor(() => expect(storedIntent()).toBeNull())
        expect(screen.queryByText(/Vorgemerkt, noch nicht gespeichert/)).not.toBeInTheDocument()
        expect(mutations()).toEqual([])
    })

    it('keeps a lone reader from deleting a noted draft', async () => {
        state.project = { ...state.project, role: 'viewer' }
        const plugin = pluginModule(flutterDefinition())
        server.modules = [...builtins, plugin]
        server.config = moduleConfig(4, emptySettings({ activeModuleId: plugin.entry.id, modules: { [plugin.entry.id]: adoptedEntry(plugin, values()) } }), entries())
        writeSetupIntent('https://hub.example', 'user-1', 'p1', { moduleId: plugin.entry.id, moduleDigest: plugin.entry.digest, values: values({ notes: 'Entwurf' }), repositoryId: null, createdAt: 1 })
        mount('module')
        expect(await screen.findByText(/Nur Projektadministratoren können ihn prüfen und speichern/)).toBeInTheDocument()
        expect(storedIntent()?.values).toMatchObject({ notes: 'Entwurf' })
    })

    it('keeps an adopted revision and a new required value across the GitHub detour and a reload, without saving', async () => {
        const repoField = { id: 'assets', kind: 'repository' as const, label: 'Asset-Repository', required: true }
        const base = flutterDefinition().fields!.filter(field => field.id !== 'assets')
        const r1 = pluginModule(flutterDefinition({ fields: [...base, repoField] }))
        const r2 = pluginModule(flutterDefinition({ contentVersion: '2026.11.01-1', fields: [...base, repoField, { id: 'target', kind: 'text', label: 'Build-Ziel', required: true, default: null }] }), { digestSeed: 'r2' })
        server.modules = [...builtins, r2]
        server.config = moduleConfig(0, emptySettings(), entries())
        server.repositories = catalog([repo('101', 'ready')])
        writeSetupIntent('https://hub.example', 'user-1', 'p1', { moduleId: r1.entry.id, moduleDigest: r1.entry.digest, values: values({ notes: 'aus Anlage' }), repositoryId: null, createdAt: 1 })
        const view = mount('module')
        fireEvent.click(await screen.findByRole('button', { name: 'Installierte Fassung übernehmen und Werte prüfen' }))
        fireEvent.change(await screen.findByLabelText(/^Build-Ziel/), { target: { value: 'apk' } })
        fireEvent.click(stepButton(/GitHub und Repository/))
        fireEvent.click(await screen.findByRole('button', { name: 'Als Standard vormerken und zum Modul' }))
        expect(await screen.findByLabelText(/^Build-Ziel/)).toHaveValue('apk')
        expect(screen.getByLabelText(/^Hinweis für Übergaben/)).toHaveValue('aus Anlage')
        expect(screen.queryByText(/Neue Modulfassung installiert/)).not.toBeInTheDocument()
        // Reload: the same scoped draft comes back.
        view.unmount()
        mount('module')
        expect(await screen.findByLabelText(/^Build-Ziel/)).toHaveValue('apk')
        fireEvent.change(screen.getByLabelText(/^Asset-Repository/), { target: { value: '101' } })
        expect(mutations()).toEqual([])
        const save = screen.getByRole('button', { name: 'Speichern' })
        await waitFor(() => expect(save).toBeEnabled())
        fireEvent.click(save)
        expect(await screen.findByText(/Gespeichert als Revision 1/)).toBeInTheDocument()
        const body = (mutations()[0]![1] as { body: { settings: DevelopmentModuleSettingsInput } }).body.settings
        expect(body).toMatchObject({ activeModuleId: r2.entry.id, repositoryId: '101', modules: { [r2.entry.id]: { moduleDigest: r2.entry.digest, values: { target: 'apk', assets: '101', notes: 'aus Anlage' } } } })
        await waitFor(() => expect(storedIntent()).toBeNull())
    })

    it('turns a restored draft based on an older revision into the visible conflict choice', async () => {
        server.config = odooConfig(5)
        const settings = { ...settingsInputOf(odooConfig(4).settings), odoo: { ...defaultOdooSettings(20), developmentBranch: 'mein-entwurf' } }
        writeSetupIntent('https://hub.example', 'user-1', 'p1', { moduleId: null, moduleDigest: null, values: null, repositoryId: null, createdAt: 1, draft: { baseRevision: 4, settings } })
        mount('module')
        expect(await screen.findByText(/Die Konfiguration wurde inzwischen geändert/)).toBeInTheDocument()
        expect(screen.getByLabelText(/^Arbeitsbranch für Sitzungen/)).toHaveValue('mein-entwurf')
        expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
    })
})

describe('stored drafts are untrusted input', () => {
    const key = 'hapi.evolved.setup-intent:' + JSON.stringify(['https://hub.example', 'user-1', 'p1'])
    const odooDraft = (odoo: Record<string, unknown>) => ({ moduleId: null, moduleDigest: null, values: null, repositoryId: null, createdAt: 1,
        draft: { baseRevision: 2, settings: { ...settingsInputOf(odooConfig(2).settings), odoo: { ...defaultOdooSettings(20), hosting: 'odoo_sh', ...odoo } } } })
    const sh = (extra: Record<string, unknown>) => ({ dashboardUrl: null, staging: emptyOdooShEnvironment(), production: emptyOdooShEnvironment(), unassigned: null, ...extra })
    const corrupt: Array<[string, unknown]> = [
        ['legacy branch is an object', odooDraft({ odooSh: sh({ unassigned: { declaredStage: null, branch: { label: 'main' }, buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: null } }) })],
        ['legacy entry lacks its stage key', odooDraft({ odooSh: sh({ unassigned: { branch: 'main', buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: null } }) })],
        ['production branch is an object', odooDraft({ odooSh: sh({ production: { ...emptyOdooShEnvironment(), branch: { label: 'main' } } }) })],
        ['environment is empty', odooDraft({ odooSh: sh({ staging: {} }) })],
        ['addons path is an object', odooDraft({ addonsPaths: [{ path: 'x' }] })],
        ['unknown hosting', odooDraft({ hosting: 'cloud' })],
    ]
    it.each(corrupt)('ignores a draft whose %s and still renders the setup', async (_name, stored) => {
        localStorage.setItem(key, JSON.stringify(stored))
        const errors: unknown[] = []
        const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
        try {
            mount('module')
            expect(await screen.findByRole('form', { name: 'Einstellungen des Entwicklungsmoduls' })).toBeInTheDocument()
            expect(screen.queryByText(/Vorgemerkt, noch nicht gespeichert/)).not.toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
            expect(mutations()).toEqual([])
            expect(errors.filter(args => String(args).includes('Objects are not valid as a React child'))).toEqual([])
        } finally { spy.mockRestore() }
    })

    it('keeps a correctly typed but still invalid partial draft and shows its field problems', async () => {
        const unassigned = { declaredStage: 'development', branch: 'alt', buildId: '7', buildHost: 'erp-alt-7.dev.odoo.com', sshResourceId: null, applicationResourceId: null }
        localStorage.setItem(key, JSON.stringify(odooDraft({ developmentBranch: 'feature..x', testDatabaseSlug: '', odooSh: sh({ unassigned,
            staging: { ...emptyOdooShEnvironment(), branch: 'main', sshResourceId: 'ssh-vorab' }, production: { ...emptyOdooShEnvironment(), branch: 'main' } }) })))
        mount('module')
        expect(await screen.findByText(/Vorgemerkt, noch nicht gespeichert/)).toBeInTheDocument()
        expect(within(screen.getByRole('region', { name: 'Staging' })).getByLabelText(/^Staging · SSH-Ressource/)).toHaveValue('ssh-vorab')
        expect(within(screen.getByRole('region', { name: 'Produktion' })).getByLabelText(/^Produktion-Branch/)).toHaveValue('main')
        expect(screen.getByLabelText(/^Arbeitsbranch für Sitzungen/)).toHaveValue('feature..x')
        expect(screen.getByText('erp-alt-7.dev.odoo.com')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
        expect(readSetupIntent('https://hub.example', 'user-1', 'p1')?.draft?.settings.odoo?.odooSh.staging.sshResourceId).toBe('ssh-vorab')
        expect(mutations()).toEqual([])
    })
})
