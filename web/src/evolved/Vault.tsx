import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isCredentialEnvName } from '@hapi/protocol/credentialEnv'
import { useEvolved } from './auth'
import { isProjectAdmin, projectPath, type AgentCredentialGrants, type Resource, type SecretMetadata } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit, useAction } from './ui'

export function VaultPanel() {
    const { api, me, project } = useEvolved()
    return <VaultForProject key={`${api.baseUrl}:${me.user.id}:${project!.id}:${project!.role}:${project!.profile}`} />
}
function VaultForProject() {
    const { api, me, project } = useEvolved()
    const path = projectPath(project!.id)
    const admin = isProjectAdmin(project!.role)
    const secrets = useQuery({ queryKey: ['evolved', 'secrets', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile], queryFn: ({ signal }) => api.request<{ secrets: SecretMetadata[] }>(`${path}/secrets`, { signal }) })
    const resources = useQuery({ queryKey: ['evolved', 'resources', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile], queryFn: ({ signal }) => api.request<{ resources: Resource[] }>(`${path}/resources`, { signal }) })
    const grants = useQuery({ queryKey: ['evolved', 'secret-grants', api.baseUrl, me.user.id, project!.id, project!.role, project!.profile], queryFn: ({ signal }) => api.request<AgentCredentialGrants>(`${path}/secret-grants`, { signal }) })
    const action = useAction()
    const [name, setName] = useState('')
    const [value, setValue] = useState('')
    const [editingId, setEditingId] = useState<string | null>(null)
    const [result, setResult] = useState<Record<string, unknown> | null>(null)
    const [grantSecretId, setGrantSecretId] = useState('')
    const [envName, setEnvName] = useState('')
    const [acknowledged, setAcknowledged] = useState(false)
    const activeLease = grants.data?.managedRunner?.id
    const reload = async () => { await Promise.all([secrets.refetch(), grants.refetch()]) }
    return <div className="ev-stack"><Panel title="Projekttresor" description="Werte werden verschlüsselt gespeichert. Speichern allein gibt sie noch nicht für Agenten frei. Unter „Agentenzugriff“ legst du fest, welche Werte neue Sessions verwenden dürfen.">
        <ErrorNotice error={secrets.error} />{secrets.isPending ? <Loading /> : !secrets.data?.secrets.length ? <Empty>Noch keine Zugangsdaten für dieses Projekt.</Empty> : <div className="ev-list">{secrets.data.secrets.map(secret => <div key={secret.id} className="ev-row"><div><strong>{secret.name}</strong><small>Version {secret.version} · geändert {formatDate(secret.updatedAt)}</small><small>{grants.error ? 'Agentenfreigabe konnte nicht geprüft werden.' : grants.isPending ? 'Agentenfreigabe wird geprüft …' : grants.data?.grants.some(grant => grant.secretId === secret.id && grant.leaseId === activeLease) ? 'Für neue Agentensessions freigegeben' : 'Für Agenten nicht freigegeben'}</small></div>{admin && <div className="ev-actions"><button disabled={action.busy} onClick={() => { setEditingId(secret.id); setName(secret.name); setValue('') }}>Rotieren</button><ConfirmButton label="Löschen" detail={`${secret.name} unwiderruflich löschen? Bei einer Agentenfreigabe wird der Projektdienst widerrufen; alle seine Sessions werden beendet. Bereits gelesene Werte können nicht zurückgeholt werden.`} disabled={action.busy} onConfirm={() => void action.run(async () => { try { await api.request(`${path}/secrets/${encodeURIComponent(secret.id)}`, { method: 'DELETE' }) } finally { await reload() } }, 'Zugangsdaten gelöscht.')} /></div>}</div>)}</div>}
    </Panel>
    {admin && <Panel title={editingId ? `Neuer Wert für ${name}` : 'Zugangsdaten speichern'} description="Zum Speichern wird gegebenenfalls eine erneute Passkey-Bestätigung benötigt."><form className="ev-stack" onSubmit={submit(() => void action.run(async () => {
        try { await api.request(editingId ? `${path}/secrets/${encodeURIComponent(editingId)}` : `${path}/secrets`, { method: editingId ? 'PUT' : 'POST', body: editingId ? { value } : { name: name.trim(), value } }) } finally { await reload() }
        setValue(''); setName(''); setEditingId(null)
    }, 'Verschlüsselt gespeichert.'))}>
        {!editingId && <Field label="Name"><input required autoComplete="off" value={name} onChange={event => setName(event.target.value)} maxLength={100} /></Field>}
        <Field label="Geheimer Wert"><input required type="password" autoComplete="new-password" value={value} onChange={event => setValue(event.target.value)} spellCheck={false} /></Field>
        {editingId && <p className="ev-callout">Wenn dieser Wert für Agenten freigegeben ist, widerruft das Rotieren den Projektdienst und beendet alle seine Sessions. Danach den Dienst unter „Abos verbinden“ erneut verbinden und benötigte Werte neu freigeben. Ändere einen offengelegten Schlüssel auch beim Anbieter.</p>}
        <div className="ev-actions"><button className="ev-primary" disabled={action.busy || !value || !name.trim()}>{editingId ? 'Wert rotieren' : 'Verschlüsselt speichern'}</button>{editingId && <button type="button" onClick={() => { setEditingId(null); setName(''); setValue('') }}>Abbrechen</button>}</div>
    </form></Panel>}
    <Panel title="Agentenzugriff" description="Explizite Freigaben gelten für alle neuen Sessions des aktuellen Projektdienstes und dieses Projektprofils. Eine laufende Session vollständig stoppen und erneut starten, damit ein neuer Agentenprozess die Werte erhält. „Neue Unterhaltung“ im selben Prozess reicht nicht.">
        <ErrorNotice error={grants.error} />{grants.isPending ? <Loading /> : grants.error ? <button onClick={() => void grants.refetch()}>Freigaben neu laden</button> : <>
            {!grants.data?.grants.length && <Empty>Noch keine Tresorwerte für Agenten freigegeben.</Empty>}
            <div className="ev-list">{grants.data?.grants.map(grant => <div className="ev-row" key={grant.id}><div><strong>{grant.envName}</strong><small>{secrets.data?.secrets.find(secret => secret.id === grant.secretId)?.name ?? 'Tresoreintrag'} · Version {grant.secretVersion}</small><small>{grant.leaseId === activeLease ? 'Für neue Sessions dieses Projektdienstes verfügbar' : 'Inaktiv – der zugehörige Projektdienst ist nicht mehr aktiv'}</small></div>{admin && <ConfirmButton label="Freigabe widerrufen" detail="Diese Freigabe widerrufen und alle Sessions des zugehörigen Projektdienstes beenden? Bereits gelesene Werte können nicht zurückgeholt werden; bei Bedarf den Schlüssel beim Anbieter rotieren." disabled={action.busy} onConfirm={() => void action.run(async () => { try { await api.request(`${path}/secret-grants/${encodeURIComponent(grant.id)}`, { method: 'DELETE' }) } finally { await grants.refetch() } }, 'Freigabe widerrufen. Verbinde den Projektdienst bei Bedarf erneut und prüfe alle benötigten Freigaben.')} />}</div>)}</div>
            {!activeLease && <p className="ev-callout">Für eine neue Freigabe wird ein aktiver Projektdienst benötigt. <a href={`/evolved?tab=providers&project=${encodeURIComponent(project!.id)}`}>Unter „Abos verbinden“ einrichten oder erneut verbinden.</a></p>}
            {admin && <form className="ev-stack" onSubmit={submit(() => void action.run(async () => {
                try { await api.request(`${path}/secret-grants`, { method: 'POST', body: { id: crypto.randomUUID(), secretId: grantSecretId, leaseId: activeLease, envName, acknowledgeProcessAccess: true } }) } finally { await grants.refetch() }
                setGrantSecretId(''); setEnvName(''); setAcknowledged(false)
            }, 'Freigabe gespeichert. Starte einen neuen Agentenprozess: eine laufende Session vollständig stoppen und erneut starten.'))}>
                <Field label="Tresoreintrag für Agenten"><select required value={grantSecretId} disabled={action.busy || !activeLease} onChange={event => { setGrantSecretId(event.target.value); const secret = secrets.data?.secrets.find(item => item.id === event.target.value); setEnvName(secret ? 'PROJECT_SECRET_' + secret.name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 65) : ''); setAcknowledged(false) }}><option value="">Eintrag auswählen</option>{secrets.data?.secrets.map(secret => <option key={secret.id} value={secret.id}>{secret.name}</option>)}</select></Field>
                <Field label="Umgebungsvariable" hint="Beginnt mit PROJECT_SECRET_, danach Großbuchstaben, Ziffern und Unterstriche. Dieses Präfix schützt die Agenten- und Systemkonfiguration."><input required value={envName} disabled={action.busy || !activeLease} autoComplete="off" spellCheck={false} maxLength={80} placeholder="PROJECT_SECRET_ODOO_API_KEY" onChange={event => { setEnvName(event.target.value); setAcknowledged(false) }} /></Field>
                {envName && !isCredentialEnvName(envName) && <p className="ev-error">Der Name muss mit PROJECT_SECRET_ beginnen und danach einen Großbuchstaben, Ziffern oder Unterstriche verwenden.</p>}
                <label className="ev-check"><input type="checkbox" checked={acknowledged} disabled={action.busy || !activeLease} onChange={event => setAcknowledged(event.target.checked)} />Ich erlaube allen neuen Agentensessions dieses Projektdienstes, den Wert als Umgebungsvariable zu lesen und für meine Aufgaben zu verwenden. Ein Agent kann ihn auslesen und an externe Dienste senden. Bereits gelesene Werte lassen sich nicht zurückholen.</label>
                <button className="ev-primary" disabled={action.busy || !activeLease || !grantSecretId || !isCredentialEnvName(envName) || !acknowledged}>Agentenzugriff freigeben</button>
                <p className="ev-muted">Bestätigung mit frischem Passkey erforderlich. Die Freigabe gewährt keine zusätzlichen Netzwerkrechte. Der Wert wird weder hier noch im MCP-Katalog angezeigt.</p>
            </form>}
        </>}
    </Panel>
    <Panel title="Freigegebene Ressourcen" description="Aktionen laufen mit den hinterlegten Zugangsdaten. Geheimwerte werden weder im Browser angezeigt noch an Agenten ausgegeben."><ErrorNotice error={resources.error} />{resources.isPending ? <Loading /> : !resources.data?.resources.length ? <Empty>Für dieses Projekt wurden noch keine Ressourcenaktionen eingerichtet.</Empty> : <div className="ev-list">{resources.data.resources.map(resource => <div className="ev-row" key={resource.id}><div><strong>{resource.name}</strong><small>{resource.type}</small></div>{resource.actions.map(resourceAction => <button key={resourceAction} disabled={action.busy || project?.role === 'viewer'} onClick={() => void action.run(async () => {
        const idempotencyKey = crypto.randomUUID()
        const response = await api.request<Record<string, unknown>>(`${path}/resources/${encodeURIComponent(resource.id)}/invoke`, { method: 'POST', body: { action: resourceAction, input: {} }, idempotencyKey })
        // Deliberately render only the broker's declared non-secret outcome fields.
        setResult({ status: response.status, httpStatus: response.httpStatus, exitCode: response.exitCode })
    })}>{resourceAction === 'execute' ? 'Ausführen' : resourceAction}</button>)}</div>)}</div>}
        {result && <div className="ev-callout" role="status">{Object.entries(result).filter(([, value]) => value !== undefined).map(([key, value]) => <p key={key}>{key}: {String(value)}</p>)}</div>}
    </Panel><ActionStatus action={action} /></div>
}
