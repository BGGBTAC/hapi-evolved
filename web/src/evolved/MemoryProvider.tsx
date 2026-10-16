import { useEffect, useRef, useState } from 'react'
import { useEvolved } from './auth'
import { EvolvedApiError, isProjectAdmin, projectPath, type MemorySettings } from './api'
import { ConfirmButton, ErrorNotice, Field, Loading, Panel, submit } from './ui'

export type MemoryProviderConfig = {
    provider: 'openai'; model: string; embeddingModel: string; embeddingDimensions: 1536
    inputUsdPerMTok: string; outputUsdPerMTok: string; embeddingUsdPerMTok: string; maxOutputTokens: number
}
export type MemoryProviderStatus = {
    configured: boolean; version: number; apiKeyConfigured: boolean
    source: 'project' | 'environment' | 'disabled'; config: MemoryProviderConfig | null
    embeddingLocked: boolean; boundEmbeddingModel: string | null; canManage: boolean
}

// Price suggestions only: model availability always comes from the provider.
// Verified 2026-10-16 against https://developers.openai.com/api/docs/models/<model>.
const textPrices: Record<string, [string, string]> = { 'gpt-4.1-mini': ['0.40', '1.60'], 'gpt-4.1-nano': ['0.10', '0.40'] }
const embeddingPrices: Record<string, string> = { 'text-embedding-3-small': '0.02', 'text-embedding-3-large': '0.13' }
const emptyConfig = (): MemoryProviderConfig => ({ provider: 'openai', model: '', embeddingModel: '', embeddingDimensions: 1536, inputUsdPerMTok: '', outputUsdPerMTok: '', embeddingUsdPerMTok: '', maxOutputTokens: 2048 })
const storedConfig = (status: MemoryProviderStatus): MemoryProviderConfig => status.config ?? { ...emptyConfig(), embeddingModel: status.boundEmbeddingModel ?? '', embeddingUsdPerMTok: embeddingPrices[status.boundEmbeddingModel ?? ''] ?? '' }
const validPrice = (value: string) => value.length <= 32 && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) && Number(value) > 0 && Number(value) <= 1_000_000

function setupError(error: unknown): Error {
    if (error instanceof EvolvedApiError) {
        if (error.code === 'memory_provider_busy') return new Error('Für dieses Projekt läuft gerade eine Wissensverarbeitung oder Änderung. Warte kurz und versuche es erneut.')
        if (error.code === 'memory_embedding_locked') return new Error('Bestehende Graphdaten binden das bisherige Embedding-Modell. Ein Wechsel oder die Übernahme einer unbekannten Alt-Konfiguration benötigt eine gesonderte Prüfung; es wurden keine Graphdaten geändert.')
        if (error.status === 409) return new Error('Die Einrichtung hat sich geändert oder das Embedding-Modell ist durch vorhandene Graphdaten gebunden. Lade den Stand neu; bestehende Vektoren können nicht mit einem anderen Modell gemischt werden.')
        if (error.status === 401 || error.status === 403) return new Error('Die Freigabe fehlt oder ist abgelaufen. Melde dich erneut an und bestätige die Aktion mit deinem Passkey.')
        if (error.status === 503 || error.status === 502) return new Error('Der Memory-Dienst oder Anbieter ist gerade nicht erreichbar. Lokales Wissen bleibt verfügbar. Versuche es später erneut.')
        if (error.status === 429) return new Error('Zu viele Versuche. Bitte warte kurz, bevor du erneut prüfst.')
    }
    // Never echo upstream error bodies: they may contain submitted credentials.
    return new Error('Die Einrichtung konnte nicht geprüft oder gespeichert werden. Prüfe den API-Key, die ausgewählten Modelle und die Preise. Es wurde keine erfolgreiche Verbindung bestätigt.')
}

export function MemoryProviderPanel({ settings, onChanged }: { settings?: MemorySettings; onChanged?: () => Promise<unknown> }) {
    const { api, me, project } = useEvolved()
    if (!project) return null
    if (project.role === 'viewer') return <Panel title="Graph-Memory einrichten"><p className="ev-muted">Ein Projektadministrator kann hier den API-Key, Modelle und Preise verwalten.</p></Panel>
    return <MemoryProviderForm key={`${api.baseUrl}:${me.user.id}:${project.id}:${project.role}`} settings={settings} onChanged={onChanged} />
}

function MemoryProviderForm({ settings, onChanged }: { settings?: MemorySettings; onChanged?: () => Promise<unknown> }) {
    const { api, project } = useEvolved()
    const path = `${projectPath(project!.id)}/memory/provider`
    const [status, setStatus] = useState<MemoryProviderStatus | null>(null)
    const [config, setConfig] = useState(emptyConfig)
    const [apiKey, setApiKey] = useState('')
    const [models, setModels] = useState<string[]>([])
    const [busy, setBusy] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)
    const [notice, setNotice] = useState('')
    const [tested, setTested] = useState(false)
    const [dirty, setDirty] = useState(false)
    const [advanced, setAdvanced] = useState(false)
    const lifecycle = useRef<AbortController | null>(null)
    const pending = useRef(false)
    const admin = isProjectAdmin(project?.role) && status?.canManage !== false
    const budgetReady = Boolean(settings?.enabled && settings.cloudAllowed && settings.monthlyBudgetMicros > 0 && settings.jobBudgetMicros > 0)

    useEffect(() => {
        const controller = new AbortController()
        lifecycle.current = controller
        void api.request<MemoryProviderStatus>(path, { signal: controller.signal }).then(value => {
            if (controller.signal.aborted) return
            setStatus(value); setConfig(storedConfig(value))
        }).catch(cause => { if (!controller.signal.aborted) setError(setupError(cause)) })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => { controller.abort(); lifecycle.current = null }
    }, [api, path])

    const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
        const controller = lifecycle.current
        if (!controller || controller.signal.aborted || pending.current) return
        pending.current = true; setBusy(true); setError(null); setNotice('')
        try { await operation(controller.signal) }
        catch (cause) { if (!controller.signal.aborted) { setTested(false); setError(setupError(cause)) } }
        finally { if (!controller.signal.aborted) { pending.current = false; setBusy(false) } }
    }
    const accept = (value: MemoryProviderStatus) => {
        setStatus(value); setConfig(storedConfig(value)); setDirty(false); setTested(false)
    }
    const change = (patch: Partial<MemoryProviderConfig>) => { setConfig(value => ({ ...value, ...patch })); setDirty(true); setTested(false); setNotice('') }
    const chooseModel = (model: string) => {
        const prices = textPrices[model]
        if (!prices) setAdvanced(true)
        change({ model, inputUsdPerMTok: prices?.[0] ?? '', outputUsdPerMTok: prices?.[1] ?? '' })
    }
    const chooseEmbedding = (embeddingModel: string) => {
        if (!embeddingPrices[embeddingModel]) setAdvanced(true)
        change({ embeddingModel, embeddingUsdPerMTok: embeddingPrices[embeddingModel] ?? '' })
    }
    const fetchModels = () => run(async signal => {
        const response = await api.request<{ models: string[] }>(`${path}/models`, { method: 'POST', body: apiKey.trim() ? { apiKey: apiKey.trim() } : {}, signal })
        if (signal.aborted) return
        const ids = [...new Set(response.models)].sort()
        setModels(ids)
        setConfig(value => {
            const model = value.model || (ids.includes('gpt-4.1-mini') ? 'gpt-4.1-mini' : '')
            const embeddingModel = value.embeddingModel || (ids.includes('text-embedding-3-small') ? 'text-embedding-3-small' : '')
            return { ...value, model, embeddingModel, inputUsdPerMTok: value.inputUsdPerMTok || textPrices[model]?.[0] || '', outputUsdPerMTok: value.outputUsdPerMTok || textPrices[model]?.[1] || '', embeddingUsdPerMTok: value.embeddingUsdPerMTok || embeddingPrices[embeddingModel] || '' }
        })
        if (!status?.configured) setDirty(true)
        setNotice(`${ids.length} Modelle direkt vom Anbieter geladen. Die Liste bestätigt noch keine Eignung für Graph-Memory.`)
    })
    const save = () => run(async signal => {
        const body = { ...config, version: status!.version, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
        // The submitted key remains only in this short-lived request, never in caches/storage.
        setApiKey('')
        const value = await api.request<MemoryProviderStatus>(path, { method: 'PUT', body, signal })
        if (signal.aborted) return
        accept(value); setNotice('Einrichtung verschlüsselt gespeichert. Prüfe jetzt die Verbindung und die Cloud-Freigabe unten.')
        await onChanged?.()
    })
    const test = () => run(async signal => {
        const result = await api.request<{ ok: boolean; modelsVerified: boolean; inferenceTested: boolean }>(`${path}/test`, { method: 'POST', body: {}, signal })
        if (signal.aborted) return
        if (!result.ok || !result.modelsVerified || result.inferenceTested) throw new Error('Unexpected connection result')
        setTested(true); setNotice('API-Key akzeptiert, Modelle im Katalog gefunden und Graphdatenbank erreichbar. Eine kostenpflichtige KI-Anfrage wurde nicht ausgeführt; die Modellkompatibilität ist damit noch nicht getestet.')
        await onChanged?.()
    })
    const disconnect = () => run(async signal => {
        setApiKey('')
        const value = await api.request<MemoryProviderStatus>(path, { method: 'DELETE', body: { version: status!.version }, signal })
        if (signal.aborted) return
        accept(value); setModels([]); setNotice('Projektverbindung entfernt. Lokales Wissen bleibt erhalten; neue Cloud-Aufträge benötigen eine erneute Einrichtung.')
        await onChanged?.()
    })
    const reload = () => run(async signal => {
        const value = await api.request<MemoryProviderStatus>(path, { signal })
        if (!signal.aborted) { accept(value); setApiKey(''); setModels([]) }
    })
    const canSave = Boolean(status && config.model && config.embeddingModel && (apiKey.trim() || status.apiKeyConfigured) && [config.inputUsdPerMTok, config.outputUsdPerMTok, config.embeddingUsdPerMTok].every(validPrice) && Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens >= 256 && config.maxOutputTokens <= 4096)
    const options = (selected: string) => [...new Set([selected, ...models].filter(Boolean))].map(id => <option key={id} value={id}>{id}</option>)

    return <div id="memory-provider"><Panel title="Graph-Memory einrichten" description="Verbinde das Projektgedächtnis mit OpenAI. Die Einrichtung gilt für dieses Projekt und wird sofort übernommen – ohne SSH oder Neustart.">
        {loading ? <Loading /> : <>
            <ol className="ev-memory-steps" aria-label="Einrichtungsstatus">
                <li data-complete={Boolean(status?.apiKeyConfigured)}><span>1</span> API-Key {status?.apiKeyConfigured ? 'gespeichert' : 'hinterlegen'}</li>
                <li data-complete={Boolean(status?.configured)}><span>2</span> Modelle {status?.configured ? 'gespeichert' : 'auswählen'}</li>
                <li data-complete={tested}><span>3</span> Verbindung {tested ? 'geprüft' : 'prüfen'}</li>
                <li data-complete={budgetReady}><span>4</span> <a href="#memory-budget">Cloud und Budget {budgetReady ? 'freigegeben' : 'freigeben'}</a></li>
            </ol>
            {status?.source === 'environment' && <p className="ev-muted">Noch keine Projektverbindung gespeichert. Falls der Betreiber einen allgemeinen Zugang eingerichtet hat, gilt dieser bis zum Speichern einer eigenen Projektverbindung.</p>}
            {!admin ? <p className="ev-muted">Ein Projektadministrator kann hier den API-Key, Modelle und Preise verwalten. {status?.configured ? `Aktuell: ${status.config?.model ?? 'Betreiberkonfiguration'}.` : 'Graph-Memory ist noch nicht eingerichtet.'}</p> : status && <form className="ev-stack" onSubmit={submit(() => void save())}>
                <p className="ev-muted">Benötigt wird ein OpenAI-API-Key mit API-Guthaben. Deine Claude- und Codex-Anmeldung bleibt unter „Abos verbinden“; sie ersetzt diesen Zugang nicht. <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">API-Key bei OpenAI erstellen ↗</a></p>
                <Field label="OpenAI-API-Key" hint={status.apiKeyConfigured ? 'Ein Schlüssel ist hinterlegt und wird nicht angezeigt. Leer lassen, um ihn zu behalten; einen neuen Schlüssel eingeben, um ihn zu ersetzen.' : 'Verschlüsselt im Projektspeicher. Der Schlüssel wird weder an Agenten ausgegeben noch im Browser gespeichert.'}>
                    <input aria-label="OpenAI-API-Key" type="password" name="memory-api-key" autoComplete="new-password" spellCheck={false} maxLength={4096} value={apiKey} disabled={busy} placeholder={status.apiKeyConfigured ? 'Schlüssel gespeichert' : 'API-Key einfügen'} onChange={event => { setApiKey(event.target.value); setDirty(true); setTested(false); setModels([]); setNotice('') }} />
                </Field>
                <div className="ev-actions"><button type="button" disabled={busy || (!apiKey.trim() && !status.apiKeyConfigured)} onClick={() => void fetchModels()}>Modelle vom Anbieter laden</button><small className="ev-muted">Keine kostenpflichtige KI-Anfrage.</small></div>
                <div className="ev-form-grid">
                    <Field label="Sprachmodell" hint="Extrahiert Wissen und bewertet Suchtreffer."><select aria-label="Sprachmodell" required disabled={busy || !models.length} value={config.model} onChange={event => chooseModel(event.target.value)}><option value="">Modell auswählen</option>{options(config.model)}</select></Field>
                    <Field label="Embedding-Modell" hint={status.embeddingLocked && status.boundEmbeddingModel ? 'An bestehende Graphdaten gebunden. Ein Modellwechsel benötigt eine gesonderte Neuindizierung.' : status.embeddingLocked ? 'Vor dem erstmaligen Speichern wird geprüft, ob frühere Verarbeitungsversuche bereits Graphdaten erzeugt haben.' : 'Wandelt Wissen in Suchvektoren um. Das Projekt verwendet 1536 Dimensionen.'}><select aria-label="Embedding-Modell" required disabled={busy || !models.length || (status.embeddingLocked && Boolean(status.boundEmbeddingModel))} value={config.embeddingModel} onChange={event => chooseEmbedding(event.target.value)}><option value="">Modell auswählen</option>{options(config.embeddingModel)}</select></Field>
                </div>
                <details className="ev-disclosure" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
                    <summary>Preise und erweiterte Einstellungen</summary>
                    <p className="ev-muted">Preise in USD je Million Tokens sind für die Budgetkontrolle erforderlich. Preisvorschläge für GPT-4.1 mini/nano und Embedding-3 stammen vom 16.10.2026. Für weitere Modelle die aktuellen <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer">Anbieterpreise</a> eintragen; der Modellkatalog liefert keine Preise.</p>
                    <div className="ev-form-grid">{([['inputUsdPerMTok', 'Sprachmodell: Eingabe'], ['outputUsdPerMTok', 'Sprachmodell: Ausgabe'], ['embeddingUsdPerMTok', 'Embeddings: Eingabe']] as const).map(([field, label]) => <Field key={field} label={label}><input type="number" min="0.000001" max="1000000" step="any" required disabled={busy} value={config[field]} onChange={event => change({ [field]: event.target.value })} /></Field>)}
                        <Field label="Maximale Ausgabetokens je KI-Aufruf"><input type="number" min="256" max="4096" step="1" required disabled={busy} value={config.maxOutputTokens} onChange={event => change({ maxOutputTokens: Number(event.target.value) })} /></Field>
                    </div>
                    <p className="ev-muted">Der Katalog zeigt verfügbare Modell-IDs ohne Funktionsangaben. Graph-Memory braucht strukturierte Textausgaben, Chat Completions mit Logprobs und ein Embedding-Modell für 1536 Dimensionen. Nicht jedes gelistete Modell erfüllt diese Anforderungen.</p>
                </details>
                <p className="ev-muted">Neue und bereits wartende Verarbeitungsaufträge verwenden die gespeicherte Einrichtung, sobald Cloud-Verarbeitung und ein ausreichendes Budget freigegeben sind. Schlüssel und Freigaben können eine Passkey-Bestätigung erfordern.</p>
                <div className="ev-actions"><button className="ev-primary" disabled={busy || !canSave || !dirty}>Einrichtung speichern</button><button type="button" disabled={busy || !status.configured || dirty} onClick={() => void test()}>Verbindung testen</button><button type="button" disabled={busy} onClick={() => void reload()}>Stand neu laden</button>
                </div>
            </form>}
            {admin && status?.apiKeyConfigured && <div className="ev-actions ev-memory-disconnect"><ConfirmButton label="Verbindung entfernen" detail="Cloud-Verbindung dieses Projekts entfernen? Lokales Wissen bleibt erhalten." disabled={busy} onConfirm={() => void disconnect()} /></div>}
            {!status && admin && <button disabled={busy} onClick={() => void reload()}>Einrichtung erneut laden</button>}
        </>}
        <ErrorNotice error={error} />{notice && <p className="ev-notice" role="status">{notice}</p>}
    </Panel></div>
}
