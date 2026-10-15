import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getColorThemeOptions, registerPluginColorThemes } from '@/hooks/useColorTheme'
import type { EvolvedApi } from './api'
import { PluginThemeSync } from './PluginThemeSync'

const theme = { id: 'plugin:installation:mint', name: 'Mint', mode: 'light', colors: { background: '#ffffff', surface: '#f0f5f2', text: '#14221b', muted: '#485b50', accent: '#145c3c', accentText: '#ffffff', border: '#819c8b' } }
const visible = () => getColorThemeOptions().some(option => option.value === theme.id)
afterEach(() => registerPluginColorThemes([]))
describe('Plugin theme catalog ownership', () => {
    it('refreshes on shared catalog invalidation and clears on unmount', async () => {
        const request = vi.fn().mockResolvedValue({ themes: [theme] })
        const api = { baseUrl: '', request } as unknown as EvolvedApi
        const client = new QueryClient()
        const view = render(<QueryClientProvider client={client}><PluginThemeSync api={api} userId="owner" /></QueryClientProvider>)
        await waitFor(() => expect(visible()).toBe(true))
        request.mockResolvedValue({ themes: [] })
        await act(async () => { await client.invalidateQueries({ queryKey: ['evolved', 'agent-catalog'] }) })
        await waitFor(() => expect(visible()).toBe(false))
        view.unmount()
        expect(visible()).toBe(false)
    })
    it('aborts and ignores a previous account response', async () => {
        let resolveOld!: (value: unknown) => void
        let oldSignal!: AbortSignal
        const request = vi.fn().mockImplementationOnce((_path, { signal }) => { oldSignal = signal; return new Promise(resolve => { resolveOld = resolve }) }).mockResolvedValue({ themes: [] })
        const api = { baseUrl: '', request } as unknown as EvolvedApi
        const client = new QueryClient()
        const content = (userId: string) => <QueryClientProvider client={client}><PluginThemeSync key={userId} api={api} userId={userId} /></QueryClientProvider>
        const view = render(content('old'))
        await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
        view.rerender(content('new'))
        expect(oldSignal.aborted).toBe(true)
        await act(async () => resolveOld({ themes: [theme] }))
        expect(visible()).toBe(false)
    })
})
