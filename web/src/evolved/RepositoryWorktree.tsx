import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RepoWorktreeSchema, RepoDiffSchema, type RepoImpact } from '@hapi/protocol/evolvedWorkspace'
import { DiffDisplay } from '@/components/SessionFiles/DiffDisplay'
import { useEvolved } from './auth'
import { canWriteProject, EvolvedApiError, projectPath } from './api'
import { CodeGraphCanvas } from './Codegraph'
import { useProjectWorkflow } from './ProjectWorkflowContext'
import { ConfirmButton, Empty, ErrorNotice, Loading, Panel, formatDate } from './ui'
import { WorkspaceLink } from './workspaceNavigation'

type DiffSelection = { snapshotId: string; path: string; side: 'staged' | 'unstaged' }
const memoryTextPath = /\.(?:ts|tsx|js|jsx|mjs|py|rs|go|java|c|h|cpp|swift|md|txt|json|yaml|yml|toml)$/i
const withheld = { sensitive_path: 'Dieser Pfad ist geschützt.', credential_pattern: 'Mögliche Zugangsdaten: Inhalt wird nicht angezeigt.', untracked: 'Neue, noch nicht von Git erfasste Datei. Kein Git-Diff verfügbar.', unsupported: 'Für diesen Dateityp ist keine sichere Vorschau verfügbar.' }

export function RepositoryWorktreePanel({ repositoryId, name, onClose }: { repositoryId: string; name: string; onClose: () => void }) {
    const { api, me, project } = useEvolved()
    const scope = JSON.stringify([api.baseUrl, me.user.id, project!.id, project!.role, project!.profile, repositoryId])
    return <RepositoryWorktreeForScope key={scope} repositoryId={repositoryId} name={name} onClose={onClose} />
}
function RepositoryWorktreeForScope({ repositoryId, name, onClose }: { repositoryId: string; name: string; onClose: () => void }) {
    const { api, me, project } = useEvolved(), client = useQueryClient()
    const workflow = useProjectWorkflow()
    const base = `${projectPath(project!.id)}/repositories/${encodeURIComponent(repositoryId)}`
    const scope = [api.baseUrl, me.user.id, project!.id, project!.role, project!.profile, repositoryId]
    const status = useQuery({ queryKey: ['evolved', 'worktree', ...scope], retry: false, gcTime: 0,
        queryFn: async ({ signal }) => {
            const result = RepoWorktreeSchema.parse(await api.request(`${base}/worktree`, { signal }))
            if (result.repositoryId !== repositoryId) throw new Error('Repository-Zuordnung konnte nicht geprüft werden.')
            return result
        } })
    const current = !status.error ? status.data : undefined
    const sessions = useQuery({ queryKey: ['evolved', 'repository-sessions', ...scope], retry: false, gcTime: 0,
        queryFn: ({ signal }) => api.request<{ sessions: Array<{ id: string; active: boolean; createdAt: number; updatedAt: number }> }>(`${base}/sessions`, { signal }) })
    const ready = current?.state === 'ready' && !!current.snapshotId
    const [selection, setSelection] = useState<DiffSelection | null>(null)
    const [selectedPaths, setSelectedPaths] = useState<string[]>([])
    const [impactRequest, setImpactRequest] = useState<{ snapshotId: string; paths: string[] } | null>(null)
    const [selectedNode, setSelectedNode] = useState<string | null>(null)
    const [memoryBusy, setMemoryBusy] = useState(false), [memoryError, setMemoryError] = useState<unknown>(null), [memoryNotice, setMemoryNotice] = useState('')
    const memoryRequest = useRef<AbortController | null>(null)
    useEffect(() => () => memoryRequest.current?.abort(), [])
    useEffect(() => { setSelection(null); setSelectedPaths([]); setImpactRequest(null); setSelectedNode(null); setMemoryNotice('') }, [current?.snapshotId])
    const diff = useQuery({ queryKey: ['evolved', 'repository-diff', ...scope, selection], enabled: ready && !!selection && selection.snapshotId === current?.snapshotId,
        retry: false, gcTime: 0, queryFn: async ({ signal }) => {
            const result = RepoDiffSchema.parse(await api.request(`${base}/worktree/diff`, { method: 'POST', body: selection, signal }))
            if (result.path !== selection!.path || result.side !== selection!.side) throw new Error('Die Dateizuordnung konnte nicht geprüft werden.')
            return result
        } })
    const impact = useQuery({ queryKey: ['evolved', 'repository-impact', ...scope, impactRequest], enabled: ready && !!impactRequest && impactRequest.snapshotId === current?.snapshotId,
        retry: false, gcTime: 0, queryFn: async ({ signal }) => {
            const result = await api.request<RepoImpact>(`${base}/impact`, { method: 'POST', body: impactRequest, signal })
            if (result.snapshotId !== impactRequest!.snapshotId || !Array.isArray(result.graph?.nodes) || !Array.isArray(result.graph?.edges)) throw new Error('Der Auswirkungsstand konnte nicht geprüft werden.')
            return result
        } })
    const changed = [diff.error, impact.error].some(error => error instanceof EvolvedApiError && (error.status === 409 || error.code === 'worktree_changed'))
    const refresh = () => { setSelection(null); setSelectedPaths([]); setImpactRequest(null); setSelectedNode(null); void status.refetch() }
    const proposeFile = async (path: string) => {
        if (memoryRequest.current) return
        const controller = new AbortController(); memoryRequest.current = controller
        setMemoryBusy(true); setMemoryError(null); setMemoryNotice('')
        try {
            await api.request(`${base}/memory-intake`, { method: 'POST', body: { path }, signal: controller.signal })
            if (controller.signal.aborted) return
            setMemoryNotice('Die aktuelle Datei wurde als Wissensvorschlag übernommen. Noch nicht inhaltlich verifiziert.')
            void client.invalidateQueries({ queryKey: ['evolved', 'memory'] })
        } catch (failure) { if (!controller.signal.aborted) setMemoryError(failure) }
        finally { if (!controller.signal.aborted) setMemoryBusy(false); if (memoryRequest.current === controller) memoryRequest.current = null }
    }
    return <div className="ev-stack" aria-label={`Arbeitsstand ${name}`}>
        <Panel title={`Arbeitsstand · ${name}`} description="Lokale Änderungen ansehen, Auswirkungen prüfen und einen Review vorbereiten. Diese Ansicht führt keinen Git-Fetch, Commit oder Push aus.">
            <div className="ev-actions"><button onClick={onClose}>Zurück zu den Repositorys</button><button disabled={status.isFetching} onClick={refresh}>Arbeitsstand aktualisieren</button></div>
            <ErrorNotice error={status.error} />{status.isPending && <Loading />}
            {current && <><p>Branch: <strong>{current.detached ? 'Losgelöster HEAD' : current.branch ?? 'Noch kein Branch'}</strong> · HEAD: <code>{current.head?.slice(0, 12) ?? 'Noch kein Commit'}</code></p><p className="ev-muted">Geprüft: {formatDate(current.observedAt)}{current.upstream && ` · ${current.upstream.ahead} voraus / ${current.upstream.behind} zurück`}</p>
                {current.state !== 'ready' && <p role="status">{current.message || ({ missing: 'Repository noch nicht geklont.', blocked: 'Repository kann nicht sicher gelesen werden.', syncing: 'Git-Vorgang läuft. Danach erneut prüfen.', unknown: 'Arbeitsstand unbekannt.' } as Record<string, string>)[current.state]}</p>}
                {current.truncated && <p className="ev-callout">Die Dateiliste ist begrenzt. Nicht alle Änderungen werden angezeigt.</p>}
            </>}
            {changed && <p role="alert" className="ev-callout">Der Arbeitsstand hat sich geändert. Aktualisiere ihn und wähle die Dateien erneut aus.</p>}
            {ready && current && <>
                <p className="ev-muted">Inhalte von Git-Untermodulen werden nicht geprüft.</p>
                {!current.files.length ? <Empty>Keine lokalen Änderungen.</Empty> : <ul className="ev-list">{current.files.map((file, index) => {
                    const previewable = ['file', 'symlink'].includes(file.kind) && !file.excluded && file.path.length <= 1024
                    const selectable = file.kind === 'file' && !file.excluded && file.path.length <= 1024
                    return <li className="ev-row" key={file.pathRef ?? `${file.path}:${index}`}><div className="min-w-0"><label className="ev-check"><input type="checkbox" aria-label={`Auswählen: ${file.display ?? file.path}`} checked={selectedPaths.includes(file.path)} disabled={!selectable || changed || (!selectedPaths.includes(file.path) && selectedPaths.length >= 200)} onChange={event => setSelectedPaths(previous => event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path))} /><code className="break-all">{file.display ?? file.path}</code></label><small className="ev-muted">Index: {file.index === ' ' ? 'unverändert' : file.index} · Arbeitskopie: {file.worktree === ' ' ? 'unverändert' : file.worktree}{file.oldPath ? ` · zuvor ${file.oldPath}` : ''}{file.kind !== 'file' ? ` · ${file.kind}` : ''}{file.excluded ? ' · Vorschau geschützt' : ''}</small></div>
                        {previewable && <div className="ev-actions">{file.index !== ' ' && file.index !== '?' && <button disabled={changed} onClick={() => setSelection({ snapshotId: current.snapshotId!, path: file.path, side: 'staged' })} aria-label={`Staged-Diff: ${file.path}`}>Index-Diff</button>}{file.worktree !== ' ' && <button disabled={changed} onClick={() => setSelection({ snapshotId: current.snapshotId!, path: file.path, side: 'unstaged' })} aria-label={`Arbeitskopie-Diff: ${file.path}`}>Arbeitskopie-Diff</button>}
                            {file.kind === 'file' && canWriteProject(project!.role) && memoryTextPath.test(file.path) && file.worktree !== 'D' && file.index !== 'D' && <ConfirmButton label="Als Wissen vorschlagen" detail="Die Datei wird jetzt erneut gelesen, als Vorschlag gespeichert und mit ihrer Prüfsumme belegt. Ändert sich die Quelle später, wird der Eintrag entfernt. Keine automatische inhaltliche Verifikation." disabled={memoryBusy || changed} onConfirm={() => void proposeFile(file.path)} />}
                        </div>}
                    </li>
                })}</ul>}
                <div className="ev-actions"><button disabled={!selectedPaths.length || changed || impact.isFetching} onClick={() => setImpactRequest({ snapshotId: current.snapshotId!, paths: [...selectedPaths] })}>Auswirkungen prüfen ({selectedPaths.length}/200)</button>
                    {workflow && canWriteProject(project!.role) && selectedPaths.length > 0 && !changed && <WorkspaceLink tab="agents" projectId={project!.id} onClick={() => workflow.setReview({ repositoryId, snapshotId: current.snapshotId!, paths: [...selectedPaths] })}>Review vorbereiten</WorkspaceLink>}
                </div>
            </>}
            <ErrorNotice error={memoryError} />{memoryNotice && <><p role="status">{memoryNotice}</p><WorkspaceLink tab="memory" projectId={project!.id}>Wissensvorschlag im Projektgedächtnis prüfen</WorkspaceLink></>}
        </Panel>
        <Panel title="Sitzungen zu diesem Repository"><ErrorNotice error={sessions.error} />{sessions.isPending && <Loading />}{!sessions.error && sessions.data && (sessions.data.sessions.length ? <ul className="ev-list">{sessions.data.sessions.map(session => <li key={session.id}><Link to="/sessions/$sessionId" params={{ sessionId: session.id }}>Sitzung {session.id.slice(0, 8)} · {session.active ? 'Aktiv' : 'Inaktiv'} · {formatDate(session.updatedAt)}</Link></li>)}</ul> : <Empty>Noch keine zugeordnete Sitzung.</Empty>)}</Panel>
        {ready && selection && <Panel title={`Diff · ${selection.path}`}><p>{selection.side === 'staged' ? 'Index gegenüber HEAD' : 'Arbeitskopie gegenüber Index'}</p><ErrorNotice error={diff.error} />{diff.isFetching && <Loading />}{!diff.error && diff.data && !changed && <>{diff.data.withheld ? <p>{withheld[diff.data.withheld]}</p> : diff.data.binary ? <p>Binärdatei: kein Text-Diff.</p> : diff.data.truncated ? <p>Diff überschreitet die Vorschaugrenze; der Inhalt wird vollständig zurückgehalten.</p> : diff.data.patch ? <DiffDisplay diffContent={diff.data.patch} /> : <Empty>Keine Unterschiede auf dieser Seite.</Empty>}</>}</Panel>}
        {ready && impactRequest && <Panel title="Auswirkungen der ausgewählten Änderungen"><ErrorNotice error={impact.error} />{impact.isFetching && <Loading />}{!impact.error && impact.data && !changed && <>
            <p>Index: {impact.data.index.state} · {impact.data.index.lastIndexedAt ? formatDate(impact.data.index.lastIndexedAt) : 'Zeitpunkt unbekannt'}{impact.data.index.stale ? ' · Veraltet oder nicht vollständig geprüft' : ''}</p>
            <p className="ev-muted">Codegraph-Beziehungen sind Hinweise, kein Nachweis vollständiger Testabdeckung oder bestandener Tests.</p>
            {impact.data.graph.nodes.length ? <CodeGraphCanvas graph={impact.data.graph} selected={selectedNode} onSelect={setSelectedNode} /> : <Empty>{impact.data.index.state !== 'ready' || impact.data.index.stale ? 'Der Index liefert noch keinen bestätigten Ausschnitt. Prüfe den Codegraph-Status.' : 'Keine Beziehungen für die verarbeiteten Dateien gefunden.'}</Empty>}
            {selectedNode && workflow && <WorkspaceLink tab="codegraph" projectId={project!.id} onClick={() => workflow.setNodeId(selectedNode)}>Symbol im Codegraph öffnen</WorkspaceLink>}
            {impact.data.graph.truncated && <p>Graphausschnitt begrenzt.</p>}
            {impact.data.skipped.length > 0 && <details open><summary>Nicht ausgewertete Dateien ({impact.data.skipped.length})</summary><ul>{impact.data.skipped.map((item, index) => <li key={index}><code>{item.path}</code> · {item.reason}</li>)}</ul></details>}
            <h3>Testkandidaten</h3>{impact.data.candidateTests.length ? <ul>{impact.data.candidateTests.map(item => <li key={item.path}><code>{item.path}</code> · anhand des Dateinamens</li>)}</ul> : <p>Keine Testkandidaten erkannt. Das bedeutet nicht, dass keine Tests nötig sind.</p>}
        </>}</Panel>}
    </div>
}
