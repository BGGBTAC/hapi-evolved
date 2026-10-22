import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmButton } from './ui'

function inForm(props: { disabled?: boolean } = {}) {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
    const onConfirm = vi.fn()
    render(<form onSubmit={onSubmit}><input name="unrelated" defaultValue="synthetic" /><ConfirmButton label="Eintrag löschen" detail="Wirklich löschen?" onConfirm={onConfirm} {...props} /></form>)
    return { onSubmit, onConfirm }
}

describe('ConfirmButton inside a form', () => {
    it('opens and cancels without submitting the parent form', () => {
        const { onSubmit, onConfirm } = inForm()
        const open = screen.getByRole('button', { name: 'Eintrag löschen' })
        expect(open).toHaveAttribute('type', 'button')
        fireEvent.click(open)
        expect(screen.getByText('Wirklich löschen?')).toBeVisible()
        const cancel = screen.getByRole('button', { name: 'Abbrechen' })
        expect(cancel).toHaveAttribute('type', 'button')
        expect(screen.getByRole('button', { name: 'Bestätigen' })).toHaveAttribute('type', 'button')
        fireEvent.click(cancel)
        expect(screen.getByRole('button', { name: 'Eintrag löschen' })).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Bestätigen' })).not.toBeInTheDocument()
        expect(onSubmit).not.toHaveBeenCalled()
        expect(onConfirm).not.toHaveBeenCalled()
    })

    it('calls onConfirm exactly once per confirmation and never submits', () => {
        const { onSubmit, onConfirm } = inForm()
        fireEvent.click(screen.getByRole('button', { name: 'Eintrag löschen' }))
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(onConfirm).toHaveBeenCalledTimes(1)
        // The confirmation closes; another deletion needs the two-stage flow again.
        expect(screen.queryByRole('button', { name: 'Bestätigen' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Eintrag löschen' }))
        expect(onConfirm).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(onConfirm).toHaveBeenCalledTimes(2)
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it('keeps the initial action disabled when disabled', () => {
        const { onSubmit, onConfirm } = inForm({ disabled: true })
        const open = screen.getByRole('button', { name: 'Eintrag löschen' })
        expect(open).toBeDisabled()
        fireEvent.click(open)
        expect(screen.queryByRole('button', { name: 'Bestätigen' })).not.toBeInTheDocument()
        expect(onConfirm).not.toHaveBeenCalled()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it('disables only confirmation when disabled during an open confirmation; cancelling stays available', () => {
        const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault()), onConfirm = vi.fn()
        const view = render(<form onSubmit={onSubmit}><ConfirmButton label="Eintrag löschen" detail="Wirklich löschen?" onConfirm={onConfirm} /></form>)
        fireEvent.click(screen.getByRole('button', { name: 'Eintrag löschen' }))
        view.rerender(<form onSubmit={onSubmit}><ConfirmButton label="Eintrag löschen" detail="Wirklich löschen?" onConfirm={onConfirm} disabled /></form>)
        expect(screen.getByRole('button', { name: 'Bestätigen' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        expect(onConfirm).not.toHaveBeenCalled()
        const cancel = screen.getByRole('button', { name: 'Abbrechen' })
        expect(cancel).toBeEnabled()
        fireEvent.click(cancel)
        expect(screen.getByRole('button', { name: 'Eintrag löschen' })).toBeDisabled()
        expect(onSubmit).not.toHaveBeenCalled()
    })
})
