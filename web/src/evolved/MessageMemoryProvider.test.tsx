import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { EvolvedApiError } from './api'
import { MessageMemoryProvider, codePointSelection } from './MessageMemoryProvider'
import { useMessageMemoryAction } from './messageMemoryContext'

const request = vi.hoisted(() => vi.fn())
const context = vi.hoisted(() => ({
    api: { baseUrl: 'https://hub.example', request: vi.fn() }, me: { user: { id: 'human' } },
    project: { id: 'project-a', name: 'Project A', role: 'member', profile: 'workspace' },
}))
vi.mock('./auth', () => ({ useOptionalEvolved: () => ({ ...context, api: { ...context.api, request } }) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, search, ...props }: React.PropsWithChildren<{ to: string; search: Record<string, string> }>) => <a href={`${to}?${new URLSearchParams(search)}`} {...props}>{children}</a> }))

const hash = 'a'.repeat(64)
const source = { sessionId: 'session-a', messageId: 'source-a', body: 'Stored fact <script>not HTML</script>', sourceHash: hash, title: 'A fact' }
function Trigger({ ids }: { ids: string[] }) {
    const open = useMessageMemoryAction()
    return open ? <button onClick={() => open(ids)}>Propose</button> : <span>Unavailable</span>
}
function mount(ids = ['source-a']) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const tree = (sessionId = 'session-a') => <I18nProvider><QueryClientProvider client={client}><MessageMemoryProvider sessionId={sessionId}><Trigger ids={ids} /></MessageMemoryProvider></QueryClientProvider></I18nProvider>
    return { ...render(tree()), client, tree }
}
beforeEach(() => {
    request.mockReset()
    context.project = { id: 'project-a', name: 'Project A', role: 'member', profile: 'workspace' }
    context.me.user.id = 'human'
    request.mockImplementation(async (path: string) => path.includes('message-source') ? source : { item: { id: 'memory-a', projectId: 'project-a', status: 'proposed' } })
})

describe('verified message source proposal', () => {
    it('converts UTF-16 selection to codepoint offsets without splitting an emoji', () => {
        expect(codePointSelection('A😀BC', 1, 3)).toEqual({ start: 1, end: 2 })
        expect(codePointSelection('A😀BC', 2, 3)).toEqual({ start: 1, end: 2 })
    })
    it('sends an explicit original-text excerpt instead of a modified body', async () => {
        request.mockImplementation(async (path: string) => path.includes('message-source') ? { ...source, body: 'A😀BC' } : { item: { projectId: 'project-a', status: 'proposed' } })
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        const input = await screen.findByLabelText('Gespeicherter Nachrichtentext (nur lesen)') as HTMLTextAreaElement
        input.setSelectionRange(1, 3)
        fireEvent.select(input)
        fireEvent.click(screen.getByRole('button', { name: 'Markierten Ausschnitt übernehmen' }))
        expect(screen.getByLabelText('Ausgewählter Ausschnitt')).toHaveTextContent('😀')
        fireEvent.click(screen.getByRole('button', { name: 'Vorschlag speichern' }))
        await screen.findByText(/Vorschlag gespeichert/)
        const payload = request.mock.calls.find(([, options]) => options.method === 'POST')?.[1].body
        expect(payload.excerpt).toEqual({ start: 1, end: 2 })
        expect(payload).not.toHaveProperty('body')
    })
    it('loads the exact source and submits title/hash without editable body, HTML or attachments', async () => {
        const { container } = mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        const text = await screen.findByLabelText('Gespeicherter Nachrichtentext (nur lesen)')
        expect(text).toHaveValue(source.body)
        expect(text).toHaveAttribute('readonly')
        expect(container.querySelector('script')).toBeNull()
        fireEvent.change(screen.getByLabelText('Titel'), { target: { value: 'Edited title' } })
        fireEvent.click(screen.getByRole('button', { name: 'Vorschlag speichern' }))
        await screen.findByText(/Vorschlag gespeichert/)
        expect(request).toHaveBeenCalledWith('/projects/project-a/memory/from-message', expect.objectContaining({ method: 'POST', body: {
            sessionId: 'session-a', messageId: 'source-a', expectedSourceHash: hash, title: 'Edited title',
        } }))
        expect(screen.getByRole('link', { name: 'Im Projektgedächtnis ansehen' })).toHaveAttribute('href', '/evolved?tab=memory&project=project-a')
    })
    it('requires explicit selection from aggregated true source IDs, not a rendered card ID', async () => {
        mount(['source-a', 'source-b'])
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        expect(request).not.toHaveBeenCalled()
        request.mockResolvedValue({ ...source, messageId: 'source-b' })
        fireEvent.change(screen.getByLabelText(/Gespeicherte Nachricht/), { target: { value: 'source-b' } })
        await screen.findByLabelText('Titel')
        expect(request.mock.calls[0]?.[0]).toBe('/projects/project-a/memory/message-source?sessionId=session-a&messageId=source-b')
    })
    it('never offers a proposal to viewers', () => {
        context.project.role = 'viewer'
        mount()
        expect(screen.queryByRole('button', { name: 'Propose' })).not.toBeInTheDocument()
        expect(request).not.toHaveBeenCalled()
    })
    it('cancel only aborts a source read and never saves', async () => {
        request.mockImplementation((_path, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
        expect(request.mock.calls[0]?.[1].signal.aborted).toBe(true)
        expect(request.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false)
    })
    it.each(['project', 'account', 'role', 'profile', 'session'])('drops source data and aborts pending read on %s change', async change => {
        let resolve!: (value: unknown) => void
        request.mockImplementation(() => new Promise(done => { resolve = done }))
        const { rerender, tree } = mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        const signal = request.mock.calls[0]?.[1].signal as AbortSignal
        if (change === 'project') context.project = { ...context.project, id: 'project-b' }
        if (change === 'account') context.me.user.id = 'other-user'
        if (change === 'role') context.project.role = 'viewer'
        if (change === 'profile') context.project.profile = 'restricted'
        rerender(tree(change === 'session' ? 'session-b' : 'session-a'))
        expect(signal.aborted).toBe(true)
        await act(async () => resolve(source))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.queryByText(source.body)).not.toBeInTheDocument()
    })
    it.each([403, 404, 409, 413, 422])('shows source status %s as an error, without a usable old source', async status => {
        request.mockRejectedValue(new EvolvedApiError('Server rejected', status))
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        expect(await screen.findByRole('alert')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Vorschlag speichern' })).not.toBeInTheDocument()
    })
    it('clears the old source after a changed-source save and demands an explicit reload', async () => {
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        await screen.findByLabelText('Titel')
        request.mockRejectedValueOnce(new EvolvedApiError('Source changed', 409))
        fireEvent.click(screen.getByRole('button', { name: 'Vorschlag speichern' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('geändert')
        expect(screen.queryByLabelText('Titel')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Quelle erneut laden' })).toBeInTheDocument()
    })
    it('keeps an uncertain save immutable and repeats only the same title/hash', async () => {
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        await screen.findByLabelText('Titel')
        request.mockRejectedValueOnce(new TypeError('Network lost'))
        fireEvent.click(screen.getByRole('button', { name: 'Vorschlag speichern' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Speicherstatus ist unklar')
        expect(screen.getByLabelText('Titel')).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Denselben Vorschlag erneut senden' }))
        await screen.findByText(/Vorschlag gespeichert/)
        const posts = request.mock.calls.filter(([, options]) => options.method === 'POST')
        expect(posts[0]?.[1].body).toEqual(posts[1]?.[1].body)
    })
    it('rejects a mismatched source receipt before exposing or saving it', async () => {
        request.mockResolvedValue({ ...source, sessionId: 'other-session' })
        mount()
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
        await screen.findByRole('alert')
        expect(screen.queryByLabelText('Titel')).not.toBeInTheDocument()
    })
})

it('accepts an existing verified deduplicated receipt without retrying or changing its status', async () => {
    request.mockImplementation(async (path: string) => path.includes('message-source') ? source : { item: { projectId: 'project-a', status: 'verified' } })
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
    await screen.findByLabelText('Gespeicherter Nachrichtentext (nur lesen)')
    fireEvent.click(screen.getByRole('button', { name: 'Vorschlag speichern' }))
    expect(await screen.findByText(/bereits verifiziert im Projektgedächtnis vorhanden/)).toBeInTheDocument()
    expect(screen.queryByText(/Speicherstatus ist unklar/)).not.toBeInTheDocument()
    expect(request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
})

it('maps normalized CRLF textarea selection plus emoji back to original source codepoints', async () => {
    const original = 'First\r\n😀Second\r\nThird'
    expect(codePointSelection(original, 6, 8)).toEqual({ start: 7, end: 8 })
    request.mockImplementation(async (path: string) => path.includes('message-source') ? { ...source, body: original } : { item: { projectId: 'project-a', status: 'proposed' } })
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
    const input = await screen.findByLabelText('Gespeicherter Nachrichtentext (nur lesen)') as HTMLTextAreaElement
    expect(input.value).toBe('First\n😀Second\nThird')
    input.setSelectionRange(6, 8); fireEvent.select(input)
    fireEvent.click(screen.getByRole('button', { name: 'Markierten Ausschnitt übernehmen' }))
    expect(screen.getByLabelText('Ausgewählter Ausschnitt')).toHaveTextContent('😀')
    fireEvent.click(screen.getByRole('button', { name: 'Vorschlag speichern' }))
    await screen.findByText(/Vorschlag gespeichert/)
    expect(request.mock.calls.find(([, options]) => options.method === 'POST')?.[1].body.excerpt).toEqual({ start: 7, end: 8 })
})

it('explains and prevents an excerpt beyond 20000 codepoints while allowing the complete source', async () => {
    request.mockImplementation(async (path: string) => path.includes('message-source') ? { ...source, body: 'x'.repeat(20001) } : { item: { projectId: 'project-a', status: 'proposed' } })
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Propose' }))
    const input = await screen.findByLabelText('Gespeicherter Nachrichtentext (nur lesen)') as HTMLTextAreaElement
    input.setSelectionRange(0, 20001); fireEvent.select(input)
    expect(screen.getByText(/Ein Ausschnitt darf höchstens 20.000 Zeichen umfassen/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Markierten Ausschnitt übernehmen' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Vorschlag speichern' })).toBeEnabled()
})
