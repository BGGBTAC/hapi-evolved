import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolvedApiError, type ExecutionProfile, type ProjectRole } from './api'
import { GithubPanel } from './Github'

const context = vi.hoisted(() => ({
    api: { request: vi.fn(), baseUrl: '' },
    me: { user: { id: 'user-1' } },
    project: { id: 'project-1', role: 'admin' as ProjectRole, profile: 'restricted' as ExecutionProfile },
    refresh: vi.fn(),
}))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ to, search, children, ...props }: { to: string; search: Record<string, string>; children: React.ReactNode }) => <a href={`${to}?${new URLSearchParams(search)}`} {...props}>{children}</a> }))
const path = '/projects/project-1/github'
const token = 'github_pat_synthetic_test_credential_not_real'
const repo = { id: '123', owner: 'example', name: 'demo', fullName: 'example/demo', permission: 'read' as const }
const disconnected = { connected: false, repositories: [] }
const connected = { connected: true, account: { id: 42, login: 'synthetic-account' }, repositories: [repo] }

beforeEach(() => {
    context.project.id = 'project-1'; context.project.role = 'admin'; context.project.profile = 'restricted'
    context.me.user.id = 'user-1'; context.api.request.mockReset()
    context.refresh.mockReset().mockResolvedValue(undefined)
})
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><GithubPanel /></QueryClientProvider>)
    return { client, ...view, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><GithubPanel /></QueryClientProvider>) }
}
describe('project GitHub connection', () => {
    it('clears a submitted credential immediately and caches only returned metadata', async () => {
        let finish!: (result: unknown) => void
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => options.method === 'POST'
            ? new Promise(resolve => { finish = resolve }) : disconnected)
        const { client } = mount()
        const input = await screen.findByLabelText('Fine-grained Personal Access Token')
        expect(input).toHaveAttribute('type', 'password')
        fireEvent.change(input, { target: { value: token } })
        fireEvent.click(screen.getByRole('button', { name: 'GitHub verbinden' }))
        expect(input).toHaveValue('')
        expect(input).toBeDisabled()
        expect(context.api.request).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'POST', body: { token } }))
        await act(async () => finish({ ...connected, repositories: [] }))
        expect(await screen.findByText('synthetic-account')).toBeInTheDocument()
        expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain(token)
        expect(client.getMutationCache().getAll()).toHaveLength(0)
        expect(document.body.textContent).not.toContain(token)
    })
    it('clears the token after provider rejection and allows a new explicit attempt', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => {
            if (options.method === 'POST') throw new EvolvedApiError('GitHub rejected the credential.', 403)
            return disconnected
        })
        mount()
        const input = await screen.findByLabelText('Fine-grained Personal Access Token')
        fireEvent.change(input, { target: { value: token } })
        fireEvent.click(screen.getByRole('button', { name: 'GitHub verbinden' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('GitHub rejected the credential.')
        expect(input).toHaveValue('')
        expect(screen.getByRole('button', { name: 'GitHub verbinden' })).toBeDisabled()
        fireEvent.change(input, { target: { value: `${token}_replacement` } })
        expect(screen.getByRole('button', { name: 'GitHub verbinden' })).not.toBeDisabled()
    })
    it('requires acknowledgment before replacing a connection and removes returned grants', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => options.method === 'POST'
            ? { ...connected, repositories: [] } : connected)
        mount()
        fireEvent.change(await screen.findByLabelText('Fine-grained Personal Access Token'), { target: { value: token } })
        const button = screen.getByRole('button', { name: 'Verbindung ersetzen' })
        expect(button).toBeDisabled()
        fireEvent.click(screen.getByLabelText('Ich ersetze die Verbindung und entferne bisherige Repository-Freigaben.'))
        fireEvent.click(button)
        expect(await screen.findByText('Noch kein Repository freigegeben.')).toBeInTheDocument()
        expect(screen.queryByText('example/demo')).not.toBeInTheDocument()
    })
    it.each(['restricted', 'workspace', 'extended'] as const)('grants an exact repository and supports changing its permission in %s', async (profile) => {
        context.project.profile = profile
        context.api.request.mockImplementation(async (_path: string, options: { method?: string; body?: { permission: string } }) => options.method === 'PUT'
            ? { ...connected, repositories: [{ ...repo, permission: options.body!.permission }] } : { ...connected, repositories: [] })
        mount()
        fireEvent.change(await screen.findByLabelText(/^GitHub-Repository/), { target: { value: 'example/demo' } })
        fireEvent.change(screen.getByLabelText('Git-Berechtigung'), { target: { value: 'write' } })
        fireEvent.click(screen.getByRole('button', { name: 'Repository freigeben' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith(`${path}/repositories`, expect.objectContaining({ method: 'PUT', body: { repository: 'example/demo', permission: 'write' } })))
        expect(await screen.findByText('Lesen und Push freigegeben')).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('Git-Berechtigung für example/demo'), { target: { value: 'read' } })
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith(`${path}/repositories`, expect.objectContaining({ method: 'PUT', body: { repository: 'example/demo', permission: 'read' } })))
        expect(await screen.findByText('git clone https://github.com/example/demo.git')).toBeInTheDocument()
        expect(context.api.request.mock.calls.some(([requestPath]) => requestPath.endsWith('/profile'))).toBe(false)
    })
    it('allows restricted projects to change existing grants while explaining effective push restrictions', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string; body?: { permission: string } }) => options.method === 'PUT'
            ? { ...connected, repositories: [{ ...repo, permission: options.body!.permission }] } : connected)
        mount()
        await screen.findByLabelText('Git-Berechtigung für example/demo')
        for (const option of screen.getAllByRole('option', { name: 'Lesen und Push' })) expect(option).not.toBeDisabled()
        fireEvent.change(screen.getByLabelText('Git-Berechtigung für example/demo'), { target: { value: 'write' } })
        expect(await screen.findByText('Lesen und Push freigegeben')).toBeInTheDocument()
        expect(screen.getByText('Push durch Projektprofil gesperrt')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Was für Push erforderlich ist' })).toBeInTheDocument()
        expect(screen.getByText(/Die gespeicherte Freigabe bestätigt keine GitHub-Schreibrechte/)).toBeInTheDocument()
        expect(context.project.profile).toBe('restricted')
        expect(context.api.request.mock.calls.some(([requestPath]) => requestPath.endsWith('/profile'))).toBe(false)
        expect(context.refresh).not.toHaveBeenCalled()
    })
    it('keeps a rejected grant unchanged and shows the failure without claiming success', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => {
            if (options.method === 'PUT') throw new EvolvedApiError('Repository-Freigabe nicht gespeichert.', 502)
            return connected
        })
        mount()
        fireEvent.change(await screen.findByLabelText('Git-Berechtigung für example/demo'), { target: { value: 'write' } })
        expect(await screen.findByRole('alert')).toHaveTextContent('Repository-Freigabe nicht gespeichert.')
        expect(screen.getByLabelText('Git-Berechtigung für example/demo')).toHaveValue('read')
        expect(screen.queryByText('Lesen und Push freigegeben')).not.toBeInTheDocument()
        expect(screen.queryByText('Repository-Freigabe aktualisiert.')).not.toBeInTheDocument()
    })
    it('reconciles a write grant after its response was lost instead of presenting stale permission', async () => {
        let granted = false
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => {
            if (options.method === 'PUT') { granted = true; throw new Error('Verbindung während der Antwort unterbrochen.') }
            return { ...connected, repositories: [{ ...repo, permission: granted ? 'write' : 'read' }] }
        })
        mount()
        fireEvent.change(await screen.findByLabelText('Git-Berechtigung für example/demo'), { target: { value: 'write' } })
        expect(await screen.findByRole('alert')).toHaveTextContent('Verbindung während der Antwort unterbrochen.')
        expect(await screen.findByText('Lesen und Push freigegeben')).toBeInTheDocument()
        expect(screen.getByLabelText('Git-Berechtigung für example/demo')).toHaveValue('write')
        expect(screen.queryByText('Repository-Freigabe aktualisiert.')).not.toBeInTheDocument()
        expect(context.api.request.mock.calls.filter(([, options]) => options.method === 'PUT')).toHaveLength(1)
    })
    it('requires explicit confirmation before enabling workspace and keeps runner navigation scoped to the project', async () => {
        context.api.request.mockResolvedValue(connected)
        mount()
        const activate = await screen.findByRole('button', { name: 'Arbeitsbereich für Push aktivieren' })
        fireEvent.click(activate)
        expect(screen.getByText(/Alle bisherigen Runner-Zugänge dieses Projekts werden ungültig/)).toBeInTheDocument()
        expect(screen.getByText(/lokale Schreib- und Ausführungsrechte/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
        expect(context.api.request.mock.calls.some(([requestPath]) => requestPath.endsWith('/profile'))).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich für Push aktivieren' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await waitFor(() => expect(context.refresh).toHaveBeenCalledTimes(1))
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/profile', expect.objectContaining({ method: 'PUT', body: { profile: 'workspace' }, signal: expect.any(AbortSignal) }))
        expect(context.api.request.mock.calls.filter(([requestPath]) => requestPath.endsWith('/profile'))).toHaveLength(1)
        expect(screen.getByRole('link', { name: 'Runner für Push einrichten' })).toHaveAttribute('href', '/evolved?tab=runner&project=project-1')
    })
    it('refreshes uncertain profile state before allowing another attempt after a lost response', async () => {
        context.api.request.mockImplementation(async (requestPath: string) => {
            if (requestPath.endsWith('/profile')) throw new Error('Antwort der Profiländerung fehlt.')
            return connected
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Arbeitsbereich für Push aktivieren' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Antwort der Profiländerung fehlt.')
        expect(screen.queryByRole('button', { name: 'Arbeitsbereich für Push aktivieren' })).not.toBeInTheDocument()
        expect(screen.queryByText('Projektprofil aktualisiert. Richte jetzt einen neuen Runner-Zugang ein.')).not.toBeInTheDocument()
        expect(context.refresh).not.toHaveBeenCalled()
        context.refresh.mockRejectedValueOnce(new Error('Aktualisierung fehlgeschlagen.'))
        fireEvent.click(screen.getByRole('button', { name: 'Projektstatus aktualisieren' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Aktualisierung fehlgeschlagen.')
        expect(screen.queryByRole('button', { name: 'Arbeitsbereich für Push aktivieren' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projektstatus aktualisieren' }))
        await screen.findByRole('button', { name: 'Arbeitsbereich für Push aktivieren' })
        expect(context.api.request.mock.calls.filter(([requestPath]) => requestPath.endsWith('/profile'))).toHaveLength(1)
    })
    it('does not repeat a successful profile mutation when refreshing its result fails', async () => {
        context.api.request.mockResolvedValue(connected)
        context.refresh.mockRejectedValueOnce(new Error('Projektstatus nicht erreichbar.'))
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Arbeitsbereich für Push aktivieren' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Projektstatus nicht erreichbar.')
        expect(screen.queryByRole('button', { name: 'Arbeitsbereich für Push aktivieren' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projektstatus aktualisieren' }))
        await waitFor(() => expect(context.refresh).toHaveBeenCalledTimes(2))
        expect(context.api.request.mock.calls.filter(([requestPath]) => requestPath.endsWith('/profile'))).toHaveLength(1)
    })
    it('aborts a pending profile mutation when switching projects and does not refresh the new project with its result', async () => {
        let finish!: () => void
        let signal: AbortSignal | undefined
        context.api.request.mockImplementation(async (requestPath: string, options: { signal?: AbortSignal }) => {
            if (requestPath.endsWith('/profile')) { signal = options.signal; return new Promise<void>(resolve => { finish = resolve }) }
            return connected
        })
        const { rerenderPanel } = mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Arbeitsbereich für Push aktivieren' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        context.project.id = 'project-2'
        rerenderPanel()
        expect(signal?.aborted).toBe(true)
        await act(async () => finish())
        expect(context.refresh).not.toHaveBeenCalled()
        expect(await screen.findByRole('link', { name: 'Runner für Push einrichten' })).toHaveAttribute('href', '/evolved?tab=runner&project=project-2')
    })
    it('revokes a repository and disconnects the project with confirmation', async () => {
        context.api.request.mockImplementation(async (requestPath: string, options: { method?: string }) => {
            if (options.method === 'DELETE') return requestPath === path ? disconnected : { ...connected, repositories: [] }
            return connected
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Repository-Freigabe widerrufen' }))
        expect(context.api.request.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(await screen.findByText('Noch kein Repository freigegeben.')).toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledWith(`${path}/repositories/123`, expect.objectContaining({ method: 'DELETE' }))
        fireEvent.click(screen.getByRole('button', { name: 'GitHub-Verbindung trennen' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(await screen.findByText('Noch kein GitHub-Konto verbunden.')).toBeInTheDocument()
        expect(screen.queryByText('synthetic-account')).not.toBeInTheDocument()
    })
    it.each(['member', 'viewer'] as const)('shows metadata but no mutation controls for a %s', async (role) => {
        context.project.role = role
        context.api.request.mockResolvedValue(connected)
        mount()
        expect(await screen.findByText('example/demo')).toBeInTheDocument()
        expect(screen.queryByLabelText('Fine-grained Personal Access Token')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Repository freigeben' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'GitHub-Verbindung trennen' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Arbeitsbereich für Push aktivieren' })).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Runner für Push einrichten' })).not.toBeInTheDocument()
    })
    it('does not present an unauthorized status response as a disconnected account', async () => {
        context.api.request.mockRejectedValue(new EvolvedApiError('Anmeldung abgelaufen', 401))
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Anmeldung abgelaufen')
        expect(screen.queryByText('Noch kein GitHub-Konto verbunden.')).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Fine-grained Personal Access Token')).not.toBeInTheDocument()
        context.api.request.mockResolvedValue(disconnected)
        fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
        expect(await screen.findByLabelText('Fine-grained Personal Access Token')).toBeInTheDocument()
    })
    it('hides cached metadata when access is revoked', async () => {
        context.api.request.mockResolvedValue(connected)
        const { client } = mount()
        await screen.findByText('synthetic-account')
        context.api.request.mockRejectedValue(new EvolvedApiError('Projektzugriff widerrufen', 403))
        await act(async () => { await client.invalidateQueries({ queryKey: ['evolved', 'github'] }) })
        expect(await screen.findByRole('alert')).toHaveTextContent('Projektzugriff widerrufen')
        expect(screen.queryByText('synthetic-account')).not.toBeInTheDocument()
        expect(screen.queryByText('example/demo')).not.toBeInTheDocument()
    })
    it('rechecks project access after a denied mutation and clears a pending credential draft', async () => {
        context.api.request.mockResolvedValue(connected)
        mount()
        fireEvent.change(await screen.findByLabelText('Fine-grained Personal Access Token'), { target: { value: token } })
        context.api.request.mockRejectedValue(new EvolvedApiError('Projektzugriff widerrufen', 403))
        fireEvent.click(screen.getByRole('button', { name: 'Repository-Freigabe widerrufen' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await waitFor(() => expect(screen.queryByText('synthetic-account')).not.toBeInTheDocument())
        expect(screen.queryByLabelText('Fine-grained Personal Access Token')).not.toBeInTheDocument()
        context.api.request.mockResolvedValue(connected)
        fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
        expect(await screen.findByLabelText('Fine-grained Personal Access Token')).toHaveValue('')
    })
    it('discards drafts on account change and aborts an old project mutation without caching its response', async () => {
        let finish!: (result: unknown) => void
        let signal: AbortSignal | undefined
        context.api.request.mockImplementation(async (_path: string, options: { method?: string; signal?: AbortSignal }) => {
            if (options.method === 'POST') { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return disconnected
        })
        const { client, rerenderPanel } = mount()
        fireEvent.change(await screen.findByLabelText('Fine-grained Personal Access Token'), { target: { value: token } })
        context.me.user.id = 'user-2'
        rerenderPanel()
        expect(await screen.findByLabelText('Fine-grained Personal Access Token')).toHaveValue('')
        fireEvent.change(screen.getByLabelText('Fine-grained Personal Access Token'), { target: { value: token } })
        fireEvent.click(screen.getByRole('button', { name: 'GitHub verbinden' }))
        context.project.id = 'project-2'
        rerenderPanel()
        expect(signal?.aborted).toBe(true)
        await act(async () => finish(connected))
        expect(await screen.findByLabelText('Fine-grained Personal Access Token')).toHaveValue('')
        expect(screen.queryByText('synthetic-account')).not.toBeInTheDocument()
        expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain('synthetic-account')
    })
})
