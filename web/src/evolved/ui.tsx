import { useState, type FormEvent, type ReactNode } from 'react'

export function ErrorNotice({ error }: { error: unknown }) {
    if (!error) return null
    return <div className="ev-error" role="alert">{error instanceof Error ? error.message : String(error)}</div>
}
export function Empty({ children }: { children: ReactNode }) {
    return <p className="ev-empty">{children}</p>
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
    return <label className="ev-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}
export function Panel({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
    return <section className="ev-panel"><h2>{title}</h2>{description && <p className="ev-muted">{description}</p>}{children}</section>
}
export function Loading() { return <p role="status" className="ev-muted">Wird geladen …</p> }
export function useAction() {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<unknown>(null)
    const [notice, setNotice] = useState('')
    const run = async (action: () => Promise<void>, success = '') => {
        setBusy(true)
        setError(null)
        setNotice('')
        try { await action(); setNotice(success) } catch (failure) { setError(failure) } finally { setBusy(false) }
    }
    return { busy, error, notice, run, clear: () => { setError(null); setNotice('') } }
}
export function ActionStatus({ action }: { action: ReturnType<typeof useAction> }) {
    return <><ErrorNotice error={action.error} />{action.notice && <p className="ev-success" role="status">{action.notice}</p>}</>
}
export function submit(action: () => void) {
    return (event: FormEvent) => { event.preventDefault(); action() }
}
export function formatDate(value: number | string): string {
    return new Date(value).toLocaleString('de-DE')
}
export function ConfirmButton({ label, detail, onConfirm, disabled = false }: {
    label: string; detail: string; onConfirm: () => void; disabled?: boolean
}) {
    const [confirming, setConfirming] = useState(false)
    return confirming ? <span className="ev-confirm"><span>{detail}</span><button className="ev-danger" disabled={disabled} onClick={() => { setConfirming(false); onConfirm() }}>Bestätigen</button><button onClick={() => setConfirming(false)}>Abbrechen</button></span>
        : <button className="ev-danger-subtle" disabled={disabled} onClick={() => setConfirming(true)}>{label}</button>
}
