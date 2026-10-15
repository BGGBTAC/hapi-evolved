import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvolvedProject } from './api'
import { ProjectsPanel } from './ProjectsTeam'
const context = vi.hoisted(() => ({ api: { request: vi.fn(), baseUrl: 'https://hub.example' }, me: { user: { id: 'user-1', isAdmin: false }, accessibleProjects: [] as EvolvedProject[] }, project: null as EvolvedProject | null, selectProject: vi.fn(), refresh: vi.fn() }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('./Capacity', () => ({ CapacityPanel: () => <p>Selected project capacity</p> }))
const projects: EvolvedProject[] = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((name, index) => ({ id: `project-${index}`, teamId: 'team-1', name, role: 'viewer', profile: 'restricted', rootPath: `/work/${name}` }))
function mount(onSelectProject?: (id: string) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><ProjectsPanel onSelectProject={onSelectProject} /></QueryClientProvider>)
    return { ...view, rerenderPanel: () => view.rerender(<QueryClientProvider client={client}><ProjectsPanel onSelectProject={onSelectProject} /></QueryClientProvider>) }
}
beforeEach(() => { context.me.user.id = 'user-1'; context.me.accessibleProjects = [...projects]; context.project = projects[0]; context.api.request.mockReset().mockResolvedValue({ teams: [] }); context.selectProject.mockReset() })
describe('project overview', () => {
    it('offers name search only when useful and restores the full list after an empty result', async () => {
        mount()
        await screen.findByLabelText('Projekte durchsuchen')
        fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'aLPHa' } })
        expect(screen.getByRole('button', { name: /Alpha Lesend/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Beta Lesend/ })).not.toBeInTheDocument()
        fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'does-not-exist' } })
        expect(screen.getByText(/Kein Projekt passt/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }))
        expect(screen.getByRole('button', { name: /Epsilon Lesend/ })).toBeInTheDocument()
        expect(screen.getByText('5 von 5 Projekten')).toBeInTheDocument()
    })
    it('keeps small project lists simple and preserves role restrictions', async () => {
        context.me.accessibleProjects = projects.slice(0, 2)
        mount()
        await screen.findByRole('heading', { name: 'Ausführungsprofil' })
        expect(screen.queryByLabelText('Projekte durchsuchen')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Eingeschränkt Schreib-/ })).toBeDisabled()
        expect(screen.getByText('Selected project capacity')).toBeInTheDocument()
    })
    it('delegates selection to URL-aware workspace navigation when provided', () => {
        const select = vi.fn()
        mount(select)
        fireEvent.click(screen.getByRole('button', { name: /Beta Lesend/ }))
        expect(select).toHaveBeenCalledWith('project-1')
        expect(context.selectProject).not.toHaveBeenCalled()
    })
    it('drops removed projects immediately and resets search across accounts', () => {
        const { rerenderPanel } = mount()
        fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'Alpha' } })
        context.me.accessibleProjects = projects.slice(1)
        rerenderPanel()
        expect(screen.queryByRole('button', { name: /Alpha Lesend/ })).not.toBeInTheDocument()
        expect(screen.queryByText('Selected project capacity')).not.toBeInTheDocument()
        context.me.user.id = 'another-user'; context.me.accessibleProjects = [...projects]
        rerenderPanel()
        expect(screen.getByLabelText('Projekte durchsuchen')).toHaveValue('')
    })
})
