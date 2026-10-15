import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getPrimaryGithubPrRef, parseGithubPrInput, type ExternalRef } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const featureKey = ['hub-features'] as const
export function useGithubPrFeature(api: ApiClient | null) {
    return useQuery({ queryKey: featureKey, queryFn: () => api!.getFeatures(), enabled: !!api && typeof api.getFeatures === 'function', staleTime: 15_000, refetchInterval: 30_000, retry: false })
}
export function SessionPrChip({ api, refs, link = false }: { api: ApiClient | null; refs?: ExternalRef[]; link?: boolean }) {
    const { data } = useGithubPrFeature(api), ref = getPrimaryGithubPrRef(refs)
    if (!data?.githubPrAwareness.enabled || !ref) return null
    const text = `${ref.repo}#${ref.number}`
    return link ? <a className="text-xs text-[var(--app-link)] truncate" href={ref.url} target="_blank" rel="noopener noreferrer" title={text}>{text}</a>
        : <span className="text-xs text-[var(--app-hint)] truncate" title={text}>{text}</span>
}
export function GithubPrControl({ api, sessionId, refs }: { api: ApiClient | null; sessionId: string; refs?: ExternalRef[] }) {
    const { data } = useGithubPrFeature(api), queries = useQueryClient()
    const [open, setOpen] = useState(false), [value, setValue] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
    if (!data?.githubPrAwareness.enabled) return null
    const save = async (unlink = false) => {
        const ref = parseGithubPrInput(value)
        if (!unlink && !ref) { setError('Enter a github.com PR URL or owner/repository#number.'); return }
        setBusy(true); setError('')
        try {
            await api!.setSessionExternalRefs(sessionId, unlink ? [] : [ref!])
            await queries.invalidateQueries({ predicate: q => q.queryKey.includes('sessions') || q.queryKey.includes(sessionId) })
            setOpen(false)
        } catch (e) { setError(e instanceof Error ? e.message : 'PR link could not be saved.') }
        finally { setBusy(false) }
    }
    return <>
        <button type="button" className="px-2 text-xs text-[var(--app-hint)]" title="Link GitHub PR" aria-label="Link GitHub PR" onClick={() => { setValue(getPrimaryGithubPrRef(refs)?.url ?? ''); setError(''); setOpen(true) }}>PR</button>
        <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Link GitHub PR</DialogTitle></DialogHeader>
            <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void save() }}>
                <label>PR URL or owner/repository#number<input autoFocus className="w-full rounded border p-2 bg-[var(--app-bg)]" value={value} maxLength={300} onChange={e => setValue(e.target.value)} disabled={busy}/></label>
                <p className="text-xs text-[var(--app-hint)]">Only a link is saved. GitHub is contacted when you open it.</p>
                {error ? <p role="alert">{error}</p> : null}
                <div className="flex gap-2"><Button type="submit" disabled={busy}>Save PR link</Button><Button type="button" variant="secondary" disabled={busy || !refs?.length} onClick={() => void save(true)}>Unlink PR</Button></div>
            </form>
        </DialogContent></Dialog>
    </>
}
export function GithubPrSetting({ api }: { api: ApiClient | null }) {
    const { data } = useGithubPrFeature(api), queries = useQueryClient()
    const [error, setError] = useState(''), [busy, setBusy] = useState(false)
    if (!data?.canManage) return null
    return <div className="rounded-lg border p-3 flex flex-col gap-2">
        <label className="flex gap-2"><input type="checkbox" checked={data.githubPrAwareness.enabled} disabled={busy || data.githubPrAwareness.source === 'env'} onChange={async e => {
            setBusy(true); setError('')
            try { queries.setQueryData(featureKey, await api!.updateFeatures(e.target.checked)) }
            catch (err) { setError(err instanceof Error ? err.message : 'Setting could not be saved.') }
            finally { setBusy(false) }
        }}/>GitHub PR links</label>
        <p className="text-xs text-[var(--app-hint)]">Optional session links, CLI and agent tool. {data.githubPrAwareness.source === 'env' ? 'Pinned by the hub environment.' : 'Reconnect agent sessions after enabling the tool.'}</p>
        {error ? <p role="alert">{error}</p> : null}
    </div>
}
