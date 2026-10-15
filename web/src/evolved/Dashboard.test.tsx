import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { Dashboard, summarizeSessions } from './Dashboard'

const context = vi.hoisted(() => ({ api: { baseUrl: 'https://hub.example' }, me: { user: { id: 'user-1' }, accessibleProjects: [{ id: 'project-1' }] }, project: { id: 'project-1', name: 'Example', role: 'admin', profile: 'restricted' } as { id: string; name: string; role: string; profile: string } | null }))
const runtime = vi.hoisted(() => ({ getSessions: vi.fn(), getMachines: vi.fn() }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: runtime }) }))
vi.mock('./ProjectReadiness', () => ({ ProjectReadinessPanel: () => <div>Readiness section</div> }))
vi.mock('./Capacity', () => ({ CapacityPanel: () => <div>Capacity section</div> }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, params: _params, search: _search, ...props }: React.PropsWithChildren<{ to: string; params?: unknown; search?: unknown }>) => <a href={to} {...props}>{children}</a> }))
function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return { id, active: true, thinking: false, activeAt: 1, updatedAt: 1, metadata: { name: id, path: '/work' }, metadataVersion: 1, agentStateVersion: 1, todosUpdatedAt: 0, todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null, ...overrides }
}
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>)
    return { client, ...view, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>) }
}
beforeEach(() => { context.project = { id: 'project-1', name: 'Example', role: 'admin', profile: 'restricted' }; context.me.accessibleProjects = [{ id: 'project-1' }]; runtime.getSessions.mockReset().mockResolvedValue({ sessions: [] }); runtime.getMachines.mockReset().mockResolvedValue({ machines: [] }) })
describe('project dashboard', () => {
    it('counts authoritative pending requests, not the capped preview and prioritizes attention', async () => {
        runtime.getSessions.mockResolvedValue({ sessions: [session('needs-review', { pendingRequestsCount: 12, pendingRequests: [] }), session('offline', { active: false, updatedAt: 999 })] })
        runtime.getMachines.mockResolvedValue({ machines: [{ id: 'online', active: true, metadata: { host: 'Runner one', platform: 'linux', happyCliVersion: '0.1.0' } }, { id: 'offline', active: false }] })
        const { container } = mount()
        await screen.findByText('needs-review')
        expect([...container.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['1', '12', '1'])
        expect(screen.getByRole('heading', { name: 'Benötigt Aufmerksamkeit' })).toBeInTheDocument()
        expect(screen.queryByText('offline')).not.toBeInTheDocument()
        expect(screen.getByText('Runner one')).toBeInTheDocument()
    })
    it('never presents loading or failed data as an empty count', async () => {
        runtime.getSessions.mockRejectedValue(new Error('Sitzungen nicht erreichbar'))
        runtime.getMachines.mockImplementation(() => new Promise(() => {}))
        const { container } = mount()
        expect([...container.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['—', '—', '—'])
        await screen.findByRole('alert')
        expect([...container.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['—', '—', '—'])
    })
    it('hides create and runner administration actions for a viewer but keeps sessions accessible', async () => {
        context.project!.role = 'viewer'
        mount()
        await screen.findByText('Noch keine Sitzung in diesem Projekt')
        expect(screen.queryByRole('link', { name: 'Neue Sitzung' })).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Runner einrichten' })).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Zugänge verwalten' })).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Alle Sessions' })).toHaveAttribute('href', '/sessions')
    })
    it('offers onboarding without touching session or machine APIs before an authorized project exists', () => {
        context.project = null
        mount()
        expect(screen.getByRole('heading', { name: 'Alles beginnt mit einem Projekt.' })).toBeInTheDocument()
        expect(runtime.getSessions).not.toHaveBeenCalled(); expect(runtime.getMachines).not.toHaveBeenCalled()
    })
    it('discards old session content immediately after a refresh denies access', async () => {
        runtime.getSessions.mockResolvedValueOnce({ sessions: [session('private session title')] }).mockRejectedValue(new Error('Zugriff widerrufen'))
        mount()
        await screen.findByText('private session title')
        fireEvent.click(screen.getByRole('button', { name: 'Sitzungen aktualisieren' }))
        await screen.findByRole('alert')
        expect(screen.queryByText('private session title')).not.toBeInTheDocument()
    })
    it('isolates cached summaries by project and suppresses stale in-flight results', async () => {
        let finish!: (value: unknown) => void
        runtime.getSessions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        const { client, rerenderPanel } = mount()
        await waitFor(() => expect(runtime.getSessions).toHaveBeenCalled())
        context.project!.id = 'project-2'; context.me.accessibleProjects = [{ id: 'project-2' }]
        runtime.getSessions.mockResolvedValue({ sessions: [session('second project')] })
        rerenderPanel()
        await screen.findByText('second project')
        finish({ sessions: [session('old project private title')] })
        await waitFor(() => expect(screen.queryByText('old project private title')).not.toBeInTheDocument())
        expect(client.getQueryCache().findAll().some(query => query.queryKey.includes('project-2'))).toBe(true)
    })
    it('bounds recent sessions and uses actual message activity before metadata updates', () => {
        const values = Array.from({ length: 20 }, (_, index) => session(String(index), { lastMessageAt: index + 1, updatedAt: 999 - index }))
        expect(summarizeSessions(values).recent.map(value => value.id)).toEqual(['19', '18', '17', '16', '15'])
    })
})
