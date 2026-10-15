import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { FileMarkdownPreview } from './FileMarkdownPreview'
import { I18nProvider } from '@/lib/i18n-context'
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate, Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('file Markdown resources', () => {
    it('reads local images with session authority, navigates relative links and revokes blobs', async () => {
        const readSessionFile = vi.fn().mockResolvedValue({ success: true, content: 'aW1hZ2U=', size: 5 })
        const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-image'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        const view = render(<I18nProvider><FileMarkdownPreview api={{ readSessionFile } as unknown as ApiClient} sessionId="source-session" filePath="docs/README.md" rootPath="/project" content={'![Local](images/a.png)\n\n[Sibling](next.md)\n\n[Escape](../../outside.md)'} /></I18nProvider>)
        expect(await screen.findByRole('img', { name: 'Local' })).toHaveAttribute('src', 'blob:local-image')
        expect(readSessionFile).toHaveBeenCalledWith('source-session', '/project/docs/images/a.png'); expect(create).toHaveBeenCalledOnce()
        fireEvent.click(screen.getByRole('link', { name: 'Sibling' })); expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { sessionId: 'source-session' } }))
        expect(screen.queryByRole('link', { name: 'Escape' })).toBeNull()
        view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:local-image')
    })
    it('loads HTTPS images directly only after explicit consent and blocks unsafe sources', async () => {
        const readSessionFile = vi.fn()
        render(<I18nProvider><FileMarkdownPreview api={{ readSessionFile } as unknown as ApiClient} sessionId="s" filePath="README.md" rootPath="/project" content={'![Remote](https://images.example/test.png)\n\n![Unsafe](file:///etc/passwd)'} /></I18nProvider>)
        expect(screen.queryByRole('img')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Externe HTTPS-Bilder laden' }))
        await waitFor(() => expect(screen.getByRole('img', { name: 'Remote' })).toHaveAttribute('src', 'https://images.example/test.png'))
        expect(screen.getByRole('img', { name: 'Remote' })).toHaveAttribute('referrerpolicy', 'no-referrer'); expect(readSessionFile).not.toHaveBeenCalled()
    })
})
