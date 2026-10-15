import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolvedApiError, type ExecutionProfile, type ProjectRole } from './api'
import { GithubPanel } from './Github'

const context = vi.hoisted(() => ({
    api: { request: vi.fn(), baseUrl: '' },
    me: { user: { id: 'one' } },
    project: { id: 'one', role: 'member' as ProjectRole, profile: 'workspace' as ExecutionProfile },
    refresh: vi.fn(),
}))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
const repository = { id: '123', owner: 'owner', name: 'repo', fullName: 'owner/repo', permission: 'read' as const }
const localRepository = { ...repository, cloneUrl: 'https://github.com/owner/repo.git', path: '/managed-workspaces/one/repositories/owner/repo', local: { state: 'missing', branch: null as string | null, dirty: false as boolean | null, message: undefined as string | undefined }, job: undefined as unknown }
let workspace: { connected: boolean; rootPath: string; canSync: boolean; canPush: boolean; runner: { status: string }; repositories: typeof localRepository[] }
const job = { id: 'job-one', repositoryId: '123', action: 'clone', state: 'running' }
type Options = { method?: string; body?: unknown; signal?: AbortSignal }
async function baseRequest(path: string, options: Options = {}) {
    if (path.endsWith('/github')) return { connected: true, repositories: [repository] }
    if (path.endsWith('/repositories') && !options.method) return structuredClone(workspace)
    throw Error(`Unexpected request: ${path}`)
}
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><GithubPanel /></QueryClientProvider>)
    return { client, ...view, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><GithubPanel /></QueryClientProvider>) }
}
beforeEach(() => {
    sessionStorage.clear()
    context.project.id = 'one'; context.project.role = 'member'; context.project.profile = 'workspace'; context.me.user.id = 'one'
    context.api.request.mockReset().mockImplementation(baseRequest)
    workspace = { connected: true, rootPath: '/managed-workspaces/one', canSync: true, canPush: true, runner: { status: 'ready' }, repositories: [structuredClone(localRepository)] }
})

describe('project repository workspace', () => {
    it('lets members clone a read grant, polls the job and displays the actual path and branch', async () => {
        let polls = 0
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') return { job }
            if (path.endsWith('/repository-jobs/job-one')) {
                polls++
                if (polls === 1) return { job }
                workspace.repositories[0]!.local = { state: 'ready', branch: 'main', dirty: false, message: undefined }
                return { job: { ...job, state: 'succeeded' } }
            }
            return baseRequest(path, options)
        })
        mount()
        const clone = await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' })
        expect(clone).toBeEnabled()
        expect(screen.queryByLabelText('Fine-grained Personal Access Token')).not.toBeInTheDocument()
        fireEvent.click(clone)
        expect(await screen.findByText('Repository wird geklont …')).toBeInTheDocument()
        expect(clone).toBeDisabled()
        expect(context.api.request).toHaveBeenCalledWith('/projects/one/repositories/123/sync', expect.objectContaining({
            method: 'POST', body: { action: 'clone', requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) }, signal: expect.any(AbortSignal),
        }), false)
        expect(await screen.findByText('Repository geklont.', {}, { timeout: 3000 })).toBeInTheDocument()
        expect(await screen.findByText(/Branch: main/)).toBeInTheDocument()
        expect(screen.getByText(localRepository.path)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Aktualisieren: owner/repo' })).toBeEnabled()
        expect(context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    })
    it('updates an existing repository without asking for a URL or token', async () => {
        workspace.repositories[0]!.local = { state: 'ready', branch: 'feature', dirty: false, message: undefined }
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') return { job: { ...job, action: 'pull' } }
            if (path.endsWith('/repository-jobs/job-one')) return { job: { ...job, action: 'pull', state: 'succeeded' } }
            return baseRequest(path, options)
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Aktualisieren: owner/repo' }))
        expect(await screen.findByText('Repository aktualisiert.')).toBeInTheDocument()
        expect(context.api.request.mock.calls.find(([, options]) => options?.method === 'POST')?.[1].body).toMatchObject({ action: 'pull' })
        expect(screen.queryByLabelText('GitHub-Repository')).not.toBeInTheDocument()
    })
    it.each([['viewer', 'workspace'], ['member', 'restricted']] as const)('blocks file operations for %s/%s even with an inconsistent canSync response', async (role, profile) => {
        context.project.role = role; context.project.profile = profile
        mount()
        expect(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).toBeDisabled()
        expect(context.api.request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    })
    it.each(['offline', 'upgrade_required', 'ambiguous'])('preserves grant metadata but disables mutations when runner is %s', async status => {
        workspace.runner.status = status; workspace.canSync = false
        mount()
        expect(await screen.findByText('owner/repo')).toBeInTheDocument()
        expect(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).toBeDisabled()
        expect(screen.queryByLabelText('Fine-grained Personal Access Token')).not.toBeInTheDocument()
    })
    it('does not confuse an unreadable local status with a missing clone and allows an explicit read retry', async () => {
        let failed = true
        context.api.request.mockImplementation(async (path: string, options: Options) => {
            if (path.endsWith('/repositories') && failed) throw new EvolvedApiError('Lokaler Status nicht erreichbar.', 503)
            return baseRequest(path, options)
        })
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Lokaler Status nicht erreichbar.')
        expect(screen.getByText('owner/repo')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).not.toBeInTheDocument()
        failed = false
        fireEvent.click(screen.getByRole('button', { name: 'Repository-Status prüfen' }))
        expect(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).toBeEnabled()
    })
    it.each(['blocked', 'unknown'])('never offers clone or pull for local state %s', async state => {
        workspace.repositories[0]!.local.state = state
        mount()
        await screen.findByText(localRepository.path)
        expect(screen.queryByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Aktualisieren: owner/repo' })).not.toBeInTheDocument()
    })
    it('preserves dirty work and explains why automatic pull is disabled', async () => {
        workspace.repositories[0]!.local = { state: 'ready', branch: 'main', dirty: true, message: undefined }
        mount()
        expect(await screen.findByRole('button', { name: 'Aktualisieren: owner/repo' })).toBeDisabled()
        expect(screen.getByText(/Hier werden keine Änderungen verworfen/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Erzwingen|Zurücksetzen/ })).not.toBeInTheDocument()
    })
    it('reconciles a lost mutation response without retrying the POST and resumes its job', async () => {
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') { workspace.repositories[0]!.job = { ...job, requestId: (options.body as {requestId: string}).requestId }; throw Error('Antwort verloren. Status erneut prüfen.') }
            if (path.endsWith('/repository-jobs/job-one')) return { job }
            return baseRequest(path, options)
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Antwort verloren.')
        expect(await screen.findByText('Repository wird geklont …')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).toBeDisabled()
        expect(context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    })
    it('keeps an unacknowledged request across remount and explicitly retries the same idempotency key', async () => {
        let attempts = 0
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') {
                attempts++
                if (attempts === 1) throw Error('Antwort verloren.')
                return { job: { ...job, requestId: (options.body as {requestId: string}).requestId } }
            }
            if (path.endsWith('/repository-jobs/job-one')) return { job }
            return baseRequest(path, options)
        })
        const view = mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' }))
        await screen.findByRole('button', { name: 'Auftrag erneut zuordnen: owner/repo' })
        expect(attempts).toBe(1)
        view.unmount()
        mount()
        const retry = await screen.findByRole('button', { name: 'Auftrag erneut zuordnen: owner/repo' })
        expect(attempts).toBe(1)
        expect(screen.queryByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).not.toBeInTheDocument()
        await waitFor(() => expect(retry).toBeEnabled())
        fireEvent.click(retry)
        await screen.findByText('Repository wird geklont …')
        const posts = context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST')
        expect(posts).toHaveLength(2)
        expect(posts[0]![1].body).toEqual(posts[1]![1].body)
        expect(sessionStorage.length).toBe(0)
    })
    it('resolves uncertainty only from the matching request id returned by status', async () => {
        let requestId = ''
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') { requestId = (options.body as {requestId: string}).requestId; throw Error('Antwort verloren.') }
            return baseRequest(path, options)
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' }))
        await screen.findByRole('button', { name: 'Auftrag erneut zuordnen: owner/repo' })
        workspace.repositories[0]!.local.state = 'ready'
        workspace.repositories[0]!.job = { ...job, state: 'succeeded', requestId: 'different-request' }
        fireEvent.click(screen.getByRole('button', { name: 'Repository-Status prüfen' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Auftrag erneut zuordnen: owner/repo' })).toBeEnabled())
        workspace.repositories[0]!.job = { ...job, state: 'succeeded', requestId }
        fireEvent.click(screen.getByRole('button', { name: 'Repository-Status prüfen' }))
        expect(await screen.findByRole('button', { name: 'Aktualisieren: owner/repo' })).toBeEnabled()
        expect(sessionStorage.length).toBe(0)
        expect(context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    })
    it('restores a running job after reload and reports a failed fast-forward without claiming success', async () => {
        workspace.repositories[0]!.job = { ...job, action: 'pull' }
        workspace.repositories[0]!.local.state = 'ready'
        context.api.request.mockImplementation(async (path: string, options: Options) => {
            if (path.endsWith('/repository-jobs/job-one')) {
                workspace.repositories[0]!.job = undefined
                return { job: { ...job, action: 'pull', state: 'failed', message: 'Branches sind auseinander gelaufen. Kein Fast-forward möglich.' } }
            }
            return baseRequest(path, options)
        })
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Kein Fast-forward möglich.')
        expect(screen.queryByText('Repository aktualisiert.')).not.toBeInTheDocument()
        expect(context.api.request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    })
    it('recovers an unavailable job by reading actual repository status without another mutation', async () => {
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') return { job }
            if (path.endsWith('/repository-jobs/job-one')) throw new EvolvedApiError('Vorgang nicht mehr verfügbar.', 404)
            return baseRequest(path, options)
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Vorgang nicht mehr verfügbar.')
        expect(screen.getByText(/Der aktuelle Stand des Git-Vorgangs ist unbekannt/)).toBeInTheDocument()
        workspace.repositories[0]!.local = { state: 'ready', branch: 'main', dirty: false, message: undefined }
        fireEvent.click(screen.getByRole('button', { name: 'Repository-Status prüfen' }))
        expect(await screen.findByRole('button', { name: 'Aktualisieren: owner/repo' })).toBeEnabled()
        expect(screen.queryByText('Repository geklont.')).not.toBeInTheDocument()
        expect(context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    })
    it('hides cached paths and actions when local workspace authorization is denied', async () => {
        let denied = false
        context.api.request.mockImplementation(async (path: string, options: Options) => {
            if (path.endsWith('/repositories') && denied) throw new EvolvedApiError('Projektzugriff widerrufen.', 403)
            return baseRequest(path, options)
        })
        mount()
        await screen.findByText(localRepository.path)
        denied = true
        fireEvent.click(screen.getByRole('button', { name: 'Repository-Status prüfen' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Projektzugriff widerrufen.')
        expect(screen.queryByText(localRepository.path)).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).not.toBeInTheDocument()
    })
    it('aborts an in-flight job poll and ignores its success after switching projects', async () => {
        let finish!: (value: unknown) => void
        let signal: AbortSignal | undefined
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') return { job }
            if (path.endsWith('/repository-jobs/job-one')) { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return baseRequest(path, options)
        })
        const { rerenderPanel } = mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' }))
        await waitFor(() => expect(signal).toBeDefined())
        context.project.id = 'two'; rerenderPanel()
        expect(signal?.aborted).toBe(true)
        await act(async () => finish({ job: { ...job, state: 'succeeded' } }))
        expect(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).toBeEnabled()
        expect(screen.queryByText('Repository geklont.')).not.toBeInTheDocument()
    })
    it('hides cached local paths as soon as a job poll reports revoked access', async () => {
        workspace.repositories[0]!.job = job
        context.api.request.mockImplementation(async (path: string, options: Options) => {
            if (path.endsWith('/repository-jobs/job-one')) throw new EvolvedApiError('Projektzugriff widerrufen.', 403)
            return baseRequest(path, options)
        })
        mount()
        expect(await screen.findByRole('alert')).toHaveTextContent('Projektzugriff widerrufen.')
        expect(screen.queryByText(localRepository.path)).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).not.toBeInTheDocument()
    })
    it.each(['project', 'account'] as const)('aborts pending submissions and rejects a late response after %s change', async change => {
        let finish!: (value: unknown) => void
        let signal: AbortSignal | undefined
        context.api.request.mockImplementation(async (path: string, options: Options = {}) => {
            if (options.method === 'POST') { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return baseRequest(path, options)
        })
        const { rerenderPanel } = mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Ins Projekt klonen: owner/repo' }))
        if (change === 'project') context.project.id = 'two'
        else context.me.user.id = 'two'
        rerenderPanel()
        expect(signal?.aborted).toBe(true)
        await act(async () => finish({ job }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Ins Projekt klonen: owner/repo' })).toBeEnabled())
        expect(screen.queryByText('Repository wird geklont …')).not.toBeInTheDocument()
        expect(context.api.request.mock.calls.some(([path]) => path.includes('/repository-jobs/'))).toBe(false)
    })
})
