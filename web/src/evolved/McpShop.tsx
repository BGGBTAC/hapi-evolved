import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { EvolvedApiError, isProjectAdmin, projectPath, type McpAuth, type McpCallHistory, type McpCatalog, type McpConnection } from './api'
import { ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit } from './ui'
import { ProjectBrowserCard } from './ProjectBrowser'
import './mcp-shop.css'

type Credential = { mode: McpAuth['mode']; headerName?: string; token?: string }
type Creation = { id: string; kind: McpConnection['kind']; name?: string; endpoint?: string; auth: Credential }
const states: Record<McpConnection['status']['state'], string> = {
    untested: 'Noch nicht geprüft', ready: 'Verbindung geprüft', auth_required: 'Zugang erforderlich',
    unreachable: 'Nicht erreichbar', catalog_changed: 'Werkzeuge geändert',
}
function safeError(error: unknown): Error {
    if (error instanceof EvolvedApiError) {
        if (error.status === 409) return new Error('Die Verbindung oder ihre Werkzeuge wurden inzwischen geändert. Lade den aktuellen Stand und prüfe deine Freigaben erneut.')
        if (error.status === 401 || error.status === 403) return new Error('Die Berechtigung fehlt oder ist abgelaufen. Melde dich erneut an oder bestätige die Änderung mit deinem Passkey.')
        if (error.status === 429) return new Error('Zu viele Anfragen. Bitte warte kurz und versuche es erneut.')
        if (error.status === 400 || error.status === 422) return new Error('Die Angaben konnten nicht übernommen werden. Prüfe HTTPS-Adresse, Authentifizierung und Werkzeugfreigaben.')
    }
    // Remote error bodies can contain submitted credentials or untrusted instructions.
    return new Error('Die Anfrage konnte nicht bestätigt werden. Lade den aktuellen Stand, bevor du Änderungen erneut sendest.')
}
function endpointValid(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.search && !url.hash
    } catch { return false }
}
function useRequests() {
    const current = useRef<AbortController | null>(null)
    const alive = useRef(true)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<Error | null>(null)
    const [notice, setNotice] = useState('')
    useEffect(() => { alive.current = true; return () => { alive.current = false; current.current?.abort() } }, [])
    const run = async (name: string, operation: (signal: AbortSignal) => Promise<void>, interrupt = false) => {
        if (current.current && !interrupt) return
        if (interrupt) current.current?.abort()
        const controller = new AbortController(); current.current = controller
        setBusy(name); setError(null); setNotice('')
        try { await operation(controller.signal) }
        catch (cause) { if (alive.current && !controller.signal.aborted) setError(safeError(cause)) }
        finally {
            if (alive.current && current.current === controller) { current.current = null; setBusy(null) }
        }
    }
    return { run, busy, error, notice, setNotice }
}
function AuthFields({ kind, mode, setMode, header, setHeader, token, setToken, disabled, stored = false }: {
    kind: McpConnection['kind']; mode: McpAuth['mode']; setMode: (mode: McpAuth['mode']) => void
    header: string; setHeader: (value: string) => void; token: string; setToken: (value: string) => void; disabled: boolean; stored?: boolean
}) {
    return <>
        <Field label="Authentifizierung"><select aria-label="Authentifizierung" value={mode} disabled={disabled} onChange={event => { setMode(event.target.value as McpAuth['mode']); setToken('') }}><option value="none">Ohne Zugangsschlüssel</option><option value="bearer">Bearer-Token / API-Key</option>{kind === 'custom' && <option value="header">API-Key in X-Header</option>}</select></Field>
        {mode === 'header' && <Field label="Headername" hint="Nur X-Header, beispielsweise X-API-Key."><input aria-label="Headername" required pattern="[Xx]-[A-Za-z0-9-]+" maxLength={100} value={header} disabled={disabled} onChange={event => setHeader(event.target.value)} /></Field>}
        {mode !== 'none' && <Field label={stored ? 'Neuer Zugangsschlüssel' : 'Zugangsschlüssel'} hint="Wird verschlüsselt gespeichert und nicht an Agenten ausgegeben. Der Wert wird nach dem Absenden aus dem Eingabefeld entfernt."><input aria-label={stored ? 'Neuer Zugangsschlüssel' : 'Zugangsschlüssel'} type="password" required autoComplete="new-password" spellCheck={false} maxLength={4096} value={token} disabled={disabled} onChange={event => setToken(event.target.value)} /></Field>}
    </>
}

export function McpShopPanel() {
    const { api, me, project } = useEvolved()
    if (!project) return null
    return <ProjectMcpShop key={JSON.stringify([api.baseUrl, me.user.id, project.id, project.role, project.profile])} />
}
function ProjectMcpShop() {
    const { api, me, project } = useEvolved()
    const client = useQueryClient()
    const path = `${projectPath(project!.id)}/mcp`
    const key = ['evolved', 'mcp', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile]
    const catalog = useQuery({ queryKey: key, queryFn: ({ signal }) => api.request<McpCatalog>(path, { signal }), retry: false, gcTime: 0 })
    const [adding, setAdding] = useState<McpConnection['kind'] | null>(null)
    const [showCatalog, setShowCatalog] = useState(false)
    const catalogOpen = !catalog.data?.connections.length || showCatalog
    const canManage = isProjectAdmin(project!.role) && catalog.data?.canManage === true && !catalog.error
    const accept = (connection: McpConnection) => client.setQueryData<McpCatalog>(key, value => {
        if (!value) return value
        const previous = value.connections.find(item => item.id === connection.id)
        if (previous && previous.version > connection.version) return value
        return { ...value, connections: previous ? value.connections.map(item => item.id === connection.id ? connection : item) : [...value.connections, connection] }
    })
    const reload = async () => {
        const result = await catalog.refetch()
        if (result.error || !result.data) throw result.error ?? new Error('Missing catalog')
        return result.data
    }
    const template = catalog.data?.templates.find(item => item.id === 'context7')
    return <div className="ev-stack ev-mcp-shop">
        <Panel title="Werkzeuge für dein Projekt" description={`Einmal in „${project!.name}“ einrichten und gezielt für die Agenten dieses Projekts freigeben.`}>
            {catalogOpen && <p className="ev-muted">Neue Verbindungen starten deaktiviert. Prüfe die Verbindung, wähle Werkzeuge aus und aktiviere sie. Der jeweilige Anbieter erhält die Eingaben deiner Werkzeugaufrufe.</p>}
            <ErrorNotice error={catalog.error ? safeError(catalog.error) : null} />
            {catalog.isPending ? <Loading /> : catalog.error ? <button onClick={() => void catalog.refetch()}>Stand neu laden</button> : <>
                {!!catalog.data?.connections.length && <button aria-expanded={catalogOpen} onClick={() => { setShowCatalog(!catalogOpen); setAdding(null) }}>{catalogOpen ? 'Katalog schließen' : 'Weitere MCPs verbinden'}</button>}
                {catalogOpen && <div className="ev-mcp-catalog">
                    {template && <article className="ev-mcp-template"><div><span className="ev-badge">Mitgeliefert</span><h3>{template.name}</h3><p>{template.description}</p><small>Dokumentation für Bibliotheken · Remote-MCP</small></div><div className="ev-actions">{canManage && <button onClick={() => setAdding('context7')}>Context7 einrichten</button>}{template.docsUrl.startsWith('https://') && <a href={template.docsUrl} target="_blank" rel="noopener noreferrer">Anbieterdokumentation ↗</a>}</div></article>}
                    <article className="ev-mcp-template"><div><h3>Eigener MCP-Server</h3><p>Verbinde einen Remote-MCP-Server über eine öffentliche HTTPS-Adresse.</p><small>Streamable HTTP · API-Key optional</small></div>{canManage && <button onClick={() => setAdding('custom')}>Eigenen MCP verbinden</button>}</article>
                </div>}
                {!canManage && <p className="ev-muted">Ein Projektadministrator verwaltet Verbindungen und Werkzeugfreigaben. Du kannst den aktuellen Stand ansehen.</p>}
            </>}
        </Panel>
        {adding && canManage && <CreateConnection key={adding} kind={adding} template={template} path={path} onCancel={() => setAdding(null)} onCreated={connection => { accept(connection); setAdding(null); setShowCatalog(false) }} reload={reload} />}
        {!catalog.error && <Panel title="Im Projekt verbunden" description="Aktivierung und zuletzt geprüfte Erreichbarkeit werden getrennt angezeigt.">
            {!catalog.isPending && !catalog.data?.connections.length && <Empty>Noch keine MCP-Verbindung eingerichtet. Wähle Context7 oder verbinde einen eigenen Server.</Empty>}
            <div className="ev-mcp-connections">{catalog.data?.connections.map(connection => <ConnectionCard key={connection.id} connection={connection} path={path} canManage={canManage} restricted={project!.profile === 'restricted'} onChanged={accept} reload={reload} onRemoved={() => client.setQueryData<McpCatalog>(key, value => value ? { ...value, connections: value.connections.filter(item => item.id !== connection.id) } : value)} />)}</div>
        </Panel>}
        <ProjectBrowserCard />
        <p className="ev-muted">Aktualisierte Claude- und Codex-Sitzungen finden freigegebene MCPs direkt über HAPI. Bereits vor diesem Update gestartete Agenten müssen einmal fortgesetzt oder neu gestartet werden. Als nur lesend freigegebene Werkzeuge können Agenten ohne Einzelbestätigung verwenden. Andere Aufrufe nutzen die normale Aktionsfreigabe des Agenten; eingeschränkte Profile erhalten ausschließlich lesend freigegebene Werkzeuge.</p>
    </div>
}

function CreateConnection({ kind, template, path, onCreated, onCancel, reload }: {
    kind: McpConnection['kind']; template?: McpCatalog['templates'][number]; path: string
    onCreated: (connection: McpConnection) => void; onCancel: () => void; reload: () => Promise<McpCatalog>
}) {
    const { api } = useEvolved()
    const action = useRequests()
    const [name, setName] = useState(kind === 'context7' ? 'Context7' : '')
    const [endpoint, setEndpoint] = useState(kind === 'context7' ? template?.endpoint ?? 'https://mcp.context7.com/mcp' : '')
    const [mode, setMode] = useState<McpAuth['mode']>('none')
    const [header, setHeader] = useState('X-API-Key')
    const [token, setToken] = useState('')
    const [uncertain, setUncertain] = useState(false)
    const pending = useRef<Creation | null>(null)
    useEffect(() => () => { pending.current = null }, [])
    const create = () => action.run('create', async signal => {
        const payload = pending.current ?? { id: crypto.randomUUID(), kind, ...(kind === 'custom' ? { name: name.trim(), endpoint: endpoint.trim() } : {}), auth: { mode, ...(mode === 'header' ? { headerName: header.trim() } : {}), ...(mode !== 'none' ? { token: token.trim() } : {}) } }
        pending.current = payload
        setToken('')
        try {
            if (uncertain) {
                const current = await reload()
                if (signal.aborted) return
                const existing = current.connections.find(item => item.id === payload.id)
                if (existing) { pending.current = null; onCreated(existing); return }
            }
            const result = await api.request<{ connection: McpConnection }>(path, { method: 'POST', body: payload, signal })
            if (signal.aborted) return
            pending.current = null; onCreated(result.connection)
        } catch (cause) {
            if (signal.aborted) return
            if (cause instanceof EvolvedApiError && cause.status < 500 && cause.status !== 409) {
                pending.current = null; setUncertain(false)
            } else setUncertain(true)
            throw cause
        }
    })
    const valid = name.trim() && endpointValid(endpoint.trim()) && (mode === 'none' || token.trim()) && (mode !== 'header' || /^[Xx]-[A-Za-z0-9-]+$/.test(header.trim()))
    return <Panel title={kind === 'context7' ? 'Context7 einrichten' : 'Eigenen MCP verbinden'} description="Die Verbindung wird deaktiviert angelegt. Speichern führt noch keinen Kontakt zum MCP-Server aus.">
        <form className="ev-stack" onSubmit={submit(() => void create())}>
            <div className="ev-form-grid"><Field label="Verbindungsname"><input required maxLength={100} value={name} disabled={Boolean(action.busy) || uncertain || kind === 'context7'} onChange={event => setName(event.target.value)} /></Field><Field label="HTTPS-Endpunkt" hint={kind === 'context7' ? 'Feste Context7-Adresse.' : 'Ohne Zugangsdaten oder Queryparameter. Lokale Adressen und andere Ports werden abgelehnt.'}><input aria-label="HTTPS-Endpunkt" type="url" required maxLength={2048} value={endpoint} disabled={Boolean(action.busy) || uncertain || kind === 'context7'} onChange={event => setEndpoint(event.target.value)} placeholder="https://mcp.example.com/mcp" /></Field></div>
            <AuthFields kind={kind} mode={mode} setMode={setMode} header={header} setHeader={setHeader} token={token} setToken={setToken} disabled={Boolean(action.busy) || uncertain} />
            {kind === 'context7' && <p className="ev-muted">Du kannst ohne Schlüssel beginnen oder deinen Context7-API-Key als Bearer-Token hinterlegen. Verfügbare Limits legt der Anbieter fest.</p>}
            {uncertain && <p className="ev-callout" role="status">Die Speicherbestätigung fehlt. Eine Wiederholung prüft dieselbe Verbindungskennung und sendet bei Bedarf exakt dieselben Angaben. Es wird keine zweite Verbindung angelegt.</p>}
            <ErrorNotice error={action.error} /><div className="ev-actions"><button className="ev-primary" disabled={Boolean(action.busy) || (!uncertain && !valid)}>{action.busy ? 'Wird gespeichert …' : uncertain ? 'Speicherstatus erneut prüfen' : 'Deaktiviert speichern'}</button><button type="button" onClick={onCancel}>{uncertain ? 'Schließen' : 'Abbrechen'}</button></div>
        </form>
    </Panel>
}

function ConnectionCard({ connection, path, canManage, restricted, onChanged, onRemoved, reload }: {
    connection: McpConnection; path: string; canManage: boolean; restricted: boolean
    onChanged: (connection: McpConnection) => void; onRemoved: () => void; reload: () => Promise<McpCatalog>
}) {
    const { api } = useEvolved()
    const action = useRequests()
    const [editing, setEditing] = useState(false)
    const [historyOpen, setHistoryOpen] = useState(false)
    const [search, setSearch] = useState('')
    const [name, setName] = useState(connection.name)
    const [enabled, setEnabled] = useState(connection.enabled)
    const [grants, setGrants] = useState(connection.enabledTools)
    const [readOnly, setReadOnly] = useState(connection.tools.filter(tool => tool.readOnly).map(tool => tool.name))
    const [changeAuth, setChangeAuth] = useState(false)
    const [mode, setMode] = useState(connection.auth.mode)
    const [header, setHeader] = useState(connection.auth.headerName ?? 'X-API-Key')
    const [token, setToken] = useState('')
    const [dirty, setDirty] = useState(false)
    const resource = `${path}/${encodeURIComponent(connection.id)}`
    useEffect(() => {
        setName(connection.name); setEnabled(connection.enabled); setGrants(connection.enabledTools)
        setReadOnly(connection.tools.filter(tool => tool.readOnly).map(tool => tool.name))
        setMode(connection.auth.mode); setHeader(connection.auth.headerName ?? 'X-API-Key'); setChangeAuth(false); setToken(''); setDirty(false)
    }, [connection.version])
    const changed = (operation: () => void) => { operation(); setDirty(true) }
    const discover = () => action.run('discover', async signal => {
        const result = await api.request<{ connection: McpConnection }>(`${resource}/discover`, { method: 'POST', body: { version: connection.version }, signal })
        if (signal.aborted) return
        onChanged(result.connection)
        action.setNotice(result.connection.status.state === 'ready' ? 'Verbindung geprüft und Werkzeuge geladen. Prüfe die Freigaben vor dem Aktivieren.' : 'Die Verbindung konnte nicht bestätigt werden. Prüfe den angezeigten Status und deinen Zugang.')
        setEditing(true)
    })
    const save = () => action.run('save', async signal => {
        const body = { version: connection.version, catalogRevision: connection.catalogRevision, name: name.trim(), enabled: changeAuth ? false : enabled, enabledTools: changeAuth ? [] : grants, readOnlyTools: changeAuth ? [] : readOnly.filter(tool => grants.includes(tool)), ...(changeAuth ? { auth: { mode, ...(mode === 'header' ? { headerName: header.trim() } : {}), ...(mode !== 'none' ? { token: token.trim() } : {}) } } : {}) }
        setToken('')
        const result = await api.request<{ connection: McpConnection }>(resource, { method: 'PUT', body, signal })
        if (signal.aborted) return
        onChanged(result.connection); action.setNotice(changeAuth ? 'Zugang geändert. Die Verbindung ist deaktiviert und muss erneut geprüft und freigegeben werden.' : 'Verbindung und Werkzeugfreigaben gespeichert.')
    })
    const disable = () => action.run('disable', async signal => {
        const result = await api.request<{ connection: McpConnection }>(resource, { method: 'PUT', body: { version: connection.version, catalogRevision: connection.catalogRevision, enabled: false, enabledTools: connection.enabledTools, readOnlyTools: connection.tools.filter(tool => tool.readOnly && connection.enabledTools.includes(tool.name)).map(tool => tool.name) }, signal })
        if (signal.aborted) return
        onChanged(result.connection); action.setNotice('Deaktiviert. Neue Aufrufe sind gesperrt; bereits gestartete externe Aktionen werden dadurch nicht rückgängig gemacht.')
    }, action.busy === 'discover')
    const remove = () => action.run('delete', async signal => {
        await api.request(resource, { method: 'DELETE', body: { version: connection.version }, signal })
        if (!signal.aborted) onRemoved()
    })
    const busy = Boolean(action.busy)
    const validAuth = !changeAuth || mode === 'none' || token.trim() && (mode !== 'header' || /^[Xx]-[A-Za-z0-9-]+$/.test(header.trim()))
    const canEnable = connection.status.state === 'ready' && !!connection.catalogRevision && grants.length > 0 && !changeAuth
    const tools = connection.tools.filter(tool => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    return <article className="ev-mcp-connection" aria-label={connection.name}>
        <header><div><h3>{connection.name}</h3><p className="ev-mcp-endpoint">{connection.endpoint}</p></div><span className={`ev-badge ${connection.enabled ? 'ev-verified' : ''}`}>{connection.enabled ? 'Aktiv' : 'Deaktiviert'}</span></header>
        <div className="ev-mcp-meta"><span>{states[connection.status.state] ?? 'Status unbekannt'}</span><span>{connection.enabledTools.length} von {connection.tools.length} Werkzeugen freigegeben</span><span>{connection.auth.configured ? 'Zugangsschlüssel gespeichert' : 'Ohne gespeicherten Schlüssel'}</span></div>
        {restricted && connection.enabled && !connection.tools.some(tool => tool.readOnly && connection.enabledTools.includes(tool.name)) && <p className="ev-muted">Für das eingeschränkte Projektprofil ist noch kein Werkzeug als nur lesend freigegeben.</p>}
        {connection.status.checkedAt !== null && <small className="ev-mcp-date">Zuletzt geprüft: {formatDate(connection.status.checkedAt)}</small>}
        {connection.status.state === 'catalog_changed' && <p className="ev-callout">Der Anbieter hat Werkzeuge geändert. Lade den Katalog erneut und bestätige die gewünschten Freigaben.</p>}
        {connection.status.state === 'auth_required' && <p className="ev-callout">Der Anbieter akzeptiert den Zugang nicht. Ein Administrator kann den Schlüssel unter „Verwalten“ ändern.</p>}
        {connection.status.state === 'unreachable' && <p className="ev-callout">{connection.status.errorCode === 'mcp_proxy_unsupported' ? 'Der Hub verwendet einen HTTP-Proxy. Diese MCP-Anbindung benötigt eine direkte HTTPS-Verbindung; der Betreiber muss die Hub-Konfiguration prüfen.' : 'Der Server ist nicht erreichbar oder unterstützt den erwarteten MCP-Verbindungsaufbau nicht. Prüfe Adresse und Anbieterstatus.'}</p>}
        {canManage && <div className="ev-actions"><button disabled={busy || dirty} onClick={() => void discover()}>{action.busy === 'discover' ? 'Verbindung wird geprüft …' : 'Verbindung prüfen & Werkzeuge laden'}</button><button disabled={busy} aria-expanded={editing} onClick={() => setEditing(value => !value)}>{editing ? 'Verwaltung schließen' : 'Verwalten'}</button>{connection.enabled && <button className="ev-danger-subtle" disabled={busy && action.busy !== 'discover'} onClick={() => void disable()}>Jetzt deaktivieren</button>}</div>}
        {canManage && editing && <form className="ev-stack ev-mcp-editor" onSubmit={submit(() => void save())}>
            <Field label="Verbindungsname"><input required maxLength={100} value={name} disabled={busy} onChange={event => changed(() => setName(event.target.value))} /></Field>
            <p className="ev-muted">Die Serveradresse ist fest. Für eine andere Adresse eine neue Verbindung anlegen.</p>
            <label className="ev-check"><input type="checkbox" checked={changeAuth} disabled={busy} onChange={event => changed(() => { setChangeAuth(event.target.checked); setToken('') })} />Zugang ändern</label>
            {changeAuth && <><AuthFields kind={connection.kind} mode={mode} setMode={value => changed(() => setMode(value))} header={header} setHeader={value => changed(() => setHeader(value))} token={token} setToken={value => changed(() => setToken(value))} disabled={busy} stored /><p className="ev-callout">Ein geänderter Zugang deaktiviert die Verbindung und setzt die Freigaben zurück. Danach erneut prüfen und freigeben.</p></>}
            {connection.tools.length > 0 && <><Field label="Werkzeuge durchsuchen"><input type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field><p className="ev-muted">Beschreibungen stammen vom externen Server. Deine Einstufung „nur lesend“ erlaubt Aufrufe ohne Einzelbestätigung und in eingeschränkten Profilen. Sie ist keine technisch geprüfte Zusicherung des Anbieters.</p><div className="ev-mcp-tools">{tools.map(tool => <div key={tool.name} className="ev-mcp-tool"><label className="ev-check"><input type="checkbox" aria-label={`Freigeben: ${tool.name}`} checked={grants.includes(tool.name)} disabled={busy || changeAuth} onChange={event => changed(() => setGrants(values => event.target.checked ? [...values, tool.name] : values.filter(value => value !== tool.name)))} /><strong>{tool.name}</strong></label><p>{tool.description}</p><label className="ev-check ev-mcp-readonly"><input type="checkbox" aria-label={`Nur lesend: ${tool.name}`} checked={readOnly.includes(tool.name)} disabled={busy || changeAuth || !grants.includes(tool.name)} onChange={event => changed(() => setReadOnly(values => event.target.checked ? [...values, tool.name] : values.filter(value => value !== tool.name)))} />Als nur lesend freigeben</label><details><summary>Beschreibung & Eingabeschema</summary><div className="ev-mcp-description">{tool.description}</div><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div>)}</div>{!tools.length && <Empty>Keine Werkzeuge passen zur Suche.</Empty>}</>}
            {restricted && <p className="ev-muted">Dieses Projekt verwendet das eingeschränkte Profil. Agenten sehen nur Werkzeuge mit Freigabe und aktivierter Einstufung „nur lesend“.</p>}
            <label className="ev-check"><input type="checkbox" checked={enabled && !changeAuth} disabled={busy || changeAuth || (!canEnable && !enabled)} onChange={event => changed(() => setEnabled(event.target.checked))} />Für Agenten dieses Projekts aktivieren</label>
            {!canEnable && <p className="ev-muted">Zum Aktivieren zuerst die Verbindung prüfen und mindestens ein Werkzeug freigeben.</p>}
            <div className="ev-actions"><button className="ev-primary" disabled={busy || !dirty || !name.trim() || !validAuth || (!changeAuth && enabled && !canEnable)}>Konfiguration speichern</button></div>
        </form>}
        {canManage && editing && <div className="ev-actions"><ConfirmButton label="Verbindung entfernen" detail="Diese Projektverbindung und ihren Zugangsschlüssel entfernen? Externe Daten werden nicht gelöscht." disabled={busy} onConfirm={() => void remove()} /></div>}
        {!canManage && connection.tools.length > 0 && <details><summary>{connection.tools.length} Werkzeuge ansehen</summary><div className="ev-mcp-tools">{connection.tools.map(tool => <div key={tool.name} className="ev-mcp-tool"><strong>{tool.name}</strong><p>{tool.description}</p><small>{connection.enabledTools.includes(tool.name) ? 'Freigegeben' : 'Nicht freigegeben'}{tool.readOnly ? ' · Nur lesend' : ''}</small><details><summary>Beschreibung & Eingabeschema</summary><div className="ev-mcp-description">{tool.description}</div><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div>)}</div></details>}
        <details open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)} className="ev-mcp-history"><summary>Letzte Aufrufe</summary>{historyOpen && <ConnectionHistory serverId={connection.id} path={resource} />}</details>
        <ErrorNotice error={action.error} />{action.error && <button disabled={busy} onClick={() => void action.run('reload', async signal => { await reload(); if (!signal.aborted) action.setNotice('Aktueller Stand geladen. Prüfe die Freigaben erneut.') })}>Stand neu laden</button>}{action.notice && <p className="ev-success" role="status">{action.notice}</p>}
    </article>
}

function ConnectionHistory({ serverId, path }: { serverId: string; path: string }) {
    const { api, me, project } = useEvolved()
    const history = useQuery({ queryKey: ['evolved', 'mcp-history', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile, serverId], queryFn: ({ signal }) => api.request<McpCallHistory>(`${path}/history`, { signal }), retry: false, gcTime: 0 })
    const status = { success: 'Erfolgreich', tool_error: 'Werkzeugfehler', failed: 'Fehlgeschlagen', unknown: 'Ergebnis unklar – nicht erneut ausführen' }
    return <div><p className="ev-muted">Die letzten 50 Aufrufe mit Dauer und Status. Argumente, Ergebnisse und Zugangsschlüssel werden hier nicht gespeichert oder angezeigt.</p>
        {history.isPending ? <Loading /> : history.error ? <ErrorNotice error={new Error('Der Aufrufverlauf konnte nicht geladen werden. Versuche es erneut.')} /> : history.data?.calls.length ? <ol className="ev-mcp-history-list">{history.data.calls.map(call => <li key={call.id}><div><strong>{call.toolName}</strong><small>{formatDate(call.startedAt)}</small></div><span>{status[call.status] ?? 'Unbekannt'} · {(call.durationMs / 1000).toFixed(1)} s</span></li>)}</ol> : <Empty>Noch keine Aufrufe für diese Verbindung.</Empty>}
        <button disabled={history.isFetching} onClick={() => void history.refetch()}>Verlauf aktualisieren</button>
    </div>
}
