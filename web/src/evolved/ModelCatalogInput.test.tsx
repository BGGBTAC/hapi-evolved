import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogInput } from './ModelCatalogInput'
import type { ProviderModelsState } from './useProviderModels'

vi.mock('./auth', () => ({ useOptionalEvolved: () => null }))
const catalog = (): ProviderModelsState => ({ enabled: true, canRefresh: true, data: { provider: 'claude', status: 'ready', method: 'subscription', source: 'native-cli', catalogOrigin: 'native-reported', entitlementVerified: false, upstreamRefresh: 'unknown', stale: false, checkedAt: 1, expiresAt: Date.now() + 60_000, models: [{ id: 'opus-latest-synthetic', label: 'Native Opus', resolvedModel: 'claude-native-new' }] }, error: null, isLoading: false, refresh: vi.fn().mockResolvedValue(undefined) })

function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

describe('Native model selection', () => {
    it('shows optional native capacities and descriptions without claiming they are a session limit', () => {
        const state = catalog()
        state.data!.models[0] = { ...state.data!.models[0], description: 'Native model description', contextWindow: 1_000_000 }
        render(<ModelCatalogInput provider="claude" value="opus-latest-synthetic" onChange={vi.fn()} catalog={state} />)
        expect(screen.getByRole('option', { name: /1\.000\.000 Token/ })).toBeInTheDocument()
        expect(screen.getByText('Native model description')).toBeInTheDocument()
        expect(screen.getByText(/tatsächliche Kontextfenster meldet der laufende Agent/)).toBeInTheDocument()
    })
    it('uses native options without hardcoded model presets or account entitlement claims', () => {
        const state = catalog(), change = vi.fn()
        render(<ModelCatalogInput provider="claude" value="auto" onChange={change} catalog={state} />)
        expect(screen.getByRole('option', { name: 'Native Opus · claude-native-new' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Sonnet' })).not.toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent('Zugriff wird beim Start geprüft')
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'opus-latest-synthetic' } })
        expect(change).toHaveBeenCalledWith('opus-latest-synthetic')
        fireEvent.click(screen.getByRole('button', { name: 'Liste aktualisieren' }))
        expect(state.refresh).toHaveBeenCalledOnce()
    })
    it('preserves a currently selected unknown model and supports explicit manual IDs', () => {
        const change = vi.fn()
        render(<ModelCatalogInput provider="claude" value="new-native-id" onChange={change} catalog={catalog()} />)
        expect(screen.getByRole('combobox')).toHaveValue('new-native-id')
        fireEvent.click(screen.getByRole('button', { name: 'Eigene Modell-ID' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Eigene Modell-ID' }), { target: { value: 'provider-newer-model' } })
        fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
        expect(change).toHaveBeenCalledWith('provider-newer-model')
    })
    it('shows disconnected native status, never stale models, while default remains explicit', () => {
        const state = catalog(); state.data!.status = 'disconnected'
        render(<ModelCatalogInput provider="claude" value="auto" onChange={vi.fn()} catalog={state} />)
        expect(screen.getByRole('status')).toHaveTextContent('Anbieter noch nicht angemeldet')
        expect(screen.getAllByRole('option')).toHaveLength(1)
        expect(screen.getByRole('option')).toHaveTextContent('Standard des Anbieters')
    })
    it('distinguishes API-key authentication and blocks mutation when disabled', () => {
        const state = catalog(); state.data!.method = 'api-key'
        render(<ModelCatalogInput provider="claude" value="auto" onChange={vi.fn()} disabled catalog={state} />)
        expect(screen.getByText(/API-Schlüssel, kein Anbieterabo/)).toBeInTheDocument()
        expect(screen.getByRole('combobox')).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Eigene Modell-ID' })).toBeDisabled()
    })
    it('clears a manual draft when its provider changes', () => {
        const props = { value: 'auto', onChange: vi.fn(), catalog: catalog() }
        const view = render(<ModelCatalogInput provider="claude" {...props} />)
        fireEvent.click(screen.getByRole('button', { name: 'Eigene Modell-ID' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Eigene Modell-ID' }), { target: { value: 'claude-only-id' } })
        view.rerender(<ModelCatalogInput provider="codex" {...props} />)
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Eigene Modell-ID' }))
        expect(screen.getByRole('textbox', { name: 'Eigene Modell-ID' })).toHaveValue('')
    })
    it('shows native configuration rejection and keeps the existing selected model', async () => {
        const change = vi.fn().mockRejectedValue(new Error('Modell wird vom Runner nicht akzeptiert'))
        render(<ModelCatalogInput provider="claude" value="auto" onChange={change} catalog={catalog()} />)
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'opus-latest-synthetic' } })
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Modell wird vom Runner nicht akzeptiert'))
        expect(screen.getByRole('combobox')).toHaveValue('auto')
        expect(screen.getByRole('combobox')).toBeEnabled()
    })
    it('preserves a checked disconnected status alongside a refresh error', () => {
        const state = catalog(); state.data!.status = 'disconnected'; state.error = 'Bitte später aktualisieren'
        render(<ModelCatalogInput provider="claude" value="auto" onChange={vi.fn()} catalog={state} />)
        expect(screen.getByRole('status')).toHaveTextContent('Anbieter noch nicht angemeldet')
        expect(screen.getByRole('alert')).toHaveTextContent('Bitte später aktualisieren')
    })

    describe.each([
        ['project', { projectId: 'project-a' }, { projectId: 'project-b' }],
        ['provider', { provider: 'claude' as const }, { provider: 'codex' as const }],
    ])('a pending selection when the %s changes', (_, before, after) => {
        const base = { provider: 'claude' as const, projectId: 'project-a', value: 'auto', catalog: catalog() }
        function startOldSelection(newChange: (value: string) => void | Promise<void> = vi.fn()) {
            const old = deferred(), oldChange = vi.fn(() => old.promise)
            const view = render(<ModelCatalogInput {...base} {...before} onChange={oldChange} />)
            fireEvent.change(screen.getByRole('combobox'), { target: { value: 'opus-latest-synthetic' } })
            expect(oldChange).toHaveBeenCalledWith('opus-latest-synthetic')
            expect(screen.getByRole('combobox')).toBeDisabled()
            view.rerender(<ModelCatalogInput {...base} {...after} onChange={newChange} />)
            // The new context is usable immediately; it does not wait for the old request.
            expect(screen.getByRole('combobox')).toBeEnabled()
            fireEvent.click(screen.getByRole('button', { name: 'Eigene Modell-ID' }))
            fireEvent.change(screen.getByRole('textbox', { name: 'Eigene Modell-ID' }), { target: { value: 'new-context-draft' } })
            return { old, oldChange }
        }
        const settle = (old: ReturnType<typeof deferred>, outcome: 'resolve' | 'reject') => act(async () => {
            if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Alter Fehler aus dem vorherigen Kontext'))
            await old.promise.catch(() => {})
        })
        const expectNoOldError = () => {
            expect(screen.queryByRole('alert')).not.toBeInTheDocument()
            expect(screen.queryByText('Alter Fehler aus dem vorherigen Kontext')).not.toBeInTheDocument()
        }

        it.each(['resolve', 'reject'] as const)('an old %s neither closes the new manual draft nor shows an old error; the new context still selects its own model', async outcome => {
            const newChange = vi.fn()
            const { old, oldChange } = startOldSelection(newChange)
            await settle(old, outcome)
            expect(screen.getByRole('textbox', { name: 'Eigene Modell-ID' })).toHaveValue('new-context-draft')
            expect(screen.getByRole('button', { name: 'Eigene Modell-ID' })).toHaveAttribute('aria-expanded', 'true')
            expect(screen.getByRole('combobox')).toBeEnabled()
            expectNoOldError()
            fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
            expect(newChange).toHaveBeenCalledOnce()
            expect(newChange).toHaveBeenCalledWith('new-context-draft')
            expect(oldChange).toHaveBeenCalledOnce()
            // The new context's own completion still closes its manual input.
            await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Eigene Modell-ID' })).not.toBeInTheDocument())
            expect(screen.getByRole('combobox')).toBeEnabled()
            expectNoOldError()
        })

        it.each(['resolve', 'reject'] as const)('an old %s does not unlock or finish a pending selection of the new context', async outcome => {
            const current = deferred(), newChange = vi.fn(() => current.promise)
            const { old } = startOldSelection(newChange)
            fireEvent.change(screen.getByRole('combobox'), { target: { value: 'opus-latest-synthetic' } })
            expect(newChange).toHaveBeenCalledOnce()
            expect(screen.getByRole('combobox')).toBeDisabled()
            await settle(old, outcome)
            expect(screen.getByRole('combobox')).toBeDisabled()
            expect(screen.getByRole('textbox', { name: 'Eigene Modell-ID' })).toHaveValue('new-context-draft')
            expectNoOldError()
            // While the new request is pending, another choice is still rejected locally (no duplicate onChange).
            fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
            expect(newChange).toHaveBeenCalledOnce()
            await act(async () => { current.resolve(); await current.promise })
            expect(screen.getByRole('combobox')).toBeEnabled()
            expect(screen.queryByRole('textbox', { name: 'Eigene Modell-ID' })).not.toBeInTheDocument()
            expectNoOldError()
        })
    })
})
