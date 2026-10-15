import { useEffect, useState } from 'react'
import { useAui } from '@assistant-ui/react'
import { imageVersionFile, imageVersionId, isImageVersionSwitching, setImageVersionSwitching, markImageVersionsInconsistent, type ImagePreparation } from '@/lib/imageUpload'
function size(value: number) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB` }
export function ImageVersionControl({ id, sessionId, preparation, disabled }: { id: string; sessionId: string; preparation: ImagePreparation; disabled: boolean }) {
    const api = useAui(), [busy, setBusy] = useState(false), [error, setError] = useState('')
    useEffect(() => () => { setImageVersionSwitching(sessionId, false) }, [sessionId])
    const replace = async () => {
        if (busy || isImageVersionSwitching() || isImageVersionSwitching(sessionId)) return
        setBusy(true); setError(''); setImageVersionSwitching(sessionId, true)
        const nextFile = imageVersionFile(preparation, !preparation.originalSelected), replacementId = imageVersionId(nextFile)!
        let consistent = false
        try {
            await api.composer().addAttachment(nextFile)
            // React's composer snapshot can lag behind the adapter's resolved promise.
            const deadline = Date.now() + 3000
            let items = api.composer().getState().attachments
            let replacement = items.find(item => item.id === replacementId)
            while ((!replacement || replacement.status.type === 'running') && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 25))
                items = api.composer().getState().attachments
                replacement = items.find(item => item.id === replacementId)
            }
            if (!replacement) throw new Error('Versionswechsel wurde abgebrochen oder ist noch nicht bestätigt. Bisheriger Anhang bleibt erhalten.')
            if (!items.some(item => item.id === id) || replacement.status.type !== 'requires-action') {
                await api.composer().attachment({ id: replacement.id }).remove()
                if (replacement.status.type !== 'requires-action') throw new Error('Versionswechsel fehlgeschlagen. Bisheriger Anhang bleibt erhalten.')
            } else await api.composer().attachment({ id }).remove()
        } catch (failure) {
            try { await api.composer().attachment({ id: replacementId }).remove() } catch { /* remain locked if both versions survive */ }
            setError(failure instanceof Error ? failure.message : 'Versionswechsel fehlgeschlagen.') }
        finally {
            const ids = new Set(api.composer().getState().attachments.map(item => item.id)); consistent = !(ids.has(id) && ids.has(replacementId))
            if (!consistent) {
                markImageVersionsInconsistent(sessionId, [id, replacementId])
                setError('Beide Bildversionen sind noch vorhanden. Entferne einen Anhang oder lade den Entwurf neu, bevor du sendest.')
            }
            setImageVersionSwitching(sessionId, false)
            setBusy(false)
        }
    }
    return <div className="max-w-56 text-xs text-[var(--app-hint)]"><p>{preparation.compressed ? `Komprimiert · ${size(preparation.original.size)} → ${size(preparation.file.size)}` : size(preparation.file.size)}{preparation.width && preparation.height ? ` · ${preparation.width} × ${preparation.height}` : ''}</p><button type="button" className="min-h-8 underline" disabled={disabled || busy} onClick={() => void replace()}>{busy ? 'Bildversion wird gewechselt …' : preparation.originalSelected ? 'Automatisch komprimieren' : 'Original senden'}</button>{error && <p role="alert" className="text-red-500">{error}</p>}</div>
}
