import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolvedBoundary, useEvolved } from './auth'
import { clearAllMessageWindows, getMessageWindowState, ingestIncomingMessages } from '@/lib/message-window-store'
import type { DecryptedMessage } from '@/types/api'

vi.mock('@/hooks/useServerUrl', () => ({ useServerUrl: () => ({ baseUrl: 'https://hub.test' }) }))
afterEach(() => { clearAllMessageWindows(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })
function renderBoundary() {
    const legacyMounted = vi.fn()
    function Legacy() { legacyMounted(); return <div>Legacy token login</div> }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><EvolvedBoundary legacy={<Legacy />} onboarding={<div>Project onboarding</div>} authenticated={() => <div>Authenticated</div>} /></QueryClientProvider>)
    return legacyMounted
}
describe('Evolved authentication boundary', () => {
    it('never mounts legacy token authentication when Evolved is enabled', async () => {
        localStorage.setItem('hapi_access_token::https://hub.test', 'old-token')
        const fetcher = vi.fn().mockImplementation((url: string) => {
            if (url.endsWith('/health')) return Promise.resolve(Response.json({ evolved: { enabled: true } }))
            if (url.endsWith('/auth/status')) return Promise.resolve(Response.json({ enabled: true, initialized: true, authenticated: false }))
            throw new Error(`Unexpected endpoint ${url}`)
        })
        vi.stubGlobal('fetch', fetcher)
        const legacy = renderBoundary()
        expect(await screen.findByRole('button', { name: 'Mit Passkey anmelden' })).toBeInTheDocument()
        expect(legacy).not.toHaveBeenCalled()
        expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/api/auth'))).toBe(true)
    })
    it('does not fall back to legacy login when mode detection fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')))
        const legacy = renderBoundary()
        expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable')
        expect(legacy).not.toHaveBeenCalled()
    })
    it('resumes an unfinished enrollment after a reload without reusing the consumed invitation', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/health')
            ? Response.json({ evolved: { enabled: true } })
            : Response.json({ initialized: true, authenticated: false, enrollment: { displayName: 'Invited user', expiresAt: Date.now() + 600000 } })))
        renderBoundary()
        expect(await screen.findByRole('button', { name: 'Passkey erstellen' })).toBeInTheDocument()
        expect(screen.getByLabelText('Benutzername')).toHaveValue('Invited user')
        expect(screen.getByLabelText('Benutzername')).toHaveAttribute('readonly')
        expect(screen.queryByLabelText(/Einladungscode/)).not.toBeInTheDocument()
    })
    it('preserves the original application on a non-Evolved hub', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ healthy: true })))
        const legacy = renderBoundary()
        await waitFor(() => expect(legacy).toHaveBeenCalled())
        expect(screen.getByText('Legacy token login')).toBeInTheDocument()
    })
})


const user = { id: 'user-1', displayName: 'Test user', isAdmin: true }
const projects = ['a', 'b'].map(id => ({ id, teamId: 'team', name: id, role: 'admin', profile: 'restricted' }))
function ScopeControls({ token }: { token: string }) {
    const { me, project, refresh, logout } = useEvolved()
    return <div><span>{me.user.id}</span><span>{project?.id}:{token}</span><button onClick={() => void refresh()}>Reload permissions</button><button onClick={() => void logout()}>Logout test</button></div>
}
function seedPrivateTranscript() {
    const message: DecryptedMessage = { id: 'private-message', seq: 1, localId: null, createdAt: 1000, content: { role: 'user', content: { type: 'text', text: 'private old transcript' } } }
    ingestIncomingMessages('loaded-private', [message])
    sessionStorage.setItem('hapi:message-window:v2:cold-private', JSON.stringify({ messages: [message] }))
}
function expectPrivateTranscriptsCleared() {
    expect(getMessageWindowState('loaded-private').messages).toEqual([])
    expect(sessionStorage.getItem('hapi:message-window:v2:cold-private')).toBeNull()
}
function renderAuthenticated() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><EvolvedBoundary legacy={<div>Legacy</div>} onboarding={<div>No project</div>} authenticated={bridge => <ScopeControls token={bridge.token} />} /></QueryClientProvider>)
    return client
}
describe('Evolved scope changes', () => {
    it('keeps current API authority usable after a failed logout and permits a retry', async () => {
        let logoutFails = true
        const fetcher = vi.fn(async (url: string) => {
            if (url.endsWith('/health')) return Response.json({ evolved: { enabled: true } })
            if (url.endsWith('/auth/status')) return Response.json({ initialized: true, authenticated: true })
            if (url.endsWith('/me')) return Response.json({ user, accessibleProjects: projects })
            if (url.includes('/session-token?')) return Response.json({ token: 'test-token' })
            if (url.endsWith('/auth/logout')) {
                if (logoutFails) throw new Error('Network unavailable')
                return Response.json({ ok: true })
            }
            if (url.endsWith('/api/sessions')) return Response.json({ sessions: [] })
            throw new Error(`Unexpected endpoint ${url}`)
        })
        vi.stubGlobal('fetch', fetcher)
        function Probe({ api }: { api: ApiClient }) {
            const { logout } = useEvolved()
            const [status, setStatus] = useState('Ready')
            return <><p role="status">{status}</p><button onClick={() => void logout().catch(error => setStatus(error.message))}>Logout retry</button><button onClick={() => void api.getSessions().then(() => setStatus('Sessions loaded')).catch(error => setStatus(error.message))}>Read sessions</button></>
        }
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><EvolvedBoundary legacy={null} onboarding={null} authenticated={bridge => <Probe api={bridge.api} />} /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole('button', { name: 'Logout retry' }))
        await screen.findByText('Network unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Read sessions' }))
        await screen.findByText('Sessions loaded')
        expect(fetcher.mock.calls.some(([url]) => url.endsWith('/api/sessions'))).toBe(true)
        logoutFails = false
        fireEvent.click(screen.getByRole('button', { name: 'Logout retry' }))
        await screen.findByRole('button', { name: 'Mit Passkey anmelden' })
    })
    it('clears the previous project cache when refreshed membership changes the active project', async () => {
        let accessibleProjects = projects
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.endsWith('/health')) return Response.json({ evolved: { enabled: true } })
            if (url.endsWith('/auth/status')) return Response.json({ initialized: true, authenticated: true })
            if (url.endsWith('/me')) return Response.json({ user, accessibleProjects })
            if (url.includes('/session-token?')) return Response.json({ token: `token-${new URL(url).searchParams.get('projectId')}` })
            throw new Error('Unexpected endpoint')
        }))
        const client = renderAuthenticated()
        await screen.findByText('a:token-a')
        client.setQueryData(['sessions'], ['private project A data'])
        seedPrivateTranscript()
        accessibleProjects = [projects[1]]
        fireEvent.click(screen.getByRole('button', { name: 'Reload permissions' }))
        await screen.findByText('b:token-b')
        expect(client.getQueryData(['sessions'])).toBeUndefined()
        expectPrivateTranscriptsCleared()
        expect(screen.queryByText('a:token-a')).not.toBeInTheDocument()
    })
    it('ignores a principal response which arrives after logout', async () => {
        let deferPrincipal = false
        let resolvePrincipal: ((response: Response) => void) | undefined
        vi.stubGlobal('fetch', vi.fn((url: string) => {
            if (url.endsWith('/health')) return Promise.resolve(Response.json({ evolved: { enabled: true } }))
            if (url.endsWith('/auth/status')) return Promise.resolve(Response.json({ initialized: true, authenticated: true }))
            if (url.endsWith('/auth/logout')) return Promise.resolve(Response.json({ ok: true }))
            if (url.endsWith('/me')) return deferPrincipal ? new Promise<Response>(resolve => { resolvePrincipal = resolve }) : Promise.resolve(Response.json({ user, accessibleProjects: projects }))
            if (url.includes('/session-token?')) return Promise.resolve(Response.json({ token: 'test-token' }))
            throw new Error('Unexpected endpoint')
        }))
        const client = renderAuthenticated()
        await screen.findByText('a:test-token')
        client.setQueryData(['sessions'], ['private data'])
        seedPrivateTranscript()
        deferPrincipal = true
        fireEvent.click(screen.getByRole('button', { name: 'Reload permissions' }))
        await waitFor(() => expect(resolvePrincipal).toBeDefined())
        fireEvent.click(screen.getByRole('button', { name: 'Logout test' }))
        await screen.findByRole('button', { name: 'Mit Passkey anmelden' })
        await act(async () => { resolvePrincipal!(Response.json({ user, accessibleProjects: projects })) })
        expect(screen.getByRole('button', { name: 'Mit Passkey anmelden' })).toBeInTheDocument()
        expect(screen.queryByText('a:test-token')).not.toBeInTheDocument()
        expect(client.getQueryData(['sessions'])).toBeUndefined()
        expectPrivateTranscriptsCleared()
    })
    it('clears transcripts when the principal changes within the same project', async () => {
        let currentUser = user
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.endsWith('/health')) return Response.json({ evolved: { enabled: true } })
            if (url.endsWith('/auth/status')) return Response.json({ initialized: true, authenticated: true })
            if (url.endsWith('/me')) return Response.json({ user: currentUser, accessibleProjects: projects })
            if (url.includes('/session-token?')) return Response.json({ token: 'test-token' })
            throw new Error('Unexpected endpoint')
        }))
        renderAuthenticated()
        await screen.findByText('user-1')
        seedPrivateTranscript()
        currentUser = { ...user, id: 'user-2' }
        fireEvent.click(screen.getByRole('button', { name: 'Reload permissions' }))
        await screen.findByText('user-2')
        expectPrivateTranscriptsCleared()
    })
})
