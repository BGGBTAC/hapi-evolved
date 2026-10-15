import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getRuntimeAgentConfigDescriptor } from '@hapi/protocol'
import { AgentConfigFieldControl } from './AgentConfigFieldControl'

afterEach(cleanup)
const field = getRuntimeAgentConfigDescriptor('codex').fields.find(field => field.id === 'permission')!
describe('runtime descriptor field control', () => {
    it('renders groups, keeps unknown current value visible, and does not offer unavailable options', () => {
        const { container } = render(<AgentConfigFieldControl field={field} label="Permission" value="future-mode" options={[
            { value: 'default', label: 'Workspace', group: 'Constrained' },
            { value: 'yolo', label: 'Full', group: 'Expanded', disabled: true },
        ]} onChange={vi.fn()} />)
        const select = screen.getByRole('combobox') as HTMLSelectElement
        expect(select.value).toBe('future-mode')
        expect(container.querySelectorAll('optgroup')).toHaveLength(2)
        expect(container.querySelector('option[value="yolo"]')?.hasAttribute('disabled')).toBe(true)
    })
    it('blocks unavailable controls with an explanation, and surfaces async mutation failures', async () => {
        const { rerender } = render(<AgentConfigFieldControl field={{ ...field, unavailableReason: 'Runtime capability unavailable' }} label="Permission" value="default" options={[{ value: 'default', label: 'Workspace' }]} onChange={vi.fn()} />)
        expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
        expect(screen.getByRole('status').textContent).toBe('Runtime capability unavailable')
        const change = vi.fn(async () => { throw Error('Project policy rejected update') })
        rerender(<AgentConfigFieldControl field={field} label="Permission" value="default" options={[{ value: 'default', label: 'Workspace' }, { value: 'read-only', label: 'Read only' }]} onChange={change} />)
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'read-only' } })
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Project policy rejected update'))
        expect(change).toHaveBeenCalledWith('read-only')
    })
})
