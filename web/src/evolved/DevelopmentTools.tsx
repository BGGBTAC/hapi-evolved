import { useEffect, useRef, useState } from 'react'
import { DevelopmentBuildStatusResponseSchema, GitRefSchema, ODOO_SH_ENVIRONMENTS, type DevelopmentBuildStatusResponse, type OdooShEnvironmentId } from '@hapi/protocol/evolvedDevelopment'
import {
    DevelopmentModuleDoctorResponseSchema, DevelopmentModuleInspectResponseSchema,
    type DevelopmentModuleContext, type DevelopmentModuleDoctorResponse, type DevelopmentModuleInspectResponse, type ProjectDevelopmentModuleConfig,
} from '@hapi/protocol/developmentModules'
import { useEvolved } from './auth'
import { EvolvedApiError } from './api'
import { WorkspaceLink } from './workspaceNavigation'
import {
    commitStateLabels, describeDevelopmentError, developmentPath, doctorStateLabels, formatTimestamp, runnerStatusLabels, safeHttpsUrl,
} from './developmentApi'

type Scoped<T> = { scope: string; value: T }
type ModuleView = NonNullable<DevelopmentModuleContext['module']>
const repositoryStateText = {
    unbound: 'Kein Standard-Repository gebunden.',
    granted: 'Freigegeben.',
    not_granted: 'Nicht mehr freigegeben. Gib es im Bereich GitHub erneut frei oder wähle ein anderes.',
    github_disconnected: 'GitHub ist nicht verbunden.',
    hidden: 'Details nicht sichtbar.',
    unknown: 'Freigabe konnte nicht geprüft werden.',
} as const
const environmentLabels: Record<OdooShEnvironmentId, string> = { staging: 'Staging', production: 'Produktion' }
const integrationStateText = { not_configured: 'Nicht eingerichtet', configured: 'Eingetragen', manual: 'Manuell', unavailable: 'Nicht verfügbar' } as const

/**
 * One explicit request at a time per action. Results are bound to the config revision and
 * module revision they were produced for and disappear when either changes or the panel unmounts.
 */
function useExplicitRequest<T>(scope: string, onModuleChanged?: () => void) {
    const [result, setResult] = useState<Scoped<T> | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const active = useRef<AbortController | null>(null)
    useEffect(() => () => active.current?.abort(), [])
    useEffect(() => { active.current?.abort(); active.current = null; setResult(null); setError(null); setBusy(false) }, [scope])
    const run = (work: (signal: AbortSignal) => Promise<T>) => {
        if (active.current) return
        const controller = new AbortController(); active.current = controller
        setBusy(true); setError(null); setResult(null)
        void work(controller.signal).then(
            value => { if (!controller.signal.aborted) setResult({ scope, value }) },
            failure => {
                if (controller.signal.aborted) return
                setError(describeDevelopmentError(failure))
                if (failure instanceof EvolvedApiError && ['development_module_changed', 'development_module_unavailable', 'development_changed'].includes(failure.code ?? '')) onModuleChanged?.()
            },
        ).finally(() => { if (active.current === controller) { active.current = null; setBusy(false) } })
    }
    return { result: result?.scope === scope ? result.value : null, error, busy, run }
}

export function DevelopmentTools({ config, context, module, unsaved, canRun, onContextRefresh, onModuleChanged, onOpenTask }: {
    config: ProjectDevelopmentModuleConfig; context: DevelopmentModuleContext; module: ModuleView; unsaved: boolean; canRun: boolean; onContextRefresh: () => void; onModuleChanged: () => void
    /** Opens the start form of a task of this module (nothing is started). */
    onOpenTask?: (taskId: string) => void
}) {
    const { api, project } = useEvolved()
    const projectId = project!.id
    const scope = `${config.revision}:${module.id}:${module.digest}`
    const doctor = useExplicitRequest<DevelopmentModuleDoctorResponse>(scope, onModuleChanged)
    const inspect = useExplicitRequest<DevelopmentModuleInspectResponse>(scope, onModuleChanged)
    const odoo = config.settings.activeModuleId === 'builtin:odoo'
    const odooSh = odoo && config.settings.odoo?.hosting === 'odoo_sh' ? config.settings.odoo.odooSh : null
    // Explicit status target: one Odoo.sh stage (its saved branch) or a typed branch/commit. Never a silent default.
    const [target, setTarget] = useState<OdooShEnvironmentId | 'ref'>('ref')
    const [ref, setRef] = useState('')
    const statusTarget = target !== 'ref' && odooSh ? { environment: target, branch: odooSh[target].branch } : null
    const status = useExplicitRequest<DevelopmentBuildStatusResponse>(`${scope}:${statusTarget ? `env:${statusTarget.environment}` : `ref:${ref.trim()}`}`)
    const refValid = !!ref.trim() && GitRefSchema.safeParse(ref.trim()).success
    const blocker = !canRun ? 'Prüfungen brauchen die Rolle Mitglied oder Administrator.' : unsaved ? 'Speichere oder verwirf zuerst deine Änderungen. Prüfungen nutzen nur die gespeicherte Konfiguration.' : null
    const repository = context.repository
    const doctorBlocker = blocker ?? (!module.doctor ? 'Dieses Modul bietet keine Werkzeugprüfung.' : null)
    const inspectBlocker = blocker ?? (!module.inspect ? 'Dieses Modul bietet keine Projektprüfung.' : repository.state !== 'granted' ? 'Für die Projektprüfung braucht es ein freigegebenes Standard-Repository.' : null)
    // Both checks bind the module and revision shown here; the hub refuses them for any other module revision.
    const binding = { moduleId: module.id, moduleDigest: module.digest }
    const bound = <T extends { moduleId: string; moduleDigest: string }>(value: T): T => {
        if (value.moduleId !== binding.moduleId || value.moduleDigest !== binding.moduleDigest) throw new Error('Die Antwort gehört zu einer anderen Modulfassung und wird nicht angezeigt.')
        return value
    }
    const runDoctor = () => doctor.run(async signal => bound(DevelopmentModuleDoctorResponseSchema.parse(await api.request(developmentPath(projectId, '/modules-doctor'), { method: 'POST', body: binding, signal }))))
    const runInspect = () => inspect.run(async signal => bound(DevelopmentModuleInspectResponseSchema.parse(await api.request(developmentPath(projectId, '/modules-inspect'), { method: 'POST', body: binding, signal }))))
    const statusBlocker = statusTarget ? (!statusTarget.branch ? `Für ${environmentLabels[statusTarget.environment]} ist kein Branch gespeichert.` : null) : !refValid ? 'Gib einen Branch-Namen oder eine vollständige Commit-SHA ein.' : null
    const runStatus = () => {
        if (statusBlocker) return
        const requested = statusTarget ? { environment: statusTarget.environment, ref: statusTarget.branch! } : { environment: null, ref: ref.trim() }
        const query = new URLSearchParams(statusTarget ? { environment: statusTarget.environment } : { ref: requested.ref })
        status.run(async signal => {
            const response = DevelopmentBuildStatusResponseSchema.parse(await api.request(developmentPath(projectId, `/build-status?${query}`), { signal }))
            // A result is shown only for exactly the requested stage, ref and saved revision; staging never stands in for production.
            if (response.environment !== requested.environment || response.ref !== requested.ref || response.revision !== config.revision) throw new Error('Die Antwort gehört zu einem anderen Ziel oder einer anderen Revision und wird nicht angezeigt.')
            return response
        })
    }
    const doctorResult = doctor.result
    const fresh = doctorResult?.result && doctorResult.revision === config.revision ? doctorResult.result : null
    const last = context.lastDoctor?.moduleDigest === module.digest ? context.lastDoctor : null

    return <>
        <section className="ev-panel" aria-labelledby="ev-dev-tools">
            <h2 id="ev-dev-tools">Werkzeuge und Projekt prüfen</h2>
            <p className="ev-muted">Nur lesend auf dem Projektrunner. „Gefunden“ heißt: auf diesem Runner vorhanden.{module.doctor ? ` ${module.doctor.checks.length} Prüfungen für die gespeicherten Einstellungen.` : ''}</p>
            <dl className="ev-dev-meta"><div><dt>Standard-Repository</dt><dd>{repository.fullName ?? repository.repositoryId ?? '—'} · {repository.message ?? repositoryStateText[repository.state]}</dd></div></dl>
            {repository.state !== 'granted' && repository.state !== 'unbound' && <p className="ev-muted"><WorkspaceLink tab="github" projectId={projectId}>Repository-Freigaben prüfen</WorkspaceLink></p>}
            {(blocker ?? doctorBlocker) && <p className="ev-muted" role="status">{blocker ?? doctorBlocker}</p>}
            <div className="ev-actions">
                <button type="button" className="ev-primary" disabled={!!doctorBlocker || doctor.busy} onClick={runDoctor}>{doctor.busy ? 'Werkzeuge werden geprüft …' : 'Werkzeuge prüfen'}</button>
                <button type="button" disabled={!!inspectBlocker || inspect.busy} onClick={runInspect} title={inspectBlocker ?? undefined}>{inspect.busy ? 'Projekt wird gelesen …' : odoo ? 'Odoo-Module prüfen' : 'Projektdateien prüfen'}</button>
                <button type="button" disabled={doctor.busy || inspect.busy} onClick={onContextRefresh}>Kontext aktualisieren</button>
            </div>
            {!blocker && inspectBlocker && <p className="ev-muted">{inspectBlocker}</p>}
            {doctor.error && <p className="ev-error" role="alert">{doctor.error}</p>}
            {!doctorResult && !doctor.busy && last && <p className="ev-muted" role="status">Letzte Prüfung für Revision {last.revision}: {formatTimestamp(last.observedAt)} · {last.ready} gefunden, {last.missing} fehlen, {last.unsupported} nicht unterstützt, {last.unknown} unbekannt, {last.warning} zu prüfen. Führe die Prüfung aus, um Details zu sehen.</p>}
            {!doctorResult && !doctor.busy && last && last.revision === config.revision && !!last.missingRequired?.length && <ul className="ev-dev-checks" aria-label="Offene Pflichtprüfungen der letzten Prüfung">{last.missingRequired.map(item => <li key={item.id}><div>
                <strong>{module.doctor?.checks.find(check => check.id === item.id)?.label ?? item.id}</strong>
                <small>{item.remedyKind === 'operator' ? 'Betreiber: Das Runner-Image muss das Werkzeug mitbringen.' : item.remedyKind === 'recipe' ? 'Lässt sich mit einer Einrichtungsaufgabe beheben.' : item.remedyKind === 'manual' || item.remedyKind === 'docs' ? 'Manuelle Abhilfe, siehe Prüfdetails.' : 'Keine Abhilfe angegeben.'}</small>
                {item.recipeId && <RemedyTasks recipeId={item.recipeId} module={module} onOpenTask={onOpenTask} />}
            </div><span className="ev-dev-state" data-state={item.state === 'warning' ? undefined : 'missing'}>{doctorStateLabels[item.state]}</span></li>)}</ul>}
            {!doctorResult && !doctor.busy && !last && !doctor.error && module.doctor && <p className="ev-muted" role="status">Noch keine Werkzeugprüfung für diese Revision.</p>}
            {doctorResult && !doctorResult.result && <p className="ev-callout" role="status">{runnerStatusLabels[doctorResult.runner.status]}{doctorResult.runner.missingCapabilities.length ? ' Dem Runner fehlt die passende Prüffähigkeit.' : ''}{doctorResult.message ? ` ${doctorResult.message}` : ''}</p>}
            {fresh && <div aria-label="Ergebnis der Werkzeugprüfung">
                <p className="ev-dev-meta"><span>Geprüft {formatTimestamp(fresh.observedAt)}</span><span>Dauer {Math.round(fresh.durationMs / 100) / 10} s</span><span>{fresh.host.os}/{fresh.host.arch}</span><span>Image: {fresh.host.image ?? 'unbekannt'}</span><span>Revision {doctorResult!.revision}</span></p>
                <ul className="ev-dev-checks ev-dev-scroll">{fresh.checks.map(check => <li key={check.id}><div>
                    <strong>{check.label}</strong>{check.version && <small>{check.version}</small>}{check.detail && <small>{check.detail}</small>}
                    {check.remedy && check.state !== 'ready' && <small>Abhilfe: {check.remedy.text}{safeHttpsUrl(check.remedy.url) && <> · <a href={safeHttpsUrl(check.remedy.url)!} target="_blank" rel="noopener noreferrer">Dokumentation</a></>}</small>}
                    {check.remedy?.recipeId && check.state !== 'ready' && <RemedyTasks recipeId={check.remedy.recipeId} module={module} onOpenTask={onOpenTask} />}
                </div><span className="ev-dev-state" data-state={check.state}>{doctorStateLabels[check.state]}</span></li>)}</ul>
                {fresh.truncated && <p className="ev-muted">Die Liste wurde gekürzt.</p>}
            </div>}
            {inspect.error && <p className="ev-error" role="alert">{inspect.error}</p>}
            {inspect.result && <InspectResult response={inspect.result} odooMajor={odoo ? config.settings.odoo?.major : null} />}
        </section>

        <section className="ev-panel" aria-labelledby="ev-dev-status">
            <h2 id="ev-dev-status">GitHub-Commit-Status</h2>
            <p className="ev-muted">Kombinierter Commit-Status des Standard-Repositorys aus GitHub; keine Check-Runs.{odoo ? ' Odoo.sh meldet hier nur, wenn GitHub-Statusmeldungen in Odoo.sh aktiviert sind.' : ''}</p>
            <form className="ev-dev-toolbar" onSubmit={event => { event.preventDefault(); runStatus() }}>
                {odooSh && <fieldset className="ev-dev-choices ev-dev-status-target"><legend>Ziel</legend>
                    {([...ODOO_SH_ENVIRONMENTS, 'ref'] as const).map(id => <label key={id} className="ev-check"><input type="radio" name="ev-dev-status-target" checked={target === id} onChange={() => setTarget(id)} />
                        {id === 'ref' ? 'Eigener Branch oder Commit' : `${environmentLabels[id]}${odooSh[id].branch ? ` (${odooSh[id].branch})` : ' (kein Branch gespeichert)'}`}</label>)}
                </fieldset>}
                {!statusTarget && <label className="ev-field"><span>Branch oder Commit</span><input value={ref} onChange={event => setRef(event.target.value)} maxLength={200} spellCheck={false} autoCapitalize="off" aria-invalid={(!!ref.trim() && !refValid) || undefined}
                    aria-describedby={statusBlocker ? 'ev-dev-status-blocker' : undefined} placeholder={(odoo ? config.settings.odoo?.developmentBranch : null) ?? 'z. B. main'} /></label>}
                <button type="submit" disabled={status.busy || !!statusBlocker || repository.state === 'unbound'}>{status.busy ? 'Wird abgefragt …' : 'Status abrufen'}</button>
            </form>
            {statusBlocker && <p className="ev-muted" role="status" id="ev-dev-status-blocker">{statusBlocker}</p>}
            {repository.state === 'unbound' && <p className="ev-muted">Wähle oben ein Standard-Repository, um seinen Status abzurufen.</p>}
            {status.error && <p className="ev-error" role="alert">{status.error}</p>}
            {status.result && <BuildStatus response={status.result} projectId={projectId} odooSh={!!odooSh} />}
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

/** Tasks of this module that use the remedy recipe; none or several are said as such instead of guessing. */
function RemedyTasks({ recipeId, module, onOpenTask }: { recipeId: string; module: ModuleView; onOpenTask?: (taskId: string) => void }) {
    const recipe = module.recipes.find(item => item.id === recipeId)
    const tasks = module.tasks.filter(task => task.recipeIds.includes(recipeId))
    const name = recipe?.title ?? recipeId
    if (!tasks.length) return <small>Keine Aufgabe dieses Moduls führt den Ablauf „{name}“ aus. Folge der Abhilfe von Hand oder wende dich an den Betreiber.</small>
    return <span className="ev-dev-remedy">
        <small>{tasks.length === 1 ? `Passende Aufgabe für den Ablauf „${name}“:` : `${tasks.length} Aufgaben verwenden den Ablauf „${name}“. Wähle bewusst:`} Das Öffnen zeigt nur das Startformular mit allen Auswirkungen; gestartet wird erst dort.</small>
        {onOpenTask && <span className="ev-actions">{tasks.map(task => <button type="button" key={task.id} onClick={() => onOpenTask(task.id)}>Aufgabe öffnen: {task.title}</button>)}</span>}
    </span>
}

/** Odoo 19 lists access rules in ir.model.access.csv, Odoo 20 in ir.access.csv; without a known version the wording stays neutral. */
function accessFileName(major: number | null | undefined) {
    return major === 19 ? 'ir.model.access.csv' : major === 20 ? 'ir.access.csv' : null
}

function InspectResult({ response, odooMajor }: { response: DevelopmentModuleInspectResponse; odooMajor?: number | null }) {
    const accessFile = accessFileName(odooMajor)
    const result = response.result
    if (!result) return <p className="ev-callout" role="status">{runnerStatusLabels[response.runner.status]}{response.message ? ` ${response.message}` : ''}</p>
    return <div aria-label="Ergebnis der Projektprüfung">
        <h3>Projektprüfung · {response.repository.fullName ?? `Repository ${result.repositoryId}`}</h3>
        <p className="ev-dev-meta"><span>Gelesen {formatTimestamp(result.observedAt)}</span><span>Branch {result.branch ?? 'unbekannt'}</span><span>Commit {result.head ? <code>{result.head.slice(0, 12)}</code> : 'unbekannt'}</span><span>{result.scanned.files} Dateien, {result.scanned.directories} Ordner{result.scanned.limitReached ? ' (Grenze erreicht, unvollständig)' : ''}</span></p>
        {result.state !== 'ready' && <p className="ev-callout" role="status">{result.state === 'missing' ? 'Das Repository ist im Projekt noch nicht geklont.' : 'Das Repository konnte nicht sicher gelesen werden.'}{result.message ? ` ${result.message}` : ''}</p>}
        {result.warnings.length > 0 && <ul className="ev-dev-links">{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        {(result.provider.id === 'builtin.odoo' || result.odooModules.length > 0) && (result.odooModules.length ? <ul className="ev-dev-checks ev-dev-scroll">{result.odooModules.map(module => <li key={module.path}><div>
            <strong>{module.technicalName}</strong><small>{module.path} · {module.name ?? 'ohne Namen'} · Version {module.version ?? 'fehlt'}{module.versionMatchesMajor === false ? ' (passt nicht zur Odoo-Version)' : ''}</small>
            <small>Abhängigkeiten: {module.depends.join(', ') || 'keine'} · Zugriffsrechte: {module.security.accessCsv ? `${module.security.accessRules ?? '?'} Regeln` : accessFile ? `keine Zugriffsdatei (Odoo ${odooMajor}: security/${accessFile})` : 'keine Zugriffsdatei'} · Tests: {module.counts.tests}{module.hasMigrations ? ' · Migrationen vorhanden' : ''}</small>
            {module.missingDataFiles.length > 0 && <small>Fehlende Datendateien: {module.missingDataFiles.join(', ')}</small>}
            {module.issues.length > 0 && <details><summary>{module.issues.length} Hinweise</summary><ul className="ev-dev-links">{module.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
        </div><span className="ev-dev-state" data-state={module.manifest === 'valid' && !module.issues.length ? 'ready' : 'missing'}>{module.manifest === 'valid' ? module.issues.length ? 'Hinweise' : 'Gültig' : module.manifest === 'unsafe' ? 'Nicht gelesen' : 'Ungültig'}</span></li>)}</ul>
            : <p className="ev-muted">Keine Odoo-Module in den Addon-Pfaden gefunden.</p>)}
        {result.buildFiles.length > 0 && <details><summary>{result.buildFiles.length} Build-Dateien</summary><ul className="ev-dev-checks ev-dev-scroll">{result.buildFiles.map(file => <li key={`${file.kind}:${file.path}`}><div><strong>{file.path}</strong>
            {file.facts && <small>{Object.entries(file.facts).map(([key, value]) => `${key}: ${value}`).join(' · ')}</small>}</div><span className="ev-dev-state">{file.kind}</span></li>)}</ul></details>}
    </div>
}

function BuildStatus({ response, projectId, odooSh }: { response: DevelopmentBuildStatusResponse; projectId: string; odooSh: boolean }) {
    const permission = response.state === 'permission_missing'
    return <div aria-label="Commit-Status">
        <p><span className="ev-dev-state" data-state={response.state}>{commitStateLabels[response.state]}</span> {response.environment ? <strong>{environmentLabels[response.environment]} · </strong> : null}{response.fullName ?? ''}{response.ref ? ` · ${response.ref}` : ''}</p>
        <p className="ev-dev-meta"><span>Commit {response.sha ? <code>{response.sha.slice(0, 12)}</code> : 'nicht ermittelt'}</span><span>Abgefragt {formatTimestamp(response.observedAt)}</span><span>{response.totalCount} Statusquellen</span></p>
        <p className="ev-muted">{response.message}</p>
        {permission && <p className="ev-callout" role="status">Dem GitHub-Token fehlt die Berechtigung <strong>Commit statuses: Read-only</strong> für dieses Repository. Ergänze sie bei GitHub im fein abgestuften Token und ersetze das Token im Bereich GitHub. Schreibrechte auf Inhalte sind dafür nicht nötig. <WorkspaceLink tab="github" projectId={projectId}>GitHub öffnen</WorkspaceLink></p>}
        {response.state === 'credential_rejected' && <p className="ev-callout" role="status">GitHub hat das Token abgelehnt. Ersetze es im Bereich GitHub. <WorkspaceLink tab="github" projectId={projectId}>GitHub öffnen</WorkspaceLink></p>}
        {response.state === 'no_status' && <p className="ev-muted">Für diesen Commit liegt keine Statusmeldung vor. Das ist kein Erfolg.{odooSh ? ' Odoo.sh meldet nur, wenn in den Odoo.sh-Projekteinstellungen ein GitHub-Token mit „Commit statuses: Read and write“ hinterlegt ist.' : ''}</p>}
        {response.statuses.length > 0 && <ul className="ev-dev-checks">{response.statuses.map(entry => { const url = safeHttpsUrl(entry.targetUrl); return <li key={entry.context}><div>
            <strong>{entry.context}</strong>{entry.description && <small>{entry.description}</small>}<small>{entry.updatedAt ? `Aktualisiert ${new Date(entry.updatedAt).toLocaleString('de-DE')}` : 'Zeitpunkt unbekannt'}{url && <> · <a href={url} target="_blank" rel="noopener noreferrer">Details</a></>}</small>
        </div><span className="ev-dev-state" data-state={entry.state === 'error' ? 'failure' : entry.state}>{entry.state === 'success' ? 'Erfolgreich' : entry.state === 'pending' ? 'Ausstehend' : 'Fehlgeschlagen'}</span></li> })}</ul>}
        {response.truncated && <p className="ev-muted">Nicht alle Statusquellen werden angezeigt; der Gesamtstatus berücksichtigt alle.</p>}
    </div>
}
