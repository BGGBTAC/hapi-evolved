import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionListSearch } from './SessionList'

function renderSearch(overrides: Partial<Parameters<typeof SessionListSearch>[0]> = {}) {
    return render(
        <I18nProvider>
            <SessionListSearch
                value=""
                onChange={vi.fn()}
                customStart=""
                customEnd=""
                sessionActivityDates={new Set()}
                onDateRangeChange={vi.fn()}
                expanded={true}
                onExpandedChange={vi.fn()}
                searchMode="metadata"
                onSearchModeChange={vi.fn()}
                {...overrides}
            />
        </I18nProvider>
    )
}

describe('SessionListSearch content scope', () => {
    // Upstream touch layout (tiann/hapi#2034): calendar sits inside the field,
    // immediately left of the furthest-right 48px clear end-cap.
    it('keeps the calendar left of the 48px clear end-cap and clearing returns focus to the search input', () => {
        const onChange = vi.fn(), onExpandedChange = vi.fn()
        renderSearch({ value: 'project', onChange, onExpandedChange })
        const input = screen.getByRole('searchbox'), clear = screen.getByRole('button', { name: 'Clear search' })
        const calendar = screen.getByRole('button', { name: 'Filter sessions by last activity' })
        expect(input.parentElement).toContainElement(clear)
        expect(input.parentElement).toContainElement(calendar)
        expect(input.parentElement?.lastElementChild).toBe(clear)
        expect(calendar.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(clear).toHaveClass('min-h-[48px]', 'min-w-[48px]')
        expect(calendar).toHaveClass('min-h-[48px]', 'min-w-[48px]')
        fireEvent.click(clear)
        expect(onChange).toHaveBeenCalledWith('')
        expect(input).toHaveFocus()
        expect(onExpandedChange).not.toHaveBeenCalledWith(false)
    })
    it('exposes an explicit content scope switch without changing the default scope', () => {
        const onSearchModeChange = vi.fn()
        renderSearch({ onSearchModeChange })

        expect(screen.getByRole('searchbox').getAttribute('placeholder')).toContain('title/path')
        const scopeButton = screen.getByRole('button', { name: 'Search scope' })
        expect(scopeButton).toHaveTextContent('Default')
        fireEvent.click(scopeButton)
        expect(screen.getByRole('button', { name: 'Default' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Content' }))
        expect(onSearchModeChange).toHaveBeenCalledWith('content')
    })

    it('uses the message-content placeholder after selecting content scope', () => {
        renderSearch({ searchMode: 'content' })

        expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('Search message content')
    })
})

describe('SessionListSearch merged touch layout', () => {
    it('keeps evolved scope and exclude controls inside the field alongside the upstream calendar end-cap', () => {
        const onExcludeMatchesChange = vi.fn()
        renderSearch({ value: 'project', excludeMatches: false, onExcludeMatchesChange })
        const input = screen.getByRole('searchbox')
        const field = input.parentElement!
        const scope = screen.getByRole('button', { name: 'Search scope' })
        const exclude = screen.getByRole('button', { name: 'Suchtreffer ausschließen' })
        const calendar = screen.getByTestId('session-list-search-date-embedded')
        const clear = screen.getByRole('button', { name: 'Clear search' })
        const order = [scope, exclude, input, calendar, clear]
        for (const node of order) expect(field).toContainElement(node)
        for (let index = 1; index < order.length; index++) {
            expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        }
        expect(exclude).toHaveAttribute('aria-pressed', 'false')
        fireEvent.click(exclude)
        expect(onExcludeMatchesChange).toHaveBeenCalledWith(true)
    })

    it('hides the exclude toggle in content scope but keeps the calendar left of clear', () => {
        renderSearch({ value: 'needle', searchMode: 'content', onExcludeMatchesChange: vi.fn() })
        expect(screen.queryByRole('button', { name: 'Suchtreffer ausschließen' })).toBeNull()
        const calendar = screen.getByTestId('session-list-search-date-embedded')
        const clear = screen.getByRole('button', { name: 'Clear search' })
        expect(calendar.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.getByRole('searchbox')).toHaveAttribute('aria-label', 'Search message content')
    })
})
