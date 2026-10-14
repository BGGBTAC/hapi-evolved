import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { isProjectAdmin, hubUrl, projectPath } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit, useAction } from './ui'

type Preview = { id: string; name: string; directory: string; openPath: string; createdAt: number }
type PreviewShare = { id: string; expiresAt: number; revokedAt: number | null }
function Sharing({ preview, path }: { preview: Preview; path: string }) {
    const { api } = useEvolved()
    const action = useAction()
    const shares = useQuery({ queryKey: ['evolved', 'preview-shares', preview.id], queryFn: ({ signal }) => api.request<{ shares: PreviewShare[] }>(`${path}/${encodeURIComponent(preview.id)}/shares`, { signal }) })
    const [hours, setHours] = useState('1')
    const [link, setLink] = useState<{ id: string; url: string; expiresAt: number } | null>(null)
    return <div className="ev-stack"><p className="ev-muted">Ein Freigabelink erlaubt Zugriff auf diese Vorschau ohne Anmeldung. Gib ihn nur gezielt weiter; die Freigabe endet spätestens nach 24 Stunden.</p>
        <form className="ev-inline-form" onSubmit={submit(() => void action.run(async () => {
            setLink(await api.request(`${path}/${encodeURIComponent(preview.id)}/shares`, { method: 'POST', body: { expiresInSeconds: Math.round(Number(hours) * 3600) } })); await shares.refetch()
        }))}><Field label={`Freigabedauer für ${preview.name} (Stunden)`}><input required type="number" min="1" max="24" step="1" value={hours} onChange={event => setHours(event.target.value)} /></Field><button disabled={action.busy}>Freigabelink erstellen</button></form>
        {link && <div className="ev-callout"><Field label="Einmaliger Freigabelink"><input readOnly value={hubUrl(api.baseUrl, link.url)} onFocus={event => event.target.select()} /></Field><p>Gültig bis {formatDate(link.expiresAt)}</p><div className="ev-actions"><button onClick={() => void action.run(async () => { await navigator.clipboard.writeText(new URL(hubUrl(api.baseUrl, link.url), window.location.href).toString()) }, 'Link kopiert.')}>Freigabelink kopieren</button><button onClick={() => setLink(null)}>Link ausblenden</button></div></div>}
        <ErrorNotice error={shares.error} />{shares.isPending ? <Loading /> : <div className="ev-list">{shares.data?.shares.map(share => <div className="ev-row" key={share.id}><div><code>{share.id}</code><small>{share.revokedAt ? 'Widerrufen' : share.expiresAt <= Date.now() ? 'Abgelaufen' : `Gültig bis ${formatDate(share.expiresAt)}`}</small></div>{!share.revokedAt && share.expiresAt > Date.now() && <ConfirmButton label="Freigabe widerrufen" detail="Freigabelink sofort deaktivieren?" disabled={action.busy} onConfirm={() => void action.run(async () => { await api.request(`${path}/${encodeURIComponent(preview.id)}/shares/${encodeURIComponent(share.id)}`, { method: 'DELETE' }); if (link?.id === share.id) setLink(null); await shares.refetch() }, 'Freigabe widerrufen.')} />}</div>)}</div>}
        <ActionStatus action={action} />
    </div>
}
export function PreviewsPanel() {
    const { api, project } = useEvolved()
    const path = `${projectPath(project!.id)}/previews`
    const editable = isProjectAdmin(project?.role)
    const previews = useQuery({ queryKey: ['evolved', 'previews', project!.id], queryFn: ({ signal }) => api.request<{ previews: Preview[] }>(path, { signal }) })
    const [name, setName] = useState('')
    const [directory, setDirectory] = useState('')
    const [sharing, setSharing] = useState<string | null>(null)
    const action = useAction()
    return <div className="ev-stack"><Panel title="Projektvorschauen" description="Öffne gebaute Webseiten aus diesem Projekt in einer isolierten Vorschau. Freigabelinks sind befristet und können widerrufen werden.">
        <ErrorNotice error={previews.error} />{previews.isPending ? <Loading /> : !previews.data?.previews.length ? <Empty>Noch keine Vorschau registriert.</Empty> : <div className="ev-list">{previews.data.previews.map(preview => <section key={preview.id} className="ev-preview"><div className="ev-row"><div><strong>{preview.name}</strong><small>{preview.directory}</small></div><div className="ev-actions"><a className="ev-session-link" href={hubUrl(api.baseUrl, preview.openPath)} target="_blank" rel="noopener noreferrer">Vorschau öffnen ↗</a>{editable && <><button onClick={() => setSharing(sharing === preview.id ? null : preview.id)} aria-expanded={sharing === preview.id}>Freigaben</button><ConfirmButton label="Vorschau entfernen" detail="Vorschau und alle Freigabelinks entfernen? Quelldateien bleiben erhalten." disabled={action.busy} onConfirm={() => void action.run(async () => { await api.request(`${path}/${encodeURIComponent(preview.id)}`, { method: 'DELETE' }); await previews.refetch() }, 'Vorschau entfernt.')} /></>}</div></div>{sharing === preview.id && <Sharing preview={preview} path={path} />}</section>)}</div>}
    </Panel>
    {editable && <Panel title="Vorschau registrieren" description="Das Buildverzeichnis muss innerhalb des Projektverzeichnisses liegen und eine index.html enthalten."><form className="ev-stack" onSubmit={submit(() => void action.run(async () => {
        await api.request(path, { method: 'POST', body: { name: name.trim(), directory: directory.trim() } }); setName(''); setDirectory(''); await previews.refetch()
    }, 'Vorschau registriert.'))}><Field label="Vorschauname"><input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="Absolutes Buildverzeichnis"><input required value={directory} onChange={event => setDirectory(event.target.value)} placeholder={`${project?.rootPath || '/projekt'}/dist`} /></Field><button className="ev-primary" disabled={action.busy || !name.trim() || !directory.trim()}>Vorschau registrieren</button></form></Panel>}
    <ActionStatus action={action} /></div>
}
