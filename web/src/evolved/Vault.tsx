import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { isProjectAdmin, projectPath, type Resource, type SecretMetadata } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit, useAction } from './ui'

export function VaultPanel() {
    const { api, project } = useEvolved()
    const path = projectPath(project!.id)
    const admin = isProjectAdmin(project!.role)
    const secrets = useQuery({ queryKey: ['evolved', 'secrets', project!.id], queryFn: ({ signal }) => api.request<{ secrets: SecretMetadata[] }>(`${path}/secrets`, { signal }) })
    const resources = useQuery({ queryKey: ['evolved', 'resources', project!.id], queryFn: ({ signal }) => api.request<{ resources: Resource[] }>(`${path}/resources`, { signal }) })
    const action = useAction()
    const [name, setName] = useState('')
    const [value, setValue] = useState('')
    const [editingId, setEditingId] = useState<string | null>(null)
    const [result, setResult] = useState<Record<string, unknown> | null>(null)
    return <div className="ev-stack"><Panel title="Projekttresor" description="Werte werden verschlüsselt gespeichert und ausschließlich für freigegebene Ressourcenaktionen verwendet. Die Übersicht zeigt nur Namen und Versionen.">
        <ErrorNotice error={secrets.error} />{secrets.isPending ? <Loading /> : !secrets.data?.secrets.length ? <Empty>Noch keine Zugangsdaten für dieses Projekt.</Empty> : <div className="ev-list">{secrets.data.secrets.map(secret => <div key={secret.id} className="ev-row"><div><strong>{secret.name}</strong><small>Version {secret.version} · geändert {formatDate(secret.updatedAt)}</small></div>{admin && <div className="ev-actions"><button disabled={action.busy} onClick={() => { setEditingId(secret.id); setName(secret.name); setValue('') }}>Rotieren</button><ConfirmButton label="Löschen" detail={`${secret.name} unwiderruflich löschen?`} disabled={action.busy} onConfirm={() => void action.run(async () => { await api.request(`${path}/secrets/${encodeURIComponent(secret.id)}`, { method: 'DELETE' }); await secrets.refetch() }, 'Zugangsdaten gelöscht.')} /></div>}</div>)}</div>}
    </Panel>
    {admin && <Panel title={editingId ? `Neuer Wert für ${name}` : 'Zugangsdaten speichern'} description="Zum Speichern wird gegebenenfalls eine erneute Passkey-Bestätigung benötigt."><form className="ev-stack" onSubmit={submit(() => void action.run(async () => {
        await api.request(editingId ? `${path}/secrets/${encodeURIComponent(editingId)}` : `${path}/secrets`, { method: editingId ? 'PUT' : 'POST', body: editingId ? { value } : { name: name.trim(), value } })
        setValue(''); setName(''); setEditingId(null); await secrets.refetch()
    }, 'Verschlüsselt gespeichert.'))}>
        {!editingId && <Field label="Name"><input required autoComplete="off" value={name} onChange={event => setName(event.target.value)} maxLength={100} /></Field>}
        <Field label="Geheimer Wert"><input required type="password" autoComplete="new-password" value={value} onChange={event => setValue(event.target.value)} spellCheck={false} /></Field>
        <div className="ev-actions"><button className="ev-primary" disabled={action.busy || !value || !name.trim()}>{editingId ? 'Wert rotieren' : 'Verschlüsselt speichern'}</button>{editingId && <button type="button" onClick={() => { setEditingId(null); setName(''); setValue('') }}>Abbrechen</button>}</div>
    </form></Panel>}
    <Panel title="Freigegebene Ressourcen" description="Aktionen laufen mit den hinterlegten Zugangsdaten. Geheimwerte werden weder im Browser angezeigt noch an Agenten ausgegeben."><ErrorNotice error={resources.error} />{resources.isPending ? <Loading /> : !resources.data?.resources.length ? <Empty>Für dieses Projekt wurden noch keine Ressourcenaktionen eingerichtet.</Empty> : <div className="ev-list">{resources.data.resources.map(resource => <div className="ev-row" key={resource.id}><div><strong>{resource.name}</strong><small>{resource.type}</small></div>{resource.actions.map(resourceAction => <button key={resourceAction} disabled={action.busy || project?.role === 'viewer'} onClick={() => void action.run(async () => {
        const idempotencyKey = crypto.randomUUID()
        const response = await api.request<Record<string, unknown>>(`${path}/resources/${encodeURIComponent(resource.id)}/invoke`, { method: 'POST', body: { action: resourceAction, input: {} }, idempotencyKey })
        // Deliberately render only the broker's declared non-secret outcome fields.
        setResult({ status: response.status, httpStatus: response.httpStatus, exitCode: response.exitCode })
    })}>{resourceAction === 'execute' ? 'Ausführen' : resourceAction}</button>)}</div>)}</div>}
        {result && <div className="ev-callout" role="status">{Object.entries(result).filter(([, value]) => value !== undefined).map(([key, value]) => <p key={key}>{key}: {String(value)}</p>)}</div>}
    </Panel><ActionStatus action={action} /></div>
}
