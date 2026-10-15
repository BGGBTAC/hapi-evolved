import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { ModelErrorBanner } from './ModelErrorBanner'
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
describe('persistent model error banner', () => {
    it('acknowledges the visible source error and retains a rejected acknowledgement', async () => {
        const ack = vi.fn(async () => { throw new Error('A newer failure exists') })
        const session = { id: 'source-session', metadata: { lastModelError: { kind: 'prompt_failed', message: 'Synthetic quota failure', at: 42 } } } as Session
        const view = render(<QueryClientProvider client={new QueryClient()}><ModelErrorBanner api={{ acknowledgeModelError: ack } as unknown as ApiClient} session={session} /></QueryClientProvider>)
        expect(screen.getByRole('alert').textContent).toContain('Synthetic quota failure')
        fireEvent.click(screen.getByRole('button'))
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('A newer failure exists'))
        expect(ack).toHaveBeenCalledWith('source-session', 42)
        view.rerender(<QueryClientProvider client={new QueryClient()}><ModelErrorBanner api={{ acknowledgeModelError: ack } as unknown as ApiClient} session={{ ...session, metadata: { ...session.metadata!, lastModelError: { ...session.metadata!.lastModelError!, acknowledgedAt: 100 } } }} /></QueryClientProvider>)
        expect(screen.queryByRole('alert')).toBeNull()
    })
})
