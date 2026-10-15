import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function LongPasteChoice({ text, allowFile, onText, onFile, onCancel }: {
    text: string; allowFile: boolean; onText: () => void; onFile: (file: File) => Promise<void>; onCancel: () => void
}) {
    const [busy, setBusy] = useState(false), [error, setError] = useState('')
    return <Dialog open onOpenChange={open => { if (!open && !busy) onCancel() }}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Large pasted text</DialogTitle></DialogHeader>
        <p>{text.length.toLocaleString()} characters, {text.split('\n').length.toLocaleString()} lines. Choose how to add the complete text to your draft.</p>
        {!allowFile ? <p>Attachments are unavailable for scheduled messages.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="flex gap-2 flex-wrap">
            <Button type="button" disabled={busy} onClick={onText}>Send as text</Button>
            <Button type="button" disabled={busy || !allowFile} onClick={async () => {
                setBusy(true); setError('')
                try { await onFile(new File([text], `pasted-${Date.now()}.txt`, { type: 'text/plain' })); onCancel() }
                catch { setError('The attachment could not be added. The original text is still available here.') }
                finally { setBusy(false) }
            }}>Send as .txt</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
        <p className="text-xs text-[var(--app-hint)]">Review the draft, then use the normal Send button.</p>
    </DialogContent></Dialog>
}
