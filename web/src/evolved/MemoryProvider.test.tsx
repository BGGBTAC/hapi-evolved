import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolvedApiError, type EvolvedProject } from './api'
import { MemoryProviderPanel, type MemoryProviderConfig, type MemoryProviderStatus } from './MemoryProvider'
import { MemoryPanel } from './Memory'

const context = vi.hoisted(() => ({ api: { baseUrl: '', request: vi.fn() }, me: { user: { id: 'user-1' } }, project: null as EvolvedProject | null }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
const config: MemoryProviderConfig = { provider: 'openai', model: 'gpt-4.1-mini', embeddingModel: 'text-embedding-3-small', embeddingDimensions: 1536, inputUsdPerMTok: '0.40', outputUsdPerMTok: '1.60', embeddingUsdPerMTok: '0.02', maxOutputTokens: 2048 }
const status = (configured = false): MemoryProviderStatus => ({ configured, version: configured ? 1 : 0, apiKeyConfigured: configured, source: configured ? 'project' : 'disabled', config: configured ? { ...config } : null, embeddingLocked: false, boundEmbeddingModel: configured ? config.embeddingModel : null, canManage: true })
const catalog = ['gpt-4.1-mini', 'text-embedding-3-small', 'future-model-from-provider']
const keyInput = () => screen.getByLabelText(/OpenAI-API-Key/)
const setKey = () => fireEvent.change(keyInput(), { target: { value: 'synthetic-test-key' } })

beforeEach(() => {
    context.project = { id: 'project-1', teamId: 'team-1', name: 'Project', role: 'admin', profile: 'restricted' }
    context.me.user.id = 'user-1'
    context.api.baseUrl = ''
    context.api.request.mockReset().mockResolvedValue(status())
    localStorage.clear(); sessionStorage.clear()
})

describe('Graph Memory browser configuration', () => {
    it('does not repeat a previous paid hybrid search when testing the provider connection', async () => {
        context.api.request.mockImplementation(async (path: string) => {
            if (path.endsWith('/provider/test')) return { ok: true, modelsVerified: true, inferenceTested: false }
            if (path.endsWith('/provider')) return status(true)
            if (path.startsWith('/memory/search?')) return { results: [], mode: 'hybrid', backendAvailable: true }
            return { items: [], settings: { enabled: true, cloudAllowed: true, monthlyBudgetMicros: 1_000_000, jobBudgetMicros: 100_000 }, budget: { spentMicros: 0, reservedMicros: 0, limitMicros: 1_000_000, period: '2026-10' }, backend: { available: true } }
        })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const view = render(<QueryClientProvider client={client}><MemoryPanel /></QueryClientProvider>)
        await screen.findByLabelText('OpenAI-API-Key')
        fireEvent.change(screen.getByLabelText('Suchart'), { target: { value: 'hybrid' } })
        fireEvent.change(screen.getByLabelText('Wissen durchsuchen'), { target: { value: 'synthetic query' } })
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
        await screen.findByText(/Suchmodus: hybrid/)
        const searches = () => context.api.request.mock.calls.filter(([path]) => path.startsWith('/memory/search?'))
        expect(searches()).toHaveLength(1)
        fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }))
        await screen.findByText(/API-Key akzeptiert/)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Verbindung testen' })).toBeEnabled())
        expect(searches()).toHaveLength(1)
        view.unmount(); client.clear()
    })

    it('explains the first-run setup without a server error and does not call an unscoped API', async () => {
        const view = render(<MemoryProviderPanel />)
        await screen.findByLabelText(/OpenAI-API-Key/)
        expect(screen.getByRole('button', { name: 'Einrichtung speichern' })).toBeDisabled()
        expect(screen.getByRole('link', { name: /API-Key bei OpenAI/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys')
        expect(screen.getByText(/Claude- und Codex-Anmeldung/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Cloud und Budget freigeben/ })).toHaveAttribute('href', '#memory-budget')
        context.project = null; view.rerender(<MemoryProviderPanel />)
        expect(screen.queryByLabelText(/OpenAI-API-Key/)).not.toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledTimes(1)
    })

    it('loads live models, fills verified price suggestions, saves an encrypted-key request and tests without inference', async () => {
        let saved = false
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (path.endsWith('/models')) return { models: catalog }
            if (path.endsWith('/test')) return { ok: true, modelsVerified: true, inferenceTested: false }
            if (options.method === 'PUT') saved = true
            return status(saved)
        })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText(/OpenAI-API-Key/); setKey()
        fireEvent.click(screen.getByRole('button', { name: 'Modelle vom Anbieter laden' }))
        await screen.findByText(/3 Modelle direkt/)
        expect(screen.getByLabelText('Sprachmodell')).toHaveValue('gpt-4.1-mini')
        expect(screen.getByLabelText('Embedding-Modell')).toHaveValue('text-embedding-3-small')
        expect(screen.getByLabelText('Sprachmodell: Eingabe')).toHaveValue(0.4)
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        expect(keyInput()).toHaveValue('')
        await screen.findByText(/Einrichtung verschlüsselt gespeichert/)
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/memory/provider', expect.objectContaining({ method: 'PUT', body: { ...config, version: 0, apiKey: 'synthetic-test-key' }, signal: expect.any(AbortSignal) }))
        expect(JSON.stringify(localStorage)).not.toContain('synthetic-test-key')
        expect(JSON.stringify(sessionStorage)).not.toContain('synthetic-test-key')
        expect(document.body.textContent).not.toContain('synthetic-test-key')
        fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }))
        await screen.findByText(/API-Key akzeptiert/)
        expect(screen.getByText(/Modellkompatibilität ist damit noch nicht getestet/)).toBeInTheDocument()
        expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/ingest') || path.endsWith('/search') || path.endsWith('/settings'))).toBe(false)
    })

    it('accepts new provider model IDs with explicit prices instead of a hardcoded model allowlist', async () => {
        context.api.request.mockImplementation(async (path: string) => path.endsWith('/models') ? { models: catalog } : status(true))
        render(<MemoryProviderPanel />)
        await screen.findByLabelText(/OpenAI-API-Key/)
        fireEvent.click(screen.getByRole('button', { name: 'Modelle vom Anbieter laden' }))
        await screen.findByText(/3 Modelle direkt/)
        fireEvent.change(screen.getByLabelText('Sprachmodell'), { target: { value: 'future-model-from-provider' } })
        expect(screen.getByLabelText('Sprachmodell: Eingabe')).toHaveValue(null)
        expect(screen.getByRole('button', { name: 'Einrichtung speichern' })).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Sprachmodell: Eingabe'), { target: { value: '1.25' } })
        fireEvent.change(screen.getByLabelText('Sprachmodell: Ausgabe'), { target: { value: '5' } })
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        await screen.findByText(/Einrichtung verschlüsselt gespeichert/)
        const body = context.api.request.mock.calls.find(([, options]) => options.method === 'PUT')?.[1].body
        expect(body).toMatchObject({ model: 'future-model-from-provider', inputUsdPerMTok: '1.25', outputUsdPerMTok: '5', version: 1 })
        expect(body).not.toHaveProperty('apiKey')
    })

    it.each(['member', 'viewer'] as const)('does not expose secret fields or mutation controls to a %s', async role => {
        context.project!.role = role
        context.api.request.mockResolvedValue({ ...status(true), canManage: false })
        render(<MemoryProviderPanel />)
        await screen.findByText(/Ein Projektadministrator kann hier/)
        expect(screen.queryByLabelText(/OpenAI-API-Key/)).not.toBeInTheDocument()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledTimes(role === 'viewer' ? 0 : 1)
    })

    it('explains the server-enforced embedding check and disconnects only after confirmation', async () => {
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (path.endsWith('/models')) return { models: catalog }
            return options.method === 'DELETE' ? { ...status(), version: 2 } : { ...status(true), embeddingLocked: true }
        })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText(/OpenAI-API-Key/)
        expect(screen.getByLabelText('Embedding-Modell')).toBeDisabled()
        expect(screen.getByText(/wenn der Graph nachweislich leer ist/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Verbindung entfernen' }))
        expect(context.api.request.mock.calls.some(([, options]) => ['PUT', 'DELETE'].includes(options.method))).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await screen.findByText(/Projektverbindung entfernt/)
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/memory/provider', expect.objectContaining({ method: 'DELETE', body: { version: 1 } }))
        expect(context.api.request.mock.calls.some(([, options]) => options.method === 'PUT')).toBe(false)
    })

    it('retains the bound embedding identity after removal so the project can reconnect with a new key', async () => {
        let connected = true
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (path.endsWith('/models')) return { models: catalog }
            if (options.method === 'DELETE') connected = false
            if (options.method === 'PUT') connected = true
            return { ...status(connected), version: connected ? 3 : 2, embeddingLocked: true, boundEmbeddingModel: config.embeddingModel }
        })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText(/OpenAI-API-Key/)
        fireEvent.click(screen.getByRole('button', { name: 'Verbindung entfernen' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await screen.findByText(/Projektverbindung entfernt/)
        expect(screen.getByLabelText('Embedding-Modell')).toHaveValue(config.embeddingModel)
        expect(screen.getByLabelText('Embedding-Modell')).toBeDisabled()
        setKey(); fireEvent.click(screen.getByRole('button', { name: 'Modelle vom Anbieter laden' }))
        await screen.findByText(/3 Modelle direkt/)
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        await screen.findByText(/Einrichtung verschlüsselt gespeichert/)
        expect(context.api.request.mock.calls.find(([, options]) => options.method === 'PUT')?.[1].body).toMatchObject({ version: 2, apiKey: 'synthetic-test-key', embeddingModel: config.embeddingModel })
    })

    it('allows selecting a first embedding model for legacy failed work while the server verifies the graph is empty', async () => {
        context.api.request.mockImplementation(async (path: string) => path.endsWith('/models') ? { models: catalog } : { ...status(), source: 'environment', embeddingLocked: true, boundEmbeddingModel: null })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText('OpenAI-API-Key'); setKey()
        fireEvent.click(screen.getByRole('button', { name: 'Modelle vom Anbieter laden' }))
        await screen.findByText(/3 Modelle direkt/)
        expect(screen.getByLabelText('Embedding-Modell')).toBeEnabled()
        expect(screen.getByLabelText('Embedding-Modell')).toHaveValue(config.embeddingModel)
        expect(screen.getByText(/frühere Verarbeitungsversuche bereits Graphdaten/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Einrichtung speichern' })).toBeEnabled()
    })

    it('permits an explicit embedding change to be checked by the server without bypassing a nonempty-graph rejection', async () => {
        context.api.request.mockImplementation(async (path: string, options: { method?: string }) => {
            if (path.endsWith('/models')) return { models: [...catalog, 'text-embedding-3-large'] }
            if (options.method === 'PUT') throw new EvolvedApiError('Graph not empty', 409, 'memory_embedding_locked')
            return { ...status(true), embeddingLocked: true }
        })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText('OpenAI-API-Key')
        fireEvent.click(screen.getByRole('button', { name: 'Modelle vom Anbieter laden' }))
        await screen.findByText(/4 Modelle direkt/)
        fireEvent.change(screen.getByLabelText('Embedding-Modell'), { target: { value: 'text-embedding-3-large' } })
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/keine Graphdaten geändert/)
        expect(context.api.request.mock.calls.find(([, options]) => options.method === 'PUT')?.[1].body).toMatchObject({ embeddingModel: 'text-embedding-3-large', embeddingUsdPerMTok: '0.13' })
    })

    it('opens required prices for reconnecting a custom embedding and keeps them open while editing', async () => {
        context.api.request.mockResolvedValue({ ...status(), embeddingLocked: true, boundEmbeddingModel: 'custom-embedding' })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText('OpenAI-API-Key')
        const details = screen.getByText('Preise und erweiterte Einstellungen').closest('details')!
        expect(details.open).toBe(true)
        for (const label of ['Sprachmodell: Eingabe', 'Sprachmodell: Ausgabe', 'Embeddings: Eingabe']) fireEvent.change(screen.getByLabelText(label), { target: { value: '0.2' } })
        expect(details.open).toBe(true)
    })

    it('allows explicitly blocking an inherited operator connection without possessing its key', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => options.method === 'DELETE' ? { ...status(), version: 1 } : { ...status(), source: 'environment' })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText('OpenAI-API-Key')
        fireEvent.click(screen.getByRole('button', { name: 'Betreiberzugang für dieses Projekt sperren' }))
        expect(context.api.request.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await screen.findByText(/Projektverbindung entfernt/)
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/memory/provider', expect.objectContaining({ method: 'DELETE', body: { version: 0 } }))
    })

    it.each(['project', 'user', 'role', 'origin'] as const)('discards secret-bearing state and a late model response after changing %s', async change => {
        let finish!: (value: unknown) => void
        let signal!: AbortSignal
        context.api.request.mockImplementation(async (path: string, options: { signal: AbortSignal }) => {
            if (path.endsWith('/models')) { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
            return status()
        })
        const view = render(<MemoryProviderPanel />)
        await screen.findByLabelText(/OpenAI-API-Key/); setKey()
        fireEvent.click(screen.getByRole('button', { name: 'Modelle vom Anbieter laden' }))
        await waitFor(() => expect(finish).toBeDefined())
        if (change === 'project') context.project = { ...context.project!, id: 'project-2' }
        if (change === 'user') context.me.user.id = 'user-2'
        if (change === 'role') context.project = { ...context.project!, role: 'member' }
        if (change === 'origin') context.api.baseUrl = 'https://another.example'
        view.rerender(<MemoryProviderPanel />)
        expect(signal.aborted).toBe(true)
        await act(async () => finish({ models: ['old-private-model'] }))
        expect(screen.queryByText(/old-private-model/)).not.toBeInTheDocument()
        expect(document.body.innerHTML).not.toContain('synthetic-test-key')
        if (change !== 'role') expect(await screen.findByLabelText(/OpenAI-API-Key/)).toHaveValue('')
    })

    it('never echoes a rejected credential from an upstream error and clears a submitted key on save failure', async () => {
        context.api.request.mockImplementation(async (_path: string, options: { method?: string }) => {
            if (options.method === 'PUT') throw new EvolvedApiError('synthetic-test-key rejected', 400, 'invalid_key')
            return status(true)
        })
        render(<MemoryProviderPanel />)
        await screen.findByLabelText(/OpenAI-API-Key/); setKey()
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        const error = await screen.findByRole('alert')
        expect(error).toHaveTextContent(/Prüfe den API-Key/)
        expect(error).not.toHaveTextContent('synthetic-test-key')
        expect(keyInput()).toHaveValue('')
        expect(screen.queryByText(/Einrichtung verschlüsselt gespeichert/)).not.toBeInTheDocument()
    })
})
