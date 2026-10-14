import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunnerPanel } from './Runner'
import { PreviewsPanel } from './Previews'
import { ProjectsPanel } from './ProjectsTeam'
import type { ProjectRole } from './api'

const context = vi.hoisted(() => ({ api: { request: vi.fn(), baseUrl: '' }, project: { id: 'project-1', role: 'admin' as ProjectRole, rootPath: '/work/project' }, me: { user: { isAdmin: false }, accessibleProjects: [] }, refresh: vi.fn(), selectProject: vi.fn() }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
beforeEach(() => { context.project.role = 'admin'; context.me.user.isAdmin = false; context.api.request.mockReset(); context.refresh.mockReset() })
function mount(component: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}>{component}</QueryClientProvider>)
    return client
}
describe('Operator access', () => {
    it('allows team administrators to create projects without granting repository attachment', async () => {
        context.api.request.mockResolvedValue({ teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] })
        mount(<ProjectsPanel />)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Memory only' } })
        expect(screen.queryByLabelText(/Repository-Verzeichnis \(optional\)/)).not.toBeInTheDocument()
        expect(screen.getByText(/nur ein Systemadministrator verknüpfen/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects', { method: 'POST', body: { name: 'Memory only', teamId: 'team-1' } }))
    })
    it('exposes repository attachment to system administrators with the passkey requirement', async () => {
        context.me.user.isAdmin = true
        context.api.request.mockResolvedValue({ teams: [{ id: 'team-1', name: 'Team', role: 'admin' }] })
        mount(<ProjectsPanel />)
        fireEvent.change(await screen.findByLabelText('Projektname'), { target: { value: 'Repository' } })
        fireEvent.change(screen.getByLabelText(/Repository-Verzeichnis \(optional\)/), { target: { value: '/workspaces/project' } })
        expect(screen.getByText(/aktuelle Passkey-Anmeldung/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects', { method: 'POST', body: { name: 'Repository', teamId: 'team-1', rootPath: '/workspaces/project' } }))
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
        fireEvent.change(screen.getByLabelText('Gültigkeit (Stunden, maximal 168)'), { target: { value: '168' } })
        fireEvent.click(screen.getByLabelText('Gedächtnis lesen'))
        fireEvent.click(screen.getByRole('button', { name: 'Runner-Zugang erstellen' }))
        expect(await screen.findByLabelText('Einmaliger Runner-Schlüssel')).toHaveValue('one-time-synthetic-token')
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/runner-leases', expect.objectContaining({ method: 'POST', body: { name: 'Isolated runner', scopes: ['runner:connect', 'memory:read'], actionIds: [], expiresInSeconds: 604800 } }))
        expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain('one-time-synthetic-token')
        expect(screen.getByRole('button', { name: 'Schlüssel schließen' })).toBeDisabled()
        fireEvent.click(screen.getByLabelText('Ich habe die Operator-Datei sicher abgelegt.'))
        fireEvent.click(screen.getByRole('button', { name: 'Schlüssel schließen' }))
        expect(screen.queryByLabelText('Einmaliger Runner-Schlüssel')).not.toBeInTheDocument()
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
