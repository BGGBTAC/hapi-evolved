import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolvedApiError, type EvolvedProject, type McpCatalog, type McpConnection, type McpTool } from './api'
import { McpShopPanel } from './McpShop'

const context = vi.hoisted(() => ({ api: { baseUrl: '', request: vi.fn() }, me: { user: { id: 'user-1' } }, project: null as EvolvedProject | null }))
vi.mock('./auth', () => ({ useEvolved: () => context }))
vi.mock('./ProjectBrowser', () => ({ ProjectBrowserCard: () => null }))
const template: McpCatalog['templates'][number] = { id: 'context7', name: 'Context7', description: 'Aktuelle Bibliotheksdokumentation für deine Agenten.', endpoint: 'https://mcp.context7.com/mcp', docsUrl: 'https://context7.com/docs' }
const tool = (name = 'lookup', readOnly = false): McpTool => ({ name, description: 'Search documentation <img src="https://tracking.invalid/pixel">', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, fingerprint: `fingerprint-${name}`, readOnly })
const connection = (overrides: Partial<McpConnection> = {}): McpConnection => ({ id: 'connection-1', name: 'Docs server', kind: 'custom', endpoint: 'https://docs.example.com/mcp', version: 1, enabled: false, auth: { mode: 'none', configured: false }, status: { state: 'untested', checkedAt: null }, catalogRevision: null, tools: [], enabledTools: [], createdAt: 1000, updatedAt: 1000, ...overrides })
const catalog = (connections: McpConnection[] = [], canManage = true): McpCatalog => ({ templates: [template], connections, canManage })
const clients: QueryClient[] = []
const endpoint = '/projects/project-1/mcp'
function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
    const tree = () => <QueryClientProvider client={client}><McpShopPanel /></QueryClientProvider>
    return { ...render(tree()), tree }
}
beforeEach(() => {
    context.project = { id: 'project-1', teamId: 'team-1', name: 'Project One', role: 'admin', profile: 'restricted' }
    context.me.user.id = 'user-1'; context.api.baseUrl = ''; localStorage.clear(); sessionStorage.clear()
    context.api.request.mockReset().mockResolvedValue(catalog())
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

describe('Project MCP shop', () => {
    it('lists templates and metadata without probing external servers or executing tools', async () => {
        mount()
        await screen.findByRole('button', { name: 'Context7 einrichten' })
        expect(screen.getByRole('button', { name: 'Eigenen MCP verbinden' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Anbieterdokumentation ↗' })).toHaveAttribute('href', 'https://context7.com/docs')
        expect(context.api.request).toHaveBeenCalledTimes(1)
        expect(context.api.request).toHaveBeenCalledWith(endpoint, expect.objectContaining({ signal: expect.any(AbortSignal) }))
        expect(screen.getByText(/Einmal in „Project One“/)).toBeInTheDocument()
    })

    it('keeps existing connections compact and opens the catalog only on request', async () => {
        context.api.request.mockResolvedValue(catalog([connection()]))
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Weitere MCPs verbinden' }))
        expect(screen.getByRole('button', { name: 'Context7 einrichten' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Katalog schließen' }))
        expect(screen.queryByRole('button', { name: 'Context7 einrichten' })).not.toBeInTheDocument()
        expect(screen.getByRole('article', { name: 'Docs server' })).toBeInTheDocument()
    })

    it('creates Context7 disabled with an optional write-only key and does not auto-discover', async () => {
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string; body?: Record<string, unknown> }) => options?.method === 'POST' ? { connection: connection({ id: options.body!.id as string, kind: 'context7', name: 'Context7', endpoint: template.endpoint, auth: { mode: 'bearer', configured: true } }) } : catalog())
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Context7 einrichten' }))
        expect(screen.getByLabelText('HTTPS-Endpunkt')).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Authentifizierung'), { target: { value: 'bearer' } })
        fireEvent.change(screen.getByLabelText('Zugangsschlüssel'), { target: { value: 'synthetic-private-key' } })
        fireEvent.click(screen.getByRole('button', { name: 'Deaktiviert speichern' }))
        const card = await screen.findByRole('article', { name: 'Context7' })
        expect(within(card).getByText('Deaktiviert')).toBeInTheDocument()
        const posted = context.api.request.mock.calls.find(([, options]) => options.method === 'POST')?.[1].body
        expect(posted).toEqual({ id: expect.any(String), kind: 'context7', auth: { mode: 'bearer', token: 'synthetic-private-key' } })
        expect(posted.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(document.body.innerHTML).not.toContain('synthetic-private-key')
        expect(JSON.stringify(localStorage)).not.toContain('synthetic-private-key')
        expect(JSON.stringify(sessionStorage)).not.toContain('synthetic-private-key')
        expect(context.api.request.mock.calls.some(([path]) => /\/discover$|\/call$/.test(path))).toBe(false)
    })

    it('supports explicit custom HTTPS/X-header setup and rejects credential-bearing URLs locally', async () => {
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Eigenen MCP verbinden' }))
        fireEvent.change(screen.getByLabelText('Verbindungsname'), { target: { value: 'Custom' } })
        for (const value of ['http://public.example/mcp', 'https://user:password@public.example/mcp', 'https://public.example/mcp?token=private', 'https://public.example:8443/mcp']) {
            fireEvent.change(screen.getByLabelText('HTTPS-Endpunkt'), { target: { value } })
            expect(screen.getByRole('button', { name: 'Deaktiviert speichern' })).toBeDisabled()
        }
        fireEvent.change(screen.getByLabelText('HTTPS-Endpunkt'), { target: { value: 'https://public.example/mcp' } })
        fireEvent.change(screen.getByLabelText('Authentifizierung'), { target: { value: 'header' } })
        fireEvent.change(screen.getByLabelText('Headername'), { target: { value: 'Cookie' } })
        fireEvent.change(screen.getByLabelText('Zugangsschlüssel'), { target: { value: 'synthetic-key' } })
        expect(screen.getByRole('button', { name: 'Deaktiviert speichern' })).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Headername'), { target: { value: 'X-Docs-Key' } })
        expect(screen.getByRole('button', { name: 'Deaktiviert speichern' })).toBeEnabled()
    })

    it('discovers tools only on request and saves exact explicit grants and read-only classification', async () => {
        const discovered = connection({ version: 2, catalogRevision: 'catalog-2', tools: [tool('lookup'), tool('update')], status: { state: 'ready', checkedAt: 2000 } })
        context.api.request.mockImplementation(async (path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
            if (path.endsWith('/discover')) return { connection: discovered }
            if (options?.method === 'PUT') return { connection: { ...discovered, version: 3, enabled: true, enabledTools: ['lookup'], tools: [tool('lookup', true), tool('update')] } }
            return catalog([connection()])
        })
        const { container } = mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Verbindung prüfen & Werkzeuge laden' }))
        await screen.findByLabelText('Freigeben: lookup')
        expect(screen.getByLabelText('Freigeben: lookup')).not.toBeChecked()
        expect(screen.getByLabelText('Nur lesend: lookup')).not.toBeChecked()
        expect(screen.getByLabelText('Für Agenten dieses Projekts aktivieren')).toBeDisabled()
        fireEvent.click(screen.getByLabelText('Freigeben: lookup'))
        fireEvent.click(screen.getByLabelText('Nur lesend: lookup'))
        fireEvent.click(screen.getByLabelText('Für Agenten dieses Projekts aktivieren'))
        fireEvent.click(screen.getByRole('button', { name: 'Konfiguration speichern' }))
        await screen.findByText('Verbindung und Werkzeugfreigaben gespeichert.')
        expect(context.api.request).toHaveBeenCalledWith(`${endpoint}/connection-1/discover`, expect.objectContaining({ method: 'POST', body: { version: 1 } }))
        expect(context.api.request).toHaveBeenCalledWith(`${endpoint}/connection-1`, expect.objectContaining({ method: 'PUT', body: { version: 2, catalogRevision: 'catalog-2', name: 'Docs server', enabled: true, enabledTools: ['lookup'], readOnlyTools: ['lookup'] } }))
        expect(container.querySelector('img')).toBeNull()
        expect(context.api.request.mock.calls.some(([path]) => path.endsWith('/call'))).toBe(false)
    })

    it.each(['member', 'viewer'] as const)('shows metadata to a %s without configuration or discovery controls', async role => {
        context.project!.role = role
        context.api.request.mockResolvedValue(catalog([connection({ tools: [tool()] })], false))
        mount()
        await screen.findByRole('article', { name: 'Docs server' })
        for (const name of ['Context7 einrichten', 'Eigenen MCP verbinden', 'Verwalten', 'Verbindung prüfen & Werkzeuge laden']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
        expect(screen.getByText('1 Werkzeuge ansehen')).toBeInTheDocument()
        expect(screen.queryByLabelText('Zugangsschlüssel')).not.toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledTimes(1)
    })

    it('does not show empty or disconnected claims after a catalog fetch error', async () => {
        context.api.request.mockRejectedValue(new Error('remote-secret-leak'))
        mount()
        expect(await screen.findByRole('alert')).not.toHaveTextContent('remote-secret-leak')
        expect(screen.queryByText(/Noch keine MCP-Verbindung/)).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Eigenen MCP verbinden' })).not.toBeInTheDocument()
    })

    it('explains unsupported Hub proxies without exposing proxy configuration', async () => {
        context.api.request.mockResolvedValue(catalog([connection({ status: { state: 'unreachable', checkedAt: 1000, errorCode: 'mcp_proxy_unsupported' } })]))
        mount()
        expect(await screen.findByText('Der Hub verwendet einen HTTP-Proxy. Diese MCP-Anbindung benötigt eine direkte HTTPS-Verbindung; der Betreiber muss die Hub-Konfiguration prüfen.')).toBeInTheDocument()
        expect(screen.queryByText(/Der Server ist nicht erreichbar oder unterstützt/)).not.toBeInTheDocument()
        expect(document.body.innerHTML).not.toContain('mcp_proxy_unsupported')
        expect(context.api.request).toHaveBeenCalledTimes(1)
    })

    it('disables immediately during discovery and discards its late enabled response', async () => {
        const active = connection({ enabled: true, catalogRevision: 'catalog-1', enabledTools: ['lookup'], tools: [tool('lookup', true)], status: { state: 'ready', checkedAt: 1000 } })
        let finish!: (value: unknown) => void, signal!: AbortSignal
        context.api.request.mockImplementation((path: string, options?: { method?: string; signal?: AbortSignal }) => {
            if (path.endsWith('/discover')) { signal = options!.signal!; return new Promise(resolve => { finish = resolve }) }
            if (options?.method === 'PUT') return Promise.resolve({ connection: { ...active, version: 2, enabled: false } })
            return Promise.resolve(catalog([active]))
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Verbindung prüfen & Werkzeuge laden' }))
        await waitFor(() => expect(finish).toBeDefined())
        expect(screen.getByRole('button', { name: 'Jetzt deaktivieren' })).toBeEnabled()
        fireEvent.click(screen.getByRole('button', { name: 'Jetzt deaktivieren' }))
        await screen.findByText(/Deaktiviert. Neue Aufrufe sind gesperrt/)
        expect(signal.aborted).toBe(true)
        await act(async () => finish({ connection: { ...active, version: 2 } }))
        const card = screen.getByRole('article', { name: 'Docs server' })
        expect(within(card).getByText('Deaktiviert')).toBeInTheDocument()
        expect(within(card).queryByText('Aktiv', { exact: true })).not.toBeInTheDocument()
    })

    it('keeps a lost create immutable and reuses exactly the same ID and secret payload', async () => {
        const posts: unknown[] = []
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string; body?: CreationPayload }) => {
            if (options?.method === 'POST') {
                posts.push(options.body)
                if (posts.length === 1) throw new TypeError('Response lost with synthetic-private-key')
                return { connection: connection({ id: options.body!.id, kind: 'context7', name: 'Context7' }) }
            }
            return catalog()
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Context7 einrichten' }))
        fireEvent.change(screen.getByLabelText('Authentifizierung'), { target: { value: 'bearer' } })
        fireEvent.change(screen.getByLabelText('Zugangsschlüssel'), { target: { value: 'synthetic-private-key' } })
        fireEvent.click(screen.getByRole('button', { name: 'Deaktiviert speichern' }))
        await screen.findByText(/Die Speicherbestätigung fehlt/)
        expect(screen.getByLabelText('Zugangsschlüssel')).toHaveValue('')
        expect(screen.getByLabelText('Zugangsschlüssel')).toBeDisabled()
        expect(screen.getByRole('alert')).not.toHaveTextContent('synthetic-private-key')
        fireEvent.click(screen.getByRole('button', { name: 'Speicherstatus erneut prüfen' }))
        await screen.findByRole('article', { name: 'Context7' })
        expect(posts).toHaveLength(2)
        expect(posts[1]).toEqual(posts[0])
    })

    it('requires a new credential for rotation and sends no credentials with ordinary grant changes', async () => {
        const stored = connection({ auth: { mode: 'bearer', configured: true }, status: { state: 'ready', checkedAt: 1000 }, catalogRevision: 'catalog-1', tools: [tool()] })
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string }) => options?.method === 'PUT' ? { connection: { ...stored, version: 2, enabled: false, status: { state: 'untested', checkedAt: null }, tools: [], enabledTools: [] } } : catalog([stored]))
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Verwalten' }))
        fireEvent.click(screen.getByLabelText('Zugang ändern'))
        expect(screen.getByRole('button', { name: 'Konfiguration speichern' })).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Neuer Zugangsschlüssel'), { target: { value: 'synthetic-rotated-key' } })
        fireEvent.click(screen.getByRole('button', { name: 'Konfiguration speichern' }))
        await screen.findByText(/Zugang geändert. Die Verbindung ist deaktiviert/)
        expect(context.api.request.mock.calls.find(([, options]) => options.method === 'PUT')?.[1].body).toMatchObject({ enabled: false, enabledTools: [], readOnlyTools: [], auth: { mode: 'bearer', token: 'synthetic-rotated-key' } })
        expect(document.body.innerHTML).not.toContain('synthetic-rotated-key')
    })

    it('requires explicit deletion confirmation and does not accidentally submit the edit form', async () => {
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string }) => options?.method === 'DELETE' ? { ok: true } : catalog([connection()]))
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Verwalten' }))
        fireEvent.click(screen.getByRole('button', { name: 'Verbindung entfernen' }))
        expect(context.api.request.mock.calls.some(([, options]) => options.method)).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }))
        await screen.findByText(/Noch keine MCP-Verbindung eingerichtet/)
        expect(screen.getByRole('button', { name: 'Context7 einrichten' })).toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledWith(`${endpoint}/connection-1`, expect.objectContaining({ method: 'DELETE', body: { version: 1 } }))
        expect(context.api.request.mock.calls.some(([, options]) => options.method === 'PUT')).toBe(false)
    })

    it('reports CAS conflicts safely and loads the authoritative catalog before further edits', async () => {
        let rejected = false
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string }) => {
            if (options?.method === 'PUT') { rejected = true; throw new EvolvedApiError('secret-upstream-response', 409) }
            return catalog([connection({ version: rejected ? 2 : 1, name: rejected ? 'Updated elsewhere' : 'Docs server' })])
        })
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Verwalten' }))
        fireEvent.change(screen.getByLabelText('Verbindungsname'), { target: { value: 'Draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'Konfiguration speichern' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/inzwischen geändert/)
        expect(screen.getByRole('alert')).not.toHaveTextContent('secret-upstream-response')
        fireEvent.click(screen.getByRole('button', { name: 'Stand neu laden' }))
        await screen.findByRole('article', { name: 'Updated elsewhere' })
        expect(screen.getByLabelText('Verbindungsname')).toHaveValue('Updated elsewhere')
    })

    it('allows revoking the last grant by explicitly disabling the connection', async () => {
        const active = connection({ enabled: true, catalogRevision: 'catalog-1', enabledTools: ['lookup'], tools: [tool('lookup', true)], status: { state: 'ready', checkedAt: 1000 } })
        context.api.request.mockImplementation(async (_path: string, options?: { method?: string }) => options?.method === 'PUT' ? { connection: { ...active, version: 2, enabled: false, enabledTools: [] } } : catalog([active]))
        mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Verwalten' }))
        fireEvent.click(screen.getByLabelText('Freigeben: lookup'))
        expect(screen.getByLabelText('Für Agenten dieses Projekts aktivieren')).toBeEnabled()
        fireEvent.click(screen.getByLabelText('Für Agenten dieses Projekts aktivieren'))
        fireEvent.click(screen.getByRole('button', { name: 'Konfiguration speichern' }))
        await screen.findByText('Verbindung und Werkzeugfreigaben gespeichert.')
        expect(context.api.request.mock.calls.find(([, options]) => options.method === 'PUT')?.[1].body).toMatchObject({ enabled: false, enabledTools: [], readOnlyTools: [] })
    })

    it('loads history only on expansion and renders only bounded metadata', async () => {
        context.api.request.mockImplementation(async (path: string) => path.endsWith('/history') ? { calls: [
            { id: '1', toolName: 'lookup', startedAt: 1000, durationMs: 1250, status: 'success', errorCode: null, arguments: { secret: 'do-not-render-arguments' }, result: 'do-not-render-result' },
            { id: '2', toolName: '<img src=x onerror=alert(1)>', startedAt: 2000, durationMs: 200, status: 'failed', errorCode: 'do-not-render-raw-error' },
        ] } : catalog([connection()]))
        const { container } = mount()
        const summary = await screen.findByText('Letzte Aufrufe')
        expect(context.api.request).toHaveBeenCalledTimes(1)
        const details = summary.closest('details')!
        details.open = true; fireEvent(details, new Event('toggle'))
        expect(await screen.findByText('Erfolgreich · 1.3 s')).toBeInTheDocument()
        expect(context.api.request).toHaveBeenCalledWith(`${endpoint}/connection-1/history`, expect.objectContaining({ signal: expect.any(AbortSignal) }))
        for (const hidden of ['do-not-render-arguments', 'do-not-render-result', 'do-not-render-raw-error']) expect(document.body.innerHTML).not.toContain(hidden)
        expect(container.querySelector('img')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Verlauf aktualisieren' }))
        await waitFor(() => expect(context.api.request.mock.calls.filter(([path]) => path.endsWith('/history'))).toHaveLength(2))
        expect(screen.getByText(/ohne Einzelbestätigung verwenden/)).toBeInTheDocument()
    })

    it('marks uncertain remote outcomes without offering or triggering execution retries', async () => {
        context.api.request.mockImplementation(async (path: string) => path.endsWith('/history') ? { calls: [
            { id: 3, toolName: 'publish', startedAt: 1000, durationMs: 10000, status: 'unknown', errorCode: 'mcp_outcome_unknown' },
        ] } : catalog([connection()]))
        mount()
        const details = (await screen.findByText('Letzte Aufrufe')).closest('details')!
        details.open = true; fireEvent(details, new Event('toggle'))
        expect(await screen.findByText('Ergebnis unklar – nicht erneut ausführen · 10.0 s')).toBeInTheDocument()
        expect(within(details).getAllByRole('button')).toHaveLength(1)
        fireEvent.click(within(details).getByRole('button', { name: 'Verlauf aktualisieren' }))
        await waitFor(() => expect(context.api.request.mock.calls.filter(([path]) => path.endsWith('/history'))).toHaveLength(2))
        expect(context.api.request.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true)
        expect(context.api.request.mock.calls.some(([path]) => /\/(call|query)$/.test(path))).toBe(false)
    })

    it('aborts expanded history on project change and never renders the previous project result', async () => {
        let signal!: AbortSignal, finish!: (value: unknown) => void
        context.api.request.mockImplementation((path: string, options?: { signal?: AbortSignal }) => path.endsWith('/history') ? new Promise(resolve => { finish = resolve; signal = options!.signal! }) : Promise.resolve(catalog([connection()])))
        const { rerender, tree } = mount()
        const details = (await screen.findByText('Letzte Aufrufe')).closest('details')!
        details.open = true; fireEvent(details, new Event('toggle'))
        await waitFor(() => expect(finish).toBeDefined())
        context.project = { ...context.project!, id: 'project-2' }; rerender(tree())
        expect(signal.aborted).toBe(true)
        await act(async () => finish({ calls: [{ id: '1', toolName: 'previous-project-private-tool', startedAt: 1000, durationMs: 10, status: 'success', errorCode: null }] }))
        expect(screen.queryByText('previous-project-private-tool')).not.toBeInTheDocument()
        expect(context.api.request.mock.calls.filter(([path]) => path.endsWith('/history'))).toHaveLength(1)
    })

    it.each(['project', 'account', 'role', 'origin', 'profile'] as const)('aborts pending discovery and clears private drafts on %s change', async change => {
        let finish!: (value: unknown) => void, signal!: AbortSignal
        let changed = false
        context.api.request.mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
            if (path.endsWith('/discover')) { signal = options!.signal!; return new Promise(resolve => { finish = resolve }) }
            return Promise.resolve(catalog(changed ? [] : [connection()]))
        })
        const { rerender, tree } = mount()
        fireEvent.click(await screen.findByRole('button', { name: 'Verbindung prüfen & Werkzeuge laden' }))
        await waitFor(() => expect(finish).toBeDefined())
        changed = true
        if (change === 'project') context.project = { ...context.project!, id: 'project-2' }
        if (change === 'account') context.me.user.id = 'user-2'
        if (change === 'role') context.project = { ...context.project!, role: 'viewer' }
        if (change === 'origin') context.api.baseUrl = 'https://other.example'
        if (change === 'profile') context.project = { ...context.project!, profile: 'workspace' }
        rerender(tree())
        expect(signal.aborted).toBe(true)
        await act(async () => finish({ connection: connection({ name: 'Previous private server', version: 2, tools: [tool('private-tool')] }) }))
        expect(screen.queryByText('Previous private server')).not.toBeInTheDocument()
        expect(screen.queryByText('private-tool')).not.toBeInTheDocument()
    })
})
type CreationPayload = { id: string; auth: { token?: string } }
