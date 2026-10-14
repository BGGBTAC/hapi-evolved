import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { canWriteProject, isProjectAdmin, projectPath, type MemoryItem, type MemoryResponse, type MemorySettings, type MemorySource } from './api'
import { ActionStatus, ConfirmButton, Empty, ErrorNotice, Field, Loading, Panel, formatDate, submit, useAction } from './ui'

function MemoryCard({ item, editable, admin, busy, onVerify, onForget }: {
    item: MemoryItem; editable: boolean; admin: boolean; busy: boolean; onVerify: () => void; onForget: () => void
}) {
    return <article className="ev-memory-card"><header><h3>{item.title}</h3><span className={`ev-badge ${item.status === 'verified' ? 'ev-verified' : ''}`}>{item.status === 'verified' ? 'Verifiziert' : 'Vorgeschlagen'}</span></header>
        <p className="ev-memory-body">{item.body}</p><small className="ev-muted">{formatDate(item.createdAt)}</small>
        <details><summary>Quellen ({item.sources?.length ?? 0})</summary><ul className="ev-sources">{item.sources?.map((source, index) => <li key={index}><strong>{source.origin === 'user:reference' ? 'Manuelle Chatreferenz (nicht automatisch verifiziert)' : source.origin?.startsWith('hub:session:') ? 'Übernommene Sessionquelle' : source.kind}</strong>{source.path && <code>{source.path}</code>}{source.commit && <span>Commit: <code>{source.commit}</code></span>}{source.sessionId && <span>Session: <code>{source.sessionId}</code></span>}{source.messageId && <span>Nachricht: <code>{source.messageId}</code></span>}{source.hash && <span>Prüfsumme: <code>{source.hash}</code></span>}</li>)}</ul></details>
        <div className="ev-actions">{admin && item.status === 'proposed' && <button disabled={busy} onClick={onVerify}>Verifizieren</button>}{editable && <ConfirmButton label="Vergessen" detail="Eintrag und abgeleitete Indexdaten entfernen?" disabled={busy} onConfirm={onForget} />}</div>
    </article>
}
function BudgetSettings({ data, save, busy }: { data: MemorySettings; save: (value: MemorySettings) => void; busy: boolean }) {
    const [enabled, setEnabled] = useState(data.enabled)
    const [cloud, setCloud] = useState(data.cloudAllowed)
    const [monthly, setMonthly] = useState(String(data.monthlyBudgetMicros / 1_000_000))
    const [perJob, setPerJob] = useState(String(data.jobBudgetMicros / 1_000_000))
    useEffect(() => { setEnabled(data.enabled); setCloud(data.cloudAllowed); setMonthly(String(data.monthlyBudgetMicros / 1_000_000)); setPerJob(String(data.jobBudgetMicros / 1_000_000)) }, [data])
    return <form className="ev-stack" onSubmit={submit(() => save({ enabled, cloudAllowed: cloud, monthlyBudgetMicros: Math.round(Number(monthly) * 1_000_000), jobBudgetMicros: Math.round(Number(perJob) * 1_000_000) }))}>
        <label className="ev-check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Automatische Wissensverarbeitung aktiv</label>
        <label className="ev-check"><input type="checkbox" checked={cloud} onChange={event => setCloud(event.target.checked)} />Cloud-Verarbeitung für dieses Projekt erlauben</label>
        <div className="ev-form-grid"><Field label="Monatslimit (USD)"><input type="number" min="0" step="0.000001" required value={monthly} onChange={event => setMonthly(event.target.value)} /></Field><Field label="Limit je Auftrag (USD)"><input type="number" min="0" step="0.000001" required value={perJob} onChange={event => setPerJob(event.target.value)} /></Field></div>
        <p className="ev-muted">0 bedeutet kein Ausgabenbudget. Eine Cloud-Freigabe allein löst keinen Auftrag aus.</p><button className="ev-primary" disabled={busy}>Einstellungen speichern</button>
    </form>
}
export function MemoryPanel() {
    const { api, project } = useEvolved()
    const path = `${projectPath(project!.id)}/memory`
    const action = useAction()
    const memory = useQuery({ queryKey: ['evolved', 'memory', project!.id], queryFn: ({ signal }) => api.request<MemoryResponse>(path, { signal }) })
    const [query, setQuery] = useState('')
    const [submittedQuery, setSubmittedQuery] = useState('')
    const [searchMode, setSearchMode] = useState<'ledger' | 'hybrid'>('ledger')
    const [status, setStatus] = useState<'all' | 'proposed' | 'verified'>('all')
    const search = useQuery({ queryKey: ['evolved', 'memory-search', project!.id, submittedQuery, searchMode], enabled: submittedQuery.length > 0, queryFn: ({ signal }) => api.request<{ results: MemoryItem[]; mode: string; backendAvailable: boolean }>(`/memory/search?q=${encodeURIComponent(submittedQuery)}&projectId=${encodeURIComponent(project!.id)}&mode=${searchMode}`, { signal }) })
    const [title, setTitle] = useState('')
    const [body, setBody] = useState('')
    const [kind, setKind] = useState<MemorySource['kind']>('manual')
    const [sourcePath, setSourcePath] = useState('')
    const [commit, setCommit] = useState('')
    const [sessionId, setSessionId] = useState('')
    const [messageId, setMessageId] = useState('')
    const editable = canWriteProject(project?.role)
    const admin = isProjectAdmin(project?.role)
    const results = (submittedQuery ? search.data?.results : memory.data?.items) ?? []
    const reload = async () => { await memory.refetch(); if (submittedQuery) await search.refetch() }
    const budget = memory.data?.budget
    const usage = budget && budget.limitMicros > 0 ? Math.min(100, (budget.spentMicros + budget.reservedMicros) / budget.limitMicros * 100) : 0
    return <div className="ev-stack"><Panel title="Projektgedächtnis" description="Wissen bleibt projektbezogen erhalten. Vorschläge werden erst durch eine bewusste Prüfung verifiziert.">
        <form className="ev-inline-form" onSubmit={submit(() => setSubmittedQuery(query.trim()))}><Field label="Wissen durchsuchen"><input type="search" value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setSubmittedQuery('') }} /></Field><button>Suchen</button><Field label="Suchart"><select value={searchMode} onChange={event => setSearchMode(event.target.value as typeof searchMode)}><option value="ledger">Lokale Textsuche</option><option value="hybrid" disabled={!memory.data?.settings.enabled || !memory.data?.settings.cloudAllowed}>Hybrid (verwendet Verarbeitungsbudget)</option></select></Field><Field label="Status"><select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">Alle</option><option value="proposed">Vorgeschlagen</option><option value="verified">Verifiziert</option></select></Field></form>
        <ErrorNotice error={memory.error || search.error} />
        {memory.data && <p className="ev-muted">{memory.data.backend.available ? 'Graphspeicher verbunden.' : `Graphspeicher nicht erreichbar${memory.data.backend.error ? `: ${memory.data.backend.error}` : '.'} Lokale Einträge bleiben lesbar.`}{submittedQuery && search.data ? ` Suchmodus: ${search.data.mode}.` : ''}</p>}
        {memory.isPending || (submittedQuery && search.isFetching) ? <Loading /> : results.filter(item => status === 'all' || item.status === status).length === 0 ? <Empty>{submittedQuery ? 'Keine passenden Einträge.' : 'Noch kein Wissen gespeichert. Füge eine belegte Erkenntnis hinzu.'}</Empty> : <div className="ev-memory-grid">{results.filter(item => status === 'all' || item.status === status).map(item => <MemoryCard key={item.id} item={item} editable={editable} admin={editable} busy={action.busy}
            onVerify={() => void action.run(async () => { await api.request(`${path}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { status: 'verified' } }); await reload() }, 'Wissen verifiziert.')}
            onForget={() => void action.run(async () => { await api.request(`${path}/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await reload() }, 'Eintrag aus der Suche entfernt. Die Bereinigung des Graphindex wurde vorgemerkt.')} />)}</div>}
    </Panel>
    {editable && <Panel title="Erkenntnis vorschlagen"><form className="ev-stack" onSubmit={submit(() => void action.run(async () => {
        const source: MemorySource = { kind, ...((kind === 'code' || kind === 'attachment') && sourcePath.trim() ? { path: sourcePath.trim() } : {}), ...(kind === 'code' && commit.trim() ? { commit: commit.trim() } : {}), ...(kind === 'chat' ? { sessionId: sessionId.trim(), messageId: messageId.trim() } : {}) }
        await api.request(path, { method: 'POST', body: { title: title.trim(), body: body.trim(), sources: [source] } }); setTitle(''); setBody(''); await reload()
    }, 'Vorschlag gespeichert.'))}>
        <Field label="Titel"><input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></Field><Field label="Erkenntnis"><textarea required rows={5} maxLength={50000} value={body} onChange={event => setBody(event.target.value)} /></Field>
        <div className="ev-form-grid"><Field label="Quelle"><select value={kind} onChange={event => setKind(event.target.value as MemorySource['kind'])}><option value="manual">Eigene Beobachtung</option><option value="code">Quellcode</option><option value="chat">Manuelle Sessionreferenz</option><option value="attachment">Anhang</option></select></Field>
            {(kind === 'code' || kind === 'attachment') && <Field label="Dateipfad"><input required value={sourcePath} onChange={event => setSourcePath(event.target.value)} /></Field>}{kind === 'code' && <Field label="Commit (optional)"><input value={commit} onChange={event => setCommit(event.target.value)} /></Field>}{kind === 'chat' && <><Field label="Session-ID"><input required value={sessionId} onChange={event => setSessionId(event.target.value)} /></Field><Field label="Nachrichten-ID"><input required value={messageId} onChange={event => setMessageId(event.target.value)} /></Field></>}
        </div><button className="ev-primary" disabled={action.busy || !title.trim() || !body.trim()}>Vorschlag speichern</button>
    </form></Panel>}
    {budget && <Panel title="Verarbeitung und Budget"><p>Zeitraum: {budget.period}</p><div className="ev-budget" role="meter" aria-label="Verbrauchtes und reserviertes Monatsbudget" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage)}><span style={{ width: `${usage}%` }} /></div><p>{(budget.spentMicros / 1_000_000).toFixed(4)} USD verbraucht · {(budget.reservedMicros / 1_000_000).toFixed(4)} USD reserviert · {(budget.limitMicros / 1_000_000).toFixed(2)} USD Limit</p>
        {admin && memory.data && <BudgetSettings data={memory.data.settings} busy={action.busy} save={settings => void action.run(async () => { await api.request(`${path}/settings`, { method: 'PATCH', body: settings }); await memory.refetch() }, 'Gedächtniseinstellungen gespeichert.')} />}
    </Panel>}<ActionStatus action={action} /></div>
}
