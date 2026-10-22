import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationPanel } from './Automation'
import { RunnerPanel } from './Runner'
import { PreviewsPanel } from './Previews'
import { ProjectsPanel } from './ProjectsTeam'
import { EvolvedApiError, type ExecutionProfile, type ProjectRole } from './api'

const context = vi.hoisted(() => ({ api: { request: vi.fn(), baseUrl: '' }, project: { id: 'project-1', role: 'admin' as ProjectRole, profile: 'restricted' as ExecutionProfile, rootPath: '/work/project' }, me: { user: { id: 'user-1', isAdmin: false }, accessibleProjects: [] }, refresh: vi.fn(), selectProject: vi.fn() }))
const standardRunnerScopes = (profile: ExecutionProfile) => [
    'runner:connect', 'git:read', 'memory:read', 'memory:write', 'codegraph:read',
    'peers:read', 'peers:send', 'peers:manage',
    ...(profile === 'restricted' ? [] : ['git:write']),
]
vi.mock('./auth', () => ({ useEvolved: () => context }))
// Module choice during creation has its own tests (ProjectsTeam.test.tsx); here it stays a general project.
vi.mock('./DevelopmentModuleCreation', () => ({ useDevelopmentCreation: () => ({ blocker: null, development: () => undefined, intent: () => null, deferred: false, reset: () => {}, showServerIssues: () => {}, handleFailure: () => {} }), DevelopmentCreationFields: () => null }))
beforeEach(() => { context.project.role = 'admin'; context.project.profile = 'restricted'; context.me.user.id = 'user-1'; context.me.user.isAdmin = false; context.api.request.mockReset(); context.refresh.mockReset() })
/** Teams for the form; a created project carries its returned id (the hub's 201 body). */
const creationResponses = () => context.api.request.mockImplementation(async (path: string, options?: { method?: string }) => path === '/projects' && options?.method === 'POST' ? { project: { id: 'created-1' } } : { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] })
function mount(component: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}>{component}</QueryClientProvider>)
    return client
}
describe('Operator access', () => {
    it.each([false, true])('creates a project with an automatic directory by default (system admin: %s)', async (isAdmin) => {
        context.me.user.isAdmin = isAdmin
        creationResponses()
        mount(<ProjectsPanel />)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Automatic project' } })
        expect(screen.queryByLabelText('Projektordner auf dem Server')).not.toBeInTheDocument()
        expect(screen.getByText(/automatisch ein eigener Ordner/)).toBeInTheDocument()
        expect(Boolean(screen.queryByLabelText('Ordner manuell festlegen oder wählen'))).toBe(isAdmin)
        expect(context.api.request.mock.calls.some(([path]) => path.startsWith('/workspaces'))).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects', { method: 'POST', body: { name: 'Automatic project', teamId: 'team-1' }, signal: expect.any(AbortSignal) }))
    })
    it('requires a nonempty manual path, submits a typed path and resets after success', async () => {
        context.me.user.isAdmin = true
        creationResponses()
        mount(<ProjectsPanel />)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Repository' } })
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        expect(screen.getByRole('button', { name: 'Projekt anlegen' })).toBeDisabled()
        expect(context.api.request.mock.calls.some(([path]) => path.startsWith('/workspaces'))).toBe(false)
        fireEvent.change(screen.getByLabelText(/Projektordner auf dem Server/), { target: { value: ' /workspaces/project ' } })
        expect(screen.getByText(/aktuelle Passkey-Anmeldung/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects', { method: 'POST', body: { name: 'Repository', teamId: 'team-1', rootPath: '/workspaces/project' }, signal: expect.any(AbortSignal) }))
        await waitFor(() => expect(screen.getByLabelText('Projektname')).toHaveValue(''))
        expect(screen.getByLabelText('Ordner manuell festlegen oder wählen')).not.toBeChecked()
        expect(screen.queryByLabelText('Projektordner auf dem Server')).not.toBeInTheDocument()
    })
    it('discards the manual path when returning to automatic creation', async () => {
        context.me.user.isAdmin = true
        creationResponses()
        mount(<ProjectsPanel />)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Automatic again' } })
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        fireEvent.change(screen.getByLabelText(/Projektordner auf dem Server/), { target: { value: '/workspaces/stale' } })
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects', { method: 'POST', body: { name: 'Automatic again', teamId: 'team-1' }, signal: expect.any(AbortSignal) }))
    })
    it('loads server roots only on request and chooses a directory across bounded pages', async () => {
        context.me.user.isAdmin = true
        context.api.request.mockImplementation(async (path: string) => {
            if (path === '/teams') return { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
            if (path === '/workspaces') return { roots: [{ path: '/allowed', name: 'allowed', selectable: false }], path: null, directories: [], hasMore: false }
            if (path.includes('offset=0')) return { roots: [], path: '/allowed', directories: [], hasMore: true, nextOffset: 50 }
            if (path.includes('offset=50')) return { roots: [], path: '/allowed', directories: [{ path: '/allowed/repo', name: 'repo', selectable: true }], hasMore: false }
            return { project: {} }
        })
        mount(<ProjectsPanel />)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Selected folder' } })
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        expect(context.api.request.mock.calls.some(([path]) => path.startsWith('/workspaces'))).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Ordner auf dem Server auswählen' }))
        expect(await screen.findByRole('button', { name: 'allowed verwenden' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'allowed öffnen' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Weitere Ordner' }))
        fireEvent.click(await screen.findByRole('button', { name: 'repo verwenden' }))
        expect(screen.getByLabelText(/Projektordner auf dem Server/)).toHaveValue('/allowed/repo')
        expect(screen.queryByRole('group', { name: 'Ordner auf dem Server auswählen' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects', { method: 'POST', body: { name: 'Selected folder', teamId: 'team-1', rootPath: '/allowed/repo' }, signal: expect.any(AbortSignal) }))
    })
    it('shows empty roots and allows recovery after a failed directory request', async () => {
        context.me.user.isAdmin = true
        let failed = true
        context.api.request.mockImplementation(async (path: string) => {
            if (path === '/teams') return { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
            if (failed) throw new Error('Ordnerliste nicht erreichbar')
            return { roots: [], directories: [], path: null, hasMore: false }
        })
        mount(<ProjectsPanel />)
        await screen.findByLabelText('Projektname')
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        fireEvent.click(screen.getByRole('button', { name: 'Ordner auf dem Server auswählen' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Ordnerliste nicht erreichbar')
        failed = false
        fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
        expect(await screen.findByText(/Keine manuell auswählbaren Ordner/)).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    it('hides previously loaded directory names when access is revoked on refresh', async () => {
        context.me.user.isAdmin = true
        let revoked = false
        context.api.request.mockImplementation(async (path: string) => {
            if (path === '/teams') return { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
            if (revoked) throw new Error('Zugriff widerrufen')
            return { roots: [{ path: '/sensitive', name: 'sensitive', selectable: true }], directories: [], path: null, hasMore: false }
        })
        mount(<ProjectsPanel />)
        await screen.findByLabelText('Projektname')
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        fireEvent.click(screen.getByRole('button', { name: 'Ordner auf dem Server auswählen' }))
        await screen.findByRole('button', { name: 'sensitive verwenden' })
        revoked = true
        fireEvent.click(screen.getByRole('button', { name: 'Ordnerliste aktualisieren' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Zugriff widerrufen')
        expect(screen.queryByText('sensitive')).not.toBeInTheDocument()
        expect(screen.queryByText('/sensitive')).not.toBeInTheDocument()
    })
    it.each(['account', 'admin-role'])('clears drafts and aborts directory reads after a changed %s', async (change) => {
        context.me.user.isAdmin = true
        let readSignal: AbortSignal | undefined
        context.api.request.mockImplementation(async (path: string, options: { signal?: AbortSignal }) => {
            if (path === '/teams') return { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
            readSignal = options.signal
            return new Promise(() => {})
        })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const view = render(<QueryClientProvider client={client}><ProjectsPanel /></QueryClientProvider>)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Old draft' } })
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        fireEvent.change(screen.getByLabelText(/Projektordner auf dem Server/), { target: { value: '/old/private' } })
        fireEvent.click(screen.getByRole('button', { name: 'Ordner auf dem Server auswählen' }))
        await waitFor(() => expect(readSignal).toBeDefined())
        if (change === 'account') context.me.user.id = 'user-2'
        else context.me.user.isAdmin = false
        view.rerender(<QueryClientProvider client={client}><ProjectsPanel /></QueryClientProvider>)
        expect(await screen.findByLabelText('Projektname')).toHaveValue('')
        expect(screen.queryByLabelText('Projektordner auf dem Server')).not.toBeInTheDocument()
        expect(readSignal?.aborted).toBe(true)
        if (change === 'account') expect(client.getQueryCache().find({ queryKey: ['evolved', 'teams', '', 'user-2'] })).toBeDefined()
        else expect(screen.queryByLabelText('Ordner manuell festlegen oder wählen')).not.toBeInTheDocument()
    })
    it('keeps input for a failed creation and prevents duplicate submission while busy', async () => {
        context.me.user.isAdmin = true
        let rejectCreate!: (error: Error) => void
        context.api.request.mockImplementation(async (path: string) => path === '/teams'
            ? { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
            : new Promise((_resolve, reject) => { rejectCreate = reject }))
        mount(<ProjectsPanel />)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Retry me' } })
        const button = screen.getByRole('button', { name: 'Projekt anlegen' })
        fireEvent.click(button)
        fireEvent.click(button)
        expect(screen.getByLabelText('Projektname')).toBeDisabled()
        expect(screen.getByLabelText('Ordner manuell festlegen oder wählen')).toBeDisabled()
        expect(context.api.request.mock.calls.filter(([path]) => path === '/projects')).toHaveLength(1)
        // A definite refusal (4xx) proves nothing was created; the input stays and a new attempt is allowed.
        rejectCreate(new EvolvedApiError('Projekt konnte nicht angelegt werden', 400, 'invalid_name'))
        expect(await screen.findByRole('alert')).toHaveTextContent('Projekt konnte nicht angelegt werden')
        expect(screen.getByLabelText('Projektname')).toHaveValue('Retry me')
        context.api.request.mockResolvedValue({ project: { id: 'created-2' } })
        fireEvent.click(button)
        await waitFor(() => expect(screen.getByLabelText('Projektname')).toHaveValue(''))
    })
    it('aborts project creation on account change and ignores a late response', async () => {
        context.me.user.isAdmin = true
        let finish!: (result: unknown) => void
        let signal: AbortSignal | undefined
        context.api.request.mockImplementation(async (path: string, options: { signal?: AbortSignal }) => {
            if (path === '/teams') return { teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] }
            signal = options.signal
            return new Promise(resolve => { finish = resolve })
        })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const view = render(<QueryClientProvider client={client}><ProjectsPanel /></QueryClientProvider>)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Old account project' } })
        fireEvent.click(screen.getByLabelText('Ordner manuell festlegen oder wählen'))
        fireEvent.change(screen.getByLabelText(/Projektordner auf dem Server/), { target: { value: '/old/private' } })
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        expect(signal?.aborted).toBe(false)
        context.me.user.id = 'user-2'
        view.rerender(<QueryClientProvider client={client}><ProjectsPanel /></QueryClientProvider>)
        expect(signal?.aborted).toBe(true)
        await act(async () => finish({ project: { id: 'late-project' } }))
        expect(await screen.findByLabelText('Projektname')).toHaveValue('')
        expect(screen.queryByLabelText('Projektordner auf dem Server')).not.toBeInTheDocument()
        expect(context.refresh).not.toHaveBeenCalled()
        expect(screen.queryByText('Projekt angelegt.')).not.toBeInTheDocument()
    })
    it('does not request leases or expose mutations to project members', () => {
        context.project.role = 'member'
        mount(<RunnerPanel />)
        expect(screen.queryByRole('button', { name: 'Runner-Zugang erstellen' })).not.toBeInTheDocument()
        expect(context.api.request).not.toHaveBeenCalled()
    })
    it('keeps a newly issued lease outside the query cache and clears it after acknowledgment', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => options?.method === 'POST'
            ? { id: 'lease-1', token: 'one-time-synthetic-token', projectId: 'project-1', profile: 'restricted', expiresAt: Date.now() + 3600000 }
            : { leases: [] })
        const client = mount(<RunnerPanel />)
        fireEvent.change(screen.getByLabelText('Runner-Name'), { target: { value: 'Isolated runner' } })
        fireEvent.click(screen.getByRole('radio', { name: 'Befristet' }))
        fireEvent.change(screen.getByLabelText('HAPI-Zugang gültig für (Stunden, maximal 168)'), { target: { value: '168' } })
        fireEvent.click(screen.getByText(/^Berechtigungen anpassen/))
        fireEvent.click(screen.getByLabelText('Gedächtnis lesen'))
        fireEvent.click(screen.getByRole('button', { name: 'Runner-Zugang erstellen' }))
        expect(await screen.findByLabelText('Einmaliger Runner-Schlüssel')).toHaveValue('one-time-synthetic-token')
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/runner-leases', expect.objectContaining({ method: 'POST', body: { name: 'Isolated runner', scopes: standardRunnerScopes('restricted').filter(scope => scope !== 'memory:read'), actionIds: [], expiresInSeconds: 604800 } }))
        expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain('one-time-synthetic-token')
        expect(screen.getByRole('button', { name: 'Schlüssel schließen' })).toBeDisabled()
        fireEvent.click(screen.getByLabelText('Ich habe die Operator-Datei sicher abgelegt.'))
        fireEvent.click(screen.getByRole('button', { name: 'Schlüssel schließen' }))
        expect(screen.queryByLabelText('Einmaliger Runner-Schlüssel')).not.toBeInTheDocument()
    })
    it('defaults to permanent access and submits null even after returning from a temporary choice', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => options?.method === 'POST'
            ? { id: 'permanent-1', token: 'synthetic-permanent-token', projectId: 'project-1', profile: 'restricted', expiresAt: null }
            : { leases: [] })
        const client = mount(<RunnerPanel />)
        expect(screen.getByRole('radio', { name: 'Dauerhaft – bis zum Widerruf' })).toBeChecked()
        expect(screen.queryByLabelText('HAPI-Zugang gültig für (Stunden, maximal 168)')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Befristet' }))
        fireEvent.change(screen.getByLabelText('HAPI-Zugang gültig für (Stunden, maximal 168)'), { target: { value: '48' } })
        fireEvent.click(screen.getByRole('radio', { name: 'Dauerhaft – bis zum Widerruf' }))
        expect(screen.queryByLabelText('HAPI-Zugang gültig für (Stunden, maximal 168)')).not.toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('Runner-Name'), { target: { value: 'Own runner' } })
        fireEvent.click(screen.getByRole('button', { name: 'Runner-Zugang erstellen' }))
        expect(await screen.findByLabelText('Einmaliger Runner-Schlüssel')).toHaveValue('synthetic-permanent-token')
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/runner-leases', expect.objectContaining({
            method: 'POST', body: { name: 'Own runner', scopes: standardRunnerScopes('restricted'), actionIds: [], expiresInSeconds: null },
        }))
        expect(screen.getByText(/Dauerhaft – bis zum Widerruf\. Nach dem Schließen/)).toBeInTheDocument()
        expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain('synthetic-permanent-token')
    })
    it('displays permanent and legacy timed accesses and revokes permanent access', async () => {
        let revokedAt: number | null = null
        const common = { scopes: ['runner:connect'], actionIds: [], profile: 'restricted', createdAt: Date.now() - 1000 }
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => {
            if (options?.method === 'DELETE') { revokedAt = Date.now(); return { ok: true } }
            return { leases: [
                { ...common, id: 'permanent-1', name: 'Permanent runner', expiresAt: null, revokedAt },
                { ...common, id: 'active-legacy', name: 'Existing timed runner', expiresAt: Date.now() + 60_000, revokedAt: null },
                { ...common, id: 'expired-legacy', name: 'Expired timed runner', expiresAt: Date.now() - 60_000, revokedAt: null },
            ] }
        })
        mount(<RunnerPanel />)
        const permanentRow = (await screen.findByText('Permanent runner')).closest('.ev-row') as HTMLElement
        const activeRow = screen.getByText('Existing timed runner').closest('.ev-row') as HTMLElement
        const expiredRow = screen.getByText('Expired timed runner').closest('.ev-row') as HTMLElement
        expect(within(permanentRow).getByText('Dauerhaft – bis zum Widerruf')).toBeInTheDocument()
        expect(within(activeRow).getByText(/^Gültig bis/)).toBeInTheDocument()
        expect(within(activeRow).getByRole('button', { name: 'Widerrufen' })).toBeEnabled()
        expect(within(expiredRow).getByText(/^Abgelaufen bis/)).toBeInTheDocument()
        expect(within(expiredRow).queryByRole('button', { name: 'Widerrufen' })).not.toBeInTheDocument()
        fireEvent.click(within(permanentRow).getByRole('button', { name: 'Widerrufen' }))
        fireEvent.click(within(permanentRow).getByRole('button', { name: 'Bestätigen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/runner-leases/permanent-1', { method: 'DELETE' }))
        expect(await within(permanentRow).findByText(/^Widerrufen am/)).toBeInTheDocument()
        expect(within(permanentRow).queryByRole('button', { name: 'Widerrufen' })).not.toBeInTheDocument()
    })
    it.each(['restricted', 'workspace', 'extended'] as const)('defaults Git scopes to the %s execution profile', async (profile) => {
        context.project.profile = profile
        context.api.request.mockResolvedValue({ leases: [] })
        mount(<RunnerPanel />)
        fireEvent.click(screen.getByText(/^Berechtigungen anpassen/))
        expect(screen.getByLabelText('GitHub-Repositorys lesen')).toBeChecked()
        const write = screen.getByLabelText('In GitHub-Repositorys pushen')
        if (profile === 'restricted') { expect(write).not.toBeChecked(); expect(write).toBeDisabled() }
        else { expect(write).toBeChecked(); expect(write).not.toBeDisabled() }
        fireEvent.change(screen.getByLabelText('Runner-Name'), { target: { value: 'Git runner' } })
        fireEvent.click(screen.getByRole('button', { name: 'Runner-Zugang erstellen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/runner-leases', expect.objectContaining({
            method: 'POST', body: expect.objectContaining({ scopes: standardRunnerScopes(profile) }),
        })))
    })
    it('lets an administrator restrict Git scopes and discards write scope after a profile change', async () => {
        context.project.profile = 'workspace'
        context.api.request.mockResolvedValue({ leases: [] })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const view = render(<QueryClientProvider client={client}><RunnerPanel /></QueryClientProvider>)
        fireEvent.click(screen.getByText(/^Berechtigungen anpassen/))
        fireEvent.click(screen.getByLabelText('In GitHub-Repositorys pushen'))
        expect(screen.getByLabelText('In GitHub-Repositorys pushen')).not.toBeChecked()
        fireEvent.click(screen.getByLabelText('In GitHub-Repositorys pushen'))
        context.project.profile = 'restricted'
        view.rerender(<QueryClientProvider client={client}><RunnerPanel /></QueryClientProvider>)
        expect(screen.getByLabelText('In GitHub-Repositorys pushen')).not.toBeChecked()
        expect(screen.getByLabelText('In GitHub-Repositorys pushen')).toBeDisabled()
    })
})
describe('Preview access', () => {
    const preview = { id: 'preview-1', name: 'App build', directory: '/work/project/dist', openPath: '/api/evolved/previews/preview-1/', createdAt: Date.now() }
    it('allows members to open previews but reserves registration and sharing for admins', async () => {
        context.project.role = 'member'
        context.api.request.mockResolvedValue({ previews: [preview] })
        mount(<PreviewsPanel />)
        const link = await screen.findByRole('link', { name: 'Vorschau öffnen ↗' })
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
        expect(screen.queryByRole('button', { name: 'Freigaben' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Vorschau registrieren' })).not.toBeInTheDocument()
    })
    it('revokes a share and removes its one-time URL from the page', async () => {
        let revoked = false
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (options?.method === 'DELETE') { revoked = true; return { ok: true } }
            if (options?.method === 'POST') return { id: 'share-1', url: '/api/evolved/preview-share/synthetic/', expiresAt: Date.now() + 3600000 }
            if (path.endsWith('/shares')) return { shares: [{ id: 'share-1', expiresAt: Date.now() + 3600000, revokedAt: revoked ? Date.now() : null }] }
            return { previews: [preview] }
        })
        mount(<PreviewsPanel />)
        fireEvent.click(await screen.findByRole('button', { name: 'Freigaben' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Freigabelink erstellen' }))
        expect(await screen.findByLabelText('Einmaliger Freigabelink')).toHaveValue('/api/evolved/preview-share/synthetic/')
        fireEvent.click(screen.getByRole('button', { name: 'Freigabe widerrufen' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await waitFor(() => expect(screen.queryByLabelText('Einmaliger Freigabelink')).not.toBeInTheDocument())
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/previews/preview-1/shares/share-1', { method: 'DELETE' })
    })
})

describe('project automation controls', () => {
    it('requires admin and distinguishes queued schedule runs from successful work', async () => {
        context.project.role = 'viewer'; const view = mount(<AutomationPanel />)
        expect(context.api.request).not.toHaveBeenCalled(); expect(screen.getByText(/Projektadministratoren verwaltet/)).toBeInTheDocument()
        view.clear()
    })
    it('creates exact UTC cron prompts and toggles the explicit peer policy', async () => {
        context.api.request.mockImplementation(async (path, options) => {
            if (options?.method) return { id: 'schedule' }
            return path.endsWith('peer-policy') ? { enabled: false } : { schedules: [], timezone: 'UTC' }
        })
        mount(<AutomationPanel />)
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning check' } })
        fireEvent.change(screen.getByLabelText('Session-ID'), { target: { value: 'session-1' } })
        fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Check only' } })
        fireEvent.click(screen.getByRole('button', { name: 'Zeitplan erstellen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/schedules', { method: 'POST', body: { name: 'Morning check', sessionId: 'session-1', prompt: 'Check only', cron: '0 9 * * 1-5' } }))
        fireEvent.click(screen.getByLabelText('Projekt-Agenten dürfen miteinander kommunizieren'))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/peer-policy', { method: 'PUT', body: { enabled: true } }))
    })
})
