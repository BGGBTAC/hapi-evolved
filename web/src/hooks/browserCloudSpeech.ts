import type { ApiClient } from '@/api/client'
import type { LocalSpeechRecognitionConstructor } from './browserLocalSpeech'
import type { RealtimeTranscriptionCallbacks, RealtimeTranscriptionSession } from './realtimeTranscription'
export const BROWSER_CLOUD_CONSENT_KEY = 'hapi-browser-cloud-speech-consent'
function hasConsent(): boolean { try { return localStorage.getItem(BROWSER_CLOUD_CONSENT_KEY) === 'true' } catch { return false } }
export function revokeBrowserCloudConsent() { try { localStorage.removeItem(BROWSER_CLOUD_CONSENT_KEY) } catch { /* storage unavailable */ }; if (typeof window !== 'undefined') window.dispatchEvent(new Event('hapi-cloud-speech-consent')) }
export function getBrowserCloudSpeechConstructor(): LocalSpeechRecognitionConstructor | null {
    const browser = globalThis as typeof globalThis & { SpeechRecognition?: LocalSpeechRecognitionConstructor; webkitSpeechRecognition?: LocalSpeechRecognitionConstructor }
    return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null
}
export async function browserCloudSpeechEnabled(api: ApiClient): Promise<boolean> {
    if (!getBrowserCloudSpeechConstructor()) return false
    const health = await api.getHealth()
    if (health.browserCloudSttEnabled !== true) revokeBrowserCloudConsent()
    return health.browserCloudSttEnabled === true
}
export async function startBrowserCloudTranscription(options: { api: ApiClient; language?: string; signal?: AbortSignal; callbacks: RealtimeTranscriptionCallbacks }): Promise<RealtimeTranscriptionSession> {
    options.signal?.throwIfAborted()
    if (!hasConsent() || !await browserCloudSpeechEnabled(options.api) || !hasConsent()) throw new Error('Browser-Cloud-Spracherkennung ist nicht freigeschaltet oder bestätigt.')
    options.signal?.throwIfAborted()
    const Constructor = getBrowserCloudSpeechConstructor()
    if (!Constructor) throw new Error('Browser-Spracherkennung nicht verfügbar.')
    const recognition = new Constructor()
    recognition.continuous = true; recognition.interimResults = true; recognition.lang = options.language || navigator.language
    // Deliberately do not call experimental available()/install() or processLocally.
    let text = '', ended = false
    let completeStop: (() => void) | null = null
    const cleanup = () => { recognition.onresult = null; recognition.onerror = null; recognition.onend = null; options.signal?.removeEventListener('abort', cancel); window.removeEventListener('hapi-cloud-speech-consent', consentChanged); window.removeEventListener('storage', storageChanged); completeStop?.(); completeStop = null }
    const finish = () => { if (ended) return; ended = true; cleanup(); options.callbacks.onFinal(text) }
    const cancel = () => { if (ended) return; ended = true; cleanup(); recognition.abort() }
    const consentChanged = () => { if (!ended && !hasConsent()) { cancel(); options.callbacks.onError(new Error('Cloud-Spracherkennung wurde deaktiviert.')) } }
    const storageChanged = (event: StorageEvent) => { if (event.key === null || event.key === BROWSER_CLOUD_CONSENT_KEY) consentChanged() }
    window.addEventListener('hapi-cloud-speech-consent', consentChanged)
    window.addEventListener('storage', storageChanged)
    recognition.onresult = event => { if (ended) return; text = Array.from({ length: event.results.length }, (_, index) => event.results[index]?.[0]?.transcript ?? '').join(' ').trim(); options.callbacks.onPartial(text) }
    recognition.onerror = event => { if (ended) return; ended = true; cleanup(); recognition.abort(); options.callbacks.onError(new Error(`Browser-Cloud-Spracherkennung: ${event.error ?? 'unbekannter Fehler'}`)) }
    recognition.onend = finish
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
        options.signal?.throwIfAborted()
        if (!hasConsent()) throw new Error('Browser-Cloud-Spracherkennung ist nicht mehr bestätigt.')
        recognition.start(); options.callbacks.onConnected()
    } catch (error) { cancel(); throw error }
    return { cancel, stop: async () => {
        if (ended) return
        const stopped = new Promise<void>(resolve => { const timer = setTimeout(() => { if (!ended) { finish(); recognition.abort() }; resolve() }, 2500); completeStop = () => { clearTimeout(timer); resolve() } })
        recognition.stop(); await stopped
    } }
}
