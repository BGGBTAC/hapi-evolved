import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useOptionalEvolved } from './auth'
import { projectPath } from './api'

type Availability = { enabled: boolean; model?: string; provider?: string; remainingTokens?: number; maxInputChars?: number; maxOutputTokens?: number }
type Reply = { reply: string; model: string; usedTokens: number | null; truncated: boolean }
export function useSidechannel(sessionId?: string) {
    const evolved = useOptionalEvolved(), projectId = evolved?.project?.id
    const [open, setOpen] = useState(false), [text, setText] = useState(''), [reply, setReply] = useState<Reply | null>(null)
    const [error, setError] = useState(''), [busy, setBusy] = useState(false)
    const inFlight = useRef(false)
    const active = useRef<AbortController | null>(null), scope = `${projectId ?? ''}:${sessionId ?? ''}`
    const generation = useRef(0)
    useEffect(() => { generation.current++; inFlight.current = false; active.current?.abort(); setOpen(false); setText(''); setReply(null); setError(''); setBusy(false); return () => { generation.current++; active.current?.abort() } }, [scope])
    const path = projectId ? `${projectPath(projectId)}/sidechannel` : ''
    const [availability, setAvailability] = useState<Availability | null>(null)
    const refresh = useCallback(async (signal?: AbortSignal) => {
        if (!evolved || !projectId || !sessionId) return
        const current = generation.current
        try { const result = await evolved.api.request<Availability>(path, { signal }); if (generation.current === current) setAvailability(result) } catch { /* disabled when status cannot be established */ }
    }, [evolved, projectId, sessionId, path])
    useEffect(() => { const controller = new AbortController(); setAvailability(null); void refresh(controller.signal); return () => controller.abort() }, [refresh])
    const status = { data: availability, refetch: refresh }
    const enabled = availability?.enabled === true
    const intercept = useCallback((value: string) => {
        if (!/^\/btw(?:\s|$)/.test(value)) return false
        setText(value.replace(/^\/btw\s*/, '')); setReply(null); setError(''); setOpen(true); return true
    }, [])
    const send = async () => {
        if (!evolved || !sessionId || !enabled || inFlight.current || !text.trim()) return
        inFlight.current = true
        const controller = new AbortController(), current = generation.current
        active.current = controller; setBusy(true); setError(''); setReply(null)
        // One request ID per explicit submission. Never retry a potentially billed request.
        const requestId = crypto.randomUUID()
        try {
            const result = await evolved.api.request<Reply>(path, { method: 'POST', body: { sessionId, text, requestId }, signal: controller.signal }, false)
            if (generation.current === current) { setReply(result); void status.refetch() }
        } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : 'Anfrage fehlgeschlagen.') }
        finally { if (generation.current === current) { inFlight.current = false; setBusy(false) } }
    }
    const panel = <>
        {(enabled || text.length > 0) && <button type="button" className="min-h-9 rounded px-2 text-sm text-[var(--app-hint)]" onClick={() => setOpen(true)} title="Separate Textfrage (/btw)">/btw</button>}
        <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogTitle>Separate Textfrage</DialogTitle><DialogDescription className="mt-2">Dieser Text verlässt den Host und wird an {status.data?.provider} gesendet. Modell: {status.data?.model}. Keine Chatübernahme, Werkzeuge oder Weiterleitung an deinen Agenten.</DialogDescription>
            <p className="my-2 text-sm">Verbleibendes Budget: {status.data?.remainingTokens ?? 0} Tokens · maximal {status.data?.maxOutputTokens ?? 0} Antwort-Tokens</p>
            {!enabled && <p role="status">Der separate Textkanal ist nicht verfügbar. Deine Frage wurde nicht an den Agenten gesendet.</p>}
            <form onSubmit={event => { event.preventDefault(); void send() }}><label className="block">Frage<textarea aria-label="Separate Frage" className="my-2 block w-full rounded border p-2" rows={5} maxLength={status.data?.maxInputChars} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label><button type="submit" className="rounded border px-3 py-2" disabled={!enabled || busy || !text.trim() || (status.data?.remainingTokens ?? 0) <= 0}>{busy ? 'Anfrage läuft …' : 'An Anbieter senden'}</button></form>
            {error && <p role="alert" className="mt-3 text-red-500">{error} Bei unklarem Ausgang kann die Anfrage bereits berechnet worden sein. Es erfolgt keine automatische Wiederholung.</p>}
            {reply && <div className="mt-3"><p className="whitespace-pre-wrap break-words" data-testid="sidechannel-reply">{reply.reply}</p><p className="mt-2 text-sm text-[var(--app-hint)]">{reply.model} · {reply.usedTokens === null ? 'Verbrauch nicht gemeldet' : `${reply.usedTokens} Tokens`}{reply.truncated ? ' · Antwort gekürzt' : ''}</p></div>}
        </DialogContent></Dialog>
    </>
    return { intercept, panel }
}
