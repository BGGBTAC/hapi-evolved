import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageVersionControl } from './ImageVersionControl'
import { imageVersionId, isImageVersionSwitching, setImageVersionSwitching, reconcileImageVersions } from '@/lib/imageUpload'
const mock = vi.hoisted(() => ({ composer: vi.fn() }))
vi.mock('@assistant-ui/react', () => ({ useAui: () => ({ composer: mock.composer }) }))
afterEach(() => { cleanup(); setImageVersionSwitching('upload-session', false) })
const original = new File(['original'], 'original.png', { type: 'image/png' }), compressed = new File(['small'], 'small.jpg', { type: 'image/jpeg' })
const preparation = { original, file: compressed, compressed: true, originalSelected: false }
describe('image version switching', () => {
    it('keeps an inconsistent pair scoped and unlocks after manual removal', async () => {
        let items = [{ id: 'old', status: { type: 'requires-action' } }]
        mock.composer.mockReturnValue({ getState: () => ({ attachments: items }), attachment: () => ({ remove: async () => { throw new Error('remove failed') } }), addAttachment: async (file: File) => { items.push({ id: imageVersionId(file)!, status: { type: 'requires-action' } }) } })
        render(<ImageVersionControl id="old" sessionId="upload-session" preparation={preparation} disabled={false} />)
        fireEvent.click(screen.getByRole('button', { name: 'Original senden' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Beide Bildversionen')
        expect(isImageVersionSwitching('upload-session')).toBe(true)
        expect(isImageVersionSwitching('other-session')).toBe(false)
        items = items.filter(item => item.id === 'old'); reconcileImageVersions('upload-session', items)
        expect(isImageVersionSwitching('upload-session')).toBe(false)
    })
    it('uses its exact reserved ID while an unrelated file is added concurrently', async () => {
        let items = [{ id: 'old', status: { type: 'requires-action' } }]
        let finish!: () => void
        const remove = vi.fn(async ({ id }: { id: string }) => { items = items.filter(item => item.id !== id) })
        mock.composer.mockReturnValue({ getState: () => ({ attachments: items }), attachment: ({ id }: { id: string }) => ({ remove: () => remove({ id }) }), addAttachment: (file: File) => new Promise<void>(resolve => {
            items.push({ id: 'unrelated', status: { type: 'incomplete' } })
            finish = () => { items.push({ id: imageVersionId(file)!, status: { type: 'requires-action' } }); resolve() }
        }) })
        render(<ImageVersionControl id="old" sessionId="upload-session" preparation={preparation} disabled={false} />)
        fireEvent.click(screen.getByRole('button', { name: 'Original senden' }))
        expect(isImageVersionSwitching('different-current-session')).toBe(false); expect(isImageVersionSwitching('upload-session')).toBe(true)
        finish()
        await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: 'old' }))
        expect(items.some(item => item.id === 'unrelated')).toBe(true); expect(items).toHaveLength(2); expect(isImageVersionSwitching()).toBe(false)
    })
    it('retains the old image and removes only a failed replacement', async () => {
        let items = [{ id: 'old', status: { type: 'requires-action' } }]
        mock.composer.mockReturnValue({ getState: () => ({ attachments: items }), attachment: ({ id }: { id: string }) => ({ remove: async () => { items = items.filter(item => item.id !== id) } }), addAttachment: async (file: File) => { items.push({ id: imageVersionId(file)!, status: { type: 'incomplete' } }) } })
        render(<ImageVersionControl id="old" sessionId="upload-session" preparation={preparation} disabled={false} />)
        fireEvent.click(screen.getByRole('button', { name: 'Original senden' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Bisheriger Anhang bleibt erhalten')
        expect(items).toEqual([{ id: 'old', status: { type: 'requires-action' } }]); expect(isImageVersionSwitching()).toBe(false)
    })
})
