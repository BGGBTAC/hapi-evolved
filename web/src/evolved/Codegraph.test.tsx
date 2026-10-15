import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeGraphCanvas, CodegraphPanel, layoutNodes } from './Codegraph'
import { EvolvedApiError, type CodeNode, type ProjectRole } from './api'

const request = vi.hoisted(() => vi.fn())
const context = vi.hoisted(() => ({ api: { request: vi.fn(), baseUrl: '' }, me: { user: { id: 'user-1' } }, project: { id: 'project-1', role: 'member' as ProjectRole, rootPath: '/work/project' } }))
vi.mock('./auth', () => ({ useEvolved: () => ({ ...context, api: { ...context.api, request } }) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, search, ...props }: React.PropsWithChildren<{ to: string; search: Record<string, string> }>) => <a href={`${to}?${new URLSearchParams(search)}`} {...props}>{children}</a> }))
beforeEach(() => { request.mockReset(); context.project.role = 'member' })
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><CodegraphPanel /></QueryClientProvider>)
    return { client, ...view }
}

const nodes: CodeNode[] = [{ id: 'a', name: 'entry', kind: 'function', file: 'src/main.ts', line: 1 }, { id: 'b', name: 'worker', kind: 'function', file: 'src/worker.ts', line: 12 }]
describe('Codegraph navigation', () => {
    it('allows keyboard selection of a node and has accessible location details', () => {
        const select = vi.fn()
        render(<CodeGraphCanvas graph={{ nodes, edges: [{ source: 'a', target: 'b', kind: 'calls' }] }} selected="a" onSelect={select} />)
        const target = screen.getByRole('button', { name: 'worker, function, src/worker.ts:12' })
        fireEvent.keyDown(target, { key: 'Enter' })
        expect(select).toHaveBeenCalledWith('b')
        expect(screen.getByRole('button', { name: 'entry, function, src/main.ts:1' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByText('2 Knoten · 1 Beziehungen')).toBeInTheDocument()
    })
    it('makes zoom reversible and ignores edges outside a partial graph', () => {
        const { container } = render(<CodeGraphCanvas graph={{ nodes, edges: [{ source: 'a', target: 'missing', kind: 'calls' }] }} selected={null} onSelect={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Graph vergrößern' }))
        expect(container.querySelector('svg > g')).not.toHaveAttribute('transform', 'translate(0 0) scale(1)')
        fireEvent.click(screen.getByRole('button', { name: 'Ansicht zurücksetzen' }))
        expect(container.querySelector('svg > g')).toHaveAttribute('transform', 'translate(0 0) scale(1)')
        expect(container.querySelectorAll('line')).toHaveLength(0)
    })
    it('lays out each node deterministically despite reordered API results', () => {
        expect(layoutNodes(nodes)).toEqual(layoutNodes([...nodes].reverse()))
        expect(new Set([...layoutNodes(nodes).values()].map(point => `${point.x},${point.y}`)).size).toBe(nodes.length)
    })
})


describe('Codegraph API exploration', () => {
    it('loads source and impact for a selected symbol and submits affected paths without rendering source as HTML', async () => {
        request.mockImplementation(async (path: string) => {
            if (path.endsWith('/status')) return { available: true, state: 'ready', watching: true, pendingFiles: 0 }
            if (path.endsWith('/graph')) return { nodes, edges: [{ source: 'a', target: 'b', kind: 'calls' }] }
            if (path.includes('/node?')) return { node: nodes[0], source: '<script>unsafe()</script>', callers: [], callees: [nodes[1]] }
            if (path.includes('/impact?')) return { nodes: [nodes[1]], edges: [], files: ['src/worker.ts'] }
            if (path.includes('/affected?')) return { nodes: [nodes[1]], edges: [], files: ['src/worker.test.ts'] }
            throw new Error('Unexpected graph endpoint')
        })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const { container } = render(<QueryClientProvider client={client}><CodegraphPanel /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole('button', { name: 'entry, function, src/main.ts:1' }))
        expect(await screen.findByLabelText('Quelltext src/main.ts')).toHaveTextContent('<script>unsafe()</script>')
        expect(container.querySelector('script')).toBeNull()
        expect(request).toHaveBeenCalledWith('/projects/project-1/codegraph/impact?nodeId=a', expect.anything())
        fireEvent.change(screen.getByLabelText(/Geänderte Pfade/), { target: { value: 'src/main.ts\nsrc/worker.ts' } })
        fireEvent.click(screen.getByRole('button', { name: 'Auswirkungen prüfen' }))
        await waitFor(() => expect(request).toHaveBeenCalledWith('/projects/project-1/codegraph/affected?files=src%2Fmain.ts%2Csrc%2Fworker.ts', expect.anything()))
        expect(await screen.findByText('src/worker.test.ts')).toBeInTheDocument()
    })
})


describe('Codegraph initialization and service states', () => {
    const empty = { available: true, state: 'ready', watching: true, pendingFiles: 0, stats: { nodeCount: 0, edgeCount: 0, fileCount: 0, nodesByKind: {}, edgesByKind: {}, filesByLanguage: {} } }
    it('renders real nested SDK statistics safely and explains an empty project without an error', async () => {
        request.mockImplementation(async path => path.endsWith('/status') ? empty : { nodes: [], edges: [] })
        mount()
        expect(await screen.findByText('Noch kein Code im Index')).toBeInTheDocument()
        expect(screen.getByText(/Ein neuer, leerer Projektordner ist kein Fehler/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Repository verbinden' })).toHaveAttribute('href', '/evolved?tab=github&project=project-1')
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.queryByText('nodesByKind')).not.toBeInTheDocument()
    })
    it('ignores malformed count objects instead of rendering them as React children', async () => {
        request.mockImplementation(async path => path.endsWith('/status') ? { ...empty, stats: { nodeCount: {}, edgeCount: 'oops', fileCount: 1 } } : { nodes, edges: [] })
        mount()
        expect(await screen.findByRole('button', { name: 'entry, function, src/main.ts:1' })).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.queryByText('oops')).not.toBeInTheDocument()
    })
    it('explains automatic initial indexing and does not query an unavailable graph', async () => {
        request.mockResolvedValue({ available: false, state: 'indexing', watching: false, pendingFiles: 2 })
        mount()
        expect(await screen.findByText(/Du musst keinen Graphen anlegen/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Neu indizieren' })).toBeDisabled()
        expect(request.mock.calls.every(([path]) => path.endsWith('/status'))).toBe(true)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    it('explains missing service configuration without offering an ineffective reindex', async () => {
        request.mockRejectedValue(new EvolvedApiError('not configured', 503, 'codegraph_unconfigured'))
        mount()
        expect(await screen.findByText(/noch nicht eingerichtet/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Neu indizieren' })).not.toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Status aktualisieren' })).not.toBeDisabled()
    })
    it('keeps service failures distinct from an empty index and supports an explicit retry', async () => {
        request.mockRejectedValue(new EvolvedApiError('Service unavailable', 503, 'codegraph_unavailable'))
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable')
        expect(screen.getByText(/bedeutet nicht, dass der Graph leer ist/)).toBeInTheDocument()
        expect(screen.queryByText('Noch kein Code im Index')).not.toBeInTheDocument()
        request.mockImplementation(async path => path.endsWith('/status') ? empty : { nodes: [], edges: [] })
        fireEvent.click(screen.getByRole('button', { name: 'Status aktualisieren' }))
        expect(await screen.findByText('Noch kein Code im Index')).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    it('hides previously cached graph and counts after status access is revoked', async () => {
        request.mockImplementation(async path => path.endsWith('/status') ? { ...empty, stats: { nodeCount: 2 } } : { nodes, edges: [] })
        const { client } = mount()
        await screen.findByRole('button', { name: 'entry, function, src/main.ts:1' })
        request.mockRejectedValue(new EvolvedApiError('Access revoked', 403))
        await act(async () => { await client.invalidateQueries({ queryKey: ['evolved', 'code-status'] }) })
        expect(await screen.findByRole('alert')).toHaveTextContent('Access revoked')
        expect(screen.queryByRole('group', { name: 'Interaktiver Codegraph' })).not.toBeInTheDocument()
        expect(screen.queryByText('Bereit')).not.toBeInTheDocument()
    })
    it('does not misreport a graph request failure as an empty result', async () => {
        request.mockImplementation(async path => { if (path.endsWith('/status')) return { ...empty, stats: { nodeCount: 2 } }; throw new Error('Graph request failed') })
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Graph request failed')
        expect(screen.queryByText(/keine Symbole gefunden/)).not.toBeInTheDocument()
    })
    it('does not offer reindexing to viewers', async () => {
        context.project.role = 'viewer'
        request.mockResolvedValue({ available: false, state: 'error', error: 'Index failed' })
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Index failed')
        expect(screen.queryByRole('button', { name: 'Neu indizieren' })).not.toBeInTheDocument()
        expect(screen.getByText(/Projektmitglied mit Schreibzugriff/)).toBeInTheDocument()
    })
    it('preserves graph zoom during a background index refresh without reusing another selection', async () => {
        let complete!: (value: unknown) => void
        request.mockImplementation(async path => path.endsWith('/status')
            ? { ...empty, stats: { nodeCount: 2 }, lastIndexedAt: 1 } : { nodes, edges: [] })
        const { client, container } = mount()
        const canvas = await screen.findByRole('group', { name: 'Interaktiver Codegraph' })
        fireEvent.click(screen.getByRole('button', { name: 'Graph vergrößern' }))
        const transform = container.querySelector('svg > g')!.getAttribute('transform')
        const latestStatus = { ...empty, watching: false, stats: { nodeCount: 2 }, lastIndexedAt: 2 }
        request.mockImplementation(async path => path.endsWith('/status') ? latestStatus : path.endsWith('/graph') ? new Promise(resolve => { complete = resolve }) : { nodes: [], edges: [] })
        act(() => client.setQueryData(['evolved', 'code-status', '', 'user-1', 'project-1', 'member'], latestStatus))
        await waitFor(() => expect(complete).toBeTypeOf('function'))
        expect(screen.getByRole('group', { name: 'Interaktiver Codegraph' })).toBe(canvas)
        expect(container.querySelector('svg > g')).toHaveAttribute('transform', transform!)
        await act(async () => complete({ nodes: [...nodes], edges: [] }))
        expect(screen.getByRole('group', { name: 'Interaktiver Codegraph' })).toBe(canvas)
        expect(container.querySelector('svg > g')).toHaveAttribute('transform', transform!)
        fireEvent.change(screen.getByLabelText('Symbol oder Datei suchen'), { target: { value: 'missing' } })
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        expect(await screen.findByText('Keine Symbole gefunden.')).toBeInTheDocument()
    })
})
