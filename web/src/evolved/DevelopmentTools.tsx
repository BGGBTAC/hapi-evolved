import { useEffect, useRef, useState } from 'react'
import {
    DevelopmentBuildStatusResponseSchema, DevelopmentDoctorResponseSchema, DevelopmentInspectResponseSchema, GitRefSchema,
    type DevelopmentBuildStatusResponse, type DevelopmentContext, type DevelopmentDoctorResponse, type DevelopmentInspectResponse, type ProjectDevelopmentConfig,
} from '@hapi/protocol/evolvedDevelopment'
import { useEvolved } from './auth'
import { WorkspaceLink } from './workspaceNavigation'
import {
    commitStateLabels, describeDevelopmentError, developmentPath, doctorStateLabels, formatTimestamp, runnerStatusLabels, safeHttpsUrl,
} from './developmentApi'

type Scoped<T> = { revision: number; value: T }
const repositoryStateText = {
    unbound: 'Kein Standard-Repository gebunden.',
    granted: 'Freigegeben.',
    not_granted: 'Nicht mehr freigegeben. Gib es im Bereich GitHub erneut frei oder wähle ein anderes.',
    github_disconnected: 'GitHub ist nicht verbunden.',
    hidden: 'Details nicht sichtbar.',
    unknown: 'Freigabe konnte nicht geprüft werden.',
} as const
const integrationStateText = { not_configured: 'Nicht eingerichtet', configured: 'Eingetragen', manual: 'Manuell', unavailable: 'Nicht verfügbar' } as const

/**
 * One explicit request at a time per action. Results are bound to the config
 * revision they were produced for and disappear when it changes or the panel unmounts.
 */
function useExplicitRequest<T>(revision: number) {
    const [result, setResult] = useState<Scoped<T> | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const active = useRef<AbortController | null>(null)
    useEffect(() => () => active.current?.abort(), [])
    useEffect(() => { active.current?.abort(); active.current = null; setResult(null); setError(null); setBusy(false) }, [revision])
    const run = (work: (signal: AbortSignal) => Promise<T>) => {
        if (active.current) return
        const controller = new AbortController(); active.current = controller
        setBusy(true); setError(null); setResult(null)
        void work(controller.signal).then(
            value => { if (!controller.signal.aborted) setResult({ revision, value }) },
            failure => { if (!controller.signal.aborted) setError(describeDevelopmentError(failure)) },
        ).finally(() => { if (active.current === controller) { active.current = null; setBusy(false) } })
    }
    return { result: result?.revision === revision ? result.value : null, error, busy, run }
}

export function DevelopmentTools({ config, context, unsaved, canRun, onContextRefresh }: {
    config: ProjectDevelopmentConfig; context: DevelopmentContext; unsaved: boolean; canRun: boolean; onContextRefresh: () => void
}) {
    const { api, project } = useEvolved()
    const projectId = project!.id
    const doctor = useExplicitRequest<DevelopmentDoctorResponse>(config.revision)
    const inspect = useExplicitRequest<DevelopmentInspectResponse>(config.revision)
    const status = useExplicitRequest<DevelopmentBuildStatusResponse>(config.revision)
    const [ref, setRef] = useState('')
    const refValid = !ref.trim() || GitRefSchema.safeParse(ref.trim()).success
    const mode = config.settings.mode
    const blocker = !canRun ? 'Prüfungen brauchen die Rolle Mitglied oder Administrator.' : unsaved ? 'Speichere oder verwirf zuerst deine Änderungen. Prüfungen nutzen nur die gespeicherte Konfiguration.' : null
    const repository = context.repository
    const inspectBlocker = blocker ?? (repository.state !== 'granted' ? 'Für die Projektprüfung braucht es ein freigegebenes Standard-Repository.' : null)
    const runDoctor = () => doctor.run(async signal => DevelopmentDoctorResponseSchema.parse(await api.request(developmentPath(projectId, '/doctor'), { method: 'POST', body: {}, signal })))
    const runInspect = () => inspect.run(async signal => DevelopmentInspectResponseSchema.parse(await api.request(developmentPath(projectId, '/inspect'), { method: 'POST', body: {}, signal })))
    const runStatus = () => {
        if (!refValid) return
        const query = ref.trim() ? `?${new URLSearchParams({ ref: ref.trim() })}` : ''
        status.run(async signal => DevelopmentBuildStatusResponseSchema.parse(await api.request(developmentPath(projectId, `/build-status${query}`), { signal })))
    }
    const doctorResult = doctor.result
    const fresh = doctorResult?.result && doctorResult.revision === config.revision ? doctorResult.result : null
    const last = context.lastDoctor

    return <>
        <section className="ev-panel" aria-labelledby="ev-dev-tools">
            <h2 id="ev-dev-tools">Werkzeuge und Projekt prüfen</h2>
            <p className="ev-muted">Nur lesend auf dem Projektrunner. „Gefunden“ heißt: auf diesem Runner vorhanden.</p>
            <dl className="ev-dev-meta"><div><dt>Standard-Repository</dt><dd>{repository.fullName ?? repository.repositoryId ?? '—'} · {repository.message ?? repositoryStateText[repository.state]}</dd></div></dl>
            {repository.state !== 'granted' && repository.state !== 'unbound' && <p className="ev-muted"><WorkspaceLink tab="github" projectId={projectId}>Repository-Freigaben prüfen</WorkspaceLink></p>}
            {blocker && <p className="ev-muted" role="status">{blocker}</p>}
            <div className="ev-actions">
                <button type="button" className="ev-primary" disabled={!!blocker || doctor.busy} onClick={runDoctor}>{doctor.busy ? 'Werkzeuge werden geprüft …' : 'Werkzeuge prüfen'}</button>
                <button type="button" disabled={!!inspectBlocker || inspect.busy} onClick={runInspect} title={inspectBlocker ?? undefined}>{inspect.busy ? 'Projekt wird gelesen …' : mode === 'odoo' ? 'Odoo-Module prüfen' : 'Projektdateien prüfen'}</button>
                <button type="button" disabled={doctor.busy || inspect.busy} onClick={onContextRefresh}>Kontext aktualisieren</button>
            </div>
            {!blocker && inspectBlocker && <p className="ev-muted">{inspectBlocker}</p>}
            {doctor.error && <p className="ev-error" role="alert">{doctor.error}</p>}
            {!doctorResult && !doctor.busy && last && <p className="ev-muted" role="status">Letzte Prüfung für Revision {last.revision}: {formatTimestamp(last.observedAt)} · {last.ready} gefunden, {last.missing} fehlen, {last.unsupported} nicht unterstützt, {last.unknown} unbekannt, {last.warning} zu prüfen. Führe die Prüfung aus, um Details zu sehen.</p>}
            {!doctorResult && !doctor.busy && !last && !doctor.error && <p className="ev-muted" role="status">Noch keine Werkzeugprüfung für diese Revision.</p>}
            {doctorResult && !doctorResult.result && <p className="ev-callout" role="status">{runnerStatusLabels[doctorResult.runner.status]}{doctorResult.message ? ` ${doctorResult.message}` : ''}</p>}
            {fresh && <div aria-label="Ergebnis der Werkzeugprüfung">
                <p className="ev-dev-meta"><span>Geprüft {formatTimestamp(fresh.observedAt)}</span><span>Dauer {Math.round(fresh.durationMs / 100) / 10} s</span><span>{fresh.host.os}/{fresh.host.arch}</span><span>Image: {fresh.host.image ?? 'unbekannt'}</span><span>Revision {doctorResult!.revision}</span></p>
                <ul className="ev-dev-checks ev-dev-scroll">{fresh.checks.map(check => <li key={check.id}><div>
                    <strong>{check.label}</strong>{check.version && <small>{check.version}</small>}{check.detail && <small>{check.detail}</small>}
                    {check.remedy && check.state !== 'ready' && <small>Abhilfe: {check.remedy.text}{check.remedy.recipeId ? ` (Ablauf ${check.remedy.recipeId})` : ''}{safeHttpsUrl(check.remedy.url) && <> · <a href={safeHttpsUrl(check.remedy.url)!} target="_blank" rel="noopener noreferrer">Dokumentation</a></>}</small>}
                </div><span className="ev-dev-state" data-state={check.state}>{doctorStateLabels[check.state]}</span></li>)}</ul>
                {fresh.truncated && <p className="ev-muted">Die Liste wurde gekürzt.</p>}
            </div>}
            {inspect.error && <p className="ev-error" role="alert">{inspect.error}</p>}
            {inspect.result && <InspectResult response={inspect.result} />}
        </section>

        <section className="ev-panel" aria-labelledby="ev-dev-status">
            <h2 id="ev-dev-status">GitHub-Commit-Status</h2>
            <p className="ev-muted">Kombinierter Commit-Status des Standard-Repositorys aus GitHub; keine Check-Runs.{mode === 'odoo' ? ' Odoo.sh meldet hier nur, wenn GitHub-Statusmeldungen in Odoo.sh aktiviert sind.' : ''}</p>
            <form className="ev-dev-toolbar" onSubmit={event => { event.preventDefault(); runStatus() }}>
                <label className="ev-field"><span>Branch oder Commit (optional)</span><input value={ref} onChange={event => setRef(event.target.value)} maxLength={200} spellCheck={false} autoCapitalize="off" aria-invalid={!refValid || undefined}
                    placeholder={config.settings.odoo?.developmentBranch ?? 'Standard-Branch des Repositorys'} /></label>
                <button type="submit" disabled={status.busy || !refValid || repository.state === 'unbound'}>{status.busy ? 'Wird abgefragt …' : 'Status abrufen'}</button>
            </form>
            {!refValid && <p className="ev-dev-invalid" role="status">Gib einen Branch-Namen oder eine vollständige Commit-SHA ein.</p>}
            {repository.state === 'unbound' && <p className="ev-muted">Wähle oben ein Standard-Repository, um seinen Status abzurufen.</p>}
            {status.error && <p className="ev-error" role="alert">{status.error}</p>}
            {status.result && <BuildStatus response={status.result} projectId={projectId} />}
        </section>

        {context.integrations.length > 0 && <section className="ev-panel" aria-labelledby="ev-dev-integrations">
            <h2 id="ev-dev-integrations">Anbindungen</h2>
            <p className="ev-muted">Zugangsdaten verwaltest du im <WorkspaceLink tab="vault" projectId={projectId}>Tresor</WorkspaceLink>, unter <WorkspaceLink tab="github" projectId={projectId}>GitHub</WorkspaceLink> oder im <WorkspaceLink tab="mcp" projectId={projectId}>MCP-Shop</WorkspaceLink>.</p>
            <ul className="ev-dev-checks">{context.integrations.map(item => <li key={item.id}><div>
                <strong>{item.title}</strong><small>{item.detail}</small>
                {item.links.length > 0 && <ul className="ev-dev-links">{item.links.map(link => { const url = safeHttpsUrl(link.url); return <li key={`${link.label}:${link.url}`}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{link.label}</a> : <span>{link.label} (kein sicherer Link)</span>}</li> })}</ul>}
                {item.command && <p><small>Zum Kopieren, HAPI führt das nicht aus:</small> <code>{item.command.join(' ')}</code></p>}
                {item.kind === 'manual' && <small>Manuelle Einrichtung, keine aktive Verbindung.</small>}
            </div><span className="ev-dev-state" data-state={item.state === 'configured' ? 'ready' : item.state === 'unavailable' ? 'missing' : undefined}>{integrationStateText[item.state]}</span></li>)}</ul>
        </section>}
    </>
}

function InspectResult({ response }: { response: DevelopmentInspectResponse }) {
    const result = response.result
    if (!result) return <p className="ev-callout" role="status">{runnerStatusLabels[response.runner.status]}{response.message ? ` ${response.message}` : ''}</p>
    return <div aria-label="Ergebnis der Projektprüfung">
        <h3>Projektprüfung · {response.repository.fullName ?? `Repository ${result.repositoryId}`}</h3>
        <p className="ev-dev-meta"><span>Gelesen {formatTimestamp(result.observedAt)}</span><span>Branch {result.branch ?? 'unbekannt'}</span><span>Commit {result.head ? <code>{result.head.slice(0, 12)}</code> : 'unbekannt'}</span><span>{result.scanned.files} Dateien, {result.scanned.directories} Ordner{result.scanned.limitReached ? ' (Grenze erreicht, unvollständig)' : ''}</span></p>
        {result.state !== 'ready' && <p className="ev-callout" role="status">{result.state === 'missing' ? 'Das Repository ist im Projekt noch nicht geklont.' : 'Das Repository konnte nicht sicher gelesen werden.'}{result.message ? ` ${result.message}` : ''}</p>}
        {result.warnings.length > 0 && <ul className="ev-dev-links">{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        {result.mode === 'odoo' && (result.odooModules.length ? <ul className="ev-dev-checks ev-dev-scroll">{result.odooModules.map(module => <li key={module.path}><div>
            <strong>{module.technicalName}</strong><small>{module.path} · {module.name ?? 'ohne Namen'} · Version {module.version ?? 'fehlt'}{module.versionMatchesMajor === false ? ' (passt nicht zur Odoo-Version)' : ''}</small>
            <small>Abhängigkeiten: {module.depends.join(', ') || 'keine'} · Zugriffsrechte: {module.security.accessCsv ? `${module.security.accessRules ?? '?'} Regeln` : 'keine ir.model.access.csv'} · Tests: {module.counts.tests}{module.hasMigrations ? ' · Migrationen vorhanden' : ''}</small>
            {module.missingDataFiles.length > 0 && <small>Fehlende Datendateien: {module.missingDataFiles.join(', ')}</small>}
            {module.issues.length > 0 && <details><summary>{module.issues.length} Hinweise</summary><ul className="ev-dev-links">{module.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
        </div><span className="ev-dev-state" data-state={module.manifest === 'valid' && !module.issues.length ? 'ready' : 'missing'}>{module.manifest === 'valid' ? module.issues.length ? 'Hinweise' : 'Gültig' : module.manifest === 'unsafe' ? 'Nicht gelesen' : 'Ungültig'}</span></li>)}</ul>
            : <p className="ev-muted">Keine Odoo-Module in den Addon-Pfaden gefunden.</p>)}
        {result.buildFiles.length > 0 && <details><summary>{result.buildFiles.length} Build-Dateien</summary><ul className="ev-dev-checks ev-dev-scroll">{result.buildFiles.map(file => <li key={`${file.kind}:${file.path}`}><div><strong>{file.path}</strong>
            {file.facts && <small>{Object.entries(file.facts).map(([key, value]) => `${key}: ${value}`).join(' · ')}</small>}</div><span className="ev-dev-state">{file.kind}</span></li>)}</ul></details>}
    </div>
}

function BuildStatus({ response, projectId }: { response: DevelopmentBuildStatusResponse; projectId: string }) {
    const permission = response.state === 'permission_missing'
    return <div aria-label="Commit-Status">
        <p><span className="ev-dev-state" data-state={response.state}>{commitStateLabels[response.state]}</span> {response.fullName ?? ''}{response.ref ? ` · ${response.ref}` : ''}</p>
        <p className="ev-dev-meta"><span>Commit {response.sha ? <code>{response.sha.slice(0, 12)}</code> : 'nicht ermittelt'}</span><span>Abgefragt {formatTimestamp(response.observedAt)}</span><span>{response.totalCount} Statusquellen</span></p>
        <p className="ev-muted">{response.message}</p>
        {permission && <p className="ev-callout" role="status">Dem GitHub-Token fehlt die Berechtigung <strong>Commit statuses: Read-only</strong> für dieses Repository. Ergänze sie bei GitHub im fein abgestuften Token und ersetze das Token im Bereich GitHub. Schreibrechte auf Inhalte sind dafür nicht nötig. <WorkspaceLink tab="github" projectId={projectId}>GitHub öffnen</WorkspaceLink></p>}
        {response.state === 'credential_rejected' && <p className="ev-callout" role="status">GitHub hat das Token abgelehnt. Ersetze es im Bereich GitHub. <WorkspaceLink tab="github" projectId={projectId}>GitHub öffnen</WorkspaceLink></p>}
        {response.state === 'no_status' && <p className="ev-muted">Für diesen Commit liegt keine Statusmeldung vor. Das ist kein Erfolg.</p>}
        {response.statuses.length > 0 && <ul className="ev-dev-checks">{response.statuses.map(entry => { const url = safeHttpsUrl(entry.targetUrl); return <li key={entry.context}><div>
            <strong>{entry.context}</strong>{entry.description && <small>{entry.description}</small>}<small>{entry.updatedAt ? `Aktualisiert ${new Date(entry.updatedAt).toLocaleString('de-DE')}` : 'Zeitpunkt unbekannt'}{url && <> · <a href={url} target="_blank" rel="noopener noreferrer">Details</a></>}</small>
        </div><span className="ev-dev-state" data-state={entry.state === 'error' ? 'failure' : entry.state}>{entry.state === 'success' ? 'Erfolgreich' : entry.state === 'pending' ? 'Ausstehend' : 'Fehlgeschlagen'}</span></li> })}</ul>}
        {response.truncated && <p className="ev-muted">Nicht alle Statusquellen werden angezeigt; der Gesamtstatus berücksichtigt alle.</p>}
    </div>
}
