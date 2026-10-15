import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalEvolved } from './auth'
import { EvolvedApiError, projectPath } from './api'

export type ModelProvider = 'codex' | 'claude'
export type ProviderModel = { id: string; label: string; resolvedModel?: string; isDefault?: boolean; reasoningEfforts?: string[] }
export type ProviderModelCatalog = {
    provider: ModelProvider
    status: 'ready' | 'unavailable' | 'disconnected'
    method: 'subscription' | 'api-key' | null
    source: 'native-cli'
    catalogOrigin: 'native-reported'
    entitlementVerified: false
    upstreamRefresh: 'unknown'
    stale: boolean
    checkedAt: number | null
    expiresAt: number | null
    models: ProviderModel[]
    message?: string
}
export type ProviderModelsState = {
    enabled: boolean
    canRefresh: boolean
    data: ProviderModelCatalog | null
    isLoading: boolean
    error: string | null
    refresh: () => Promise<void>
}

/** Account/project-scoped transient catalog; neither auth data nor catalog is persisted. */
export function useProviderModels(args: { provider: ModelProvider | null; projectId?: string | null; enabled?: boolean }): ProviderModelsState {
    const context = useOptionalEvolved()
    const api = context?.api
    const projectId = args.projectId === undefined ? context?.project?.id : args.projectId
    const project = context?.me.accessibleProjects.find(project => project.id === projectId)
    const allowed = project?.role === 'member' || project?.role === 'admin'
    const canRefresh = project?.role === 'admin'
    const enabled = Boolean(args.enabled !== false && api && allowed && args.provider)
    const key = JSON.stringify([api?.baseUrl, context?.me.user.id, projectId, args.provider, enabled, canRefresh])
    const [state, setState] = useState<{ key: string; data: ProviderModelCatalog | null; loading: boolean; error: string | null }>({ key: '', data: null, loading: false, error: null })
    const request = useRef<AbortController | null>(null)
    const coldRefresh = useRef<string | null>(null)
    const load = useCallback(async (refresh: boolean) => {
        request.current?.abort()
        if (!enabled || !api || !projectId || !args.provider || (refresh && !canRefresh)) return
        const controller = new AbortController()
        request.current = controller
        setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: null }))
        let snapshot: ProviderModelCatalog | null = null
        try {
            const path = `${projectPath(projectId)}/providers/${args.provider}/models`
            let data = await api.request<ProviderModelCatalog>(`${path}${refresh ? '/refresh' : ''}`, { signal: controller.signal, ...(refresh ? { method: 'POST' as const, body: {} } : {}) })
            controller.signal.throwIfAborted()
            if (data.provider !== args.provider || !Array.isArray(data.models)) throw new Error('Ungültige Modellliste.')
            snapshot = data
            // One explicit POST on cold/stale admin entry; subsequent read polling never
            // starts native discovery repeatedly. Members only ever read snapshots.
            if (!refresh && canRefresh && coldRefresh.current !== key && (data.checkedAt === null || (data.status === 'ready' && data.stale))) {
                coldRefresh.current = key
                data = await api.request<ProviderModelCatalog>(`${path}/refresh`, { method: 'POST', body: {}, signal: controller.signal })
            }
            controller.signal.throwIfAborted()
            if (data.provider !== args.provider || !Array.isArray(data.models)) throw new Error('Ungültige Modellliste.')
            setState({ key, data, loading: false, error: null })
        } catch (error) {
            if (controller.signal.aborted) return
            const denied = error instanceof EvolvedApiError && (error.status === 401 || error.status === 403)
            setState(previous => {
                const retained = snapshot ?? (previous.key === key ? previous.data : null)
                return { key, data: denied ? null : retained ? { ...retained, stale: true } : null, loading: false, error: error instanceof Error ? error.message : 'Modellliste nicht verfügbar.' }
            })
        }
    }, [api, args.provider, enabled, canRefresh, key, projectId])
    useEffect(() => {
        void load(false)
        const check = () => { if (document.visibilityState !== 'hidden') void load(false) }
        const interval = enabled ? setInterval(check, 60_000) : undefined
        if (enabled) window.addEventListener('focus', check)
        return () => { request.current?.abort(); clearInterval(interval); window.removeEventListener('focus', check) }
    }, [enabled, load])
    const refresh = useCallback(() => load(true), [load])
    const current = enabled && state.key === key ? state : null
    return { enabled, canRefresh: enabled && canRefresh, data: current?.data ?? null, isLoading: enabled && (!current || current.loading), error: current?.error ?? null, refresh }
}
