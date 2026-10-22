import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { isProjectAdmin, projectPath } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit, useAction } from './ui'

type RunnerLease = { id: string; name: string; scopes: string[]; actionIds: string[]; profile: string; createdAt: number; expiresAt: number | null; revokedAt: number | null }
type NewLease = { id: string; token: string; expiresAt: number | null; projectId: string; profile: string }
const permissions = [
    ['runner:connect', 'Agenten verbinden'], ['git:read', 'GitHub-Repositorys lesen'], ['git:write', 'In GitHub-Repositorys pushen'], ['memory:read', 'Gedächtnis lesen'],
    ['memory:write', 'Wissen vorschlagen'], ['codegraph:read', 'Codegraph lesen'],
    ['peers:read', 'Projekt-Agenten auflisten'], ['peers:send', 'Nachrichten an Projekt-Agenten senden'], ['peers:manage', 'Projekt-Agenten starten und archivieren'],
    ['resource:execute', 'Freigegebene Ressourcenaktionen ausführen'],
] as const
export function downloadOperatorFile(value: string, name: string): void {
    const url = URL.createObjectURL(new Blob([`${value}\n`], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = name; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function RunnerPanel() {
    const { api, me, project } = useEvolved()
    return <RunnerForProject key={`${api.baseUrl}:${me.user.id}:${project?.id}:${project?.role}:${project?.profile}`} />
}
function RunnerExplanation() {
    return <div><div className="ev-runner-intro">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="3" /><path d="m7 8 3 3-3 3M13 13h4M8 21h8M12 17v4" /></svg>
        <div><h2>Dein Arbeitsdienst</h2><p>Der Runner führt Claude oder Codex aus und arbeitet mit deinen Projektdateien. Hier verwaltest du seinen Zugang zu HAPI.</p></div>
    </div><details className="ev-disclosure"><summary>Was bedeutet der Runner-Zugang?</summary><div className="ev-stack">
        <p>Hier erstellst du nur die Zugangsdaten. Installation und Start des Dienstes übernimmt der Betreiber auf dem Server.</p>
        <p>Dauerhafte Zugänge haben kein Ablaufdatum. Befristete gelten höchstens 7 Tage; danach stoppt der Runner, bis ein neuer Zugang eingerichtet ist. Diese Gültigkeit ist kein Zeitlimit für dein Anbieterabo.</p>
        <p>Widerruf, Profilwechsel und Änderungen der zugehörigen Rollen können auch dauerhafte Zugänge beenden. Projektdateien und gespeicherte Anbieteranmeldungen bleiben erhalten.</p>
    </div></details></div>
}
function RunnerForProject() {
    const { api, me, project } = useEvolved()
    const admin = isProjectAdmin(project?.role)
    const path = `${projectPath(project!.id)}/runner-leases`
    const leases = useQuery({ queryKey: ['evolved', 'runner-leases', api.baseUrl, me.user.id, project!.id], enabled: admin, queryFn: ({ signal }) => api.request<{ leases: RunnerLease[] }>(path, { signal }) })
    const [name, setName] = useState('')
    const canPush = project?.profile === 'workspace' || project?.profile === 'extended'
    const [scopes, setScopes] = useState<string[]>([
        'runner:connect', 'git:read', 'memory:read', 'memory:write', 'codegraph:read',
        'peers:read', 'peers:send', 'peers:manage', ...(canPush ? ['git:write'] : []),
    ])
    const [actionIds, setActionIds] = useState('')
    const [validity, setValidity] = useState<'permanent' | 'limited'>('permanent')
    const [hours, setHours] = useState('24')
    const [created, setCreated] = useState<NewLease | null>(null)
    const [saved, setSaved] = useState(false)
    const action = useAction()
    const providerLink = <div className="ev-actions"><a className="ev-session-link" href={`/evolved?tab=providers&project=${encodeURIComponent(project!.id)}`}>Abos verbinden <span aria-hidden="true">↗</span></a><span className="ev-provider-caption">Claude und ChatGPT direkt im Browser anmelden.</span></div>
    if (!admin) return <div className="ev-stack"><RunnerExplanation />{providerLink}<Panel title="Runner-Zugänge"><Empty>Runner-Zugänge werden von Projektadministratoren verwaltet.</Empty></Panel></div>
    return <div className="ev-stack"><RunnerExplanation />{providerLink}<Panel title="Runner-Zugänge" description="Zugänge für diesen Arbeitsdienst und das aktuelle Projektprofil.">
        <ErrorNotice error={leases.error} />{leases.isPending ? <Loading /> : !leases.data?.leases.length ? <Empty>Noch kein Runner-Zugang vorhanden.</Empty> : <div className="ev-list">{leases.data.leases.map(lease => <div className="ev-row" key={lease.id}><div><strong>{lease.name}</strong><small>{lease.profile} · {lease.scopes.join(', ')}</small>{lease.actionIds.length > 0 && <small>Ressourcen: {lease.actionIds.join(', ')}</small>}<small>{lease.revokedAt ? `Widerrufen am ${formatDate(lease.revokedAt)}` : lease.expiresAt === null ? 'Dauerhaft – bis zum Widerruf' : `${lease.expiresAt <= Date.now() ? 'Abgelaufen' : 'Gültig'} bis ${formatDate(lease.expiresAt)}`}</small></div>{!lease.revokedAt && (lease.expiresAt === null || lease.expiresAt > Date.now()) && <ConfirmButton label="Widerrufen" detail={`${lease.name} sofort den Zugang entziehen?`} disabled={action.busy} onConfirm={() => void action.run(async () => { await api.request(`${path}/${encodeURIComponent(lease.id)}`, { method: 'DELETE' }); if (created?.id === lease.id) setCreated(null); await leases.refetch() }, 'Runner-Zugang widerrufen.')} />}</div>)}</div>}
    </Panel>
    {created && <Panel title="Runner-Zugang einmalig sichern" description="Diese Datei gehört ausschließlich in den geschützten Operatorbereich des Runner-Proxys. Sie darf weder im Projektverzeichnis noch in Agentenprompts oder Logs landen.">
        <Field label="Einmaliger Runner-Schlüssel"><input readOnly type="password" value={created.token} autoComplete="off" onFocus={event => event.target.select()} /></Field><p className="ev-muted">{created.expiresAt === null ? 'Dauerhaft – bis zum Widerruf.' : `Gültig bis ${formatDate(created.expiresAt)}.`} Nach dem Schließen kann dieser Schlüssel nicht erneut abgerufen werden.</p>
        <button onClick={() => downloadOperatorFile(created.token, 'hapi-evolved-runner-lease.txt')}>Operator-Datei herunterladen</button><p className="ev-muted">Lege die Datei mit Zugriffsrechten 0600 beim Runner-Proxy ab.</p>
        <label className="ev-check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />Ich habe die Operator-Datei sicher abgelegt.</label><button disabled={!saved} onClick={() => { setCreated(null); setSaved(false) }}>Schlüssel schließen</button>
    </Panel>}
    <Panel title="Runner-Zugang erstellen" description="Zugang für deinen Arbeitsdienst. Bestätigung per Passkey erforderlich."><form className="ev-stack" onSubmit={submit(() => void action.run(async () => {
        const allowedScopes = scopes.filter(scope => scope !== 'git:write' || canPush)
        const result = await api.request<NewLease>(path, { method: 'POST', body: { name: name.trim(), scopes: allowedScopes, actionIds: allowedScopes.includes('resource:execute') ? [...new Set(actionIds.split(/[\s,]+/).filter(Boolean))] : [], expiresInSeconds: validity === 'permanent' ? null : Math.round(Number(hours) * 3600) } })
        setCreated(result); setSaved(false); setName(''); await leases.refetch()
    }))}><Field label="Runner-Name"><input required value={name} maxLength={120} onChange={event => setName(event.target.value)} /></Field>
        <fieldset disabled={action.busy}><legend>Gültigkeit des HAPI-Zugangs</legend><div className="ev-choice-group">
            <label className="ev-choice"><input type="radio" name="runner-validity" value="permanent" aria-label="Dauerhaft – bis zum Widerruf" checked={validity === 'permanent'} onChange={() => setValidity('permanent')} /><span><strong>Dauerhaft</strong><small>Bis zum Widerruf</small></span></label>
            <label className="ev-choice"><input type="radio" name="runner-validity" value="limited" aria-label="Befristet" checked={validity === 'limited'} onChange={() => setValidity('limited')} /><span><strong>Befristet</strong><small>1–168 Stunden</small></span></label>
        </div>
        </fieldset>
        {validity === 'limited' && <Field label="HAPI-Zugang gültig für (Stunden, maximal 168)"><input type="number" min="1" max="168" step="1" required value={hours} onChange={event => setHours(event.target.value)} /></Field>}
        <details className="ev-disclosure"><summary>Berechtigungen anpassen · {scopes.length} ausgewählt</summary><fieldset disabled={action.busy}><legend className="ev-sr-only">Berechtigungen</legend><div className="ev-permission-grid">{permissions.map(([scope, label]) => <label className="ev-check" key={scope}><input type="checkbox" checked={scopes.includes(scope) && (scope !== 'git:write' || canPush)} disabled={scope === 'git:write' && !canPush} onChange={event => setScopes(previous => event.target.checked ? [...previous, scope] : previous.filter(item => item !== scope))} />{label}</label>)}</div></fieldset></details>
        <p className="ev-muted">Die Standardauswahl erlaubt alle integrierten Projektdienste. Git-Zugriff gilt nur für die unter „GitHub“ freigegebenen Repositorys; im eingeschränkten Profil bleibt Push gesperrt. Externe Ressourcenaktionen brauchen zusätzliche, einzeln freigegebene IDs.</p>
        {scopes.includes('resource:execute') && <Field label="Freigegebene Ressourcen-IDs" hint="Komma oder Leerzeichen als Trennzeichen. Nur diese vorkonfigurierten Aktionen sind erlaubt."><textarea rows={2} value={actionIds} onChange={event => setActionIds(event.target.value)} /></Field>}
        <button className="ev-primary" disabled={action.busy || !name.trim() || !scopes.length || !!created}>Runner-Zugang erstellen</button>
    </form></Panel><ActionStatus action={action} /></div>
}
