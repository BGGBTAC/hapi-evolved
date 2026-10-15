import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

export function ModelErrorBanner({ api, session }: { api: ApiClient; session: Session }) {
    const [failure, setFailure] = useState<string | null>(null)
    const [pending, setPending] = useState(false)
    const cache = useQueryClient()
    const { t } = useTranslation()
    const error = session.metadata?.lastModelError
    if (!error || error.acknowledgedAt) return null
    return <div role="alert" className="mx-3 rounded border border-amber-500 bg-amber-500/10 p-3 text-sm">
        <strong>{t('session.modelError.title')}</strong>
        <p>{t('session.modelError.description')}</p>
        <details><summary>{error.kind}</summary><pre className="whitespace-pre-wrap break-words">{error.message}</pre></details>
        <button type="button" disabled={pending} onClick={() => {
            setPending(true); setFailure(null)
            void api.acknowledgeModelError(session.id, error.at).then(() => {
                void cache.invalidateQueries({ queryKey: queryKeys.session(session.id) })
                void cache.invalidateQueries({ queryKey: queryKeys.sessions })
            }).catch(reason => setFailure(String(reason))).finally(() => setPending(false))
        }}>{t('session.modelError.acknowledge')}</button>
        {failure ? <p>{failure}</p> : null}
    </div>
}
