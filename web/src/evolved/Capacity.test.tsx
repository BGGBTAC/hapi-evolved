import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapacityReport, ProjectCapacity } from '@hapi/protocol'
import { CapacityPanel, capacityIsStale, capacityWindowIsStale, capacityWindowLabel } from './Capacity'

const context = vi.hoisted(() => ({ api: { request: vi.fn(), baseUrl: 'https://hub.example' }, me: { user: { id: 'user-1' } }, project: { id: 'project-1', role: 'viewer', profile: 'restricted' } }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, params: _params, search: _search, ...props }: React.PropsWithChildren<{ to: string; params?: unknown; search?: unknown }>) => <a href={to} {...props}>{children}</a> }))
const report = (overrides: Partial<CapacityReport> = {}): CapacityReport => ({ provider: 'codex', source: 'codex-app-server', scope: 'account', observedAt: Date.now(), status: 'available', reason: null, stale: false, sessionId: 'session-one', windows: [{ id: 'primary', usedPercent: 38, remainingPercent: 62, resetsAt: Date.now() + 3600_000, durationMinutes: 300, status: 'allowed', stale: false }], ...overrides })
const response = (reports: CapacityReport[] = [report()]): ProjectCapacity => ({ projectId: context.project.id, generatedAt: Date.now(), providers: [{ provider: 'codex', status: 'available', reports }] })
function mount(compact = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><CapacityPanel compact={compact} /></QueryClientProvider>)
    return { client, ...view, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><CapacityPanel compact={compact} /></QueryClientProvider>) }
}
beforeEach(() => { context.api.request.mockReset(); context.me.user.id = 'user-1'; context.project.id = 'project-1' })
describe('provider capacity', () => {
    it('shows a compact latest-session glance with at most two windows and clear provenance', async () => {
        const latest = report({ sessionId: 'latest-report' })
        latest.windows.push({ ...latest.windows[0], id: 'secondary', remainingPercent: null, usedPercent: null, stale: true }, { ...latest.windows[0], id: 'third' })
        context.api.request.mockResolvedValue(response([report({ sessionId: 'old-report', observedAt: Date.now() - 60_000 }), latest]))
        mount(true)
        expect(await screen.findByText('62 % frei')).toBeInTheDocument()
        expect(screen.getByText('Nicht gemeldet')).toBeInTheDocument()
        expect(screen.getByText(/Letzte frische numerische Sitzungsmeldung/)).toBeInTheDocument()
        expect(screen.getByText('1 weitere Fenster in der Detailansicht')).toBeInTheDocument()
        expect(screen.queryByText('old-repo')).not.toBeInTheDocument()
        expect(screen.getByTestId('capacity-panel').querySelectorAll('[data-capacity-window]')).toHaveLength(2)
        expect(screen.getByRole('link', { name: 'Alle Meldungen' })).toBeInTheDocument()
    })
    it('prefers a fresh numeric report over a newer unknown or unsupported session without merging accounts', async () => {
        context.api.request.mockResolvedValue(response([report({ sessionId: 'unknown-session', status: 'unknown', windows: [] }), report({ sessionId: 'fresh-numeric', observedAt: Date.now() - 60_000 }), report({ sessionId: 'unsupported-session', status: 'unsupported', windows: [] })]))
        mount(true)
        expect(await screen.findByText('62 % frei')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'fresh-nu' })).toBeInTheDocument()
        expect(screen.getByText(/anderen Teamkonto gehören/)).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'unknown-' })).not.toBeInTheDocument()
    })
    it('distinguishes model-specific weekly windows and different Codex buckets in labels and meter names', () => {
        const base = report().windows[0]
        expect(capacityWindowLabel({ ...base, id: 'seven_day_opus', durationMinutes: 10080 })).toBe('Opus · 7-Tage-Fenster')
        expect(capacityWindowLabel({ ...base, id: 'seven_day_sonnet', durationMinutes: 10080 })).toBe('Sonnet · 7-Tage-Fenster')
        expect(capacityWindowLabel({ ...base, id: 'codex:primary' })).not.toBe(capacityWindowLabel({ ...base, id: 'codex_pro:primary' }))
    })
    it('renders actual limits and source times without adding account-wide session reports', async () => {
        context.api.request.mockResolvedValue(response([report(), report({ sessionId: 'another-session' })]))
        mount()
        expect(await screen.findAllByText('62 %')).toHaveLength(2)
        expect(screen.queryByText('124 %')).not.toBeInTheDocument()
        expect(screen.getAllByRole('meter')).toHaveLength(2)
        expect(screen.getAllByRole('meter')[0]).toHaveAttribute('aria-valuenow', '38')
        expect(screen.getAllByText(/Reset:/)).toHaveLength(2)
        expect(screen.getAllByText(/Fensterstand:/)).toHaveLength(2)
        expect(screen.getByText(/werden nicht addiert/)).toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/capacity', { signal: expect.any(AbortSignal) })
    })
    it('shows unknown utilization without inventing zero or full remaining capacity', async () => {
        context.api.request.mockResolvedValue(response([report({ provider: 'claude', source: 'claude-sdk', status: 'unknown', reason: 'utilization_not_reported', windows: [{ id: 'five_hour', usedPercent: null, remainingPercent: null, resetsAt: null, durationMinutes: 300, status: 'allowed', stale: false }] })]))
        mount()
        expect(await screen.findByText('Nutzungsanteil nicht gemeldet')).toBeInTheDocument()
        expect(screen.getByText('Nutzung möglich')).toBeInTheDocument()
        expect(screen.getByText('Reset-Zeit nicht gemeldet')).toBeInTheDocument()
        expect(screen.queryByRole('meter')).not.toBeInTheDocument()
        expect(screen.queryByText(/^(0|100) %$/)).not.toBeInTheDocument()
    })
    it('keeps empty reports distinct from an exhausted limit and explains unsupported authentication', async () => {
        context.api.request.mockResolvedValue({ ...response([report({ status: 'unsupported', reason: 'subscription_auth_required', windows: [] })]), providers: [{ provider: 'claude', status: 'unknown', reports: [] }, { provider: 'codex', status: 'unsupported', reports: [report({ status: 'unsupported', reason: 'subscription_auth_required', windows: [] })] }] })
        mount()
        expect(await screen.findByText(/Noch keine Kapazitätsmeldung/)).toBeInTheDocument()
        expect(screen.getByText(/API-Schlüssel liefern hier kein Abonnementlimit/)).toBeInTheDocument()
        expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    })
    it('marks an old window stale independently of a new window in the same report', async () => {
        const fresh = report()
        fresh.windows.push({ ...fresh.windows[0], id: 'secondary', observedAt: Date.now() - 6 * 60_000, stale: true })
        context.api.request.mockResolvedValue(response([fresh]))
        mount()
        await screen.findByText('Veraltet')
        const panel = screen.getByTestId('capacity-panel')
        expect(panel.querySelector('[data-capacity-window="primary"]')).toHaveAttribute('data-capacity-stale', 'false')
        expect(panel.querySelector('[data-capacity-window="secondary"]')).toHaveAttribute('data-capacity-stale', 'true')
        expect(capacityIsStale(fresh, Date.now())).toBe(false)
        expect(capacityWindowIsStale({ ...fresh.windows[0], resetsAt: Date.now() - 1 }, fresh.observedAt, Date.now())).toBe(true)
    })
    it('removes cached values after a denied refresh and supports explicit recovery', async () => {
        context.api.request.mockResolvedValue(response())
        mount()
        await screen.findByText('62 %')
        context.api.request.mockRejectedValueOnce(new Error('Projektzugriff widerrufen'))
        fireEvent.click(screen.getByRole('button', { name: 'Kapazität aktualisieren' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Projektzugriff widerrufen')
        expect(screen.queryByText('62 %')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Kapazität aktualisieren' }))
        expect(await screen.findByText('62 %')).toBeInTheDocument()
    })
    it('keys reads by account and project and aborts old data on project change', async () => {
        let signal: AbortSignal | undefined
        context.api.request.mockImplementation((_path, options) => { signal = options.signal; return new Promise(() => {}) })
        const { client, rerenderPanel } = mount()
        await waitFor(() => expect(signal).toBeDefined())
        const previous = signal!
        context.project.id = 'project-2'; context.me.user.id = 'user-2'
        context.api.request.mockResolvedValue(response())
        rerenderPanel()
        await screen.findByText('62 %')
        expect(previous.aborted).toBe(true)
        expect(client.getQueryCache().findAll().some(query => query.queryKey.includes('user-2') && query.queryKey.includes('project-2'))).toBe(true)
    })
    it('rejects a response belonging to another project instead of rendering it', async () => {
        context.api.request.mockResolvedValue({ ...response(), projectId: 'foreign-project' })
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('gehört nicht zum aktiven Projekt')
        expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    })
    it('ages displayed reports while idle even if no newer response arrives', async () => {
        vi.useFakeTimers()
        try {
            const observedAt = Date.now() - 4 * 60_000 - 50_000
            context.api.request.mockResolvedValue(response([report({ observedAt })]))
            mount()
            await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(1) })
            expect(within(screen.getByTestId('capacity-panel')).queryByText('Veraltet')).not.toBeInTheDocument()
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(screen.getAllByText('Veraltet').length).toBeGreaterThan(0)
        } finally { vi.useRealTimers() }
    })
})
