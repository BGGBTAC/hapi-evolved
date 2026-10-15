import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { splitToolImages, withToolImages } from './ToolResultImages'
import type { ToolViewProps } from './_all'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vXcAAAAASUVORK5CYII='
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('extracts nested MCP/Anthropic images without mutating original or losing adjacent text', () => {
    const result = { result: { content: [{ type: 'text', text: 'Explanation' }, { type: 'image', mimeType: 'image/png', data: png }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] } }
    const copy = JSON.stringify(result), split = splitToolImages(result)
    expect(split.images).toHaveLength(2)
    expect(JSON.stringify(split.textResult)).toContain('Explanation')
    expect(JSON.stringify(split.textResult)).not.toContain(png)
    expect(JSON.stringify(result)).toBe(copy)
})
it('does not fetch URLs or accept SVG, malformed base64 or unbounded embedded images', () => {
    const result = [{ type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' }, { type: 'image', source: { type: 'url', url: 'https://attacker.example/tracker' } },
        { type: 'image', mimeType: 'image/png', data: '<script>' }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(4 * 1024 * 1024 + 4) }]
    const split = splitToolImages(result)
    expect(split.images).toEqual([])
    expect(JSON.stringify(split.textResult)).not.toContain('attacker')
    expect(splitToolImages(Array.from({ length: 20 }, () => ({ type: 'image', mimeType: 'image/png', data: png }))).images).toHaveLength(6)
})
it('opens a portal lightbox with safe new-tab action and releases blob URLs on unmount', async () => {
    const revoke = vi.fn(), create = vi.fn(() => 'blob:synthetic-tool-image')
    const originalURL = URL
    class TestURL extends originalURL { static createObjectURL = create; static revokeObjectURL = revoke }
    vi.stubGlobal('URL', TestURL)
    const View = withToolImages(({ block }) => <p>{JSON.stringify(block.tool.result)}</p>)
    const { unmount, container } = render(<View {...{ block: { tool: { result: [{ type: 'image', mimeType: 'image/png', data: png }] } }, metadata: null } as ToolViewProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Tool result image 1/ }))
    const dialog = screen.getByRole('dialog', { name: 'Tool result image 1' })
    expect(container.contains(dialog)).toBe(false)
    expect(within(dialog).getByRole('link', { name: 'Open in new tab' })).toHaveAttribute('href', 'blob:synthetic-tool-image')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    unmount(); expect(revoke).toHaveBeenCalledWith('blob:synthetic-tool-image')
})
