import { I18nProvider } from '@/lib/i18n-context'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LongPasteChoice } from './LongPasteChoice'
import { isLongMessage, longMessagePreview, addLongTextAttachment } from '@/lib/longMessage'

afterEach(cleanup)
it('waits for the React client snapshot after a successful adapter upload', async () => {
    const file = new File(['original'], 'pasted.txt', { type: 'text/plain' }), remove = vi.fn()
    let reads = 0
    const composer = { addAttachment: vi.fn(async () => {}), getState: () => ({ attachments: ++reads === 1 ? [] : [
        { id: 'ready', file, attachmentId: 'stored-original', status: { type: 'requires-action' } }
    ] }), attachment: () => ({ remove }) }
    await expect(addLongTextAttachment(composer, file, () => true)).resolves.toBeUndefined()
    expect(remove).not.toHaveBeenCalled()
})
it('a resolved but incomplete upload preserves paste choice and only removes its own failed item', async () => {
    const file = new File(['original'], 'pasted.txt', { type: 'text/plain' }), remove = vi.fn()
    const composer = { addAttachment: vi.fn(async () => {}), getState: () => ({ attachments: [
        { id: 'unrelated', file: new File(['other'], 'other.txt'), status: { type: 'requires-action' } },
        { id: 'failed', file, status: { type: 'incomplete' } }
    ] }), attachment: (selector: { id: string }) => ({ remove: () => remove(selector.id) }) }
    await expect(addLongTextAttachment(composer, file, () => true)).rejects.toThrow('did not finish')
    expect(remove).toHaveBeenCalledExactlyOnceWith('failed')
    remove.mockClear()
    let current = true
    composer.addAttachment.mockImplementationOnce(async () => { current = false })
    await expect(addLongTextAttachment(composer, file, () => current)).rejects.toThrow('Composer changed')
    expect(remove).not.toHaveBeenCalled()
})
it('offers exact thresholds, explicit alternatives and lossless UTF-8 file preparation', async () => {
    expect(isLongMessage('x'.repeat(4000))).toBe(false)
    expect(isLongMessage('x'.repeat(4001))).toBe(true)
    expect(isLongMessage(Array(40).fill('x').join('\n'))).toBe(false)
    expect(isLongMessage(Array(41).fill('x').join('\n'))).toBe(true)
    const text = '\n  😀 original\r\n' + 'x'.repeat(4000), textChoice = vi.fn(), cancel = vi.fn()
    let file: File | undefined
    const upload = vi.fn(async (value: File) => { file = value })
    render(<I18nProvider><LongPasteChoice text={text} allowFile onText={textChoice} onFile={upload} onCancel={cancel} /></I18nProvider>)
    expect(upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send as .txt' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(file?.type).toBe('text/plain')
    const original = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(file!) })
    expect(original).toBe(text)
    expect(textChoice).not.toHaveBeenCalled()
})
it('retains choice on upload failure and permits explicit text fallback', async () => {
    const textChoice = vi.fn(), cancel = vi.fn()
    render(<I18nProvider><LongPasteChoice text={'x'.repeat(4001)} allowFile onText={textChoice} onFile={async () => { throw Error('failed') }} onCancel={cancel} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Send as .txt' }))
    await screen.findByRole('alert')
    expect(cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send as text' }))
    expect(textChoice).toHaveBeenCalledTimes(1)
})
it('disables file conversion for scheduled messages and bounds a giant single-line preview', () => {
    render(<I18nProvider><LongPasteChoice text={'x'.repeat(10000)} allowFile={false} onText={vi.fn()} onFile={vi.fn()} onCancel={vi.fn()} /></I18nProvider>)
    expect(screen.getByRole('button', { name: 'Send as .txt' })).toBeDisabled()
    expect(longMessagePreview('x'.repeat(10000))).toHaveLength(4000)
    expect(longMessagePreview(Array.from({ length: 50 }, (_, i) => String(i)).join('\n'))).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n9')
})
