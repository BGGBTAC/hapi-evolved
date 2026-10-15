import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { EvolvedApiError } from './api'
import { RepositoryWorktreePanel } from './RepositoryWorktree'
import { ProjectReadinessPanel } from './ProjectReadiness'
import { SessionRepositoryLink } from './SessionRepositoryLink'
import { ProjectWorkflowProvider } from './ProjectWorkflowContext'
const context = vi.hoisted(() => ({ api: { baseUrl: 'https://hub.test', request: vi.fn() }, me: { user: { id: 'human' } }, project: { id: 'p1', name: 'One', role: 'admin', profile: 'workspace' } }))
vi.mock('./auth', () => ({ useEvolved: () => context, useOptionalEvolved: () => context }))
vi.mock('./Codegraph', () => ({ CodeGraphCanvas: () => <div>Graph canvas</div> }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ to, params, search, children, ...props }: { to: string; params?: { sessionId?: string }; search?: Record<string, string>; children: ReactNode }) => <a href={to.replace('$sessionId', params?.sessionId ?? '') + (search ? `?${new URLSearchParams(search)}` : '')} {...props}>{children}</a> }))
const file = (path: string, extra = {}) => ({ path, index: 'M', worktree: 'M', kind: 'file', ...extra })
const worktree = () => ({ repositoryId: '101', state: 'ready', branch: 'main', detached: false, head: 'a'.repeat(40), snapshotId: 'b'.repeat(64), observedAt: 1, files: [file('src/a,b.ts'), file('.env', { excluded: 'sensitive_path' }), file('image.png'), file('link', { kind: 'symlink' })], truncated: false })
const impact = () => ({ snapshotId: 'b'.repeat(64), index: { state: 'unknown', stale: true, lastIndexedAt: null, pendingFiles: null }, queried: [], skipped: [{ path: 'gone.ts', reason: 'deleted' }], graph: { nodes: [], edges: [] }, candidateTests: [] })
function mount(children: ReactNode = <RepositoryWorktreePanel repositoryId="101" name="example/app" onClose={() => {}} />) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><ProjectWorkflowProvider>{children}</ProjectWorkflowProvider></QueryClientProvider>
    return { ...render(children, { wrapper }), client }
}
beforeEach(() => {
    context.project = { id: 'p1', name: 'One', role: 'admin', profile: 'workspace' }
    context.api.request.mockReset().mockImplementation(async (path: string, options?: { body?: any }) => {
        if (path.endsWith('/worktree')) return worktree()
        if (path.endsWith('/sessions')) return { sessions: [{ id: 'session-one', active: false, createdAt: 1, updatedAt: 2 }] }
        if (path.endsWith('/impact')) return impact()
        if (path.endsWith('/diff')) return { path: options!.body.path, side: options!.body.side, patch: 'diff --git a/src/a,b.ts b/src/a,b.ts\n--- a/src/a,b.ts\n+++ b/src/a,b.ts\n@@ -1 +1 @@\n-old\n+new\n', binary: false, truncated: false, observedAt: 1 }
        return { item: { status: 'proposed' } }
    })
})
it('reuses the existing diff display with explicit staged/unstaged requests and protects excluded sources', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Staged-Diff: src/a,b.ts' }))
    expect(await screen.findByText('+new')).toBeInTheDocument()
    expect(context.api.request).toHaveBeenCalledWith('/projects/p1/repositories/101/worktree/diff', expect.objectContaining({ body: { snapshotId: 'b'.repeat(64), path: 'src/a,b.ts', side: 'staged' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Arbeitskopie-Diff: src/a,b.ts' }))
    await waitFor(() => expect(context.api.request).toHaveBeenCalledWith(expect.stringContaining('/diff'), expect.objectContaining({ body: expect.objectContaining({ side: 'unstaged' }) })))
    expect(screen.getByRole('checkbox', { name: 'Auswählen: .env' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Diff: .env/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Als Wissen vorschlagen' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Staged-Diff: link' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Auswählen: link' })).toBeDisabled()
    expect(screen.getByText('Inhalte von Git-Untermodulen werden nicht geprüft.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Sitzung session-/ })).toHaveAttribute('href', '/sessions/session-one')
})
it('reports a fully withheld oversized diff without claiming an empty or partial diff', async () => {
    const original = context.api.request.getMockImplementation()!
    context.api.request.mockImplementation(async (path, options) => path.endsWith('/diff') ? { path: 'src/a,b.ts', side: 'staged', patch: null, binary: false, truncated: true, observedAt: 1 } : original(path, options))
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Staged-Diff: src/a,b.ts' }))
    expect(await screen.findByText(/vollständig zurückgehalten/)).toBeInTheDocument()
    expect(screen.queryByText(/Keine Unterschiede/)).not.toBeInTheDocument()
})
it('keeps comma paths as array entries, marks unconfirmed graph state and prepares review without starting', async () => {
    mount(); fireEvent.click(await screen.findByRole('checkbox', { name: 'Auswählen: src/a,b.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Auswirkungen prüfen (1/200)' }))
    expect(await screen.findByText(/keinen bestätigten Ausschnitt/)).toBeInTheDocument()
    expect(context.api.request).toHaveBeenCalledWith('/projects/p1/repositories/101/impact', expect.objectContaining({ body: { snapshotId: 'b'.repeat(64), paths: ['src/a,b.ts'] } }))
    expect(screen.getByRole('link', { name: 'Review vorbereiten' })).toHaveAttribute('href', '/evolved?tab=agents&project=p1')
    expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/start'))).toBe(false)
})
it('requires refreshing after snapshot changes and blocks stale preview actions', async () => {
    const original = context.api.request.getMockImplementation()!
    context.api.request.mockImplementation(async (path, options) => { if (path.endsWith('/diff')) throw new EvolvedApiError('Changed', 409, 'worktree_changed'); return original(path, options) })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Staged-Diff: src/a,b.ts' }))
    expect(await screen.findByText(/Der Arbeitsstand hat sich geändert/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Arbeitskopie-Diff: src/a,b.ts' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Arbeitsstand aktualisieren' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Staged-Diff: src/a,b.ts' })).toBeEnabled())
})
it('requires explicit file-memory confirmation and provides a review link, without verifying or enabling processing', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Als Wissen vorschlagen' }))
    expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/memory-intake'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
    expect(await screen.findByRole('link', { name: 'Wissensvorschlag im Projektgedächtnis prüfen' })).toHaveAttribute('href', '/evolved?tab=memory&project=p1')
    expect(context.api.request).toHaveBeenCalledWith('/projects/p1/repositories/101/memory-intake', expect.objectContaining({ method: 'POST', body: { path: 'src/a,b.ts' } }))
})
it('viewer can inspect but cannot propose memory or prepare a new review', async () => {
    context.project.role = 'viewer'; mount()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Auswählen: src/a,b.ts' }))
    expect(screen.queryByRole('button', { name: 'Als Wissen vorschlagen' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Review vorbereiten' })).not.toBeInTheDocument()
})
it('aborts and removes old repository details on project switch', async () => {
    let finish!: (value: unknown) => void, signal!: AbortSignal
    context.api.request.mockImplementation((path, options) => path.endsWith('/worktree') ? new Promise(resolve => { finish = resolve; signal = options.signal }) : Promise.resolve({ sessions: [] }))
    const view = mount(); const oldFinish = finish, oldSignal = signal
    context.project = { ...context.project, id: 'p2' }
    view.rerender(<RepositoryWorktreePanel repositoryId="101" name="example/app" onClose={() => {}} />)
    expect(oldSignal.aborted).toBe(true)
    await act(async () => oldFinish(worktree()))
    expect(screen.queryByText('src/a,b.ts')).not.toBeInTheDocument()
})
it('readiness is compact, unknown is never ready, provider setup is admin-only and errors hide old data', async () => {
    context.project.role = 'member'
    context.api.request.mockResolvedValue({ projectId: 'p1', checkedAt: 1, purposes: { plan: 'unknown', code: 'missing' }, items: [{ key: 'provider', label: 'Provider', state: 'missing', detail: 'No subscription', action: { kind: 'providers', label: 'Abo einrichten' } }] })
    const view = mount(<ProjectReadinessPanel />)
    expect(await screen.findByText('Unbekannt')).toBeInTheDocument()
    expect(screen.getByText('Prüfdetails (1)').closest('details')).not.toHaveAttribute('open')
    expect(screen.queryByRole('link', { name: 'Abo einrichten' })).not.toBeInTheDocument()
    context.project.role = 'admin'; view.rerender(<ProjectReadinessPanel />)
    expect((await screen.findAllByRole('link', { name: 'Abo einrichten' }))[0]).toHaveAttribute('href', '/evolved?tab=providers&project=p1')
    context.api.request.mockRejectedValue(new EvolvedApiError('Revoked', 403, 'forbidden'))
    fireEvent.click(screen.getByRole('button', { name: 'Bereitschaft prüfen' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Abo einrichten' })).not.toBeInTheDocument())
})
it('session repository links are project scoped and disappear after access errors', async () => {
    context.api.request.mockResolvedValue({ repository: { id: '101', fullName: 'example/app', path: '/private/root' } })
    const view = mount(<SessionRepositoryLink sessionId="s1" />)
    expect(await screen.findByRole('link', { name: /Repository: example\/app/ })).toHaveAttribute('href', '/evolved?tab=github&project=p1&repository=101')
    context.api.request.mockRejectedValue(new EvolvedApiError('No access', 403, 'forbidden'))
    context.project = { ...context.project, id: 'p2' }; view.rerender(<SessionRepositoryLink sessionId="s1" />)
    expect(await screen.findByRole('button', { name: /Zuordnung erneut prüfen/ })).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
})
