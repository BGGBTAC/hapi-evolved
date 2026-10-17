import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultPanel } from './Vault'
import type { AgentCredentialGrant, EvolvedProject } from './api'

const context = vi.hoisted(() => ({ api: { baseUrl: '', request: vi.fn() }, me: { user: { id: 'admin' } }, project: { id: 'project', name: 'Project', teamId: 'team', role: 'admin', profile: 'workspace' } as EvolvedProject }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
const secret = { id: 'secret-id', name: 'OdooAPIKey', version: 1, createdAt: 1, updatedAt: 1 }
const lease = { id: 'lease-id', name: 'Managed runner' }
const grant: AgentCredentialGrant = { id: 'grant-id', secretId: secret.id, leaseId: lease.id, envName: 'PROJECT_SECRET_ODOO_API_KEY', profile: 'workspace', secretVersion: 1, createdAt: 1 }
const clients: QueryClient[] = []
let grants: AgentCredentialGrant[], active: boolean
beforeEach(() => {
    grants = []; active = true; context.project.role = 'admin'; context.project.id = 'project'
    context.api.request.mockReset().mockImplementation(async (path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
        if (options?.method === 'POST' && path.endsWith('/secret-grants')) { grants = [grant]; return { grant } }
        if (options?.method === 'DELETE' && path.includes('/secret-grants/')) { grants = []; active = false; return { ok: true } }
        if (path.endsWith('/secret-grants')) return { grants, managedRunner: active ? lease : null }
        if (path.endsWith('/secrets')) return { secrets: [secret] }
        if (path.endsWith('/resources')) return { resources: [] }
        return { ok: true }
    })
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
    const tree = () => <QueryClientProvider client={client}><VaultPanel /></QueryClientProvider>
    return { ...render(tree()), tree }
}

describe('Vault agent credential grants', () => {
    it('clearly separates stored credentials from explicit process access and requires acknowledgement', async () => {
        mount()
        expect(await screen.findByText('Für Agenten nicht freigegeben')).toBeInTheDocument()
        expect(screen.getByText(/Speichern allein gibt sie noch nicht/)).toBeInTheDocument()
        const save = screen.getByRole('button', { name: 'Agentenzugriff freigeben' })
        expect(save).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Tresoreintrag für Agenten'), { target: { value: secret.id } })
        expect(screen.getByLabelText(/^Umgebungsvariable/)).toHaveValue('PROJECT_SECRET_ODOO_API_KEY')
        expect(save).toBeDisabled()
        fireEvent.click(screen.getByRole('checkbox', { name: /Ich erlaube allen neuen Agentensessions/ }))
        fireEvent.change(screen.getByLabelText(/^Umgebungsvariable/), { target: { value: 'NODE_OPTIONS' } })
        expect(save).toBeDisabled()
        fireEvent.change(screen.getByLabelText(/^Umgebungsvariable/), { target: { value: 'PROJECT_SECRET_ODOO_API_KEY' } })
        fireEvent.click(screen.getByRole('checkbox', { name: /Ich erlaube allen neuen Agentensessions/ }))
        fireEvent.click(save)
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project/secret-grants', { method: 'POST', body: { id: expect.any(String), secretId: secret.id, leaseId: lease.id, envName: 'PROJECT_SECRET_ODOO_API_KEY', acknowledgeProcessAccess: true } }))
        expect(await screen.findByText(/Freigabe gespeichert. Starte einen neuen Agentenprozess/)).toBeInTheDocument()
        expect(screen.getByText('Für neue Agentensessions freigegeben')).toBeInTheDocument()
    })
    it('requires confirmation before revoking and explains that sessions stop and disclosed values cannot be recalled', async () => {
        grants = [grant]; mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Freigabe widerrufen' }))
        expect(screen.getByText(/alle Sessions des zugehörigen Projektdienstes beenden/)).toBeInTheDocument()
        expect(context.api.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await waitFor(() => expect(context.api.request).toHaveBeenCalledWith('/projects/project/secret-grants/grant-id', { method: 'DELETE' }))
        expect(await screen.findByText(/Für eine neue Freigabe wird ein aktiver Projektdienst benötigt/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Agentenzugriff freigeben' })).toBeDisabled()
    })
    it('does not grant stored values automatically and hides management from viewers', async () => {
        context.project.role = 'viewer'; mount()
        expect(await screen.findByText('Für Agenten nicht freigegeben')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Agentenzugriff freigeben' })).not.toBeInTheDocument()
        expect(context.api.request.mock.calls.every(([, options]) => !options.method)).toBe(true)
    })
    it('shows inactive old runner grants without implying access on a replacement runner', async () => {
        grants = [{ ...grant, leaseId: 'old-lease' }]; mount()
        expect(await screen.findByText(/Inaktiv – der zugehörige Projektdienst/)).toBeInTheDocument()
        expect(screen.getByText('Für Agenten nicht freigegeben')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Rotieren' }))
        expect(screen.getByText(/Wenn dieser Wert für Agenten freigegeben ist/)).toBeInTheDocument()
    })
    it('refreshes revoked runner state after an uncertain grant write and does not retry automatically', async () => {
        const previous = context.api.request.getMockImplementation()!
        context.api.request.mockImplementation(async (path, options) => {
            if (options?.method === 'POST') { active = false; throw new Error('Speicherbestätigung fehlt') }
            return previous(path, options)
        })
        mount()
        await screen.findByText('Für Agenten nicht freigegeben')
        fireEvent.change(screen.getByLabelText('Tresoreintrag für Agenten'), { target: { value: secret.id } })
        fireEvent.click(screen.getByRole('checkbox', { name: /Ich erlaube allen neuen Agentensessions/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Agentenzugriff freigeben' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Speicherbestätigung fehlt')
        expect(screen.getByText(/Für eine neue Freigabe wird ein aktiver Projektdienst benötigt/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Agentenzugriff freigeben' })).toBeDisabled()
        expect(context.api.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    })
})
