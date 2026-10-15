import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeGraphCanvas, CodegraphPanel, layoutNodes } from './Codegraph'
import type { CodeNode } from './api'

const request = vi.hoisted(() => vi.fn())
vi.mock('./auth', () => ({ useEvolved: () => ({ api: { request }, project: { id: 'project-1', role: 'member', rootPath: '/work/project' } }) }))

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
