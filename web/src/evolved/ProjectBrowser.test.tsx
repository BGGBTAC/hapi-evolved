import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_DEFAULT_TOOLS, BROWSER_TOOLS, type BrowserStatus } from '@hapi/protocol/browserTools'
import type { EvolvedProject } from './api'
import { ProjectBrowserCard } from './ProjectBrowser'

const context = vi.hoisted(() => ({ api: { baseUrl: '', request: vi.fn() }, me: { user: { id: 'user-1' } }, project: null as EvolvedProject | null }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
const status = (overrides: Partial<BrowserStatus['config']> = {}, runtime: BrowserStatus['runtime'] = { state: 'disabled', checkedAt: null, engineCheckedAt: null }, canManage = true): BrowserStatus => ({
    config: { enabled: false, version: 0, enabledTools: [...BROWSER_DEFAULT_TOOLS], readOnlyTools: ['camofox_list_tabs'], updatedAt: null, ...overrides },
    catalogRevision: 'a'.repeat(64), tools: [...BROWSER_TOOLS], canManage, runtime,
})
const clients: QueryClient[] = []
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
    return render(<QueryClientProvider client={client}><ProjectBrowserCard /></QueryClientProvider>)
}
beforeEach(() => {
    context.project = { id: 'project-1', teamId: 'team-1', name: 'Project One', role: 'admin', profile: 'workspace' }
    context.api.request.mockReset()
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

describe('Project browser card', () => {
    it('explains shared ephemeral state and evaluate is not granted by default', async () => {
        context.api.request.mockResolvedValue(status())
        mount()
        expect(await screen.findByText('Deaktiviert', { selector: '[role=status]' })).toBeInTheDocument()
        expect(screen.getByText(/teilen sich einen Browserzustand/)).toBeInTheDocument()
        expect(screen.getByText(/keine Trennung zwischen einzelnen Sitzungen/)).toBeInTheDocument()
        expect(screen.getByLabelText('Freigeben: camofox_evaluate')).not.toBeChecked()
        expect(screen.getByLabelText('Freigeben: camofox_create_tab')).toBeChecked()
        // Browser actions cannot be marked read-only.
        expect(screen.queryByLabelText('Nur lesend: camofox_click')).toBeNull()
        expect(screen.getByLabelText('Nur lesend: camofox_snapshot')).toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/browser', expect.anything())
    })

    it('enables with an explicit PUT and reports a missing image truthfully', async () => {
        context.api.request.mockResolvedValueOnce(status())
            .mockResolvedValueOnce({ ...status({ enabled: true, version: 1 }, { state: 'image_missing', checkedAt: null, engineCheckedAt: null }), lifecycle: { ok: false, errorCode: 'browser_image_missing' } })
        mount()
        fireEvent.click(await screen.findByRole('checkbox', { name: 'Für Agenten dieses Projekts aktivieren' }))
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
        await screen.findByText(/Das Browser-Image fehlt auf diesem Server/)
        expect(context.api.request).toHaveBeenLastCalledWith('/projects/project-1/browser', { method: 'PUT', body: { version: 0, enabled: true, enabledTools: [...BROWSER_DEFAULT_TOOLS], readOnlyTools: ['camofox_list_tabs'] } })
        expect(screen.getByText('Browser-Image fehlt', { selector: '[role=status]' })).toBeInTheDocument()
    })

    it.each([
        ['service_ready', 'Dienst erreichbar, Browser ungeprüft'], ['ready', 'Bereit'], ['failed', 'Fehler'], ['starting', 'Startet …'], ['runner_missing', 'Projektdienst nicht verbunden'],
    ] as const)('shows runtime state %s without claiming readiness', async (state, label) => {
        context.api.request.mockResolvedValue(status({ enabled: true, version: 2 }, { state, checkedAt: 1, engineCheckedAt: null }))
        mount()
        expect(await screen.findByText(label, { selector: '[role=status]' })).toBeInTheDocument()
        expect(!!screen.queryByRole('button', { name: 'Browser prüfen' })).toBe(['service_ready', 'ready', 'failed'].includes(state))
    })

    it('members see state but no controls', async () => {
        context.project = { ...context.project!, role: 'member' }
        context.api.request.mockResolvedValue(status({}, undefined, false))
        mount()
        await screen.findByText(/Ein Projektadministrator aktiviert den Browser/)
        expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull()
    })

    it('a malformed response is an error, not a state', async () => {
        context.api.request.mockResolvedValue({ templates: [], connections: [] })
        mount()
        await waitFor(() => expect(screen.getByText('Der Browserstatus konnte nicht geladen werden.')).toBeInTheDocument())
    })
})
