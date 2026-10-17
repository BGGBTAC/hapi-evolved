import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolvedBoundary } from './auth'
import { MemoryPanel } from './Memory'
import type { MemoryProviderConfig, MemoryProviderStatus } from './MemoryProvider'
import type { MemoryResponse, MemorySettings } from './api'
import { authenticatePasskey } from './webauthn'

vi.mock('@/hooks/useServerUrl', () => ({ useServerUrl: () => ({ baseUrl: 'https://hub.test' }) }))
vi.mock('./webauthn', () => ({ authenticatePasskey: vi.fn(), createPasskey: vi.fn() }))
const llmKey = 'SYNTHETIC-memory-save-llm-key', embeddingKey = 'SYNTHETIC-memory-save-embedding-key'
const config: MemoryProviderConfig = { schemaVersion: 2,
    llm: { provider: 'anthropic', model: 'synthetic-claude', inputUsdPerMTok: '1', outputUsdPerMTok: '2', maxOutputTokens: 2048 },
    embedding: { provider: 'voyage', model: 'synthetic-voyage', dimensions: 1024, inputUsdPerMTok: '0.1' }, reranker: { provider: 'rrf' } }
const user = { id: 'user-1', displayName: 'Memory test user', isAdmin: true }
const project = { id: 'project-1', teamId: 'team-1', name: 'Project', role: 'admin', profile: 'restricted' }
const principal = { user, teams: [], accessibleProjects: [project] }
const clients: QueryClient[] = []
beforeEach(() => { vi.mocked(authenticatePasskey).mockReset().mockResolvedValue({ id: 'synthetic-passkey' } as Awaited<ReturnType<typeof authenticatePasskey>>) })
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

function fixture() {
    const calls: Array<{ path: string; method: string; body: Record<string, unknown> | undefined }> = []
    let settings: MemorySettings = { enabled: false, cloudAllowed: false, monthlyBudgetMicros: 0, jobBudgetMicros: 0 }
    let stored: MemoryProviderConfig | null = null, version = 0, memoryReads = 0, providerReads = 0, tokenIssues = 0, fresh = true, saveFails = false, tokenFails = false
    const status = (): MemoryProviderStatus => ({ configured: !!stored, version, apiKeyConfigured: !!stored,
        keyConfigured: { llm: !!stored, embedding: !!stored, reranker: false }, source: stored ? 'project' : 'disabled', config: stored,
        embeddingLocked: false, boundEmbeddingProvider: stored?.embedding.provider ?? null,
        boundEmbeddingModel: stored?.embedding.model ?? null, boundEmbeddingDimensions: stored?.embedding.dimensions ?? null, canManage: true })
    const memory = (): MemoryResponse => ({ items: [], archivedImports: 0, settings: { ...settings }, budget: { period: '2026-10', spentMicros: 0,
        reservedMicros: 0, limitMicros: settings.monthlyBudgetMicros }, backend: { available: false } })
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url).pathname
        const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
        calls.push({ path, method, body })
        if (path === '/health') return Response.json({ evolved: { enabled: true } })
        if (path === '/api/evolved/auth/status') return Response.json({ initialized: true, authenticated: true })
        if (path === '/api/evolved/me') return Response.json(principal)
        if (path === '/api/evolved/session-token') { tokenIssues++; return tokenFails ? Response.json({ error: 'Temporary renewal failure' }, { status: 503 }) : Response.json({ token: `synthetic-token-${tokenIssues}` }) }
        if (path === '/api/evolved/agent-catalog') return Response.json({ themes: [] })
        if (path === '/api/evolved/auth/login/options') return Response.json({ challengeId: 'synthetic-challenge', options: {} })
        if (path === '/api/evolved/auth/login/verify') { fresh = true; return Response.json({ principal }) }
        if (path === '/api/evolved/projects/project-1/memory/settings') {
            settings = body as MemorySettings
            return Response.json({ settings, budget: memory().budget })
        }
        if (path === '/api/evolved/projects/project-1/memory') { memoryReads++; return Response.json(memory()) }
        if (path === '/api/evolved/projects/project-1/memory/provider') {
            if (method === 'GET') { providerReads++; return Response.json(status()) }
            if (method === 'PUT') {
                if (!fresh) return Response.json({ code: 'step_up_required', error: 'Fresh passkey needed' }, { status: 403 })
                if (saveFails) return Response.json({ code: 'memory_service_unavailable', error: 'Synthetic unavailable service' }, { status: 503 })
                stored = structuredClone(config); version++; return Response.json(status())
            }
        }
        throw new Error(`Unexpected synthetic endpoint: ${method} ${path}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const mounted = vi.fn(), unmounted = vi.fn()
    function MemoryWorkspace() {
        useEffect(() => { mounted(); return () => { unmounted() } }, [])
        return <MemoryPanel />
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
    render(<QueryClientProvider client={client}><EvolvedBoundary legacy={null} onboarding={null} authenticated={() => <MemoryWorkspace />} /></QueryClientProvider>)
    return { calls, mounted, unmounted, reads: () => ({ memoryReads, providerReads, tokenIssues }),
        ageSession: () => { fresh = false }, failSave: (value: boolean) => { saveFails = value }, failRenewal: (value: boolean) => { tokenFails = value } }
}

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
async function enterProviderDraft() {
    await screen.findByLabelText('Sprachmodell: API-Key')
    change('Sprachmodell: API-Key', llmKey); change('Embeddings: API-Key', embeddingKey)
    change('Sprachmodell: Modell', config.llm.model); change('Embeddings: Modell', config.embedding.model)
    change('Sprachmodell: Eingabe', config.llm.inputUsdPerMTok); change('Sprachmodell: Ausgabe', config.llm.outputUsdPerMTok)
    change('Embeddings: Eingabe', config.embedding.inputUsdPerMTok)
}
function expectDraft() {
    expect(screen.getByLabelText('Sprachmodell: API-Key')).toHaveValue(llmKey)
    expect(screen.getByLabelText('Embeddings: API-Key')).toHaveValue(embeddingKey)
    expect(screen.getByLabelText('Sprachmodell: Modell')).toHaveValue(config.llm.model)
    expect(screen.getByLabelText('Embeddings: Modell')).toHaveValue(config.embedding.model)
    expect(screen.getByLabelText('Sprachmodell: Eingabe')).toHaveValue(Number(config.llm.inputUsdPerMTok))
    expect(screen.getByLabelText('Embeddings: Eingabe')).toHaveValue(Number(config.embedding.inputUsdPerMTok))
}

describe('Memory save through the real authentication boundary', () => {
    it('preserves an unsaved provider draft when saving only cloud and budget settings', async () => {
        const f = fixture(); await enterProviderDraft()
        const reads = f.reads()
        change('Monatslimit (USD)', '3'); change('Limit je Auftrag (USD)', '0.5')
        fireEvent.click(screen.getByRole('button', { name: 'Cloud und Budget speichern' }))
        await screen.findByText('Cloud-Freigabe und Budget gespeichert.')
        expectDraft()
        const mutations = f.calls.filter(call => call.method !== 'GET')
        expect(mutations).toEqual([{ path: '/api/evolved/projects/project-1/memory/settings', method: 'PATCH',
            body: { enabled: false, cloudAllowed: false, monthlyBudgetMicros: 3_000_000, jobBudgetMicros: 500_000 } }])
        expect(JSON.stringify(mutations)).not.toContain(llmKey); expect(JSON.stringify(mutations)).not.toContain(embeddingKey)
        expect(f.reads().memoryReads).toBeGreaterThan(reads.memoryReads)
        expect(f.reads().providerReads).toBe(reads.providerReads)
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
        expect(authenticatePasskey).not.toHaveBeenCalled()
    })

    it('preserves the draft through passkey confirmation, token renewal and a failed provider save, then clears keys after retry succeeds', async () => {
        const f = fixture(); await enterProviderDraft(); f.ageSession(); f.failSave(true); f.failRenewal(true)
        let confirm!: () => void
        vi.mocked(authenticatePasskey).mockImplementationOnce(() => new Promise(resolve => { confirm = () => resolve({ id: 'synthetic-passkey' } as Awaited<ReturnType<typeof authenticatePasskey>>) }))
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        await waitFor(() => expect(authenticatePasskey).toHaveBeenCalledTimes(1))
        expectDraft()
        await act(async () => confirm())
        expect(await screen.findByRole('alert')).toHaveTextContent(/gerade nicht erreichbar/)
        expectDraft()
        expect(f.reads().tokenIssues).toBe(2)
        expect(screen.getByText(/Die Verbindung konnte gerade nicht erneuert werden/)).toBeInTheDocument()
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
        expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(2)
        f.failSave(false)
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        await screen.findByText(/Einrichtung verschlüsselt gespeichert/)
        expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(3)
        for (const request of f.calls.filter(call => call.method === 'PUT')) expect(request.body).toMatchObject({ schemaVersion: 2, version: 0,
            llm: { ...config.llm, apiKey: llmKey }, embedding: { ...config.embedding, apiKey: embeddingKey } })
        expect(screen.getByLabelText('Sprachmodell: API-Key')).toHaveValue('')
        expect(screen.getByLabelText('Embeddings: API-Key')).toHaveValue('')
        expect(screen.getByLabelText('Sprachmodell: Modell')).toHaveValue(config.llm.model)
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
    })

    it('keeps unsaved provider credentials when the passkey prompt is canceled and does not retry the mutation', async () => {
        const f = fixture(); await enterProviderDraft(); f.ageSession()
        vi.mocked(authenticatePasskey).mockRejectedValueOnce(new DOMException('Canceled', 'NotAllowedError'))
        fireEvent.click(screen.getByRole('button', { name: 'Einrichtung speichern' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/Einrichtung konnte nicht/)
        expectDraft()
        expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
        expect(f.calls.some(call => call.path.endsWith('/auth/login/verify'))).toBe(false)
        expect(f.mounted).toHaveBeenCalledTimes(1); expect(f.unmounted).not.toHaveBeenCalled()
        expect(JSON.stringify(localStorage)).not.toContain(llmKey); expect(JSON.stringify(sessionStorage)).not.toContain(embeddingKey)
    })
})
