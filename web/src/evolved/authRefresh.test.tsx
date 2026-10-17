import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolvedBoundary, useEvolved, type EvolvedBridge } from './auth'

vi.mock('@/hooks/useServerUrl', () => ({ useServerUrl: () => ({ baseUrl: 'https://hub.test' }) }))
const user = { id: 'user-1', displayName: 'Test user', isAdmin: true }
const projects = ['a', 'b'].map(id => ({ id, teamId: 'team', name: id, role: 'admin', profile: 'restricted' }))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear() })
type Failure = 'network' | 401 | 403 | 429 | 503 | null
function fixture(initialFailure: Failure = null) {
    let failure = initialFailure, currentUser = user, accessibleProjects = projects
    let defer = false, tokenCalls = 0, sessionCalls = 0
    const pending: Array<{ resolve: (response: Response) => void; reject: (error: unknown) => void }> = []
    const mounted = vi.fn(), unmounted = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input)
        if (url.pathname === '/health') return Response.json({ evolved: { enabled: true } })
        if (url.pathname.endsWith('/auth/status')) return Response.json({ initialized: true, authenticated: true })
        if (url.pathname.endsWith('/me')) return Response.json({ user: currentUser, accessibleProjects })
        if (url.pathname.endsWith('/agent-catalog')) return Response.json({ themes: [] })
        if (url.pathname.endsWith('/session-token')) {
            tokenCalls++
            if (defer) return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }))
            if (failure === 'network') throw new TypeError('Failed to fetch')
            if (failure) return Response.json({ error: 'Synthetic renewal unavailable' }, { status: failure })
            return Response.json({ token: `token-${url.searchParams.get('projectId')}-${tokenCalls}` })
        }
        if (url.pathname === '/api/sessions') {
            sessionCalls++
            if (new Headers(init?.headers).get('authorization')?.includes('renewed-token')) return Response.json({ sessions: [] })
            return Response.json({ error: 'Token expired' }, { status: 401 })
        }
        throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`)
    }))
    function Workspace({ bridge }: { bridge: EvolvedBridge }) {
        const { refresh, selectProject, project, me } = useEvolved()
        const [draft, setDraft] = useState(''), [requestError, setRequestError] = useState(''), [completedReads, setCompletedReads] = useState(0)
        useEffect(() => { mounted(); return () => { unmounted() } }, [])
        return <><p>{project?.id}:{bridge.token}:{me.user.id}</p><input aria-label="Private draft" value={draft} onChange={event => setDraft(event.target.value)} />
            <button onClick={() => void refresh()}>Renew</button><button onClick={() => selectProject('b')}>Project B</button>
            <button onClick={() => void bridge.api.getSessions().then(() => setCompletedReads(count => count + 1)).catch(error => setRequestError(error.message))}>Read sessions</button><p>{requestError}</p><p>Completed reads: {completedReads}</p></>
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
    render(<QueryClientProvider client={client}><EvolvedBoundary legacy={null} onboarding={null} authenticated={bridge => <Workspace bridge={bridge} />} /></QueryClientProvider>)
    return { mounted, unmounted, pending, fail: (value: Failure) => { failure = value }, defer: (value: boolean) => { defer = value },
        calls: () => ({ token: tokenCalls, sessions: sessionCalls }), user: (value: typeof user) => { currentUser = value }, projects: (value: typeof projects) => { accessibleProjects = value } }
}
async function draft() { fireEvent.change(await screen.findByLabelText('Private draft'), { target: { value: 'synthetic-unsaved-private-input' } }) }

describe('temporary bridge-token renewal failures', () => {
    it.each(['network', 429, 503] as const)('keeps the same workspace and draft on %s and clears the warning after explicit recovery', async failure => {
        const f = fixture(); await draft(); f.fail(failure)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await screen.findByText(/Die Verbindung konnte gerade nicht erneuert werden/)
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
        expect(screen.getByText('a:token-a-1:user-1')).toBeInTheDocument()
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
        expect(f.calls().token).toBe(2)
        f.fail(null); fireEvent.click(screen.getByRole('button', { name: 'Verbindung erneut prüfen' }))
        await screen.findByText('a:token-a-3:user-1')
        expect(screen.queryByText(/Die Verbindung konnte gerade nicht erneuert werden/)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
    })

    it('does not discard the draft when the three-minute background renewal fails', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
        const f = fixture(); await draft(); f.fail(503)
        await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
        expect(screen.getByText(/Die Verbindung konnte gerade nicht erneuert werden/)).toBeInTheDocument()
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
        expect(f.calls().token).toBe(2); expect(f.unmounted).not.toHaveBeenCalled()
    })

    it('returns no refreshed token to unauthorized API calls and does not replay them with the old token', async () => {
        const f = fixture(); await draft(); f.fail(503)
        fireEvent.click(screen.getByRole('button', { name: 'Read sessions' }))
        await screen.findByText('Session expired. Please sign in again.')
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
        expect(f.calls()).toEqual({ token: 2, sessions: 1 })
        expect(f.unmounted).not.toHaveBeenCalled()
    })

    it('blocks initial project access when no token was successfully issued', async () => {
        const f = fixture(503)
        await screen.findByRole('button', { name: 'Projekt erneut öffnen' })
        expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument()
        expect(screen.queryByText(/Deine offenen Eingaben bleiben erhalten/)).not.toBeInTheDocument()
        expect(f.mounted).not.toHaveBeenCalled()
        f.fail(null); fireEvent.click(screen.getByRole('button', { name: 'Projekt erneut öffnen' }))
        expect(await screen.findByLabelText('Private draft')).toHaveValue('')
    })

    it.each([401, 403] as const)('still removes the workspace and draft when authority is rejected with %s', async status => {
        const f = fixture(); await draft(); f.fail(status)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await screen.findByRole('button', { name: status === 401 ? 'Mit Passkey anmelden' : 'Projekt erneut öffnen' })
        expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument()
        expect(f.unmounted).toHaveBeenCalledTimes(1)
        expect(screen.queryByText(/Deine offenen Eingaben bleiben erhalten/)).not.toBeInTheDocument()
    })

    it.each(['success', 'failure'] as const)('does not replace a newer successful renewal with an older late %s', async outcome => {
        const f = fixture(); await draft(); f.defer(true)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(1))
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(2))
        await act(async () => f.pending[1].resolve(Response.json({ token: 'recovered-token' })))
        await screen.findByText('a:recovered-token:user-1')
        await act(async () => f.pending[0].resolve(outcome === 'success' ? Response.json({ token: 'older-token' }) : Response.json({ error: 'Late failure' }, { status: 503 })))
        expect(screen.getByText('a:recovered-token:user-1')).toBeInTheDocument()
        expect(screen.queryByText(/Die Verbindung konnte gerade nicht erneuert werden/)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
    })

    it.each([503, 429, 'network'] as const)('recovers from a newer %s failure when an older background renewal succeeds', async failure => {
        const f = fixture(); await draft(); f.defer(true)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(1))
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(2))
        await act(async () => failure === 'network'
            ? f.pending[1].reject(new TypeError('Failed to fetch'))
            : f.pending[1].resolve(Response.json({ error: 'Temporary failure' }, { status: failure })))
        await screen.findByText(/Die Verbindung konnte gerade nicht erneuert werden/)
        await act(async () => f.pending[0].resolve(Response.json({ token: 'renewed-token-recovered' })))
        expect(screen.getByText('a:renewed-token-recovered:user-1')).toBeInTheDocument()
        expect(screen.queryByText(/Die Verbindung konnte gerade nicht erneuert werden/)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Read sessions' }))
        await screen.findByText('Completed reads: 1')
        expect(f.calls()).toEqual({ token: 3, sessions: 1 })
    })

    it('recovers through the oldest background renewal after two newer temporary failures', async () => {
        const f = fixture(); await draft(); f.defer(true)
        for (let count = 1; count <= 3; count++) {
            fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
            await waitFor(() => expect(f.pending).toHaveLength(count))
        }
        await act(async () => f.pending[1].resolve(Response.json({ error: 'Temporary failure' }, { status: 503 })))
        await act(async () => f.pending[2].resolve(Response.json({ error: 'Temporary failure' }, { status: 503 })))
        await screen.findByText(/Die Verbindung konnte gerade nicht erneuert werden/)
        await act(async () => f.pending[0].resolve(Response.json({ token: 'renewed-token-oldest' })))
        expect(screen.getByText('a:renewed-token-oldest:user-1')).toBeInTheDocument()
        expect(screen.queryByText(/Die Verbindung konnte gerade nicht erneuert werden/)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
        fireEvent.click(screen.getByRole('button', { name: 'Read sessions' }))
        await screen.findByText('Completed reads: 1')
        expect(f.calls()).toEqual({ token: 4, sessions: 1 })
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
    })

    it('allows both concurrent unauthorized requests to retry after successful renewals', async () => {
        const f = fixture(); await draft(); f.defer(true)
        fireEvent.click(screen.getByRole('button', { name: 'Read sessions' }))
        fireEvent.click(screen.getByRole('button', { name: 'Read sessions' }))
        await waitFor(() => expect(f.pending).toHaveLength(2))
        await act(async () => f.pending[1].resolve(Response.json({ token: 'renewed-token-newer' })))
        await screen.findByText('Completed reads: 1')
        await act(async () => f.pending[0].resolve(Response.json({ token: 'renewed-token-older' })))
        await screen.findByText('Completed reads: 2')
        expect(screen.getByText('a:renewed-token-newer:user-1')).toBeInTheDocument()
        expect(screen.queryByText('Session expired. Please sign in again.')).not.toBeInTheDocument()
        expect(f.calls()).toEqual({ token: 3, sessions: 4 })
        expect(f.unmounted).not.toHaveBeenCalled()
    })

    it.each([401, 403] as const)('ignores a late successful renewal after authority was rejected with %s', async status => {
        const f = fixture(); await draft(); f.defer(true)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(1))
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(2))
        await act(async () => f.pending[1].resolve(Response.json({ error: 'Authority revoked' }, { status })))
        await screen.findByRole('button', { name: status === 401 ? 'Mit Passkey anmelden' : 'Projekt erneut öffnen' })
        await act(async () => f.pending[0].resolve(Response.json({ token: 'late-renewed-token' })))
        expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument()
        expect(screen.queryByText(/late-renewed-token/)).not.toBeInTheDocument()
        expect(f.mounted).toHaveBeenCalledTimes(1)
    })

    it.each([[401, 'failure'], [403, 'failure'], [401, 'success'], [403, 'success']] as const)('keeps authority rejection %s effective when a newer pending renewal later returns %s', async (status, outcome) => {
        const f = fixture(); await draft(); f.defer(true)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(1))
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(2))
        await act(async () => f.pending[0].resolve(Response.json({ error: 'Authority revoked' }, { status })))
        await screen.findByRole('button', { name: status === 401 ? 'Mit Passkey anmelden' : 'Projekt erneut öffnen' })
        await act(async () => f.pending[1].resolve(outcome === 'success' ? Response.json({ token: 'late-renewed-token' }) : Response.json({ error: 'Temporary failure' }, { status: 503 })))
        expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument()
        expect(screen.queryByText(/late-renewed-token/)).not.toBeInTheDocument()
        expect(screen.queryByText(/Deine offenen Eingaben bleiben erhalten/)).not.toBeInTheDocument()
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).toHaveBeenCalledTimes(1)
    })

    it.each([401, 403] as const)('ignores an older authority rejection %s after a newer renewal succeeded', async status => {
        const f = fixture(); await draft(); f.defer(true)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(1))
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(2))
        await act(async () => f.pending[1].resolve(Response.json({ token: 'renewed-token-confirmed' })))
        await screen.findByText('a:renewed-token-confirmed:user-1')
        await act(async () => f.pending[0].resolve(Response.json({ error: 'Old authority rejection' }, { status })))
        expect(screen.getByText('a:renewed-token-confirmed:user-1')).toBeInTheDocument()
        expect(screen.getByLabelText('Private draft')).toHaveValue('synthetic-unsaved-private-input')
        expect(screen.queryByText(/Deine offenen Eingaben bleiben erhalten/)).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Read sessions' }))
        await screen.findByText('Completed reads: 1')
        expect(f.calls()).toEqual({ token: 3, sessions: 1 })
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
    })

    it.each(['success', 'failure'] as const)('ignores a late previous-project %s after project authority changed', async outcome => {
        const f = fixture(); await draft(); f.defer(true)
        fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
        await waitFor(() => expect(f.pending).toHaveLength(1))
        f.defer(false); fireEvent.click(screen.getByRole('button', { name: 'Project B' }))
        await screen.findByText('b:token-b-3:user-1')
        expect(screen.getByLabelText('Private draft')).toHaveValue('')
        await act(async () => f.pending[0].resolve(outcome === 'success' ? Response.json({ token: 'old-project-token' }) : Response.json({ error: 'Late failure' }, { status: 503 })))
        expect(screen.getByText('b:token-b-3:user-1')).toBeInTheDocument()
        expect(screen.queryByText(/Die Verbindung konnte gerade nicht erneuert werden/)).not.toBeInTheDocument()
    })
})
