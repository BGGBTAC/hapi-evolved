import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { isProjectAdmin, projectPath } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit, useAction } from './ui'

type RunnerLease = { id: string; name: string; scopes: string[]; actionIds: string[]; profile: string; createdAt: number; expiresAt: number; revokedAt: number | null }
type NewLease = { id: string; token: string; expiresAt: number; projectId: string; profile: string }
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
function RunnerForProject() {
    const { api, me, project } = useEvolved()
    const admin = isProjectAdmin(project?.role)
    const path = `${projectPath(project!.id)}/runner-leases`
    const leases = useQuery({ queryKey: ['evolved', 'runner-leases', api.baseUrl, me.user.id, project!.id], enabled: admin, queryFn: ({ signal }) => api.request<{ leases: RunnerLease[] }>(path, { signal }) })
    const [name, setName] = useState('')
    const canPush = project?.profile === 'workspace' || project?.profile === 'extended'
    const [scopes, setScopes] = useState<string[]>(['runner:connect', 'git:read', ...(canPush ? ['git:write'] : [])])
    const [actionIds, setActionIds] = useState('')
    const [hours, setHours] = useState('24')
    const [created, setCreated] = useState<NewLease | null>(null)
    const [saved, setSaved] = useState(false)
    const action = useAction()
    if (!admin) return <Panel title="Runner-Zugänge"><Empty>Runner-Zugänge werden von Projektadministratoren verwaltet.</Empty></Panel>
    return <div className="ev-stack"><Panel title="Runner-Zugänge" description="Ein zeitlich begrenzter Zugang verbindet einen isolierten Runner mit genau diesem Projekt und dem aktuellen Ausführungsprofil.">
        <ErrorNotice error={leases.error} />{leases.isPending ? <Loading /> : !leases.data?.leases.length ? <Empty>Noch kein Runner-Zugang vorhanden.</Empty> : <div className="ev-list">{leases.data.leases.map(lease => <div className="ev-row" key={lease.id}><div><strong>{lease.name}</strong><small>{lease.profile} · {lease.scopes.join(', ')}</small>{lease.actionIds.length > 0 && <small>Ressourcen: {lease.actionIds.join(', ')}</small>}<small>{lease.revokedAt ? `Widerrufen am ${formatDate(lease.revokedAt)}` : `${lease.expiresAt <= Date.now() ? 'Abgelaufen' : 'Gültig'} bis ${formatDate(lease.expiresAt)}`}</small></div>{!lease.revokedAt && lease.expiresAt > Date.now() && <ConfirmButton label="Widerrufen" detail={`${lease.name} sofort den Zugang entziehen?`} disabled={action.busy} onConfirm={() => void action.run(async () => { await api.request(`${path}/${encodeURIComponent(lease.id)}`, { method: 'DELETE' }); if (created?.id === lease.id) setCreated(null); await leases.refetch() }, 'Runner-Zugang widerrufen.')} />}</div>)}</div>}
    </Panel>
    {created && <Panel title="Runner-Zugang einmalig sichern" description="Diese Datei gehört ausschließlich in den geschützten Operatorbereich des Runner-Proxys. Sie darf weder im Projektverzeichnis noch in Agentenprompts oder Logs landen.">
        <Field label="Einmaliger Runner-Schlüssel"><input readOnly type="password" value={created.token} autoComplete="off" onFocus={event => event.target.select()} /></Field><p className="ev-muted">Gültig bis {formatDate(created.expiresAt)}. Nach dem Schließen kann dieser Schlüssel nicht erneut abgerufen werden.</p>
        <button onClick={() => downloadOperatorFile(created.token, 'hapi-evolved-runner-lease.txt')}>Operator-Datei herunterladen</button><p className="ev-muted">Lege die Datei mit Zugriffsrechten 0600 beim Runner-Proxy ab.</p>
        <label className="ev-check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />Ich habe die Operator-Datei sicher abgelegt.</label><button disabled={!saved} onClick={() => { setCreated(null); setSaved(false) }}>Schlüssel schließen</button>
    </Panel>}
    <Panel title="Runner-Zugang erstellen" description="Eine frische Passkey-Bestätigung ist erforderlich. Ein Profilwechsel macht bisherige Runner-Zugänge ungültig."><form className="ev-stack" onSubmit={submit(() => void action.run(async () => {
        const allowedScopes = scopes.filter(scope => scope !== 'git:write' || canPush)
        const result = await api.request<NewLease>(path, { method: 'POST', body: { name: name.trim(), scopes: allowedScopes, actionIds: allowedScopes.includes('resource:execute') ? [...new Set(actionIds.split(/[\s,]+/).filter(Boolean))] : [], expiresInSeconds: Math.round(Number(hours) * 3600) } })
        setCreated(result); setSaved(false); setName(''); await leases.refetch()
    }))}><div className="ev-form-grid"><Field label="Runner-Name"><input required value={name} maxLength={120} onChange={event => setName(event.target.value)} /></Field><Field label="Gültigkeit (Stunden, maximal 168)"><input type="number" min="1" max="168" step="1" required value={hours} onChange={event => setHours(event.target.value)} /></Field></div>
        <fieldset disabled={action.busy}><legend>Berechtigungen</legend>{permissions.map(([scope, label]) => <label className="ev-check" key={scope}><input type="checkbox" checked={scopes.includes(scope) && (scope !== 'git:write' || canPush)} disabled={scope === 'git:write' && !canPush} onChange={event => setScopes(previous => event.target.checked ? [...previous, scope] : previous.filter(item => item !== scope))} />{label}</label>)}</fieldset>
        <p className="ev-muted">Git-Zugriff gilt nur für die unter „GitHub“ freigegebenen Repositorys. Im eingeschränkten Profil bleibt Push gesperrt.</p>
        {scopes.includes('resource:execute') && <Field label="Freigegebene Ressourcen-IDs" hint="Komma oder Leerzeichen als Trennzeichen. Nur diese vorkonfigurierten Aktionen sind erlaubt."><textarea rows={2} value={actionIds} onChange={event => setActionIds(event.target.value)} /></Field>}
        <button className="ev-primary" disabled={action.busy || !name.trim() || !scopes.length || !!created}>Runner-Zugang erstellen</button>
    </form></Panel><ActionStatus action={action} /></div>
}
