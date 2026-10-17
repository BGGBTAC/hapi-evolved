import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvolvedProject, MemoryItem, MemoryResponse } from './api'
import { MemoryPanel } from './Memory'

const context = vi.hoisted(() => ({ api: { baseUrl: '', request: vi.fn() }, me: { user: { id: 'user-1' } }, project: null as EvolvedProject | null }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('./MemoryProvider', () => ({ MemoryProviderPanel: () => <div>Provider-Einrichtung</div> }))
const active: MemoryItem = { id: 'knowledge-1', projectId: 'project-1', title: 'Belegte Erkenntnis', body: 'Diese Erkenntnis wurde ausdrücklich gespeichert.', status: 'proposed', sources: [{ kind: 'manual' }], createdAt: 1_792_171_200_000, archivedImport: false, indexState: 'pending', indexRetry: null }
const archived: MemoryItem = { ...active, id: 'import-1', title: 'Conversation session-1', body: `${'tool_use '.repeat(200)}PRIVATE-END <script>window.bad=true</script>`, sources: [{ kind: 'chat', sessionId: 'session-1', origin: 'hub:session:session-1' }], archivedImport: true }
const response = (items: MemoryItem[] = [active], archivedImports = 1): MemoryResponse => ({ items, archivedImports, settings: { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 1_000_000, jobBudgetMicros: 100_000 }, budget: { spentMicros: 0, reservedMicros: 0, limitMicros: 1_000_000, period: '2026-10' }, backend: { available: true } })
const clients: QueryClient[] = []
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const tree = () => <QueryClientProvider client={client}><MemoryPanel /></QueryClientProvider>
    return { ...render(tree()), tree }
}
beforeEach(() => {
    context.project = { id: 'project-1', teamId: 'team-1', name: 'Projekt', role: 'admin', profile: 'restricted' }
    context.me.user.id = 'user-1'
    context.api.baseUrl = ''
    context.api.request.mockReset().mockImplementation(async (path: string) => path.includes('?view=imports') ? response([archived]) : response())
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); focusManager.setFocused(undefined); onlineManager.setOnline(true) })

describe('Project memory presentation', () => {
    it('shows a historical index failure separately from verified content and retries only after explicit cost confirmation', async () => {
        const failed: MemoryItem = { ...active, status: 'verified', indexState: 'error', indexRetry: { taskId: '10d91914-4378-47e1-a260-c4b60b49bdd9', generation: 21 } }
        let current = failed
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string }) => {
            if (options?.method === 'POST') { current = { ...failed, indexState: 'pending', indexRetry: null }; return { item: current, taskId: 'new-task', replayed: false } }
            return response([current], 0)
        })
        mount()
        const card = await screen.findByRole('article', { name: failed.title })
        expect(within(card).getByText('Verifiziert')).toBeInTheDocument()
        expect(within(card).getByText('Graph: Verarbeitung fehlgeschlagen')).toBeInTheDocument()
        expect(within(card).getByText(/Auch nach einer Graphbereinigung bleibt ein früherer Fehler sichtbar/)).toBeInTheDocument()
        expect(context.api.request.mock.calls.every(([, options]) => !options?.method)).toBe(true)
        fireEvent.click(within(card).getByRole('button', { name: 'Im Graph erneut verarbeiten' }))
        expect(within(card).getByText(/erneut API-Kosten.*0\.100000 USD/)).toBeInTheDocument()
        expect(context.api.request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
        fireEvent.click(within(card).getByRole('button', { name: 'Bestätigen' }))
        await screen.findByText('Graph: Verarbeitung ausstehend')
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/memory/knowledge-1/retry', { method: 'POST', body: failed.indexRetry })
        expect(context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
        expect(within(card).getByText('Verifiziert')).toBeInTheDocument()
        expect(screen.queryByText('Graph: indiziert')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Im Graph erneut verarbeiten' })).not.toBeInTheDocument()
    })

    it.each(['member', 'viewer', 'archived', 'unsettled', 'pending', 'indexed'] as const)('offers no graph retry for %s entries or permissions', async state => {
        if (state === 'member' || state === 'viewer') context.project!.role = state
        const item: MemoryItem = { ...active, indexState: state === 'pending' || state === 'indexed' ? state : 'error',
            archivedImport: state === 'archived', indexRetry: state === 'unsettled' ? null : { generation: 21, taskId: '10d91914-4378-47e1-a260-c4b60b49bdd9' } }
        context.api.request.mockResolvedValue(response([item], state === 'archived' ? 1 : 0))
        mount()
        if (state === 'archived') fireEvent.click(await screen.findByRole('button', { name: 'Alte Gesprächsimporte (1)' }))
        await screen.findByRole('article', { name: item.title })
        expect(screen.queryByRole('button', { name: 'Im Graph erneut verarbeiten' })).not.toBeInTheDocument()
        expect(context.api.request.mock.calls.every(([, options]) => !options?.method)).toBe(true)
    })

    it.each(['backend', 'cloud', 'processing', 'budget'] as const)('explains why a new graph attempt is disabled by %s', async reason => {
        const value = response([{ ...active, indexState: 'error', indexRetry: { generation: 21, taskId: '10d91914-4378-47e1-a260-c4b60b49bdd9' } }], 0)
        if (reason === 'backend') value.backend.available = false
        if (reason === 'cloud') value.settings.cloudAllowed = false
        if (reason === 'processing') value.settings.enabled = false
        if (reason === 'budget') value.budget.reservedMicros = value.budget.limitMicros
        context.api.request.mockResolvedValue(value)
        mount()
        const card = await screen.findByRole('article', { name: active.title })
        expect(within(card).getByRole('button', { name: 'Im Graph erneut verarbeiten' })).toBeDisabled()
        expect(within(card).getByText(reason === 'backend' ? /Graphdienst nicht bereit/ : reason === 'budget' ? /Budget reicht derzeit nicht/ : /Wissensverarbeitung und Cloud-Freigabe aktiviert/)).toBeInTheDocument()
    })

    it('keeps an uncertain retry on the same failed task until a refreshed server status arrives', async () => {
        const failed: MemoryItem = { ...active, indexState: 'error', indexRetry: { generation: 21, taskId: '10d91914-4378-47e1-a260-c4b60b49bdd9' } }
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string }) => {
            if (options?.method === 'POST') throw new Error('Antwort nicht angekommen')
            return response([failed], 0)
        })
        mount()
        const card = await screen.findByRole('article', { name: failed.title })
        for (let i = 0; i < 2; i++) {
            fireEvent.click(within(card).getByRole('button', { name: 'Im Graph erneut verarbeiten' }))
            fireEvent.click(within(card).getByRole('button', { name: 'Bestätigen' }))
            await screen.findByText('Antwort nicht angekommen')
            await waitFor(() => expect(within(card).getByRole('button', { name: 'Im Graph erneut verarbeiten' })).not.toBeDisabled())
        }
        expect(context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST').map(([, options]) => options.body)).toEqual([failed.indexRetry, failed.indexRetry])
    })

    it('renders semantic graph facts without ledger mutations and refreshes status without replaying paid search', async () => {
        const fact = { id: 'graph-fact-id', projectId: active.projectId, body: 'Ein belegter semantischer Suchtreffer.', memoryIds: [active.id], sources: active.sources, status: 'verified' }
        context.api.request.mockImplementation(async (path: string) => path.startsWith('/memory/search?') ? { results: [fact], mode: 'hybrid', backendAvailable: true } : response([active], 0))
        mount()
        await screen.findByRole('article', { name: active.title })
        fireEvent.change(screen.getByLabelText('Suchart'), { target: { value: 'hybrid' } })
        fireEvent.change(screen.getByLabelText('Wissen durchsuchen'), { target: { value: 'semantische Frage' } })
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        const card = await screen.findByRole('article', { name: 'Graphfakt' })
        expect(within(card).getByText(fact.body)).toBeInTheDocument()
        expect(within(card).getByText('Quellen verifiziert')).toBeInTheDocument()
        expect(within(card).getByText('Quellen (1)')).toBeInTheDocument()
        for (const name of ['Verifizieren', 'Vergessen', 'Im Graph erneut verarbeiten']) expect(within(card).queryByRole('button', { name })).not.toBeInTheDocument()
        expect(card.textContent).not.toContain('Invalid Date')
        fireEvent.click(screen.getByRole('button', { name: 'Status aktualisieren' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Status aktualisieren' })).not.toBeDisabled())
        await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); onlineManager.setOnline(false); onlineManager.setOnline(true) })
        expect(context.api.request.mock.calls.filter(([path]) => path.startsWith('/memory/search?'))).toHaveLength(1)
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        await waitFor(() => expect(context.api.request.mock.calls.filter(([path]) => path.startsWith('/memory/search?'))).toHaveLength(2))
        expect(context.api.request.mock.calls.every(([, options]) => !options?.method)).toBe(true)
    })

    it('shows bounded text by default and exposes the unchanged full text only on explicit expansion', async () => {
        context.api.request.mockResolvedValue(response([{ ...active, body: archived.body }], 0))
        const { container } = mount()
        const card = await screen.findByRole('article', { name: active.title })
        expect(within(card).getByText(/tool_use/).textContent!.length).toBeLessThanOrEqual(322)
        expect(card.textContent).not.toContain('PRIVATE-END')
        const expand = within(card).getByRole('button', { name: 'Volltext anzeigen' })
        expect(expand).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(expand)
        expect(within(card).getByLabelText('Volltext')).toHaveTextContent(archived.body)
        expect(container.querySelector('script')).toBeNull()
        expect(within(card).getByRole('button', { name: 'Volltext schließen' })).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(within(card).getByRole('button', { name: 'Volltext schließen' }))
        expect(card.textContent).not.toContain('PRIVATE-END')
    })

    it('separates archived imports from knowledge and offers only viewing and confirmed forgetting there', async () => {
        mount()
        await screen.findByRole('article', { name: active.title })
        expect(screen.queryByText(archived.title)).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Alte Gesprächsimporte (1)' }))
        const card = await screen.findByRole('article', { name: archived.title })
        expect(screen.queryByRole('article', { name: active.title })).not.toBeInTheDocument()
        expect(within(card).getByText('Alter Gesprächsimport')).toBeInTheDocument()
        expect(within(card).queryByText('Vorgeschlagen')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Verifizieren' })).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Wissen durchsuchen')).not.toBeInTheDocument()
        expect(screen.queryByText('Provider-Einrichtung')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Vorschlag speichern' })).not.toBeInTheDocument()
        fireEvent.click(within(card).getByRole('button', { name: 'Vergessen' }))
        expect(context.api.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
        context.api.request.mockImplementation(async (path: string) => response(path.includes('?view=imports') ? [] : [active], 0))
        fireEvent.click(within(card).getByRole('button', { name: 'Bestätigen' }))
        await screen.findByText('Keine alten Gesprächsimporte vorhanden.')
        expect(await screen.findByText('Alter Gesprächsimport und Quellen vergessen.')).toBeInTheDocument()
        expect(screen.queryByText(/Die Bereinigung des Graphindex wurde vorgemerkt/)).not.toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/memory/import-1', { method: 'DELETE' })
        expect(context.api.request.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Wissen' }))
        expect(await screen.findByRole('article', { name: active.title })).toBeInTheDocument()
    })

    it('keeps a partial graph response readable when optional source arrays are absent', async () => {
        context.api.request.mockImplementation(async (path: string) => path.startsWith('/memory/search?')
            ? { results: [{ id: 'partial-fact', body: 'Partial graph result', status: 'proposed' }], mode: 'hybrid', backendAvailable: true }
            : response([active], 0))
        mount()
        await screen.findByRole('article', { name: active.title })
        fireEvent.change(screen.getByLabelText('Suchart'), { target: { value: 'hybrid' } })
        fireEvent.change(screen.getByLabelText('Wissen durchsuchen'), { target: { value: 'partial' } })
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        const card = await screen.findByRole('article', { name: 'Graphfakt' })
        expect(within(card).getByText('Partial graph result')).toBeVisible()
        expect(within(card).getByText(/aus 0 Wissenseinträgen/)).toBeVisible()
        expect(within(card).getByText('Quellen (0)')).toBeVisible()
    })

    it('aborts a pending hybrid search when opening imports and does not replay it when returning', async () => {
        let finish!: (value: unknown) => void
        let searchSignal!: AbortSignal
        context.api.request.mockImplementation((path: string, options: { signal: AbortSignal }) => {
            if (path.startsWith('/memory/search?')) { searchSignal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return Promise.resolve(path.includes('?view=imports') ? response([archived]) : response())
        })
        mount()
        await screen.findByRole('article', { name: active.title })
        fireEvent.change(screen.getByLabelText('Suchart'), { target: { value: 'hybrid' } })
        fireEvent.change(screen.getByLabelText('Wissen durchsuchen'), { target: { value: 'specific query' } })
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        await waitFor(() => expect(finish).toBeDefined())
        fireEvent.click(screen.getByRole('button', { name: 'Alte Gesprächsimporte (1)' }))
        await screen.findByRole('article', { name: archived.title })
        expect(searchSignal.aborted).toBe(true)
        await act(async () => finish({ results: [{ ...active, title: 'Late search result' }], mode: 'hybrid', backendAvailable: true }))
        expect(screen.queryByText('Late search result')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Wissen' }))
        await screen.findByRole('article', { name: active.title })
        expect(screen.getByLabelText('Wissen durchsuchen')).toHaveValue('')
        expect(context.api.request.mock.calls.filter(([path]) => path.startsWith('/memory/search?'))).toHaveLength(1)
    })

    it.each(['project', 'account', 'role', 'origin'] as const)('clears the archive view and ignores late private imports after changing %s', async change => {
        let finish!: (value: unknown) => void
        let importSignal!: AbortSignal
        context.api.request.mockImplementation((path: string, options: { signal: AbortSignal }) => {
            if (path.includes('?view=imports')) { importSignal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return Promise.resolve(response([active], 1))
        })
        const { rerender, tree } = mount()
        await screen.findByRole('article', { name: active.title })
        fireEvent.click(screen.getByRole('button', { name: 'Alte Gesprächsimporte (1)' }))
        await waitFor(() => expect(finish).toBeDefined())
        if (change === 'project') context.project = { ...context.project!, id: 'project-2' }
        if (change === 'account') context.me.user.id = 'user-2'
        if (change === 'role') context.project = { ...context.project!, role: 'viewer' }
        if (change === 'origin') context.api.baseUrl = 'https://other.example'
        rerender(tree())
        expect(importSignal.aborted).toBe(true)
        await act(async () => finish(response([archived])))
        expect(screen.queryByText(archived.title)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Wissen durchsuchen')).toHaveValue('')
        expect(context.api.request.mock.calls.filter(([path]) => path.includes('?view=imports'))).toHaveLength(1)
    })

    it('keeps imports readable for viewers without offering mutations', async () => {
        context.project!.role = 'viewer'
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Alte Gesprächsimporte (1)' }))
        const card = await screen.findByRole('article', { name: archived.title })
        expect(within(card).getByRole('button', { name: 'Volltext anzeigen' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Vergessen' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Verifizieren' })).not.toBeInTheDocument()
    })

    it('pages through every archived import and returns to the preceding page after forgetting its last entry', async () => {
        let count = 101
        const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...archived, id: `import-${index}`, title: `Import ${index + 1}`, body: 'Archived source' }))
        const last = { ...archived, id: 'import-last', title: 'Letzter Import' }
        context.api.request.mockImplementation(async (path: string, options?: { method?: string }) => {
            if (options?.method === 'DELETE') { count = 100; return {} }
            if (path.endsWith('view=imports&offset=0')) return response(firstPage, count)
            if (path.endsWith('view=imports&offset=100')) return response(count === 101 ? [last] : [], count)
            return response([active], count)
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Alte Gesprächsimporte (101)' }))
        await screen.findByText('1–100 von 101')
        expect(screen.getAllByRole('article')).toHaveLength(100)
        expect(screen.getByRole('button', { name: 'Zurück' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
        await screen.findByText('101–101 von 101')
        expect(screen.getAllByRole('article')).toHaveLength(1)
        expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Zurück' }))
        await screen.findByText('1–100 von 101')
        fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
        const card = await screen.findByRole('article', { name: 'Letzter Import' })
        fireEvent.click(within(card).getByRole('button', { name: 'Vergessen' }))
        fireEvent.click(within(card).getByRole('button', { name: 'Bestätigen' }))
        await screen.findByText('1–100 von 100')
        expect(screen.getByRole('button', { name: 'Alte Gesprächsimporte (100)' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/memory?view=imports&offset=100', expect.objectContaining({ signal: expect.any(AbortSignal) }))
        expect(screen.queryByLabelText('Wissen durchsuchen')).not.toBeInTheDocument()
    })

    it('explains explicit knowledge processing without enabling it just by viewing memory', async () => {
        mount()
        await screen.findByLabelText('Gespeichertes Wissen im Graph verarbeiten')
        expect(screen.getAllByText(/Gespräche werden nicht automatisch übernommen/)).toHaveLength(2)
        expect(context.api.request.mock.calls.every(([, options]) => !options?.method)).toBe(true)
    })
})
