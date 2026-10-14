import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import { EvolvedApi, EvolvedApiError } from './api'

afterEach(() => vi.unstubAllGlobals())
describe('Evolved API authorization transport', () => {
    it('uses cookie credentials and no legacy bearer for its own API', async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json({ teams: [] }))
        vi.stubGlobal('fetch', fetcher)
        await new EvolvedApi('https://hub.test').request('/teams')
        const [url, request] = fetcher.mock.calls[0]
        expect(url).toBe('https://hub.test/api/evolved/teams')
        expect(request.credentials).toBe('include')
        expect(request.cache).toBe('no-store')
        expect(request.headers.get('authorization')).toBeNull()
    })
    it('keeps project identity and cookie session on bridged existing API calls', async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json({ sessions: [] }))
        vi.stubGlobal('fetch', fetcher)
        const client = new ApiClient('', { baseUrl: 'https://hub.test', getToken: () => 'project-bound-jwt', getProjectId: () => 'project-A', credentials: 'include' })
        await client.getSessions()
        const request = fetcher.mock.calls[0][1]
        expect(request.headers.get('authorization')).toBe('Bearer project-bound-jwt')
        expect(request.headers.get('x-hapi-project-id')).toBe('project-A')
        expect(request.credentials).toBe('include')
    })
    it('retries a mutation only once after explicit successful passkey step-up', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(Response.json({ error: 'Fresh passkey needed', code: 'step_up_required' }, { status: 403 }))
            .mockResolvedValueOnce(Response.json({ ok: true }))
        vi.stubGlobal('fetch', fetcher)
        const api = new EvolvedApi('https://hub.test')
        const stepUp = vi.fn().mockResolvedValue(undefined)
        api.setStepUpHandler(stepUp)
        await api.request('/projects/a/secrets', { method: 'POST', body: { name: 'synthetic', value: 'test-only' }, idempotencyKey: 'same-request' })
        expect(stepUp).toHaveBeenCalledTimes(1)
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body)
        expect(fetcher.mock.calls[1][1].headers.get('Idempotency-Key')).toBe('same-request')
    })
    it('does not replay a sensitive mutation if step-up fails or returns another denial', async () => {
        const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ error: 'Fresh passkey needed', code: 'step_up_required' }, { status: 403 })))
        vi.stubGlobal('fetch', fetcher)
        const api = new EvolvedApi('https://hub.test')
        api.setStepUpHandler(async () => { throw new Error('Cancelled') })
        await expect(api.request('/projects/a/secrets', { method: 'POST', body: { value: 'test-only' } })).rejects.toThrow('Cancelled')
        expect(fetcher).toHaveBeenCalledTimes(1)
        fetcher.mockClear()
        api.setStepUpHandler(async () => {})
        await expect(api.request('/projects/a/secrets', { method: 'POST', body: { value: 'test-only' } })).rejects.toBeInstanceOf(EvolvedApiError)
        expect(fetcher).toHaveBeenCalledTimes(2)
    })
})
