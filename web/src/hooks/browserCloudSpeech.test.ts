import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { BROWSER_CLOUD_CONSENT_KEY, revokeBrowserCloudConsent, startBrowserCloudTranscription } from './browserCloudSpeech'
const callbacks = () => ({ onConnected: vi.fn(), onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() })
let recognition: FakeRecognition
class FakeRecognition {
    static available = vi.fn(() => { throw new Error('Experimental API must not run') })
    onresult: ((event: unknown) => void) | null = null; onerror: ((event: unknown) => void) | null = null; onend: (() => void) | null = null
    start = vi.fn(); abort = vi.fn(); stop = vi.fn(() => this.onend?.())
    constructor() { recognition = this }
}
const api = (enabled: boolean) => ({ getHealth: vi.fn().mockResolvedValue({ browserCloudSttEnabled: enabled }) }) as unknown as ApiClient
beforeEach(() => { localStorage.clear(); vi.stubGlobal('SpeechRecognition', undefined); vi.stubGlobal('webkitSpeechRecognition', FakeRecognition) })
afterEach(() => vi.unstubAllGlobals())
describe('explicit browser cloud recognition', () => {
    it('requires both operator flag and user consent before constructing a microphone session', async () => {
        await expect(startBrowserCloudTranscription({ api: api(true), callbacks: callbacks() })).rejects.toThrow('nicht freigeschaltet')
        localStorage.setItem(BROWSER_CLOUD_CONSENT_KEY, 'true')
        await expect(startBrowserCloudTranscription({ api: api(false), callbacks: callbacks() })).rejects.toThrow('nicht freigeschaltet')
    })
    it('does not start when consent is revoked while operator health is pending', async () => {
        localStorage.setItem(BROWSER_CLOUD_CONSENT_KEY, 'true')
        let resolve!: (value: unknown) => void
        const getHealth = vi.fn(() => new Promise(done => { resolve = done }))
        const events = callbacks()
        const pending = startBrowserCloudTranscription({ api: { getHealth } as unknown as ApiClient, callbacks: events })
        revokeBrowserCloudConsent()
        resolve({ browserCloudSttEnabled: true })
        await expect(pending).rejects.toThrow('nicht freigeschaltet')
        expect(events.onConnected).not.toHaveBeenCalled()
    })
    it('stops an active microphone when another tab revokes consent and removes all callbacks', async () => {
        localStorage.setItem(BROWSER_CLOUD_CONSENT_KEY, 'true')
        const events = callbacks()
        const session = await startBrowserCloudTranscription({ api: api(true), callbacks: events })
        const lateResult = recognition.onresult
        localStorage.removeItem(BROWSER_CLOUD_CONSENT_KEY)
        window.dispatchEvent(new StorageEvent('storage', { key: BROWSER_CLOUD_CONSENT_KEY, oldValue: 'true', newValue: null }))
        expect(recognition.abort).toHaveBeenCalledOnce()
        expect(recognition.onresult).toBeNull()
        expect(events.onError).toHaveBeenCalledOnce()
        lateResult?.({ results: [{ 0: { transcript: 'must not deliver' } }] })
        window.dispatchEvent(new StorageEvent('storage', { key: null }))
        await session.stop()
        expect(events.onPartial).not.toHaveBeenCalled()
        expect(events.onFinal).not.toHaveBeenCalled()
        expect(events.onError).toHaveBeenCalledOnce()
    })

    it('uses prefixed browsers without experimental local APIs, delivers final once, cancels late callbacks', async () => {
        localStorage.setItem(BROWSER_CLOUD_CONSENT_KEY, 'true'); const events = callbacks()
        const session = await startBrowserCloudTranscription({ api: api(true), callbacks: events })
        recognition.onresult?.({ results: [{ 0: { transcript: 'explicit speech' }, isFinal: true }] }); await session.stop()
        expect(events.onFinal).toHaveBeenCalledExactlyOnceWith('explicit speech'); expect(FakeRecognition.available).not.toHaveBeenCalled()
        const next = await startBrowserCloudTranscription({ api: api(true), callbacks: events }); next.cancel(); expect(recognition.onresult).toBeNull(); expect(events.onFinal).toHaveBeenCalledOnce()
    })
})
