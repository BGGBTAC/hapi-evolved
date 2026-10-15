import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProviderModels, type ProviderModelCatalog } from './useProviderModels'
import { EvolvedApiError } from './api'

const context = vi.hoisted(() => ({ api: { baseUrl: '', request: vi.fn() }, me: { user: { id: 'user-1' }, accessibleProjects: [{ id: 'project-1', role: 'admin' }, { id: 'project-2', role: 'admin' }] }, project: { id: 'project-1' } }))
vi.mock('./auth', () => ({ useOptionalEvolved: () => context }))
const catalog = (id = 'native-current'): ProviderModelCatalog => ({ provider: 'claude', status: 'ready', method: 'subscription', source: 'native-cli', catalogOrigin: 'native-reported', entitlementVerified: false, upstreamRefresh: 'unknown', stale: false, checkedAt: 1, expiresAt: Date.now() + 60_000, models: [{ id, label: id }] })

beforeEach(() => { context.api.request.mockReset().mockResolvedValue(catalog()); context.api.baseUrl = ''; context.me.user.id = 'user-1'; context.project.id = 'project-1'; context.me.accessibleProjects[0].role = 'admin' })

describe('Native provider model catalog scope', () => {
    it('fetches current native data, explicitly refreshes and does not persist it', async () => {
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data?.models[0].id).toBe('native-current'))
        expect(context.api.request).toHaveBeenCalledWith('/projects/project-1/providers/claude/models', expect.objectContaining({ signal: expect.any(AbortSignal) }))
        await act(() => hook.result.current.refresh())
        expect(context.api.request).toHaveBeenLastCalledWith('/projects/project-1/providers/claude/models/refresh', expect.objectContaining({ method: 'POST', body: {} }))
        expect(JSON.stringify(localStorage)).not.toContain('native-current')
    })
    it.each(['user', 'project', 'origin'] as const)('discards late previous %s response even when transport ignores abort', async dimension => {
        let finish!: (value: ProviderModelCatalog) => void
        context.api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(catalog('new-scope'))
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        const signal = context.api.request.mock.calls[0][1].signal as AbortSignal
        if (dimension === 'user') context.me.user.id = 'user-2'
        if (dimension === 'project') context.project.id = 'project-2'
        if (dimension === 'origin') context.api.baseUrl = 'https://other.invalid'
        hook.rerender()
        expect(signal.aborted).toBe(true)
        await waitFor(() => expect(hook.result.current.data?.models[0].id).toBe('new-scope'))
        await act(async () => finish(catalog('old-private-catalog')))
        expect(hook.result.current.data?.models[0].id).toBe('new-scope')
    })
    it('does not query an unauthorized or absent project', () => {
        const hook = renderHook(() => useProviderModels({ provider: 'codex', projectId: 'forbidden' }))
        expect(hook.result.current.enabled).toBe(false)
        expect(context.api.request).not.toHaveBeenCalled()
    })
    it('preserves the last catalog with stale/error state after failed refresh', async () => {
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data).not.toBeNull())
        context.api.request.mockRejectedValue(new Error('Runner offline'))
        await act(() => hook.result.current.refresh())
        expect(hook.result.current.data?.models[0].id).toBe('native-current')
        expect(hook.result.current.data?.stale).toBe(true)
        expect(hook.result.current.error).toBe('Runner offline')
    })
    it('aborts on unmount without accepting late data', () => {
        context.api.request.mockReturnValue(new Promise(() => {}))
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        const signal = context.api.request.mock.calls[0][1].signal as AbortSignal
        hook.unmount()
        expect(signal.aborted).toBe(true)
    })
    it('initializes an absent admin catalog through a single explicit POST', async () => {
        context.api.request.mockResolvedValueOnce({ ...catalog(), status: 'unavailable', checkedAt: null, models: [] }).mockResolvedValue(catalog('native-fresh'))
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data?.models[0].id).toBe('native-fresh'))
        expect(context.api.request).toHaveBeenCalledTimes(2)
        expect(context.api.request).toHaveBeenLastCalledWith('/projects/project-1/providers/claude/models/refresh', expect.objectContaining({ method: 'POST', body: {} }))
    })
    it('members never execute native discovery, including cold entry or refresh invocation', async () => {
        context.me.accessibleProjects[0].role = 'member'
        context.api.request.mockResolvedValue({ ...catalog(), status: 'unavailable', models: [] })
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data?.status).toBe('unavailable'))
        expect(hook.result.current.canRefresh).toBe(false)
        await act(() => hook.result.current.refresh())
        expect(context.api.request).toHaveBeenCalledTimes(1)
    })
    it('revoked project role aborts in-flight discovery and immediately hides prior catalog', async () => {
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data).not.toBeNull())
        context.me.accessibleProjects[0].role = 'viewer'
        hook.rerender()
        expect(hook.result.current.enabled).toBe(false)
        expect(hook.result.current.data).toBeNull()
    })
    it.each(['disconnected', 'unavailable'] as const)('does not auto-refresh a checked %s status on remount', async status => {
        context.api.request.mockResolvedValue({ ...catalog(), status, method: null, models: [], expiresAt: null, stale: true })
        let hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data?.status).toBe(status))
        hook.unmount()
        hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data?.status).toBe(status))
        expect(context.api.request.mock.calls.every(([, options]) => !options.method)).toBe(true)
    })
    it('retains the GET snapshot when a remounted stale catalog refresh returns 429', async () => {
        context.api.request.mockImplementation(async (_path, options) => {
            if (options.method === 'POST') throw new EvolvedApiError('Bitte später aktualisieren', 429)
            return { ...catalog(), stale: true }
        })
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.error).toBe('Bitte später aktualisieren'))
        expect(hook.result.current.data?.models[0].id).toBe('native-current')
        expect(hook.result.current.data?.stale).toBe(true)
    })
    it.each([401, 403])('removes all cached model data after authority failure %s', async status => {
        const hook = renderHook(() => useProviderModels({ provider: 'claude' }))
        await waitFor(() => expect(hook.result.current.data).not.toBeNull())
        context.api.request.mockRejectedValue(new EvolvedApiError('Zugriff entzogen', status))
        await act(() => hook.result.current.refresh())
        expect(hook.result.current.data).toBeNull()
    })
})
