import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { PersonalPrompts } from './SavedPrompts'
import { EvolvedApi } from './api'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('personal prompt composer panel', () => {
    it('fetches account prompts on opening and inserts exact text without posting a chat message', async () => {
        const api = new EvolvedApi(''), request = vi.spyOn(api, 'request').mockResolvedValue({ prompts: [{ id: 'one', title: 'Review', text: 'Line one\n$literal' }] })
        const insert = vi.fn(), open = vi.fn()
        render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PersonalPrompts api={api} userId="user" onOpen={open} onInsert={insert} /></QueryClientProvider>)
        expect(request).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Persönliche Prompts' }))
        expect(open).toHaveBeenCalledOnce()
        fireEvent.click(await screen.findByRole('button', { name: 'Einfügen' }))
        expect(insert).toHaveBeenCalledWith('Line one\n$literal')
        expect(request).toHaveBeenCalledTimes(1)
        expect(request.mock.calls[0][0]).toBe('/saved-prompts')
    })
    it('preserves multiline prompt text in creation and displays server errors', async () => {
        const api = new EvolvedApi(''), request = vi.spyOn(api, 'request').mockImplementation(async (_path, options) => {
            if (options?.method === 'POST') throw new Error('Prompt limit reached')
            return { prompts: [] }
        })
        render(<QueryClientProvider client={new QueryClient()}><PersonalPrompts api={api} userId="other" onOpen={() => {}} onInsert={() => {}} /></QueryClientProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Persönliche Prompts' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Neu' }))
        fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  exact\n\ntext  ' } })
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Prompt limit reached')
        await waitFor(() => expect(request).toHaveBeenCalledWith('/saved-prompts', { method: 'POST', body: { title: '', text: '  exact\n\ntext  ' } }))
        expect(screen.getByLabelText('Prompt')).toHaveValue('  exact\n\ntext  ')
    })
})
