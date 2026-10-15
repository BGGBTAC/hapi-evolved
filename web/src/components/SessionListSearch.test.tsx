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
    it('keeps the calendar outside the field and clearing returns focus to the search input', () => {
        const onChange = vi.fn(), onExpandedChange = vi.fn()
        renderSearch({ value: 'project', onChange, onExpandedChange })
        const input = screen.getByRole('searchbox'), clear = screen.getByRole('button', { name: 'Clear search' })
        const calendar = screen.getByRole('button', { name: 'Filter sessions by last activity' })
        expect(input.parentElement).toContainElement(clear)
        expect(input.parentElement).not.toContainElement(calendar)
        expect(clear).toHaveClass('h-12', 'w-12')
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
