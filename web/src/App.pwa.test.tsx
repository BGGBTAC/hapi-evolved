import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const state = vi.hoisted(() => ({ mode: 'login', reload: vi.fn(), needRefresh: true }))
vi.mock('@/hooks/usePwaUpdate', () => ({ usePwaUpdate: () => ({ needRefresh: state.needRefresh, reload: state.reload }) }))
vi.mock('@/evolved/auth', () => ({
    useOptionalEvolved: () => null,
    EvolvedBoundary: ({ legacy, onboarding }: { legacy: ReactNode; onboarding: ReactNode }) => state.mode === 'legacy' ? legacy : state.mode === 'onboarding' ? onboarding : <main>{state.mode}</main>,
}))
vi.mock('@/evolved/Workspace', () => ({ default: () => <main>No project yet</main> }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: vi.fn() } }) }))
vi.mock('@/hooks/useAuthSource', () => ({ useAuthSource: () => ({ authSource: null, isLoading: true, setAccessToken: vi.fn() }) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ token: null, api: null, isLoading: false }) }))
vi.mock('@/hooks/useServerUrl', () => ({ useServerUrl: () => ({ baseUrl: '', serverUrl: '', setServerUrl: vi.fn(), clearServerUrl: vi.fn() }) }))
vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => vi.fn() }))
vi.mock('@/hooks/useSSE', () => ({ useSSE: () => ({ subscriptionId: null }) }))
vi.mock('@/hooks/usePushNotifications', () => ({ usePushNotifications: () => ({ isSupported: false }) }))
vi.mock('@/hooks/useViewportHeight', () => ({ useViewportHeight: () => {} }))
vi.mock('@tanstack/react-router', async importOriginal => ({
    ...await importOriginal<object>(),
    useLocation: () => '/', useMatchRoute: () => () => false, useRouter: () => ({}),
}))
function show() { return render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>) }
beforeEach(() => { state.mode = 'login'; state.needRefresh = true; state.reload.mockClear() })

describe('global PWA update surface', () => {
    it.each(['login', 'bootstrap', 'onboarding', 'boundary error', 'legacy'])('offers exactly one explicit update in %s', mode => {
        state.mode = mode; show()
        expect(screen.getAllByTestId('pwa-update-banner')).toHaveLength(1)
        expect(state.reload).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'pwa.update.reload' }))
        expect(state.reload).toHaveBeenCalledOnce()
    })
    it('does not block browser zoom in the legacy AppInner', () => {
        state.mode = 'legacy'; show()
        const events = [
            ...['gesturestart', 'gesturechange', 'gestureend'].map(type => new Event(type, { bubbles: true, cancelable: true })),
            new WheelEvent('wheel', { ctrlKey: true, bubbles: true, cancelable: true }),
            ...['+', '-', '=', '0'].flatMap(key => [
                new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }),
                new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }),
            ]),
        ]
        for (const event of events) { document.dispatchEvent(event); expect(event.defaultPrevented).toBe(false) }
    })
})
