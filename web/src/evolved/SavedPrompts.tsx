import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useOptionalEvolved } from './auth'
import type { EvolvedApi } from './api'

type SavedPrompt = { id: string; title: string; text: string }
type Props = { disabled?: boolean; onOpen: () => void; onInsert: (text: string) => void }

export function SavedPromptsButton(props: Props) {
    const evolved = useOptionalEvolved()
    if (!evolved) return null
    return <PersonalPrompts key={evolved.me.user.id} api={evolved.api} userId={evolved.me.user.id} {...props} />
}

export function PersonalPrompts({ api, userId, disabled, onOpen, onInsert }: Props & { api: EvolvedApi; userId: string }) {
    const [open, setOpen] = useState(false), [search, setSearch] = useState('')
    const [editor, setEditor] = useState<{ id?: string; title: string; text: string } | null>(null)
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [deleting, setDeleting] = useState<string | null>(null)
    const client = useQueryClient(), key = ['evolved', 'saved-prompts', userId]
    const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api.request<{ prompts: SavedPrompt[] }>('/saved-prompts', { signal }), enabled: open, staleTime: 0 })
    const prompts = query.data?.prompts ?? []
    const run = async (work: () => Promise<unknown>) => {
        setBusy(true); setError('')
        try { await work(); await client.invalidateQueries({ queryKey: key }); setEditor(null); setDeleting(null) }
        catch (e) { setError(e instanceof Error ? e.message : 'Anfrage fehlgeschlagen.') }
        finally { setBusy(false) }
    }
    const move = (id: string, delta: number) => {
        const ids = prompts.map(p => p.id), index = ids.indexOf(id), next = index + delta
        if (index < 0 || next < 0 || next >= ids.length) return
        ;[ids[index], ids[next]] = [ids[next], ids[index]]
        void run(() => api.request('/saved-prompts/order', { method: 'PUT', body: { ids } }))
    }
    return <>
        <button type="button" disabled={disabled} title="Persönliche Prompts" aria-label="Persönliche Prompts" className="min-h-9 rounded px-2 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]" onClick={() => { onOpen(); setOpen(true) }}>Prompts</button>
        <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto">
            <DialogTitle className="pr-10">Persönliche Prompts</DialogTitle>
            <DialogDescription className="mt-2">Mit deinem Konto synchronisiert. Einfügen ergänzt nur den Entwurf und sendet keine Nachricht.</DialogDescription>
            <div className="mt-3 flex gap-2"><input aria-label="Prompts durchsuchen" value={search} onChange={e => setSearch(e.target.value)} placeholder="Titel oder Inhalt suchen" className="min-w-0 flex-1 rounded border p-2" /><button type="button" disabled={busy} onClick={() => setEditor({ title: '', text: '' })}>Neu</button></div>
            {error || query.error ? <p role="alert" className="my-2 text-red-500">{error || query.error?.message}</p> : null}
            {query.isPending ? <p role="status">Lädt …</p> : null}
            {editor ? <form className="my-3 grid gap-2" onSubmit={e => { e.preventDefault(); void run(() => api.request(`/saved-prompts${editor.id ? `/${encodeURIComponent(editor.id)}` : ''}`, { method: editor.id ? 'PUT' : 'POST', body: { title: editor.title, text: editor.text } })) }}>
                <label>Titel (optional)<input value={editor.title} maxLength={120} onChange={e => setEditor({ ...editor, title: e.target.value })} className="block w-full rounded border p-2" /></label>
                <label>Prompt<textarea required rows={6} maxLength={32_768} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} className="block w-full rounded border p-2" /></label>
                <div className="flex gap-3"><button disabled={busy || !editor.text.trim()}>Speichern</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>Abbrechen</button></div>
            </form> : null}
            <ul className="mt-3 grid gap-3">{prompts.filter(p => `${p.title}\n${p.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(p => <li key={p.id} className="rounded border p-3">
                <strong>{p.title || p.text.split('\n')[0].slice(0, 80)}</strong><p className="my-2 line-clamp-3 whitespace-pre-wrap break-words text-sm">{p.text}</p>
                <div className="flex flex-wrap gap-3 text-sm"><button type="button" disabled={disabled || busy} onClick={() => { onInsert(p.text); setOpen(false) }}>Einfügen</button><button type="button" disabled={busy} onClick={() => setEditor(p)}>Bearbeiten</button><button type="button" disabled={busy || prompts[0]?.id === p.id} aria-label={`Nach oben: ${p.title || 'Prompt'}`} onClick={() => move(p.id, -1)}>↑</button><button type="button" disabled={busy || prompts.at(-1)?.id === p.id} aria-label={`Nach unten: ${p.title || 'Prompt'}`} onClick={() => move(p.id, 1)}>↓</button><button type="button" disabled={busy} onClick={() => setDeleting(p.id)}>Löschen</button></div>
                {deleting === p.id ? <div className="mt-2 flex gap-3" role="group" aria-label="Löschen bestätigen"><span>Prompt endgültig löschen?</span><button type="button" disabled={busy} onClick={() => void run(() => api.request(`/saved-prompts/${encodeURIComponent(p.id)}`, { method: 'DELETE' }))}>Ja, löschen</button><button type="button" onClick={() => setDeleting(null)}>Abbrechen</button></div> : null}
            </li>)}</ul>
            {!query.isPending && !prompts.length ? <p className="mt-3 text-sm">Noch keine gespeicherten Prompts.</p> : null}
        </DialogContent></Dialog>
    </>
}
