import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEvolved } from './auth'
import { canWriteProject, projectPath, type CodeDetail, type CodeGraph, type CodeNode, type CodeStatus } from './api'
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
    const { api, project } = useEvolved()
    const path = `${projectPath(project!.id)}/codegraph`
    const action = useAction()
    const [query, setQuery] = useState('')
    const [searchQuery, setSearchQuery] = useState('')
    const [selected, setSelected] = useState<string | null>(null)
    const [focus, setFocus] = useState<string | null>(null)
    const [files, setFiles] = useState('')
    const [affectedFiles, setAffectedFiles] = useState<string | null>(null)
    const status = useQuery({ queryKey: ['evolved', 'code-status', project!.id], queryFn: ({ signal }) => api.request<CodeStatus>(`${path}/status`, { signal }), refetchInterval: query => query.state.data?.state === 'indexing' ? 2500 : false })
    const available = status.data?.available === true
    const graph = useQuery({ queryKey: ['evolved', 'code-graph', project!.id, focus, status.data?.version], enabled: available, queryFn: ({ signal }) => api.request<CodeGraph>(`${path}/graph${focus ? `?nodeId=${encodeURIComponent(focus)}` : ''}`, { signal }) })
    const search = useQuery({ queryKey: ['evolved', 'code-search', project!.id, searchQuery], enabled: available && !!searchQuery, queryFn: ({ signal }) => api.request<{ nodes: CodeNode[] }>(`${path}/search?q=${encodeURIComponent(searchQuery)}`, { signal }) })
    const detail = useQuery({ queryKey: ['evolved', 'code-node', project!.id, selected], enabled: available && !!selected, queryFn: ({ signal }) => api.request<CodeDetail>(`${path}/node?nodeId=${encodeURIComponent(selected!)}`, { signal }) })
    const impact = useQuery({ queryKey: ['evolved', 'code-impact', project!.id, selected], enabled: available && !!selected, queryFn: ({ signal }) => api.request<Impact>(`${path}/impact?nodeId=${encodeURIComponent(selected!)}`, { signal }) })
    const affected = useQuery({ queryKey: ['evolved', 'code-affected', project!.id, affectedFiles], enabled: available && !!affectedFiles, queryFn: ({ signal }) => api.request<Impact>(`${path}/affected?files=${encodeURIComponent(affectedFiles!)}`, { signal }) })
    const select = (id: string) => { setSelected(id) }
    const stateNames: Record<string, string> = { unconfigured: 'Nicht eingerichtet', indexing: 'Wird indiziert', ready: 'Bereit', error: 'Fehler' }
    return <div className="ev-stack"><Panel title="Codegraph" description="Erkunde Symbole, Abhängigkeiten und Auswirkungen im freigegebenen Repository."><div className="ev-row"><div><span className="ev-badge">{stateNames[status.data?.state ?? ''] ?? 'Verbindung wird geprüft'}</span>{status.data && <p className="ev-muted">{status.data.watching ? 'Dateiüberwachung aktiv' : 'Dateiüberwachung inaktiv'} · {status.data.pendingFiles ?? 0} ausstehende Dateien{status.data.version ? ` · Stand ${status.data.version}` : ''}</p>}</div><div className="ev-actions"><button onClick={() => { void status.refetch(); if (available) void graph.refetch() }}>Aktualisieren</button>{canWriteProject(project!.role) && <button disabled={action.busy || status.data?.state === 'indexing'} onClick={() => void action.run(async () => { await api.request(`${path}/reindex`, { method: 'POST', body: {} }); await status.refetch(); if (available) await graph.refetch() }, 'Indizierung angefordert.')}>Neu indizieren</button>}</div></div>
        <ErrorNotice error={status.error || status.data?.error} />{status.data?.stats && <div className="ev-stats">{Object.entries(status.data.stats).map(([key, value]) => <span key={key}><strong>{value}</strong> {key}</span>)}</div>}
        {!available && !status.isPending && <Empty>{project?.rootPath ? 'Der Codegraph ist derzeit nicht verfügbar. Prüfe den Indexstatus oder starte eine Indizierung.' : 'Diesem Projekt ist noch kein Repository-Verzeichnis zugeordnet. Lege ein Projekt mit einem freigegebenen Repository-Pfad an.'}</Empty>}
    </Panel>
    {available && <><Panel title="Symbole und Beziehungen"><form className="ev-inline-form" onSubmit={submit(() => setSearchQuery(query.trim()))}><Field label="Symbol oder Datei suchen"><input type="search" value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setSearchQuery('') }} /></Field><button>Suchen</button>{focus && <button type="button" onClick={() => setFocus(null)}>Gesamten Graph zeigen</button>}</form>
        <ErrorNotice error={search.error || graph.error} />{searchQuery && (search.isFetching ? <Loading /> : search.data?.nodes.length ? <NodeList nodes={search.data.nodes} select={id => { select(id); setFocus(id) }} selected={selected} /> : <Empty>Keine Symbole gefunden.</Empty>)}
        {graph.isPending ? <Loading /> : graph.data?.nodes.length ? <CodeGraphCanvas graph={graph.data} selected={selected} onSelect={select} /> : <Empty>Der Index enthält noch keine Symbole.</Empty>}
    </Panel>
    {selected && <div className="ev-code-detail-grid"><Panel title={detail.data?.node.name ?? 'Symbol'}><ErrorNotice error={detail.error} />{detail.isPending ? <Loading /> : detail.data && <>
        <p className="ev-muted">{detail.data.node.kind} · {detail.data.node.file}:{detail.data.node.line}{detail.data.node.endLine ? `–${detail.data.node.endLine}` : ''}</p><button onClick={() => setFocus(selected)}>Graph auf dieses Symbol fokussieren</button>
        <pre className="ev-source" tabIndex={0} aria-label={`Quelltext ${detail.data.node.file}`}><code>{detail.data.source || 'Für dieses Symbol ist kein Quelltext verfügbar.'}</code></pre>
        <details open><summary>Aufrufer ({detail.data.callers?.length ?? 0})</summary><NodeList nodes={detail.data.callers ?? []} select={select} /></details><details><summary>Aufgerufene Symbole ({detail.data.callees?.length ?? 0})</summary><NodeList nodes={detail.data.callees ?? []} select={select} /></details>
    </>}</Panel><Panel title="Auswirkungen"><ErrorNotice error={impact.error} />{impact.isPending ? <Loading /> : <><p className="ev-muted">Abhängige Symbole bei einer Änderung dieses Knotens.</p><NodeList nodes={impact.data?.nodes ?? []} select={select} />{impact.data?.files?.map(file => <p key={file}><code>{file}</code></p>)}{!impact.data?.nodes?.length && !impact.data?.files?.length && <Empty>Keine abhängigen Symbole gefunden.</Empty>}{impact.data?.truncated && <p className="ev-muted">Die Auswirkungsanalyse wurde begrenzt.</p>}</>}</Panel></div>}
    <Panel title="Betroffene Dateien und Tests"><form className="ev-stack" onSubmit={submit(() => setAffectedFiles(files.split(/[\n,]/).map(file => file.trim()).filter(Boolean).join(',')))}><Field label="Geänderte Pfade" hint="Repository-relative Dateipfade, eine Datei pro Zeile."><textarea required rows={3} value={files} onChange={event => setFiles(event.target.value)} /></Field><button disabled={!files.trim()}>Auswirkungen prüfen</button></form><ErrorNotice error={affected.error} />{affectedFiles && (affected.isFetching ? <Loading /> : <><NodeList nodes={affected.data?.nodes ?? []} select={id => { select(id); setFocus(id) }} />{affected.data?.files?.map(file => <p key={file}><code>{file}</code></p>)}{!affected.data?.nodes?.length && !affected.data?.files?.length && <Empty>Keine weiteren betroffenen Dateien gefunden.</Empty>}</>)}
    </Panel></>}<ActionStatus action={action} /></div>
}
