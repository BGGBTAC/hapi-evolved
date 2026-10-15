import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRole } from './api'
import { ProviderLoginPanel } from './ProviderLogin'
import { RunnerPanel } from './Runner'

const context = vi.hoisted(() => ({
    api: { baseUrl: '', request: vi.fn() },
    me: { user: { id: 'viewer-1', isAdmin: false } },
    project: { id: 'project-1', role: 'viewer' as ProjectRole, profile: 'restricted' },
}))
vi.mock('./auth', () => ({ useEvolved: () => context }))

beforeEach(() => {
    context.project.role = 'viewer'
    context.api.request.mockReset().mockResolvedValue({ leases: [] })
})

describe('Provider subscription onboarding', () => {
    it('explains native login without claiming a verified connection or collecting credentials', () => {
        const view = render(<ProviderLoginPanel />)
        expect(screen.getByRole('heading', { name: 'Abos verbinden' })).toBeInTheDocument()
        expect(screen.getByText(/Anmeldestatus hier nicht geprüft/)).toHaveAttribute('role', 'status')
        expect(screen.getByText(/Eine direkte Abo-Anmeldung in dieser Weboberfläche gibt es noch nicht/)).toBeInTheDocument()
        expect(view.container.querySelectorAll('input, textarea, form')).toHaveLength(0)
        expect(context.api.request).not.toHaveBeenCalled()
        expect(screen.getByText(/codex login --device-auth/)).toHaveTextContent('codex login status')
        expect(screen.getByText(/claude auth login --claudeai/)).toHaveTextContent('claude auth status --text')
    })

    it('points to official provider instructions and an unprivileged shell with explicit auth directories', () => {
        render(<ProviderLoginPanel />)
        expect(screen.getByRole('link', { name: 'Offizielle Codex-Anmeldehilfe' })).toHaveAttribute('href', 'https://learn.chatgpt.com/docs/auth#login-on-headless-devices')
        expect(screen.getByRole('link', { name: 'Offizielle Claude-Anmeldehilfe' })).toHaveAttribute('href', 'https://code.claude.com/docs/en/authentication')
        const command = screen.getByText(/docker compose --env-file/)
        expect(command).toHaveTextContent('--user "$RUNNER_UID:$RUNNER_GID"')
        expect(command).toHaveTextContent('-e HOME=/runner')
        expect(command).toHaveTextContent('-e CLAUDE_CONFIG_DIR=/runner/claude')
        expect(command).toHaveTextContent('-e CODEX_HOME=/runner/codex')
        expect(screen.getByText(/Ersetze den Dateipfad/)).toHaveTextContent('tatsächlichen Werte')
    })

    it.each(['viewer', 'member', 'admin'] as const)('keeps onboarding visible to %s without granting lease management', async role => {
        context.project.role = role
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><RunnerPanel /></QueryClientProvider>)
        expect(screen.getByRole('heading', { name: 'Abos verbinden' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Was macht ein Runner?' })).toBeInTheDocument()
        expect(screen.getByText(/Für deinen eigenen Runner ist ein dauerhafter Zugang/)).toHaveTextContent('kein Ablaufdatum')
        expect(screen.getByText(/Nach Ablauf eines befristeten Zugangs/)).toHaveTextContent('gespeicherte Anbieteranmeldungen bleiben erhalten')
        expect(screen.getByText(/Hier erstellst du nur diese Zugangsdaten/)).toBeInTheDocument()
        expect(screen.getByText(/Anmeldestatus hier nicht geprüft/)).toHaveAttribute('role', 'status')
        if (role === 'admin') {
            expect(await screen.findByText('Noch kein Runner-Zugang vorhanden.')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Runner-Zugang erstellen' })).toBeInTheDocument()
        } else {
            expect(screen.queryByRole('button', { name: 'Runner-Zugang erstellen' })).not.toBeInTheDocument()
            expect(context.api.request).not.toHaveBeenCalled()
        }
    })
})
