import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { useProjectWorkflow } from './ProjectWorkflowContext'
import { canWriteProject, EvolvedApiError, projectPath, type CodeDetail, type CodeGraph, type CodeNode, type CodeStatus } from './api'
import { WorkspaceLink } from './workspaceNavigation'
import { ActionStatus, Empty, ErrorNotice, Field, Loading, Panel, submit, useAction } from './ui'

export function layoutNodes(nodes: CodeNode[]): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>()
    const ordered = [...nodes].sort((left, right) => left.kind.localeCompare(right.kind) || left.file.localeCompare(right.file) || left.name.localeCompare(right.name))
    const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length * 1.7)))
    const rows = Math.max(1, Math.ceil(ordered.length / columns))
    ordered.forEach((node, index) => positions.set(node.id, { x: 70 + (index % columns) * (860 / Math.max(1, columns - 1)), y: 65 + Math.floor(index / columns) * (470 / Math.max(1, rows - 1)) }))
    return positions
}
export function CodeGraphCanvas({ graph, selected, onSelect }: { graph: CodeGraph; selected: string | null; onSelect: (id: string) => void }) {
    const positions = useMemo(() => layoutNodes(graph.nodes), [graph.nodes])
    const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
    const svg = useRef<SVGSVGElement>(null)
    const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
    const zoom = (factor: number) => setView(current => {
        const scale = Math.min(5, Math.max(0.25, current.scale * factor))
        return { scale, x: 500 - (500 - current.x) * scale / current.scale, y: 300 - (300 - current.y) * scale / current.scale }
    })
    useEffect(() => {
        const element = svg.current
        if (!element) return
        const wheel = (event: WheelEvent) => {
            event.preventDefault()
            const box = element.getBoundingClientRect()
            if (!box.width || !box.height) return
            const x = (event.clientX - box.left) / box.width * 1000
            const y = (event.clientY - box.top) / box.height * 600
            setView(current => {
                const scale = Math.min(5, Math.max(0.25, current.scale * Math.exp(-event.deltaY * 0.002)))
                return { scale, x: x - (x - current.x) * scale / current.scale, y: y - (y - current.y) * scale / current.scale }
            })
        }
        element.addEventListener('wheel', wheel, { passive: false })
        return () => element.removeEventListener('wheel', wheel)
    }, [])
    const neighbors = useMemo(() => new Set(graph.edges.filter(edge => edge.source === selected || edge.target === selected).flatMap(edge => [edge.source, edge.target])), [graph.edges, selected])
    return <div className="ev-graph-wrap"><div className="ev-actions ev-graph-controls"><button aria-label="Graph vergrößern" onClick={() => zoom(1.3)}>＋</button><button aria-label="Graph verkleinern" onClick={() => zoom(1 / 1.3)}>−</button><button onClick={() => setView({ x: 0, y: 0, scale: 1 })}>Ansicht zurücksetzen</button><span className="ev-muted">Ziehen zum Verschieben · Mausrad zum Zoomen</span></div>
        <svg ref={svg} viewBox="0 0 1000 600" className="ev-graph" role="group" aria-label="Interaktiver Codegraph" tabIndex={0}
            onKeyDown={event => {
                if (event.target !== event.currentTarget) return
                if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.3) }
                else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.3) }
                else if (event.key === 'Home') { event.preventDefault(); setView({ x: 0, y: 0, scale: 1 }) }
                else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setView(current => ({ ...current, x: current.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: current.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) })) }
            }}
            onPointerDown={event => { if (event.target !== event.currentTarget || event.button !== 0) return; drag.current = { x: event.clientX, y: event.clientY, tx: view.x, ty: view.y }; event.currentTarget.setPointerCapture(event.pointerId) }}
            onPointerMove={event => { const start = drag.current; if (!start) return; const box = event.currentTarget.getBoundingClientRect(); setView(current => ({ ...current, x: start.tx + (event.clientX - start.x) * 1000 / box.width, y: start.ty + (event.clientY - start.y) * 600 / box.height })) }}
            onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
            <defs><marker id="ev-arrow" viewBox="0 0 10 10" refX="17" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                {graph.edges.map((edge, index) => { const from = positions.get(edge.source); const to = positions.get(edge.target); if (!from || !to) return null; return <line key={`${edge.source}:${edge.target}:${edge.kind}:${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={edge.source === selected || edge.target === selected ? 'ev-edge ev-edge-active' : 'ev-edge'} markerEnd="url(#ev-arrow)"><title>{edge.kind}</title></line> })}
                {graph.nodes.map(node => { const position = positions.get(node.id)!; return <g key={node.id} transform={`translate(${position.x} ${position.y})`} role="button" tabIndex={0} aria-label={`${node.name}, ${node.kind}, ${node.file}:${node.line}`} aria-pressed={selected === node.id} className={`ev-node ${selected === node.id ? 'ev-node-selected' : neighbors.has(node.id) ? 'ev-node-neighbor' : ''}`} onClick={() => onSelect(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) } }}>
                    <title>{node.name} · {node.kind}\n{node.file}:{node.line}</title><circle r={selected === node.id ? 15 : 11} /><text y="30" textAnchor="middle">{node.name.length > 25 ? `${node.name.slice(0, 23)}…` : node.name}</text>
                </g> })}
            </g>
        </svg>
        <p className="ev-muted">{graph.nodes.length} Knoten · {graph.edges.length} Beziehungen{graph.truncated ? ' · Ausschnitt begrenzt; suche einen Knoten für mehr Details.' : ''}</p>
    </div>
}
function NodeList({ nodes, select, selected }: { nodes: CodeNode[]; select: (id: string) => void; selected?: string | null }) {
    return <ul className="ev-node-list">{nodes.map(node => <li key={node.id}><button onClick={() => select(node.id)} aria-pressed={selected === node.id}><strong>{node.name}</strong><small>{node.kind} · {node.file}:{node.line}</small></button></li>)}</ul>
}
type Impact = { nodes?: CodeNode[]; edges?: CodeGraph['edges']; files?: string[]; truncated?: boolean }
export function CodegraphPanel() {
    const { api, me, project } = useEvolved()
    if (!project) return <Panel title="Codegraph"><Empty>Wähle zuerst ein Projekt.</Empty></Panel>
    return <CodegraphForProject key={`${api.baseUrl}:${me.user.id}:${project.id}:${project.role}`} />
}
function CodegraphForProject() {
    const { api, me, project } = useEvolved()
    const workflow = useProjectWorkflow()
    const path = `${projectPath(project!.id)}/codegraph`
    const action = useAction()
    const [query, setQuery] = useState('')
    const [searchQuery, setSearchQuery] = useState('')
    const [selected, setSelected] = useState<string | null>(workflow?.nodeId ?? null)
    const [focus, setFocus] = useState<string | null>(workflow?.nodeId ?? null)
    useEffect(() => { if (workflow?.nodeId) { setSelected(workflow.nodeId); setFocus(workflow.nodeId); workflow.setNodeId(null) } }, [workflow?.nodeId])
    const [files, setFiles] = useState('')
    const [affectedFiles, setAffectedFiles] = useState<string | null>(null)
    const scope = [api.baseUrl, me.user.id, project!.id, project!.role]
    const status = useQuery({ queryKey: ['evolved', 'code-status', ...scope], queryFn: ({ signal }) => api.request<CodeStatus>(`${path}/status`, { signal }), retry: false, gcTime: 0, refetchInterval: query => query.state.error ? false : query.state.data?.state === 'indexing' ? 2500 : query.state.data?.watching ? 5000 : false })
    const current = !status.error ? status.data : undefined
    const available = current?.available === true
    const indexVersion = current?.lastIndexedAt ?? current?.version
    const graph = useQuery<CodeGraph>({ placeholderData: (data, previous) => previous?.queryKey[6] === focus ? data : undefined, queryKey: ['evolved', 'code-graph', ...scope, focus, indexVersion], enabled: available, queryFn: ({ signal }) => api.request<CodeGraph>(`${path}/graph${focus ? `?nodeId=${encodeURIComponent(focus)}` : ''}`, { signal }) })
    const search = useQuery<{ nodes: CodeNode[] }>({ placeholderData: (data, previous) => previous?.queryKey[6] === searchQuery ? data : undefined, queryKey: ['evolved', 'code-search', ...scope, searchQuery, indexVersion], enabled: available && !!searchQuery, queryFn: ({ signal }) => api.request<{ nodes: CodeNode[] }>(`${path}/search?q=${encodeURIComponent(searchQuery)}`, { signal }) })
    const detail = useQuery<CodeDetail>({ placeholderData: (data, previous) => previous?.queryKey[6] === selected ? data : undefined, queryKey: ['evolved', 'code-node', ...scope, selected, indexVersion], enabled: available && !!selected, queryFn: ({ signal }) => api.request<CodeDetail>(`${path}/node?nodeId=${encodeURIComponent(selected!)}`, { signal }) })
    const impact = useQuery<Impact>({ placeholderData: (data, previous) => previous?.queryKey[6] === selected ? data : undefined, queryKey: ['evolved', 'code-impact', ...scope, selected, indexVersion], enabled: available && !!selected, queryFn: ({ signal }) => api.request<Impact>(`${path}/impact?nodeId=${encodeURIComponent(selected!)}`, { signal }) })
    const affected = useQuery<Impact>({ placeholderData: (data, previous) => previous?.queryKey[6] === affectedFiles ? data : undefined, queryKey: ['evolved', 'code-affected', ...scope, affectedFiles, indexVersion], enabled: available && !!affectedFiles, queryFn: ({ signal }) => api.request<Impact>(`${path}/affected?files=${encodeURIComponent(affectedFiles!)}`, { signal }) })
    const select = (id: string) => { setSelected(id) }
    const unconfigured = current?.state === 'unconfigured' || status.error instanceof EvolvedApiError && status.error.code === 'codegraph_unconfigured'
    const denied = status.error instanceof EvolvedApiError && [401, 403].includes(status.error.status)
    const empty = available && current?.stats?.nodeCount === 0
    const stateNames: Record<string, string> = { unconfigured: 'Nicht eingerichtet', indexing: 'Index wird aufgebaut', ready: 'Bereit', error: 'Indizierung fehlgeschlagen' }
    const stateLabel = denied ? 'Zugriff nicht möglich' : unconfigured ? 'Nicht eingerichtet' : status.error ? 'Dienst nicht erreichbar' : empty ? 'Noch kein Code im Index' : stateNames[current?.state ?? ''] ?? 'Verbindung wird geprüft'
    // Old sidecars can return nested SDK statistics. Never render unchecked response values.
    const counts = ([['nodeCount', 'Symbole'], ['edgeCount', 'Beziehungen'], ['fileCount', 'Dateien']] as const)
        .flatMap(([key, label]) => {
            const value = current?.stats?.[key]
            return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [{ key, label, value }] : []
        })
    const reindex = () => void action.run(async () => {
        await api.request(`${path}/reindex`, { method: 'POST', body: {} })
        await status.refetch()
        if (available) await graph.refetch()
    }, 'Indizierung angefordert. Der Status wird automatisch aktualisiert.')
    return <div className="ev-stack"><Panel title="Codegraph" description="Erkunde Symbole, Abhängigkeiten und Auswirkungen der Codedateien in deinem Projektordner.">
        <div className="ev-row"><div><span className="ev-badge" role="status">{stateLabel}</span>{current && <p className="ev-muted">{current.watching ? 'Dateiüberwachung aktiv' : 'Dateiüberwachung inaktiv'} · {typeof current.pendingFiles === 'number' ? current.pendingFiles : 0} ausstehende Dateien</p>}</div><div className="ev-actions"><button disabled={status.isFetching} onClick={() => { void status.refetch(); if (available) void graph.refetch() }}>Status aktualisieren</button>{canWriteProject(project!.role) && current && !unconfigured && <button disabled={action.busy || status.isFetching || current.state === 'indexing'} onClick={reindex}>Neu indizieren</button>}</div></div>
        {status.isPending && <Loading />}
        {unconfigured ? <Empty>{project!.rootPath ? 'Der Codegraph-Dienst ist für diese Installation noch nicht eingerichtet. Der Betreiber muss den Dienst mit dem Projektordner verbinden. Danach den Status aktualisieren.' : 'Diesem Projekt ist noch kein Projektordner zugeordnet. Ordne unter Projekte einen freigegebenen Ordner zu.'}</Empty> : status.error ? <><ErrorNotice error={status.error} /><p className="ev-muted">{denied ? 'Prüfe deine Anmeldung und Projektberechtigung. Es werden keine gespeicherten Graphdaten angezeigt.' : 'Der Indexstatus konnte nicht geladen werden. Das bedeutet nicht, dass der Graph leer ist. Versuche „Status aktualisieren“; bleibt der Fehler bestehen, muss der Betreiber den Codegraph-Dienst prüfen.'}</p></> : <>
            {current?.state === 'indexing' && <p className="ev-muted">Der Codegraph wird automatisch aufgebaut. Du musst keinen Graphen anlegen. Diese Ansicht aktualisiert sich, sobald die Indizierung fertig ist.</p>}
            {current?.state === 'error' && <><ErrorNotice error={current.error || 'Der Codeindex konnte nicht aufgebaut werden.'} /><p className="ev-muted">{canWriteProject(project!.role) ? 'Versuche „Neu indizieren“. Bleibt der Fehler bestehen, muss der Betreiber den Projektordner und Codegraph-Dienst prüfen.' : 'Bitte ein Projektmitglied mit Schreibzugriff, die Indizierung erneut zu starten.'}</p></>}
            {empty && <div className="ev-empty"><p>Im Projektordner sind noch keine unterstützten Codesymbole indiziert. Ein neuer, leerer Projektordner ist kein Fehler.</p><p>Klone ein Repository in den Projektordner oder füge Codedateien hinzu. Der Codegraph erkennt Änderungen automatisch. Eine GitHub-Freigabe allein lädt noch keinen Code herunter.</p><WorkspaceLink tab="github" projectId={project!.id} className="ew-text-link">Repository verbinden</WorkspaceLink></div>}
            {counts.length > 0 && <div className="ev-stats">{counts.map(({ key, label, value }) => <span key={key}><strong>{value}</strong> {label}</span>)}</div>}
        </>}
    </Panel>
    {available && <><Panel title="Symbole und Beziehungen"><form className="ev-inline-form" onSubmit={submit(() => setSearchQuery(query.trim()))}><Field label="Symbol oder Datei suchen"><input type="search" value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setSearchQuery('') }} /></Field><button>Suchen</button>{focus && <button type="button" onClick={() => setFocus(null)}>Gesamten Graph zeigen</button>}</form>
        <ErrorNotice error={search.error || graph.error} />{searchQuery && !search.error && (search.isFetching ? <Loading /> : search.data?.nodes.length ? <NodeList nodes={search.data.nodes} select={id => { select(id); setFocus(id) }} selected={selected} /> : <Empty>Keine Symbole gefunden.</Empty>)}
        {graph.isPending ? <Loading /> : graph.error ? <p className="ev-muted">Der Graphausschnitt konnte nicht geladen werden. Aktualisiere den Status oder suche erneut nach einem Symbol.</p> : graph.data?.nodes.length ? <CodeGraphCanvas graph={graph.data} selected={selected} onSelect={select} /> : <Empty>{empty ? 'Sobald Code im Projektordner liegt, erscheinen hier seine Symbole und Beziehungen.' : 'Für diesen Ausschnitt wurden keine Symbole gefunden. Suche nach einem Symbol oder einer Datei.'}</Empty>}
    </Panel>
    {selected && <div className="ev-code-detail-grid"><Panel title={!detail.error ? detail.data?.node.name ?? 'Symbol' : 'Symbol'}><ErrorNotice error={detail.error} />{detail.isPending ? <Loading /> : !detail.error && detail.data && <>
        <p className="ev-muted">{detail.data.node.kind} · {detail.data.node.file}:{detail.data.node.line}{detail.data.node.endLine ? `–${detail.data.node.endLine}` : ''}</p><button onClick={() => setFocus(selected)}>Graph auf dieses Symbol fokussieren</button>
        <pre className="ev-source" tabIndex={0} aria-label={`Quelltext ${detail.data.node.file}`}><code>{detail.data.source || 'Für dieses Symbol ist kein Quelltext verfügbar.'}</code></pre>
        <details open><summary>Aufrufer ({detail.data.callers?.length ?? 0})</summary><NodeList nodes={detail.data.callers ?? []} select={select} /></details><details><summary>Aufgerufene Symbole ({detail.data.callees?.length ?? 0})</summary><NodeList nodes={detail.data.callees ?? []} select={select} /></details>
    </>}</Panel><Panel title="Auswirkungen"><ErrorNotice error={impact.error} />{impact.isPending ? <Loading /> : !impact.error && <><p className="ev-muted">Abhängige Symbole bei einer Änderung dieses Knotens.</p><NodeList nodes={impact.data?.nodes ?? []} select={select} />{impact.data?.files?.map(file => <p key={file}><code>{file}</code></p>)}{!impact.data?.nodes?.length && !impact.data?.files?.length && <Empty>Keine abhängigen Symbole gefunden.</Empty>}{impact.data?.truncated && <p className="ev-muted">Die Auswirkungsanalyse wurde begrenzt.</p>}</>}</Panel></div>}
    <Panel title="Betroffene Dateien und Tests"><form className="ev-stack" onSubmit={submit(() => setAffectedFiles(files.split(/[\n,]/).map(file => file.trim()).filter(Boolean).join(',')))}><Field label="Geänderte Pfade" hint="Repository-relative Dateipfade, eine Datei pro Zeile."><textarea required rows={3} value={files} onChange={event => setFiles(event.target.value)} /></Field><button disabled={!files.trim()}>Auswirkungen prüfen</button></form><ErrorNotice error={affected.error} />{affectedFiles && !affected.error && (affected.isFetching ? <Loading /> : <><NodeList nodes={affected.data?.nodes ?? []} select={id => { select(id); setFocus(id) }} />{affected.data?.files?.map(file => <p key={file}><code>{file}</code></p>)}{!affected.data?.nodes?.length && !affected.data?.files?.length && <Empty>Keine weiteren betroffenen Dateien gefunden.</Empty>}</>)}
    </Panel></>}<ActionStatus action={action} /></div>
}
