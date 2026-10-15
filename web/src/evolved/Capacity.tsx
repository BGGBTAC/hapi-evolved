import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { CapacityReport, CapacityWindow, ProjectCapacity } from '@hapi/protocol'
import { useEvolved } from './auth'
import { projectPath } from './api'
import { ErrorNotice, Loading, formatDate } from './ui'
import { WorkspaceLink } from './workspaceNavigation'

const names = { claude: 'Claude', codex: 'Codex' }
const reasons: Record<NonNullable<CapacityReport['reason']>, string> = {
    not_reported: 'Der Anbieter hat noch keine Kapazität gemeldet.',
    utilization_not_reported: 'Der Anbieter meldet einen Status, aber keinen Nutzungsanteil.',
    native_read_failed: 'Die native Kapazitätsabfrage ist fehlgeschlagen.',
    authentication_required: 'Der Agent benötigt eine Anmeldung beim Anbieter.',
    subscription_auth_required: 'Diese Anmeldung unterstützt keine Kontingentanzeige. API-Schlüssel liefern hier kein Abonnementlimit.',
    invalid_report: 'Die Anbietermeldung enthält keine verwertbaren Kapazitätsdaten.',
}
export function capacityIsStale(report: CapacityReport, now: number): boolean {
    return report.stale || (report.windows.length ? report.windows.every(window => capacityWindowIsStale(window, report.observedAt, now)) : now - report.observedAt >= 5 * 60_000)
}
export function capacityWindowIsStale(window: CapacityWindow & { stale?: boolean }, observedAt: number, now: number): boolean {
    return window.stale === true || now - (window.observedAt ?? observedAt) >= 5 * 60_000 || (window.resetsAt !== null && window.resetsAt <= now)
}
export function capacityWindowLabel(window: CapacityWindow): string {
    let duration: string | undefined
    if (window.durationMinutes !== null) {
        duration = window.durationMinutes % 1440 === 0 ? `${window.durationMinutes / 1440}-Tage-Fenster`
            : window.durationMinutes % 60 === 0 ? `${window.durationMinutes / 60}-Stunden-Fenster`
                : `${window.durationMinutes}-Minuten-Fenster`
    }
    const labels: Record<string, string> = { primary: 'Primäres Limit', secondary: 'Weiteres Limit', five_hour: '5-Stunden-Fenster', seven_day: '7-Tage-Fenster', seven_day_opus: 'Opus · 7-Tage-Fenster', seven_day_sonnet: 'Sonnet · 7-Tage-Fenster', overage: 'Zusatznutzung' }
    if (labels[window.id]) return labels[window.id]
    const codex = /^(.*):(primary|secondary)$/.exec(window.id)
    if (codex) return `${codex[1]} · ${duration ? `${duration} (${codex[2] === 'primary' ? 'primär' : 'sekundär'})` : codex[2] === 'primary' ? 'Primäres Limit' : 'Weiteres Limit'}`
    return duration ? `${window.id} · ${duration}` : window.id
}
function CapacityWindowView({ window, stale, observedAt }: { window: CapacityWindow; stale: boolean; observedAt: number }) {
    const percent = (value: number) => `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value)} %`
    const status = { allowed: 'Nutzung möglich', warning: 'Limit nähert sich', rejected: 'Limit erreicht', unknown: 'Status unbekannt' }[window.status]
    return <div className="ew-capacity-window" data-capacity-window={window.id} data-capacity-stale={stale}>
        <div className="ew-between"><strong>{capacityWindowLabel(window)}</strong><span className={`ew-status ${stale || window.status === 'warning' || window.status === 'rejected' ? 'ew-status-warning' : ''}`}>{stale ? 'Veraltet' : status}</span></div>
        <div className="ew-capacity-value">{window.remainingPercent !== null ? <><strong>{percent(window.remainingPercent)}</strong><span>verbleibend</span></> : <span>Nutzungsanteil nicht gemeldet</span>}</div>
        {window.usedPercent !== null && <><div className="ew-meter" role="meter" aria-label={`${capacityWindowLabel(window)} genutzt${stale ? ' (veraltete Meldung)' : ''}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent}><span style={{ width: `${window.usedPercent}%` }} /></div><small>{percent(window.usedPercent)} genutzt</small></>}
        <p className="ew-caption">{window.resetsAt !== null ? <>Reset: <time dateTime={new Date(window.resetsAt).toISOString()}>{formatDate(window.resetsAt)}</time>{window.resetsAt <= Date.now() && ' · neue Meldung ausstehend'}</> : 'Reset-Zeit nicht gemeldet'}</p>
        <p className="ew-caption">Fensterstand: <time dateTime={new Date(window.observedAt ?? observedAt).toISOString()}>{formatDate(window.observedAt ?? observedAt)}</time></p>
    </div>
}
function CapacityProvider({ provider, compact, now }: { provider: ProjectCapacity['providers'][number]; compact: boolean; now: number }) {
    const [visible, setVisible] = useState(3)
    const reports = [...provider.reports].sort((a, b) => b.observedAt - a.observedAt)
    const displayed = reports.slice(0, compact ? 1 : visible)
    return <section className="ew-capacity-provider" data-capacity-provider={provider.provider} aria-label={`${names[provider.provider]} Kapazität`}>
        <div className="ew-between"><h3>{names[provider.provider]}</h3><span className="ew-caption">{compact && reports.length ? 'Letzte Meldung' : `${reports.length} ${reports.length === 1 ? 'Meldung' : 'Meldungen'}`}</span></div>
        {!reports.length && <p className="ew-empty-inline">Noch keine Kapazitätsmeldung. Eine angemeldete Projektsitzung muss zuerst einen Anbieterstatus übermitteln.</p>}
        {displayed.map(report => {
            const stale = capacityIsStale(report, now)
            return <div className="ew-capacity-report" key={report.sessionId} data-capacity-stale={stale}>
                <div className="ew-capacity-provenance"><Link to="/sessions/$sessionId" params={{ sessionId: report.sessionId }}>Sitzung {report.sessionId.slice(0, 8)}</Link><span>{report.source === 'claude-sdk' ? 'Claude SDK' : 'Codex App Server'}</span><span className={`ew-status ${stale ? 'ew-status-warning' : ''}`}>{stale ? 'Veraltet' : report.status === 'available' ? 'Gemeldet' : report.status === 'unsupported' ? 'Nicht unterstützt' : 'Unbekannt'}</span></div>
                <p className="ew-caption">Stand: <time dateTime={new Date(report.observedAt).toISOString()}>{formatDate(report.observedAt)}</time></p>
                {stale && <p className="ew-caption">Keine aktuelle Kapazitätszusage. Warte auf eine neue Meldung aus einer aktiven Sitzung.</p>}
                {report.reason && <p className="ew-caption">{reasons[report.reason]}</p>}
                <div className="ew-capacity-windows">{report.windows.map(window => <CapacityWindowView key={window.id} window={window} stale={report.stale || capacityWindowIsStale(window, report.observedAt, now)} observedAt={report.observedAt} />)}</div>
                {!report.windows.length && <p className="ew-empty-inline">Keine Nutzungsfenster gemeldet.</p>}
            </div>
        })}
        {!compact && reports.length > visible && <button onClick={() => setVisible(count => count + 5)}>Weitere Meldungen ({reports.length - visible})</button>}
    </section>
}

function CapacityGlance({ provider, now }: { provider: ProjectCapacity['providers'][number]; now: number }) {
    const reports = [...provider.reports].sort((a, b) => b.observedAt - a.observedAt)
    const freshestNumeric = reports.find(report => !capacityIsStale(report, now) && report.windows.some(window => !capacityWindowIsStale(window, report.observedAt, now) && (window.remainingPercent !== null || window.usedPercent !== null)))
    const report = freshestNumeric ?? reports[0]
    const stale = report && capacityIsStale(report, now)
    return <section className="ew-capacity-provider ew-capacity-glance" data-capacity-provider={provider.provider} aria-label={`${names[provider.provider]} Kapazität`}>
        <div className="ew-between"><h3>{names[provider.provider]}</h3><span className={`ew-status ${stale ? 'ew-status-warning' : ''}`}>{!report ? 'Unbekannt' : stale ? 'Veraltet' : report.status === 'unsupported' ? 'Nicht unterstützt' : report.windows.some(window => window.remainingPercent !== null) ? 'Gemeldet' : 'Anteil unbekannt'}</span></div>
        {!report ? <p className="ew-empty-inline">Noch keine Sitzungsmeldung. Restkapazität unbekannt.</p> : <>
            {report.windows.slice(0, 2).map(window => {
                const windowStale = report.stale || capacityWindowIsStale(window, report.observedAt, now)
                return <div className="ew-glance-window" key={window.id} data-capacity-window={window.id} data-capacity-stale={windowStale}>
                    <div className="ew-between"><span>{capacityWindowLabel(window)}</span><strong>{window.remainingPercent === null ? 'Nicht gemeldet' : `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(window.remainingPercent)} % frei`}</strong></div>
                    <p className="ew-caption">{windowStale ? 'Veraltet · ' : window.status === 'rejected' ? 'Limit erreicht · ' : window.status === 'warning' ? 'Limit nähert sich · ' : ''}{window.resetsAt !== null ? `Reset: ${formatDate(window.resetsAt)}` : 'Reset nicht gemeldet'}</p>
                    <p className="ew-caption">Stand: {formatDate(window.observedAt ?? report.observedAt)}</p>
                </div>
            })}
            {!report.windows.length && <p className="ew-empty-inline">{report.reason ? reasons[report.reason] : 'Keine Nutzungsfenster gemeldet.'}</p>}
            {report.windows.length > 2 && <p className="ew-caption">{report.windows.length - 2} weitere Fenster in der Detailansicht</p>}
            <p className="ew-caption ew-glance-source">{freshestNumeric ? 'Letzte frische numerische Sitzungsmeldung' : 'Letzte Sitzungsmeldung'} · <Link to="/sessions/$sessionId" params={{ sessionId: report.sessionId }}>{report.sessionId.slice(0, 8)}</Link>{report.windows.length === 0 && ` · ${formatDate(report.observedAt)}`}</p>
        </>}
    </section>
}

export function CapacityPanel({ compact = false }: { compact?: boolean }) {
    const { api, me, project } = useEvolved()
    const [now, setNow] = useState(Date.now)
    useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])
    const capacity = useQuery({
        queryKey: ['evolved', 'capacity', api.baseUrl, me.user.id, project?.id, project?.role, project?.profile],
        enabled: !!project,
        gcTime: 0,
        retry: false,
        refetchInterval: 30_000,
        queryFn: async ({ signal }) => {
            const result = await api.request<ProjectCapacity>(`${projectPath(project!.id)}/capacity`, { signal })
            if (result.projectId !== project!.id) throw new Error('Die Kapazitätsmeldung gehört nicht zum aktiven Projekt.')
            return result
        },
    })
    const data = !capacity.error ? capacity.data : undefined
    return <section className={`ev-panel ew-capacity${compact ? ' ew-capacity-compact' : ''}`} data-testid="capacity-panel" aria-label="Anbieterkapazität">
        <div className="ew-section-heading"><div><h2>{compact ? 'Restkapazität' : 'Anbieterkapazität'}</h2><p>{compact ? 'Kontoweite Limits aus diesem Projekt. Meldungen werden nicht addiert.' : 'Kontoweite Limits, gemeldet durch Sitzungen dieses Projekts. Verschiedene Meldungen werden nicht addiert.'}</p></div>{compact && <WorkspaceLink tab="capacity" projectId={project?.id} className="ew-text-link">Alle Meldungen</WorkspaceLink>}</div>
        <ErrorNotice error={capacity.error} />
        {capacity.isPending && <Loading />}
        {data && <div className="ew-capacity-providers">{data.providers.map(provider => compact ? <CapacityGlance key={`${project?.id}:${provider.provider}`} provider={provider} now={now} /> : <CapacityProvider key={`${project?.id}:${provider.provider}`} provider={provider} compact={false} now={now} />)}</div>}
        {data && !data.providers.length && <p className="ew-empty-inline">Noch keine Anbieterdaten verfügbar.</p>}
        <p className="ew-caption ew-capacity-account-note">Die Meldung kann zu einem anderen Teamkonto gehören. Eine sichere Zuordnung zu deinem Anbieterkonto ist nicht möglich.</p>
        {(!compact || capacity.error) && <div className="ew-data-footer"><p className="ew-caption">{data ? `Hub-Abfrage: ${formatDate(data.generatedAt)}. ` : ''}Nutzungsgrenzen können sich durch weitere Anwendungen desselben Kontos ändern.</p><button disabled={capacity.isFetching} onClick={() => void capacity.refetch()}>{capacity.isFetching ? 'Wird aktualisiert …' : 'Kapazität aktualisieren'}</button></div>}
    </section>
}
