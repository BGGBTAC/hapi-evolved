import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text, inline, preserveSingleLineBreaks }: { text: string; inline?: boolean; preserveSingleLineBreaks?: boolean }) => (
        <span
            data-testid="lazy-rainbow-text"
            data-inline={inline ? 'true' : 'false'}
            data-preserve-single-line-breaks={preserveSingleLineBreaks ? 'true' : 'false'}
        >
            {text}
        </span>
    )
}))

import { UserBubbleContent, extractLeadingDirectives, formatDirectiveLabel, getUserBubbleClassName } from '@/components/AssistantChat/messages/user-bubble'

describe('extractLeadingDirectives', () => {
    it('extracts leading skill and command directives', () => {
        expect(extractLeadingDirectives('$deep-interview /model keep going')).toEqual({
            directives: ['$deep-interview', '/model'],
            body: 'keep going'
        })
    })

    it('leaves ordinary text untouched', () => {
        expect(extractLeadingDirectives('plain message')).toEqual({
            directives: [],
            body: 'plain message'
        })
    })

    it('does not treat absolute paths as slash directives', () => {
        expect(extractLeadingDirectives('/Users/bytedance/project')).toEqual({
            directives: [],
            body: '/Users/bytedance/project'
        })
    })
})

describe('UserBubbleContent', () => {
    it('collapses long text to ten lines, then expands without changing the original', () => {
        const text = Array.from({ length: 50 }, (_, i) => `Unique line ${i}`).join('\n')
        const { container } = render(<UserBubbleContent text={text} />)
        expect(container.textContent).toContain('Unique line 9')
        expect(container.textContent).not.toContain('Unique line 49')
        fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
        expect(container.querySelector('[data-testid="lazy-rainbow-text"]')?.textContent).toBe(text)
        fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
        expect(container.textContent).not.toContain('Unique line 49')
    })
    it('renders directive chips inline with the remaining single-line message body', () => {
        render(<UserBubbleContent text="$ralplan polish the user bubble" />)

        expect(screen.getByText('ralplan')).toBeInTheDocument()
        expect(screen.getByText('polish the user bubble')).toBeInTheDocument()
        expect(screen.getByTitle('$ralplan')).toBeInTheDocument()
        expect(screen.getByTestId('lazy-rainbow-text')).toHaveAttribute('data-inline', 'true')
    })

    it('asks LazyRainbowText to preserve single newlines in sent prompt bodies', () => {
        const { container } = render(<UserBubbleContent text={'Line one\nLine two\nLine three'} />)
        const lazyText = container.querySelector('[data-testid="lazy-rainbow-text"]')

        expect(lazyText).toHaveAttribute('data-preserve-single-line-breaks', 'true')
    })

    it('preserves original directive casing in chip labels', () => {
        expect(formatDirectiveLabel('$DeEp-INTERVIEW')).toBe('DeEp INTERVIEW')
    })

    it('uses the shadowless queued bubble styling', () => {
        const className = getUserBubbleClassName('queued')
        expect(className).toContain('shadow-none')
        expect(className).toContain('opacity-60')
    })
})
