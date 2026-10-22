import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryProposalFields } from './MemoryProposalFields'

function Controlled({ initial = '', disabled = false, readOnlyBody = false, onSelection }: { initial?: string; disabled?: boolean; readOnlyBody?: boolean; onSelection?: (start: number, end: number) => void }) {
    const [title, setTitle] = useState(initial), [body, setBody] = useState('Synthetischer Inhalt')
    return <MemoryProposalFields title={title} body={body} onTitle={setTitle} onBody={setBody} disabled={disabled} readOnlyBody={readOnlyBody} onSelection={onSelection} />
}
const title = () => screen.getByRole('textbox', { name: 'Titel' })

describe('MemoryProposalFields title hint', () => {
    it('describes the remaining space for an empty title without changing the accessible name or using a live region', () => {
        render(<Controlled />)
        const input = title()
        expect(input).toBeRequired()
        expect(input).toHaveAttribute('maxLength', '200')
        expect(input).toHaveAccessibleName('Titel')
        expect(input).toHaveAccessibleDescription('Noch 200 von 200 Zeichen frei')
        expect(screen.getByText('Noch 200 von 200 Zeichen frei')).toBeVisible()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(document.querySelector('[aria-live]')).toBeNull()
    })

    it('updates while typing and reports a full title at exactly 200 characters', () => {
        render(<Controlled />)
        fireEvent.change(title(), { target: { value: 'Synthetischer Titel' } })
        expect(title()).toHaveAccessibleDescription('Noch 181 von 200 Zeichen frei')
        fireEvent.change(title(), { target: { value: 'x'.repeat(200) } })
        expect(title()).toHaveValue('x'.repeat(200))
        expect(title()).toHaveAccessibleDescription('Höchstlänge von 200 Zeichen erreicht')
        expect(title()).toHaveAccessibleName('Titel')
    })

    it('counts UTF-16 code units like the native maxLength, so a surrogate pair uses two', () => {
        render(<Controlled initial={'😀'} />)
        expect('😀'.length).toBe(2)
        expect(title()).toHaveAccessibleDescription('Noch 198 von 200 Zeichen frei')
        render(<Controlled initial={`${'a'.repeat(198)}😀`} />)
        expect(screen.getAllByRole('textbox', { name: 'Titel' })[1]).toHaveAccessibleDescription('Höchstlänge von 200 Zeichen erreicht')
    })

    it('does not show negative remaining space for an over-long title supplied by the caller', () => {
        render(<Controlled initial={'y'.repeat(203)} />)
        expect(title()).toHaveAccessibleDescription('3 Zeichen über der Höchstlänge von 200')
    })

    it('keeps title and body disabled while the hint stays readable', () => {
        render(<Controlled initial="Synthetisch" disabled />)
        expect(title()).toBeDisabled()
        expect(screen.getByRole('textbox', { name: 'Erkenntnis' })).toBeDisabled()
        expect(title()).toHaveAccessibleDescription('Noch 189 von 200 Zeichen frei')
    })

    it('keeps the read-only message body and reports its selection', () => {
        const onSelection = vi.fn()
        render(<Controlled readOnlyBody onSelection={onSelection} />)
        const body = screen.getByRole('textbox', { name: 'Gespeicherter Nachrichtentext (nur lesen)' }) as HTMLTextAreaElement
        expect(body).toHaveAttribute('readonly')
        body.setSelectionRange(2, 7)
        fireEvent.select(body)
        expect(onSelection).toHaveBeenLastCalledWith(2, 7)
    })

    it('associates each hint with its own input when several forms are rendered', () => {
        render(<><div data-testid="first"><Controlled initial="abc" /></div><div data-testid="second"><Controlled initial="abcdef" /></div></>)
        const first = within(screen.getByTestId('first')).getByRole('textbox', { name: 'Titel' })
        const second = within(screen.getByTestId('second')).getByRole('textbox', { name: 'Titel' })
        expect(first.id).not.toBe(second.id)
        expect(first.getAttribute('aria-describedby')).not.toBe(second.getAttribute('aria-describedby'))
        expect(first).toHaveAccessibleDescription('Noch 197 von 200 Zeichen frei')
        expect(second).toHaveAccessibleDescription('Noch 194 von 200 Zeichen frei')
        fireEvent.change(first, { target: { value: '' } })
        expect(first).toHaveAccessibleDescription('Noch 200 von 200 Zeichen frei')
        expect(second).toHaveAccessibleDescription('Noch 194 von 200 Zeichen frei')
    })
})
