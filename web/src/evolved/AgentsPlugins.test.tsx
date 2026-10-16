import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { EvolvedApiError, type EvolvedProject } from './api'
import { AgentsPluginsPanel } from './AgentsPlugins'
import { ProjectWorkflowProvider, useProjectWorkflow } from './ProjectWorkflowContext'

const repositoryChoices = vi.hoisted(() => ({ items: [] as Array<{ id: string; fullName: string; local: { state: string } }> }))
const context = vi.hoisted(() => ({ api: { baseUrl: '', request: vi.fn() }, me: { user: { id: 'human', isAdmin: true } }, project: null as EvolvedProject | null }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('./repositoryCatalog', () => ({ useProjectRepositories: () => ({ current: { runner: { status: 'ready' }, repositories: repositoryChoices.items }, error: null, isFetching: false, refetch: vi.fn() }) }))
vi.mock('./useProviderModels', () => ({ useProviderModels: ({ provider }: { provider: string }) => ({ enabled: true, canRefresh: false, data: { provider, status: 'ready', source: 'native-cli', models: [{ id: 'future-dynamic-model', label: 'Future dynamic model' }] }, isLoading: false, error: null, refresh: vi.fn() }) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ to, params, search, children, ...props }: { to: string; params?: { sessionId?: string }; search?: Record<string, string>; children: ReactNode }) => <a href={to.replace('$sessionId', params?.sessionId ?? '') + (search ? `?${new URLSearchParams(search)}` : '')} {...props}>{children}</a> }))
const agent = { id: 'specialist', name: 'Prüfer', description: 'Prüft das Projekt.', instructions: 'Prüfe sorgfältig.', providerPreference: 'either', skills: [] as string[], origin: 'builtin', available: true }
const manifest = { schemaVersion: 1, id: 'example', name: 'Example Plugin', version: '1.0.0', description: 'Beispiel-Erweiterung', agents: [{ ...agent, id: 'reviewer' }], skills: [{ id: 'inspect', name: 'Inspektion', description: 'Quellen prüfen', instructions: '<img src="https://tracking.invalid/pixel">' }], themes: [] }
const installed = { id: 'plugin-1', repository: 'example/plugin', repositoryId: '42', commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), manifest, enabled: true, installedAt: Date.now(), updatedAt: Date.now() }
const preview = { ...installed, id: undefined, previewId: 'preview-1', pluginId: null, expiresAt: Date.now() + 600000 }
let canManage = true, agents = [agent], plugins: typeof installed[] = []
const catalog = () => ({ agents, skills: [], themes: [], canManage, machines: [{ id: 'machine-1', name: 'Projekt-Runner' }] })
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return { ...render(<QueryClientProvider client={client}><AgentsPluginsPanel /></QueryClientProvider>), client }
}
beforeEach(() => {
    canManage = true; agents = [agent]; plugins = []; repositoryChoices.items = []
    context.project = { id: 'project-1', name: 'Projekt Alpha', teamId: 'team', role: 'admin', profile: 'restricted' }
    context.api.request.mockReset().mockImplementation(async (path: string) => path === '/plugins' ? { plugins } : catalog())
})

it('global catalog stays available without a project; only explicit project context enables a launch', async () => {
    context.project = null
    mount()
    expect(await screen.findByText('Prüfer')).toBeInTheDocument()
    expect(screen.getByText(/Wähle oben ein Projekt/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aufgabe starten' })).toBeDisabled()
    expect(context.api.request).toHaveBeenCalledWith('/agent-catalog', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(context.api.request.mock.calls.some(([path]) => path.includes('/projects/'))).toBe(false)
})

it('viewer cannot start or manage global definitions and readonly builtins cannot be edited', async () => {
    canManage = false; context.project!.role = 'viewer'
    mount()
    await screen.findByText('Prüfer')
    expect(screen.getByRole('button', { name: 'Aufgabe starten' })).toBeDisabled()
    for (const name of ['Agent erstellen', 'Bearbeiten', 'Agent löschen', 'Plugin prüfen']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.getByText(/Installationsadministrator/)).toBeInTheDocument()
})

it('custom agent creation sends only supported fields and refreshes the catalog', async () => {
    context.api.request.mockImplementation(async (path: string, options: { method?: string; body?: unknown }) => {
        if (options?.method === 'POST') return { agent: { ...agent, id: 'created' } }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Agent erstellen' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tester' } })
    fireEvent.change(screen.getByLabelText('Beschreibung'), { target: { value: 'Testet Änderungen' } })
    fireEvent.change(screen.getByLabelText('Anweisungen'), { target: { value: 'Führe relevante Tests aus.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agent speichern' }))
    expect(await screen.findByText(/Agent wurde gespeichert/)).toBeInTheDocument()
    expect(context.api.request).toHaveBeenCalledWith('/agent-catalog', expect.objectContaining({ method: 'POST', body: { name: 'Tester', description: 'Testet Änderungen', instructions: 'Führe relevante Tests aus.', providerPreference: 'either', skills: [], model: undefined } }))
})

it('a disabled plugin skill blocks launch and can be explicitly removed from a custom agent', async () => {
    agents = [{ ...agent, origin: 'custom', available: false, skills: ['disabled-plugin:skill'] }]
    context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
        if (options?.method === 'PUT') return { agent: { ...agent, origin: 'custom' } }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Bearbeiten' }))
    expect(screen.getByRole('button', { name: 'Aufgabe starten' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Nicht verfügbare Fähigkeit: disabled-plugin:skill/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Agent speichern' }))
    await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/agent-catalog/specialist', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ skills: [] }) })))
})

it('agent starts submit the selected dynamic model and provider changes clear the previous model', async () => {
    context.api.request.mockImplementation(async (path: string, options: { body?: Record<string, unknown> }) => {
        if (path.endsWith('/start')) return { sessionId: 'model-session', operationId: options.body!.operationId, acknowledged: 'persisted' }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe starten' }))
    const picker = screen.getByLabelText('Modell für diesen Start (optional)')
    expect(screen.getByRole('option', { name: 'Future dynamic model' })).toBeInTheDocument()
    fireEvent.change(picker, { target: { value: 'future-dynamic-model' } })
    fireEvent.change(screen.getByLabelText('Anbieter'), { target: { value: 'codex' } })
    expect(screen.getByLabelText('Modell für diesen Start (optional)')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Modell für diesen Start (optional)'), { target: { value: 'future-dynamic-model' } })
    fireEvent.change(screen.getByLabelText('Aufgabe'), { target: { value: 'Prüfe das neue Modell.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    await screen.findByRole('link', { name: 'Sitzung öffnen' })
    expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/agent-catalog/specialist/start', expect.objectContaining({ body: expect.objectContaining({ provider: 'codex', model: 'future-dynamic-model' }) }))
})

it('uncertain start retains exact operation ID and payload; confirmed replay opens the persisted session', async () => {
    const starts: Record<string, unknown>[] = []
    context.api.request.mockImplementation(async (path: string, options: { method?: string; body?: Record<string, unknown> }) => {
        if (path.endsWith('/start')) {
            starts.push(options.body!)
            if (starts.length === 1) throw new Error('Antwort verloren')
            return { sessionId: 'session-1', operationId: options.body!.operationId, acknowledged: 'persisted' }
        }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe starten' }))
    fireEvent.change(screen.getByLabelText('Aufgabe'), { target: { value: 'Prüfe den GitHub-Zugriff.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    expect(await screen.findByText(/Die Startbestätigung fehlt/)).toBeInTheDocument()
    expect(screen.getByLabelText('Aufgabe')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Aufgabe starten' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Startbestätigung erneut prüfen' }))
    expect(await screen.findByText(/Aufgabe wurde dauerhaft/)).toBeInTheDocument()
    expect(starts[1]).toEqual(starts[0])
    expect(starts[0].operationId).toMatch(/^[a-f0-9-]{36}$/)
    expect(screen.getByRole('link', { name: 'Sitzung öffnen' })).toHaveAttribute('href', '/sessions/session-1')
})

it('preflight rejection allows correcting a task without trapping the user in uncertain-start recovery', async () => {
    context.api.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/start')) throw new EvolvedApiError('Auftrag ist zu lang', 400, 'agent_prompt_limit', false)
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe starten' }))
    fireEvent.change(screen.getByLabelText('Aufgabe'), { target: { value: 'Prüfe das Projekt.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Auftrag ist zu lang')
    expect(screen.getByLabelText('Aufgabe')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeEnabled()
    expect(screen.queryByText(/Die Startbestätigung fehlt/)).not.toBeInTheDocument()
})

it('a later preflight error cannot unlock an already uncertain operation or replace its payload', async () => {
    const starts: Record<string, unknown>[] = []
    context.api.request.mockImplementation(async (path: string, options: { body?: Record<string, unknown> }) => {
        if (path.endsWith('/start')) {
            starts.push(options.body!)
            if (starts.length === 1) throw new Error('Antwort verloren')
            throw new EvolvedApiError('Runner nicht erreichbar', 409, 'runner_unavailable', false)
        }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe starten' }))
    fireEvent.change(screen.getByLabelText('Aufgabe'), { target: { value: 'Prüfe das Projekt.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Startbestätigung erneut prüfen' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Runner nicht erreichbar')
    expect(starts).toHaveLength(2)
    expect(starts[1]).toEqual(starts[0])
    expect(screen.getByLabelText('Aufgabe')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Aufgabe starten' })).toBeDisabled()
    expect(screen.getByText(/Die Startbestätigung fehlt/)).toBeInTheDocument()
})

it('an uncertain start gets a new operation ID only after explicit recovery confirmation, never on cancel', async () => {
    const starts: Record<string, unknown>[] = []
    context.api.request.mockImplementation(async (path: string, options: { body?: Record<string, unknown> }) => {
        if (path.endsWith('/start')) { starts.push(options.body!); throw new EvolvedApiError('Ausgang unklar', 409, 'agent_start_indeterminate') }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe starten' }))
    fireEvent.change(screen.getByLabelText('Aufgabe'), { target: { value: 'Prüfe das Projekt.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    const recovery = await screen.findByRole('button', { name: 'Nach Sitzungsprüfung neuen Auftrag vorbereiten' })
    fireEvent.click(recovery); fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(starts).toHaveLength(1)
    expect(screen.getByLabelText('Aufgabe')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Nach Sitzungsprüfung neuen Auftrag vorbereiten' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
    expect(starts).toHaveLength(1)
    expect(screen.getByLabelText('Aufgabe')).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    await waitFor(() => expect(starts).toHaveLength(2))
    expect(starts[1].operationId).not.toBe(starts[0].operationId)
})

it('plugin preview renders untrusted instructions only as text and installs exact reviewed hashes', async () => {
    context.api.request.mockImplementation(async (path: string, options: { method?: string; body?: unknown }) => {
        if (path === '/plugins/preview') return { preview }
        if (path === '/plugins' && options?.method === 'POST') { plugins = [installed]; return { plugin: installed } }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.change(await screen.findByLabelText(/^GitHub-Repository/), { target: { value: 'example/plugin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plugin prüfen' }))
    expect(await screen.findByText('a'.repeat(40))).toBeInTheDocument()
    expect(document.querySelector('img[src*="tracking.invalid"]')).toBeNull()
    expect(screen.getByText('<img src="https://tracking.invalid/pixel">')).toBeInTheDocument()
    expect(context.api.request.mock.calls.some(([path, options]) => path === '/plugins' && options?.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Diese Fassung installieren' }))
    expect(await screen.findByText('Plugin wurde installiert.')).toBeInTheDocument()
    expect(context.api.request).toHaveBeenCalledWith('/plugins', expect.objectContaining({ method: 'POST', body: { previewId: 'preview-1', commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) } }))
})

it('plugin update requires a fresh explicit preview, and uninstallation needs confirmation', async () => {
    plugins = [installed]
    context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
        if (path.endsWith('/preview-update')) return { preview: { ...preview, pluginId: 'plugin-1', commitSha: 'c'.repeat(40) } }
        if (options?.method === 'DELETE') { plugins = []; return { ok: true } }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Update prüfen' }))
    expect(await screen.findByText('c'.repeat(40))).toBeInTheDocument()
    expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/update'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Vorschau verwerfen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deinstallieren' }))
    expect(context.api.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deinstallieren' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
    await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/plugins/plugin-1', expect.objectContaining({ method: 'DELETE' })))
})

it('a lost mutation response reloads persisted plugin state instead of reporting silent success', async () => {
    plugins = [installed]
    context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
        if (options?.method === 'PUT') { plugins = [{ ...installed, enabled: false }]; throw new Error('Verbindung unterbrochen') }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Deaktivieren' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Verbindung unterbrochen')
    expect(await screen.findByRole('button', { name: 'Aktivieren' })).toBeInTheDocument()
    expect(screen.queryByText('Plugin wurde installiert.')).not.toBeInTheDocument()
})

it('context switch aborts in-flight mutations and old responses never populate the new project', async () => {
    let signal: AbortSignal | undefined, finish: ((result: unknown) => void) | undefined
    context.api.request.mockImplementation(async (path: string, options: { method?: string; signal?: AbortSignal }) => {
        if (path === '/plugins/preview') { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
        return path === '/plugins' ? { plugins } : catalog()
    })
    const view = mount()
    fireEvent.change(await screen.findByLabelText(/^GitHub-Repository/), { target: { value: 'example/plugin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plugin prüfen' }))
    await waitFor(() => expect(signal).toBeDefined())
    context.project = { ...context.project!, id: 'project-2' }
    view.rerender(<QueryClientProvider client={view.client}><AgentsPluginsPanel /></QueryClientProvider>)
    expect(signal!.aborted).toBe(true)
    await act(async () => finish?.({ preview }))
    expect(screen.queryByRole('button', { name: 'Diese Fassung installieren' })).not.toBeInTheDocument()
})

it('an explicit repository selection is retained unchanged across an uncertain specialist start', async () => {
    repositoryChoices.items = [{ id: '101', fullName: 'example/app', local: { state: 'ready' } }]
    const starts: Record<string, unknown>[] = []
    context.api.request.mockImplementation(async (path, options) => {
        if (path.endsWith('/start')) { starts.push(options.body); throw new Error('Lost response') }
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe starten' }))
    fireEvent.change(screen.getByLabelText(/^Arbeitsort/), { target: { value: '101' } })
    fireEvent.change(screen.getByLabelText('Aufgabe'), { target: { value: 'Check scoped code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    await screen.findByText(/Die Startbestätigung fehlt/)
    expect(screen.getByLabelText(/^Arbeitsort/)).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Startbestätigung erneut prüfen' }))
    await waitFor(() => expect(starts).toHaveLength(2))
    expect(starts[0].repositoryId).toBe('101'); expect(starts[1]).toEqual(starts[0])
    expect(starts[0]).not.toHaveProperty('directory')
})
it('review context prefills only the builtin reviewer and requires explicit start with typed snapshot paths', async () => {
    agents = [{ ...agent, id: 'builtin:review' }]
    repositoryChoices.items = [{ id: '101', fullName: 'example/app', local: { state: 'ready' } }]
    function Trigger() { const workflow = useProjectWorkflow()!; return <><button onClick={() => workflow.setReview({ repositoryId: '101', snapshotId: 'b'.repeat(64), paths: ['src/a,b.ts'] })}>Prepare fixture</button><AgentsPluginsPanel /></> }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><ProjectWorkflowProvider><Trigger /></ProjectWorkflowProvider></QueryClientProvider>)
    await screen.findByText('Prüfer'); fireEvent.click(screen.getByRole('button', { name: 'Prepare fixture' }))
    expect(await screen.findByLabelText(/^Arbeitsort/)).toHaveValue('101')
    expect(screen.getByLabelText(/^Arbeitsort/)).toBeDisabled()
    expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/start'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/agent-catalog/builtin%3Areview/start', expect.objectContaining({ body: expect.objectContaining({ repositoryId: '101', review: { snapshotId: 'b'.repeat(64), paths: ['src/a,b.ts'] } }) })))
})

it('shows a scoped repository start intent before selecting a specialist without automatically starting', async () => {
    repositoryChoices.items = [{ id: '101', fullName: 'example/app', local: { state: 'ready' } }]
    function Trigger() { const workflow = useProjectWorkflow()!; return <><button onClick={() => workflow.setRepositoryId('101')}>Repo intent</button><AgentsPluginsPanel /></> }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><ProjectWorkflowProvider><Trigger /></ProjectWorkflowProvider></QueryClientProvider>)
    await screen.findByText('Prüfer'); fireEvent.click(screen.getByRole('button', { name: 'Repo intent' }))
    expect(screen.getByText(/Repository-ID 101 ist für den nächsten Start vorausgewählt/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Repo-Vorauswahl verwerfen' }))
    expect(screen.queryByText(/Repository-ID 101 ist für den nächsten Start vorausgewählt/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Repo intent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Aufgabe starten' }))
    expect(screen.getByLabelText(/^Arbeitsort/)).toHaveValue('101')
    expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/start'))).toBe(false)
})

it.each([['repository_read_busy', false, false], ['repository_checkout_unavailable', false, false], ['repository_access_changed', false, false], ['repository_access_changed', true, true], ['worktree_changed', undefined, true]])('uses the explicit reservation marker for %s rather than guessing from the code', async (code, reserved, uncertain) => {
    context.api.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/start')) throw new EvolvedApiError('Repository check failed', 409, code as string, reserved as boolean | undefined)
        return path === '/plugins' ? { plugins } : catalog()
    })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe starten' }))
    fireEvent.change(screen.getByLabelText('Aufgabe'), { target: { value: 'Check repository' } })
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt starten' }))
    await screen.findByText('Repository check failed')
    expect((screen.getByLabelText('Aufgabe') as HTMLTextAreaElement).disabled).toBe(uncertain)
    expect(Boolean(screen.queryByText(/Die Startbestätigung fehlt/))).toBe(uncertain)
})

it('does not claim empty plugins or a missing runner when the corresponding catalog failed', async () => {
    context.api.request.mockRejectedValue(new Error('Catalog unavailable'))
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog unavailable')
    expect(screen.queryByText('Noch keine Plugins installiert.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Noch kein ausführender Runner/)).not.toBeInTheDocument()
})
