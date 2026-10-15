import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSidechannel } from './Sidechannel'
const state = vi.hoisted(() => ({ request: vi.fn() }))
const context = { api: { request: state.request }, project: { id: 'project' } }
vi.mock('./auth', () => ({ useOptionalEvolved: () => context }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
function Panel({ sessionId = 'session' }: { sessionId?: string }) { const side = useSidechannel(sessionId); return <>{side.panel}<button onClick={() => side.intercept('/btw Explicit only')}>Intercept</button></> }
afterEach(() => { cleanup(); vi.clearAllMocks() })
const config = { enabled: true, provider: 'https://provider.test', model: 'explicit-model', remainingTokens: 500, maxInputChars: 1000, maxOutputTokens: 100 }
describe('isolated text sidechannel', () => {
    it('preserves an unavailable question without a session instead of sending or swallowing it', () => {
        render(<Panel sessionId="" />); fireEvent.click(screen.getByText('Intercept'))
        expect(screen.getByLabelText('Separate Frage')).toHaveValue('Explicit only')
        expect(screen.getByRole('status')).toHaveTextContent('nicht an den Agenten gesendet')
        expect(state.request).not.toHaveBeenCalled()
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        fireEvent.click(screen.getByRole('button', { name: '/btw' }))
        expect(screen.getByLabelText('Separate Frage')).toHaveValue('Explicit only')
    })
    it('intercepts without sending, sends one UUID request, and renders provider output only as text', async () => {
        state.request.mockImplementation(async (_path, options) => options?.method === 'POST' ? { reply: '[run](javascript:alert(1)) <img src=x>', model: 'explicit-model', usedTokens: 5, truncated: false } : config)
        render(<Panel />); await screen.findByRole('button', { name: '/btw' }); fireEvent.click(screen.getByText('Intercept'))
        expect(screen.getByLabelText('Separate Frage')).toHaveValue('Explicit only')
        expect(state.request.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
        fireEvent.click(screen.getByRole('button', { name: 'An Anbieter senden' }))
        const result = await screen.findByTestId('sidechannel-reply'); expect(result.querySelector('a,img')).toBeNull(); expect(result.textContent).toContain('javascript:')
        const post = state.request.mock.calls.find(call => call[1]?.method === 'POST')!
        expect(post[1].body).toMatchObject({ sessionId: 'session', text: 'Explicit only', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }); expect(post[2]).toBe(false)
    })
    it('does not retry ambiguous failures or retain a reply across session changes', async () => {
        state.request.mockImplementation(async (_path, options) => { if (options?.method === 'POST') throw new Error('indeterminate'); return config })
        const view = render(<Panel />); await screen.findByRole('button', { name: '/btw' }); fireEvent.click(screen.getByText('Intercept')); fireEvent.click(screen.getByRole('button', { name: 'An Anbieter senden' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('indeterminate'); expect(state.request.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
        view.rerender(<Panel sessionId="other" />); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
})
