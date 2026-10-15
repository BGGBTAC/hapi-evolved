import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolvedApiError, type EvolvedProject } from './api'
import { ProviderLoginPanel, providerVerificationUrl } from './ProviderLogin'
import { RunnerPanel } from './Runner'

const context = vi.hoisted(() => ({
    api: { baseUrl: '', request: vi.fn() },
    me: { user: { id: 'user-1', isAdmin: false } },
    project: null as EvolvedProject | null,
}))
vi.mock('./auth', () => ({ useEvolved: () => context }))
const project = (): EvolvedProject => ({ id: 'project-1', teamId: 'team-1', name: 'Project', role: 'admin', profile: 'restricted' })
const snapshot = (provider?: 'codex' | 'claude', method: 'subscription' | 'api-key' = 'subscription') => ({ runner: { status: 'unconfigured', managed: true }, providers: (['codex', 'claude'] as const).map(item => ({ provider: item, status: provider === item ? 'connected' : 'disconnected', method: provider === item ? method : null, checkedAt: Date.now() })) })
const operation = (provider: 'codex' | 'claude', state = 'waiting') => ({ id: 'operation-1', provider, state, flow: provider === 'codex' ? 'device' : 'code', expiresAt: Date.now() + 600_000, verificationUrl: provider === 'codex' ? 'https://auth.openai.com/codex/device' : 'https://claude.com/cai/oauth/authorize?state=synthetic', ...(provider === 'codex' ? { userCode: 'AAAA-BBBBB' } : {}) })
const card = (name: 'Codex' | 'Claude') => within(screen.getByRole('region', { name: `${name}-Anmeldung` }))

beforeEach(() => {
    context.project = project(); context.me.user.id = 'user-1'
    context.api.request.mockReset().mockResolvedValue(snapshot())
    localStorage.clear()
})

describe('Browser provider login', () => {
    it('requires a project and does not fetch unscoped provider state', () => {
        context.project = null
        render(<ProviderLoginPanel />)
        expect(screen.getByText(/Wähle zuerst ein Projekt/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Projekte öffnen' })).toHaveAttribute('href', '/evolved?tab=projects')
        expect(context.api.request).not.toHaveBeenCalled()
    })
    it.each(['viewer', 'member'] as const)('does not expose provider operations or account state to %s', role => {
        context.project!.role = role
        render(<ProviderLoginPanel />)
        expect(screen.getByText(/Ein Projektadministrator kann hier/)).toBeInTheDocument()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
        expect(context.api.request).not.toHaveBeenCalled()
    })
    it('starts Codex provisioning/login and confirms connection only after native status refresh', async () => {
        let connected = false
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (options?.method === 'POST') return { operation: operation('codex') }
            if (path.endsWith('/login/operation-1')) { connected = true; return { operation: operation('codex', 'connected') } }
            return snapshot(connected ? 'codex' : undefined)
        })
        const client = new QueryClient()
        render(<QueryClientProvider client={client}><ProviderLoginPanel /></QueryClientProvider>)
        const connect = await screen.findByRole('button', { name: 'Mit Codex verbinden' })
        await waitFor(() => expect(connect).toBeEnabled())
        expect(card('Codex').getByText('Noch nicht verbunden')).toBeInTheDocument()
        fireEvent.click(connect)
        expect(await screen.findByRole('link', { name: /Bei ChatGPT anmelden/ })).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
        expect(screen.getByLabelText('Gerätecode')).toHaveTextContent('AAAA-BBBBB')
        expect(card('Codex').queryByText('Abo verbunden')).not.toBeInTheDocument()
        await waitFor(() => expect(card('Codex').getByText('Abo verbunden')).toBeInTheDocument(), { timeout: 3000 })
        expect(screen.queryByLabelText('Gerätecode')).not.toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/providers/codex/login', expect.objectContaining({ method: 'POST', body: {}, signal: expect.any(AbortSignal) }))
        expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain('AAAA-BBBBB')
        expect(JSON.stringify(localStorage)).not.toContain('AAAA-BBBBB')
    })
    it('sends the Claude code only on explicit submit and clears the input immediately', async () => {
        let submitted: Record<string, unknown> | undefined
        let connected = false
        context.api.request.mockImplementation(async (path: string, options: { method?: string; body?: Record<string, unknown> }) => {
            if (path.endsWith('/code')) { submitted = options.body; connected = true; return { operation: operation('claude', 'connected') } }
            if (options?.method === 'POST') return { operation: operation('claude') }
            return snapshot(connected ? 'claude' : undefined)
        })
        render(<ProviderLoginPanel />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Claude verbinden' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Mit Claude verbinden' }))
        const input = await screen.findByLabelText('Claude-Bestätigungscode')
        expect(screen.getByRole('link', { name: /Bei Claude anmelden/ })).toHaveAttribute('rel', 'noopener noreferrer')
        fireEvent.change(input, { target: { value: 'synthetic-code#state' } })
        expect(submitted).toBeUndefined()
        fireEvent.click(screen.getByRole('button', { name: 'Anmeldung bestätigen' }))
        expect(input).toHaveValue('')
        expect(await card('Claude').findByText('Abo verbunden')).toBeInTheDocument()
        expect(submitted).toEqual({ code: 'synthetic-code#state' })
        expect(screen.queryByLabelText('Claude-Bestätigungscode')).not.toBeInTheDocument()
    })
    it('cancels a pending login and removes its one-time challenge', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => options?.method === 'POST' ? { operation: operation('codex') } : snapshot())
        render(<ProviderLoginPanel />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Codex verbinden' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Mit Codex verbinden' }))
        await screen.findByLabelText('Gerätecode')
        fireEvent.click(card('Codex').getByRole('button', { name: 'Abbrechen' }))
        await waitFor(() => expect(screen.queryByLabelText('Gerätecode')).not.toBeInTheDocument())
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/providers/codex/login/operation-1', expect.objectContaining({ method: 'DELETE' }))
    })
    it.each(['poll', 'cancel'] as const)('clears a disappeared operation after %s and allows a new login', async action => {
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (options.method === 'POST') return { operation: operation('codex') }
            if (path.endsWith('/login/operation-1')) throw new EvolvedApiError('Operation not found', 404, 'operation_not_found')
            return snapshot()
        })
        render(<ProviderLoginPanel />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Codex verbinden' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Mit Codex verbinden' }))
        await screen.findByLabelText('Gerätecode')
        if (action === 'cancel') fireEvent.click(card('Codex').getByRole('button', { name: 'Abbrechen' }))
        await waitFor(() => expect(screen.queryByLabelText('Gerätecode')).not.toBeInTheDocument(), { timeout: 2500 })
        expect(card('Codex').getByText(/nicht mehr verfügbar/)).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Codex verbinden' })).toBeEnabled())
    })
    it('preserves an existing login until logout is explicitly confirmed', async () => {
        let connected = true
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => {
            if (options?.method === 'DELETE') connected = false
            return snapshot(connected ? 'codex' : undefined)
        })
        render(<ProviderLoginPanel />)
        await card('Codex').findByText('Abo verbunden')
        expect(card('Codex').queryByRole('button', { name: 'Mit Codex verbinden' })).not.toBeInTheDocument()
        fireEvent.click(card('Codex').getByRole('button', { name: 'Codex abmelden' }))
        expect(context.api.request.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false)
        fireEvent.click(card('Codex').getByRole('button', { name: 'Bestätigen' }))
        await card('Codex').findByText('Noch nicht verbunden')
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/providers/codex', expect.objectContaining({ method: 'DELETE' }))
    })
    it('discards an in-flight poll after cancellation even when the transport ignores abort', async () => {
        let finish!: (value: unknown) => void
        let pollSignal!: AbortSignal
        context.api.request.mockImplementation(async (path: string, options: { method?: string; signal: AbortSignal }) => {
            if (options.method === 'POST') return { operation: operation('codex') }
            if (path.endsWith('/login/operation-1') && options.method !== 'DELETE') { pollSignal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return snapshot()
        })
        render(<ProviderLoginPanel />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Codex verbinden' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Mit Codex verbinden' }))
        await waitFor(() => expect(finish).toBeDefined(), { timeout: 2500 })
        fireEvent.click(card('Codex').getByRole('button', { name: 'Abbrechen' }))
        await waitFor(() => expect(screen.queryByLabelText('Gerätecode')).not.toBeInTheDocument())
        expect(pollSignal.aborted).toBe(true)
        await act(async () => finish({ operation: operation('codex') }))
        expect(screen.queryByLabelText('Gerätecode')).not.toBeInTheDocument()
    })
    it('shows a rejected Claude code without reporting success or retaining the code', async () => {
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (path.endsWith('/code')) throw new Error('Bestätigungscode ungültig.')
            if (options?.method === 'POST' || path.endsWith('/login/operation-1')) return { operation: operation('claude') }
            return snapshot()
        })
        render(<ProviderLoginPanel />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Claude verbinden' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Mit Claude verbinden' }))
        const input = await screen.findByLabelText('Claude-Bestätigungscode')
        fireEvent.change(input, { target: { value: 'invalid#synthetic' } })
        fireEvent.click(screen.getByRole('button', { name: 'Anmeldung bestätigen' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Bestätigungscode ungültig.')
        expect(input).toHaveValue('')
        expect(screen.queryByText('Abo verbunden')).not.toBeInTheDocument()
    })
    it('does not label an API-key login as a connected subscription', async () => {
        context.api.request.mockResolvedValue(snapshot('codex', 'api-key'))
        render(<ProviderLoginPanel />)
        await card('Codex').findByText('API-Schlüssel eingerichtet')
        expect(screen.queryByText('Abo verbunden')).not.toBeInTheDocument()
        expect(card('Codex').queryByRole('button', { name: 'Mit Codex verbinden' })).not.toBeInTheDocument()
    })
    it.each(['project', 'user', 'role'] as const)('aborts and discards a late login challenge after changing %s', async change => {
        let finish!: (value: unknown) => void
        let signal: AbortSignal | undefined
        context.api.request.mockImplementation(async (_path: string, options: { method?: string; signal?: AbortSignal }) => {
            if (options?.method === 'POST') { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return snapshot()
        })
        const view = render(<ProviderLoginPanel />)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Codex verbinden' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Mit Codex verbinden' }))
        await waitFor(() => expect(signal).toBeDefined())
        if (change === 'project') context.project = { ...project(), id: 'project-2' }
        if (change === 'user') context.me.user.id = 'user-2'
        if (change === 'role') context.project!.role = 'viewer'
        view.rerender(<ProviderLoginPanel />)
        expect(signal?.aborted).toBe(true)
        await act(async () => { finish({ operation: operation('codex') }) })
        expect(screen.queryByLabelText('Gerätecode')).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /Bei ChatGPT anmelden/ })).not.toBeInTheDocument()
    })
    it('can retry an unavailable status without showing a guessed connection', async () => {
        context.api.request.mockRejectedValueOnce(new Error('Runner nicht erreichbar')).mockResolvedValue(snapshot())
        render(<ProviderLoginPanel />)
        await screen.findByRole('alert')
        expect(screen.getByRole('button', { name: 'Mit Codex verbinden' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Status erneut laden' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Mit Codex verbinden' })).toBeEnabled())
        expect(screen.queryByText('Abo verbunden')).not.toBeInTheDocument()
    })
    it('keeps the Runner page compact and links to browser provider login', () => {
        context.project!.role = 'viewer'
        const client = new QueryClient()
        render(<QueryClientProvider client={client}><RunnerPanel /></QueryClientProvider>)
        expect(screen.getByRole('link', { name: 'Abos verbinden' })).toHaveAttribute('href', '/evolved?tab=providers&project=project-1')
        expect(screen.getByText('Was bedeutet der Runner-Zugang?').closest('details')).not.toHaveAttribute('open')
        expect(context.api.request).not.toHaveBeenCalled()
    })
})

describe('Provider verification link boundaries', () => {
    it.each(['javascript:alert(1)', 'https://auth.openai.com.evil.example/codex/device', 'https://user@auth.openai.com/codex/device', 'https://auth.openai.com:444/codex/device', 'https://claude.com/cai/oauth/authorize'])('rejects unsafe or wrong-provider URL %s', value => {
        expect(providerVerificationUrl('codex', value)).toBeNull()
    })
    it('accepts only the official native provider endpoints', () => {
        expect(providerVerificationUrl('codex', 'https://auth.openai.com/codex/device')).toBe('https://auth.openai.com/codex/device')
        expect(providerVerificationUrl('claude', 'https://claude.com/cai/oauth/authorize?state=synthetic')).toBe('https://claude.com/cai/oauth/authorize?state=synthetic')
    })
})
