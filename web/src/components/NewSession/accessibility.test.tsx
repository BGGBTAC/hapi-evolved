import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import { SessionTypeSelector } from './SessionTypeSelector'
import { AgentSelector } from './AgentSelector'
import { DirectorySection } from './DirectorySection'
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/AgentFlavorIcon', () => ({ AgentFlavorIcon: () => <svg><title>Decorative agent</title></svg> }))

describe('new session accessible form controls', () => {
    it('associates Machine and Model labels with unique controls across multiple instances', () => {
        render(<><MachineSelector machines={[]} machineId={null} isDisabled={false} onChange={vi.fn()} /><MachineSelector machines={[]} machineId={null} isDisabled={false} onChange={vi.fn()} /><ModelSelector agent="claude" model="default" isDisabled={false} onModelChange={vi.fn()} /></>)
        const machines = screen.getAllByRole('combobox', { name: 'newSession.machine' })
        expect(machines).toHaveLength(2)
        expect(machines[0].id).not.toBe(machines[1].id)
        expect(screen.getByRole('combobox', { name: 'newSession.model' })).toBeInTheDocument()
    })
    it('names the directory field independently of its placeholder', () => {
        render(<DirectorySection directory="" suggestions={[]} selectedIndex={0} isDisabled={false} recentPaths={[]} onDirectoryChange={vi.fn()} onDirectoryFocus={vi.fn()} onDirectoryBlur={vi.fn()} onDirectoryKeyDown={vi.fn()} onSuggestionSelect={vi.fn()} onPathClick={vi.fn()} />)
        expect(screen.getByRole('textbox', { name: 'newSession.directory' })).toBeInTheDocument()
    })
    it('makes the full worktree label selectable and preserves disabled controls and a named name field', () => {
        const change = vi.fn()
        const props = { sessionType: 'simple' as const, worktreeName: '', worktreeInputRef: createRef<HTMLInputElement>(), isDisabled: false, onSessionTypeChange: change, onWorktreeNameChange: vi.fn() }
        const view = render(<SessionTypeSelector {...props} />)
        fireEvent.click(screen.getByText('newSession.type.worktree.desc'))
        expect(change).toHaveBeenCalledWith('worktree')
        const radio = screen.getByRole('radio', { name: /newSession.type.worktree/ })
        expect(radio.closest('label')).toHaveClass('min-h-[44px]')
        view.rerender(<SessionTypeSelector {...props} sessionType="worktree" isDisabled />)
        expect(screen.getByRole('radio', { name: /newSession.type.worktree/ })).toBeDisabled()
        expect(screen.getByRole('textbox', { name: 'newSession.type.worktree.placeholder' })).toBeDisabled()
    })
    it('uses unique radio groups when two creation forms are rendered', () => {
        const props = { sessionType: 'simple' as const, worktreeName: '', worktreeInputRef: createRef<HTMLInputElement>(), isDisabled: false, onSessionTypeChange: vi.fn(), onWorktreeNameChange: vi.fn() }
        render(<><SessionTypeSelector {...props} /><SessionTypeSelector {...props} /></>)
        const radios = screen.getAllByRole('radio', { name: /newSession.type.simple/ }) as HTMLInputElement[]
        expect(radios[0].id).not.toBe(radios[1].id)
        expect(radios[0].name).not.toBe(radios[1].name)
    })
    it('keeps Agent labels at touch size and excludes decorative icons from the accessible name', () => {
        render(<AgentSelector agent="claude" agents={['claude', 'codex']} isDisabled={false} onAgentChange={vi.fn()} />)
        const claude = screen.getByRole('radio', { name: 'Claude' })
        expect(claude.closest('label')).toHaveClass('min-h-[44px]')
        expect(screen.queryByRole('radio', { name: /Decorative/ })).not.toBeInTheDocument()
    })
})
