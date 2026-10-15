import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useOptionalEvolved, type EvolvedSession } from './auth'
import { canWriteProject, EvolvedApiError, projectPath, type MemoryItem } from './api'
import { MemoryProposalFields } from './MemoryProposalFields'
import { MessageMemoryContext } from './messageMemoryContext'
import { ErrorNotice, Field, Loading, submit } from './ui'
import { WorkspaceLink } from './workspaceNavigation'

type MessageSource = { sessionId: string; messageId: string; body: string; sourceHash: string; title: string }
export function codePointSelection(text: string, start: number, end: number) {
    // Textarea offsets use UTF-16 and normalize CRLF/CR to LF. The server
    // extracts from the unchanged original text using Unicode codepoints.
    const normalized = text.replace(/\r\n?/g, '\n')
    const middle = (index: number) => index > 0 && /[\uD800-\uDBFF]/.test(normalized[index - 1] ?? '') && /[\uDC00-\uDFFF]/.test(normalized[index] ?? '')
    const from = middle(start) ? start - 1 : start, to = middle(end) ? end + 1 : end
    const original = Array.from(text), boundaries = [0]
    for (let index = 0; index < original.length; index++) {
        if (original[index] === '\r' && original[index + 1] === '\n') index++
        boundaries.push(index + 1)
    }
    return { start: boundaries[Array.from(normalized.slice(0, from)).length]!, end: boundaries[Array.from(normalized.slice(0, to)).length]! }
}

function sourceError(error: unknown): string {
    if (error instanceof EvolvedApiError) {
        if (error.status === 401 || error.status === 403) return 'Du kannst diese Nachrichtenquelle nicht übernehmen. Prüfe Anmeldung und Projektberechtigung.'
        if (error.status === 404) return 'Die gespeicherte Nachricht ist nicht mehr verfügbar oder gehört nicht zu diesem Projekt.'
        if (error.status === 409) return 'Die Nachrichtenquelle hat sich geändert. Lade sie erneut und prüfe den Text.'
        if (error.status === 413) return 'Diese Nachricht ist für einen Wissensvorschlag zu groß.'
        if (error.status === 422) return 'Die Quelle kann nicht übernommen werden. Nur unterstützter Text ohne Zugangsdaten ist erlaubt.'
    }
    return 'Die Nachrichtenquelle konnte nicht geprüft werden. Versuche es erneut.'
}

export function MessageMemoryProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
    const evolved = useOptionalEvolved()
    const project = evolved?.project
    if (!evolved || !project || !canWriteProject(project.role)) return <MessageMemoryContext.Provider value={null}>{children}</MessageMemoryContext.Provider>
    const scope = JSON.stringify([evolved.api.baseUrl, evolved.me.user.id, project.id, project.role, project.profile, sessionId])
    return <ScopedMessageMemory key={scope} evolved={evolved} sessionId={sessionId}>{children}</ScopedMessageMemory>
}

function ScopedMessageMemory({ evolved, sessionId, children }: { evolved: EvolvedSession; sessionId: string; children: ReactNode }) {
    const [selection, setSelection] = useState<{ ids: string[]; sequence: number } | null>(null)
    const sequence = useRef(0)
    const trigger = useRef<HTMLElement | null>(null)
    const open = (sourceMessageIds: readonly string[]) => {
        const ids = [...new Set(sourceMessageIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))]
        if (!ids.length) return
        trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setSelection({ ids, sequence: ++sequence.current })
    }
    return <MessageMemoryContext.Provider value={open}>
        {children}
        {selection && <MessageMemoryDialog key={selection.sequence} evolved={evolved} sessionId={sessionId} sourceIds={selection.ids}
            onClose={() => setSelection(null)} onReturnFocus={() => { if (trigger.current?.isConnected) trigger.current.focus() }} />}
    </MessageMemoryContext.Provider>
}

function MessageMemoryDialog({ evolved, sessionId, sourceIds, onClose, onReturnFocus }: {
    evolved: EvolvedSession; sessionId: string; sourceIds: string[]; onClose: () => void; onReturnFocus: () => void
}) {
    const { api, project } = evolved
    const path = `${projectPath(project!.id)}/memory`
    const client = useQueryClient()
    const [messageId, setMessageId] = useState(sourceIds.length === 1 ? sourceIds[0]! : '')
    const [source, setSource] = useState<MessageSource | null>(null)
    const [title, setTitle] = useState(''), [body, setBody] = useState('')
    const [marked, setMarked] = useState<{ start: number; end: number } | null>(null)
    const [excerpt, setExcerpt] = useState<{ start: number; end: number } | null>(null)
    const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null), [saved, setSaved] = useState<'proposed' | 'verified' | null>(null)
    const [uncertain, setUncertain] = useState(false), [reload, setReload] = useState(0)
    const mounted = useRef(false), pending = useRef<AbortController | null>(null)
    useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort() } }, [])
    useEffect(() => {
        setSource(null); setTitle(''); setBody(''); setError(null); setUncertain(false); setMarked(null); setExcerpt(null)
        if (!messageId) return
        const controller = new AbortController()
        setLoading(true)
        void api.request<MessageSource>(`${path}/message-source?${new URLSearchParams({ sessionId, messageId })}`, { signal: controller.signal })
            .then(result => {
                if (controller.signal.aborted || !mounted.current) return
                if (result.sessionId !== sessionId || result.messageId !== messageId || typeof result.body !== 'string' || result.body.length > 50000
                    || typeof result.title !== 'string' || result.title.length > 200 || !/^[a-f0-9]{64}$/.test(result.sourceHash)) throw new Error('Invalid source')
                setSource(result); setTitle(result.title); setBody(result.body)
            })
            .catch(failure => { if (!controller.signal.aborted && mounted.current) setError(sourceError(failure)) })
            .finally(() => { if (!controller.signal.aborted && mounted.current) setLoading(false) })
        return () => controller.abort()
    }, [api, path, sessionId, messageId, reload])
    const save = async () => {
        if (!source || pending.current || !title.trim() || !body.trim() || (excerpt && excerpt.end - excerpt.start > 20000)) return
        const controller = new AbortController(); pending.current = controller
        setSaving(true); setError(null)
        try {
            const response = await api.request<{ item: MemoryItem }>(`${path}/from-message`, { method: 'POST', signal: controller.signal,
                body: { sessionId, messageId: source.messageId, expectedSourceHash: source.sourceHash, title: title.trim(), ...(excerpt ? { excerpt } : {}) } })
            if (controller.signal.aborted || !mounted.current) return
            if (response.item?.projectId !== project!.id || !['proposed', 'verified'].includes(response.item?.status)) throw new Error('Invalid memory receipt')
            setSaved(response.item.status as 'proposed' | 'verified'); setSource(null); setTitle(''); setBody(''); setUncertain(false)
            void client.invalidateQueries({ queryKey: ['evolved', 'memory'] })
            void client.invalidateQueries({ queryKey: ['evolved', 'memory-search'] })
        } catch (failure) {
            if (controller.signal.aborted || !mounted.current) return
            if (!(failure instanceof EvolvedApiError) || failure.status >= 500) {
                setUncertain(true)
                setError('Der Speicherstatus ist unklar. Prüfe das Projektgedächtnis oder sende denselben unveränderten Vorschlag erneut.')
            } else {
                setError(sourceError(failure))
                if ([401, 403, 404, 409].includes(failure.status)) { setSource(null); setTitle(''); setBody('') }
            }
        } finally {
            if (mounted.current && !controller.signal.aborted) setSaving(false)
            if (pending.current === controller) pending.current = null
        }
    }
    return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <DialogContent className="evolved max-h-[85dvh] overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus() }}>
            <DialogHeader><DialogTitle>Als Wissen vorschlagen</DialogTitle><DialogDescription>Projekt: {project!.name}. Die gespeicherte Nachricht belegt die Quelle. Ihr Inhalt bleibt bis zur menschlichen Prüfung ein Vorschlag.</DialogDescription></DialogHeader>
            <div className="ev-stack mt-4">
                {saved ? <><p className="ev-success" role="status">{saved === 'verified' ? 'Dieser Inhalt ist bereits verifiziert im Projektgedächtnis vorhanden. Sein Status wurde nicht verändert.' : 'Vorschlag gespeichert. Der Inhalt wurde noch nicht verifiziert.'}</p><WorkspaceLink tab="memory" projectId={project!.id} onClick={onClose}>Im Projektgedächtnis ansehen</WorkspaceLink></> : <>
                    {sourceIds.length > 1 && <Field label="Gespeicherte Nachricht" hint="Diese Karte umfasst mehrere Nachrichten. Wähle die konkrete Textquelle."><select value={messageId} disabled={saving || uncertain} onChange={event => setMessageId(event.target.value)}><option value="">Nachricht auswählen</option>{sourceIds.map((id, index) => <option value={id} key={id}>Nachricht {index + 1} · {id}</option>)}</select></Field>}
                    <ErrorNotice error={error} />
                    {loading && <Loading />}
                    {source && <form className="ev-stack" onSubmit={submit(() => void save())}>
                        <p className="ev-muted">Übernommen wird genau dieser gespeicherte Text, ohne Anhänge. Eine eigene Zusammenfassung kannst du separat als manuelle Beobachtung im Projektgedächtnis vorschlagen. Diese Aktion schaltet keine Cloud-Verarbeitung frei.</p>
                        <MemoryProposalFields title={title} body={body} onTitle={setTitle} onBody={setBody} readOnlyBody disabled={saving || uncertain} onSelection={(start, end) => setMarked(end > start ? codePointSelection(body, start, end) : null)} />
                        <p className="ev-muted">Zum Kürzen markiere einen zusammenhängenden Textausschnitt. Der Originaltext wird nicht bearbeitet.</p>
                        <div className="ev-actions"><button type="button" disabled={saving || uncertain || !marked || marked.end - marked.start > 20000} onClick={() => setExcerpt(marked)}>Markierten Ausschnitt übernehmen</button>{excerpt && <button type="button" disabled={saving || uncertain} onClick={() => setExcerpt(null)}>Vollständige Nachricht verwenden</button>}</div>
                        {marked && marked.end - marked.start > 20000 && <p role="alert">Ein Ausschnitt darf höchstens 20.000 Zeichen umfassen. Wähle weniger Text oder übernimm die vollständige Nachricht.</p>}
                        {excerpt && <blockquote className="whitespace-pre-wrap break-words" aria-label="Ausgewählter Ausschnitt">{Array.from(body).slice(excerpt.start, excerpt.end).join('')}</blockquote>}
                        <button type="submit" className="ev-primary" disabled={saving || !title.trim() || !body.trim()}>{saving ? 'Wird gespeichert …' : uncertain ? 'Denselben Vorschlag erneut senden' : 'Vorschlag speichern'}</button>
                    </form>}
                    {!source && !loading && messageId && <button onClick={() => setReload(value => value + 1)}>Quelle erneut laden</button>}
                    {uncertain && <WorkspaceLink tab="memory" projectId={project!.id} onClick={onClose}>Speicherstatus im Projektgedächtnis prüfen</WorkspaceLink>}
                </>}
                <button type="button" onClick={onClose}>{saved ? 'Schließen' : 'Abbrechen'}</button>
            </div>
        </DialogContent>
    </Dialog>
}
