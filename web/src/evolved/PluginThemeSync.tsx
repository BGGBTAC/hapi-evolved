import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { registerPluginColorThemes } from '@/hooks/useColorTheme'
import type { EvolvedApi } from './api'

/** Only public palette metadata is cached; the registry is cleared on account changes. */
export function PluginThemeSync({ api, userId }: { api: EvolvedApi; userId: string }) {
    const query = useQuery({
        queryKey: ['evolved', 'agent-catalog', api.baseUrl, userId, 'global'],
        queryFn: ({ signal }) => api.request<{ themes?: unknown }>('/agent-catalog', { signal }),
        staleTime: 30_000,
        retry: false,
    })
    useEffect(() => () => registerPluginColorThemes([]), [api.baseUrl, userId])
    useEffect(() => { registerPluginColorThemes(query.data?.themes ?? []) }, [query.data, api.baseUrl, userId])
    return null
}
