import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BROWSER_READ_ONLY_ELIGIBLE, type BrowserRuntimeState, type BrowserStatus, type BrowserToolName } from '@hapi/protocol/browserTools'
import { useEvolved } from './auth'
import { EvolvedApiError, isProjectAdmin, projectPath } from './api'
import { ErrorNotice, Loading, Panel, formatDate, submit } from './ui'

const runtimeText: Record<BrowserRuntimeState, { label: string; detail: string }> = {
    disabled: { label: 'Deaktiviert', detail: 'Agenten dieses Projekts haben keinen Browser. Aktivieren startet einen eigenen Browser nur für dieses Projekt.' },
    unconfigured: { label: 'Nicht eingerichtet', detail: 'Der Projektbrowser ist noch nicht konfiguriert.' },
    runner_missing: { label: 'Projektdienst nicht verbunden', detail: 'Verbinde zuerst den verwalteten Projektdienst (Anbieter-Anmeldung). Der Browser läuft nur neben diesem Dienst.' },
    image_missing: { label: 'Browser-Image fehlt', detail: 'Der Installationsbetreiber muss das Image hapi-evolved-browser:0.1.0 bauen. HAPI lädt es nicht selbst herunter.' },
    stopped: { label: 'Gestoppt', detail: 'Der Browser ist aktiviert, läuft aber nicht. Starte ihn erneut.' },
    starting: { label: 'Startet …', detail: 'Die Container laufen; der Browser hat sich noch nicht gemeldet.' },
    service_ready: { label: 'Dienst erreichbar, Browser ungeprüft', detail: 'Der Dienst antwortet. Ob Firefox wirklich startet, zeigt erst eine Browserprüfung.' },
    ready: { label: 'Bereit', detail: 'Firefox wurde gestartet und hat eine Seite geladen.' },
    failed: { label: 'Fehler', detail: 'Der Browser ist ausgefallen oder die Prüfung ist fehlgeschlagen. Der Projektdienst und die Agenten laufen weiter.' },
    stale: { label: 'Keine aktuelle Rückmeldung', detail: 'Der Browser hat sich länger nicht gemeldet.' },
    unavailable: { label: 'Status nicht verfügbar', detail: 'Die Projektdienst-Steuerung ist gerade nicht erreichbar.' },
}
const lifecycleText: Record<string, string> = {
    browser_image_missing: 'Gespeichert, aber nicht gestartet: Das Browser-Image fehlt auf diesem Server.',
    browser_runner_missing: 'Gespeichert. Der Browser startet, sobald der verwaltete Projektdienst verbunden ist.',
    runner_unavailable: 'Gespeichert, aber die Projektdienst-Steuerung war nicht erreichbar. Starte den Browser später erneut.',
}
function safeError(error: unknown): Error {
    if (error instanceof EvolvedApiError) {
        if (error.status === 409) return new Error('Die Browser-Konfiguration wurde inzwischen geändert oder der Browser läuft nicht. Lade den aktuellen Stand.')
        if (error.status === 401 || error.status === 403) return new Error('Die Berechtigung fehlt oder ist abgelaufen. Bestätige die Änderung erneut mit deinem Passkey.')
    }
    return new Error('Die Anfrage konnte nicht bestätigt werden. Lade den aktuellen Stand.')
}
function valid(value: unknown): value is BrowserStatus {
    const status = value as BrowserStatus | null
    return !!status && typeof status === 'object' && !!status.config && !!status.runtime && Array.isArray(status.tools) && typeof status.runtime.state === 'string'
}

/** First-party project browser next to remote MCPs; independent configuration, never the development module. */
export function ProjectBrowserCard() {
    const { api, me, project } = useEvolved()
    const client = useQueryClient()
    const path = `${projectPath(project!.id)}/browser`
    const key = ['evolved', 'browser', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile]
    const status = useQuery({ queryKey: key, retry: false, gcTime: 0,
        queryFn: async ({ signal }) => { const value = await api.request<unknown>(path, { signal }); if (!valid(value)) throw new Error('invalid'); return value },
        refetchInterval: query => { const state = query.state.data?.runtime.state; return state && ['starting', 'service_ready', 'stopped'].includes(state) && query.state.data?.config.enabled ? 10_000 : false } })
    const data = status.data
    const canManage = isProjectAdmin(project!.role) && data?.canManage === true
    const [enabled, setEnabled] = useState(false)
    const [grants, setGrants] = useState<BrowserToolName[]>([])
    const [readOnly, setReadOnly] = useState<BrowserToolName[]>([])
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<Error | null>(null)
    const [notice, setNotice] = useState('')
    useEffect(() => { if (data) { setEnabled(data.config.enabled); setGrants(data.config.enabledTools); setReadOnly(data.config.readOnlyTools) } }, [data?.config.version])
    const run = async (name: string, operation: () => Promise<void>) => {
        if (busy) return
        setBusy(name); setError(null); setNotice('')
        try { await operation() } catch (cause) { setError(safeError(cause)) } finally { setBusy(null) }
    }
    const accept = (value: unknown) => { if (valid(value)) client.setQueryData(key, value) }
    const save = () => run('save', async () => {
        const result = await api.request<BrowserStatus & { lifecycle?: { ok: boolean; errorCode?: string } }>(path, { method: 'PUT', body: { version: data!.config.version, enabled, enabledTools: grants, readOnlyTools: readOnly.filter(name => grants.includes(name)) } })
        accept(result)
        setNotice(result.lifecycle && !result.lifecycle.ok ? lifecycleText[result.lifecycle.errorCode ?? ''] ?? 'Gespeichert, aber der Browser konnte nicht umgeschaltet werden. Prüfe den Status.'
            : enabled ? 'Gespeichert. Der Browser für dieses Projekt wird gestartet.' : 'Deaktiviert. Der Browser wurde gestoppt; offene Tabs und Anmeldungen sind verworfen.')
    })
    const probe = () => run('probe', async () => { await api.request(`${path}/probe`, { method: 'POST', body: {} }); setNotice('Prüfung angefordert. Das Ergebnis erscheint in etwa 15 Sekunden.'); setTimeout(() => void status.refetch(), 16_000) })
    const start = () => run('start', async () => { accept(await api.request(`${path}/start`, { method: 'POST', body: {} })); setNotice('Startauftrag gesendet.') })
    const dirty = !!data && (enabled !== data.config.enabled || JSON.stringify([...grants].sort()) !== JSON.stringify([...data.config.enabledTools].sort()) || JSON.stringify([...readOnly].sort()) !== JSON.stringify([...data.config.readOnlyTools].sort()))
    const runtime = data ? runtimeText[data.runtime.state] ?? runtimeText.unavailable : null
    return <Panel title="Projektbrowser (Camofox)" description="Ein eigener Firefox-basierter Browser nur für die Agenten dieses Projekts, neben Remote-MCPs und unabhängig vom aktiven Entwicklungsmodul.">
        {status.isPending ? <Loading /> : status.error || !data ? <><ErrorNotice error={new Error('Der Browserstatus konnte nicht geladen werden.')} /><button onClick={() => void status.refetch()}>Stand neu laden</button></> : <div className="ev-stack ev-browser-card">
            <div className="ev-mcp-meta" aria-label="Browserstatus">
                <span className={`ev-badge ${data.config.enabled ? 'ev-verified' : ''}`}>{data.config.enabled ? 'Aktiviert' : 'Deaktiviert'}</span>
                <span role="status">{runtime!.label}</span>
                <span>{data.config.enabledTools.length} von {data.tools.length} Werkzeugen freigegeben</span>
            </div>
            <p className="ev-muted">{runtime!.detail}{data.runtime.engineCheckedAt ? ` Zuletzt geprüft: ${formatDate(data.runtime.engineCheckedAt)}.` : ''}</p>
            <p className="ev-callout">Alle Agentensitzungen dieses Projekts teilen sich einen Browserzustand (Tabs, Cookies, Anmeldungen). Er ist flüchtig: Neustart, Deaktivieren oder ein neuer Projektdienst verwerfen ihn. Es gibt keine Trennung zwischen einzelnen Sitzungen. Erreichbar sind alle öffentlichen Websites; private Netze, der Hub und Projektdienste sind gesperrt.</p>
            {canManage && <form className="ev-stack" onSubmit={submit(() => void save())}>
                <div className="ev-mcp-tools">{data.tools.map(tool => <div key={tool.name} className="ev-mcp-tool">
                    <label className="ev-check"><input type="checkbox" aria-label={`Freigeben: ${tool.name}`} checked={grants.includes(tool.name)} disabled={!!busy} onChange={event => setGrants(values => event.target.checked ? [...values, tool.name] : values.filter(value => value !== tool.name))} /><strong>{tool.name}</strong></label>
                    <p>{tool.description}</p>
                    {BROWSER_READ_ONLY_ELIGIBLE.includes(tool.name) && <label className="ev-check ev-mcp-readonly"><input type="checkbox" aria-label={`Nur lesend: ${tool.name}`} checked={readOnly.includes(tool.name)} disabled={!!busy || !grants.includes(tool.name)} onChange={event => setReadOnly(values => event.target.checked ? [...values, tool.name] : values.filter(value => value !== tool.name))} />Als nur lesend freigeben</label>}
                </div>)}</div>
                {project!.profile === 'restricted' && <p className="ev-muted">Eingeschränktes Profil: Agenten erhalten nur als „nur lesend“ freigegebene Werkzeuge und können daher keine neuen Seiten öffnen.</p>}
                <label className="ev-check"><input type="checkbox" checked={enabled} disabled={!!busy} onChange={event => setEnabled(event.target.checked)} />Für Agenten dieses Projekts aktivieren</label>
                <div className="ev-actions">
                    <button className="ev-primary" disabled={!!busy || !dirty || (enabled && !grants.length)}>{busy === 'save' ? 'Wird gespeichert …' : 'Speichern'}</button>
                    {data.config.enabled && ['stopped', 'failed', 'stale'].includes(data.runtime.state) && <button type="button" disabled={!!busy} onClick={() => void start()}>Erneut starten</button>}
                    {data.config.enabled && ['service_ready', 'ready', 'failed'].includes(data.runtime.state) && <button type="button" disabled={!!busy} onClick={() => void probe()}>Browser prüfen</button>}
                </div>
            </form>}
            {!canManage && <p className="ev-muted">Ein Projektadministrator aktiviert den Browser und gibt Werkzeuge frei.</p>}
            <ErrorNotice error={error} />{notice && <p className="ev-success" role="status">{notice}</p>}
        </div>}
    </Panel>
}
