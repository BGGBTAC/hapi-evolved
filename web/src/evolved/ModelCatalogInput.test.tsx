import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogInput } from './ModelCatalogInput'
import type { ProviderModelsState } from './useProviderModels'

vi.mock('./auth', () => ({ useOptionalEvolved: () => null }))
const catalog = (): ProviderModelsState => ({ enabled: true, canRefresh: true, data: { provider: 'claude', status: 'ready', method: 'subscription', source: 'native-cli', catalogOrigin: 'native-reported', entitlementVerified: false, upstreamRefresh: 'unknown', stale: false, checkedAt: 1, expiresAt: Date.now() + 60_000, models: [{ id: 'opus-latest-synthetic', label: 'Native Opus', resolvedModel: 'claude-native-new' }] }, error: null, isLoading: false, refresh: vi.fn().mockResolvedValue(undefined) })

describe('Native model selection', () => {
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
})
