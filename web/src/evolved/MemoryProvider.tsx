import { useEffect, useRef, useState } from 'react'
import { useEvolved } from './auth'
import { EvolvedApiError, isProjectAdmin, projectPath, type MemorySettings } from './api'
import { ConfirmButton, ErrorNotice, Field, Loading, Panel, submit } from './ui'

type TextModel = { model: string; inputUsdPerMTok: string; outputUsdPerMTok: string; maxOutputTokens: number }
type Slot = 'llm' | 'embedding' | 'reranker'
type Provider = 'openai' | 'anthropic' | 'voyage' | 'rrf'
export type MemoryProviderConfig = {
    schemaVersion: 2
    llm: TextModel & { provider: 'openai' | 'anthropic' }
    embedding: { provider: 'openai' | 'voyage'; model: string; dimensions: number; inputUsdPerMTok: string }
    reranker: { provider: 'rrf' } | (TextModel & { provider: 'openai' }) | { provider: 'voyage'; model: string; inputUsdPerMTok: string }
}
export type MemoryProviderStatus = {
    configured: boolean; version: number; apiKeyConfigured: boolean; keyConfigured: Record<Slot, boolean>
    source: 'project' | 'environment' | 'disabled'; config: MemoryProviderConfig | null
    embeddingLocked: boolean; boundEmbeddingProvider: 'openai' | 'voyage' | null
    boundEmbeddingModel: string | null; boundEmbeddingDimensions: number | null; canManage: boolean
}
const labels: Record<Slot, string> = { llm: 'Sprachmodell', embedding: 'Embeddings', reranker: 'Suchtrefferbewertung' }
const providers: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Anthropic / Claude', voyage: 'Voyage AI', rrf: 'Lokal · RRF' }
const links = {
    openai: { key: 'https://platform.openai.com/api-keys', pricing: 'https://developers.openai.com/api/docs/pricing' },
    anthropic: { key: 'https://platform.claude.com/settings/keys', pricing: 'https://platform.claude.com/docs/en/about-claude/pricing' },
    voyage: { key: 'https://dash.voyageai.com/api-keys', pricing: 'https://docs.voyageai.com/docs/pricing' },
}
const textModel = () => ({ model: '', inputUsdPerMTok: '', outputUsdPerMTok: '', maxOutputTokens: 2048 })
const emptyConfig = (): MemoryProviderConfig => ({ schemaVersion: 2, llm: { provider: 'anthropic', ...textModel() }, embedding: { provider: 'voyage', model: '', dimensions: 1024, inputUsdPerMTok: '' }, reranker: { provider: 'rrf' } })
const emptyKeys = () => ({ llm: '', embedding: '', reranker: '' })
const emptyCatalogs = () => ({ llm: [] as string[], embedding: [] as string[], reranker: [] as string[] })
const storedConfig = (status: MemoryProviderStatus): MemoryProviderConfig => status.config ?? { ...emptyConfig(), embedding: { provider: status.boundEmbeddingProvider ?? 'voyage', model: status.boundEmbeddingModel ?? '', dimensions: status.boundEmbeddingDimensions ?? 1024, inputUsdPerMTok: '' } }
const validPrice = (value: string) => value.length <= 32 && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) && Number(value) > 0 && Number(value) <= 1_000_000

function setupError(error: unknown): Error {
    if (error instanceof EvolvedApiError) {
        if (error.code === 'memory_provider_busy') return new Error('Für dieses Projekt läuft gerade eine Wissensverarbeitung oder Änderung. Warte kurz und versuche es erneut.')
        if (error.code === 'memory_embedding_locked') return new Error('Bestehende Graphdaten binden Anbieter, Modell und Dimensionen der Embeddings. Es wurden keine Graphdaten geändert. Das Sprachmodell kannst du unabhängig davon wechseln.')
        if (error.status === 409) return new Error('Die Einrichtung hat sich geändert oder vorhandene Graphdaten verhindern den Embedding-Wechsel. Lade den Stand neu; bestehende Vektoren können nicht gemischt werden.')
        if (error.status === 401 || error.status === 403) return new Error('Die Freigabe fehlt, ist abgelaufen oder ein API-Key wurde abgelehnt. Prüfe den Schlüssel und bestätige die Aktion mit deinem Passkey.')
        if (error.status === 503 || error.status === 502) return new Error('Der Memory-Dienst oder Anbieter ist gerade nicht erreichbar. Lokales Wissen bleibt verfügbar. Versuche es später erneut.')
        if (error.status === 429) return new Error('Zu viele Versuche. Bitte warte kurz, bevor du erneut prüfst.')
    }
    return new Error('Die Einrichtung konnte nicht geprüft oder gespeichert werden. Prüfe die API-Keys, Modelle, Dimensionen und Preise. Es wurde keine erfolgreiche Verbindung bestätigt.')
}

export function MemoryProviderPanel({ settings, onChanged }: { settings?: MemorySettings; onChanged?: () => Promise<unknown> }) {
    const { api, me, project } = useEvolved()
    if (!project) return null
    if (project.role === 'viewer') return <Panel title="Graph-Memory einrichten"><p className="ev-muted">Ein Projektadministrator kann hier Anbieter, API-Keys, Modelle und Preise verwalten.</p></Panel>
    return <MemoryProviderForm key={`${api.baseUrl}:${me.user.id}:${project.id}:${project.role}`} settings={settings} onChanged={onChanged} />
}

function MemoryProviderForm({ settings, onChanged }: { settings?: MemorySettings; onChanged?: () => Promise<unknown> }) {
    const { api, project } = useEvolved()
    const path = `${projectPath(project!.id)}/memory/provider`
    const [status, setStatus] = useState<MemoryProviderStatus | null>(null)
    const [config, setConfig] = useState(emptyConfig)
    const [keys, setKeys] = useState(emptyKeys)
    const [catalogs, setCatalogs] = useState(emptyCatalogs)
    const [busy, setBusy] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)
    const [notice, setNotice] = useState('')
    const [tested, setTested] = useState(false)
    const [dirty, setDirty] = useState(false)
    const [pricesOpen, setPricesOpen] = useState({ llm: true, embedding: true, reranker: true })
    const lifecycle = useRef<AbortController | null>(null)
    const pending = useRef(false)
    const admin = isProjectAdmin(project?.role) && status?.canManage !== false
    const budgetReady = Boolean(settings?.enabled && settings.cloudAllowed && settings.monthlyBudgetMicros > 0 && settings.jobBudgetMicros > 0)
    useEffect(() => {
        const controller = new AbortController()
        lifecycle.current = controller
        void api.request<MemoryProviderStatus>(path, { signal: controller.signal }).then(value => {
            if (!controller.signal.aborted) { setStatus(value); setConfig(storedConfig(value)); setPricesOpen({ llm: !value.config, embedding: !value.config, reranker: !value.config }) }
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
        setKeys(emptyKeys()); setCatalogs(emptyCatalogs()); setPricesOpen({ llm: !value.config, embedding: !value.config, reranker: !value.config })
    }
    const edited = () => { setDirty(true); setTested(false); setNotice('') }
    const change = (slot: Slot, patch: Record<string, unknown>) => {
        setConfig(value => ({ ...value, [slot]: { ...value[slot], ...patch } })); if ('model' in patch) setPricesOpen(value => ({ ...value, [slot]: true })); edited()
    }
    const switchProvider = (slot: Slot, provider: Provider) => {
        let value: MemoryProviderConfig[Slot]
        if (slot === 'llm') value = { provider: provider as 'openai' | 'anthropic', ...textModel() }
        else if (slot === 'embedding') value = { provider: provider as 'openai' | 'voyage', model: '', dimensions: provider === 'openai' ? 1536 : 1024, inputUsdPerMTok: '' }
        else value = provider === 'rrf' ? { provider: 'rrf' } : provider === 'voyage' ? { provider: 'voyage', model: '', inputUsdPerMTok: '' } : { provider: 'openai', ...textModel() }
        setPricesOpen(current => ({ ...current, [slot]: true })); setConfig(current => ({ ...current, [slot]: value })); setKeys(current => ({ ...current, [slot]: '' })); setCatalogs(current => ({ ...current, [slot]: [] })); edited()
    }
    const retainedKey = (slot: Slot) => Boolean(status?.keyConfigured[slot] && status.config?.[slot].provider === config[slot].provider)
    const fetchModels = (slot: Slot) => run(async signal => {
        const response = await api.request<{ models: string[]; verified: boolean }>(`${path}/models`, { method: 'POST', body: { component: slot, provider: config[slot].provider, ...(keys[slot].trim() ? { apiKey: keys[slot].trim() } : {}) }, signal })
        if (signal.aborted) return
        if (!response.verified) { setNotice('Für diesen Anbieter steht kein Modellkatalog zur Verfügung. Trage die Modell-ID anhand der Anbieterdokumentation ein. Schlüssel und Modell sind damit noch nicht geprüft.'); return }
        setCatalogs(value => ({ ...value, [slot]: [...new Set(response.models)].sort() }))
        setNotice(`${labels[slot]}: ${response.models.length} Modelle direkt vom Anbieter geladen. Die Eignung für Graph-Memory ist damit noch nicht getestet.`)
    })
    const save = () => run(async signal => {
        const body = { ...config, version: status!.version, ...Object.fromEntries((['llm', 'embedding', 'reranker'] as const).map(slot => [slot, { ...config[slot], ...(config[slot].provider !== 'rrf' && keys[slot].trim() ? { apiKey: keys[slot].trim() } : {}) }])) }
        setKeys(emptyKeys())
        const value = await api.request<MemoryProviderStatus>(path, { method: 'PUT', body, signal })
        if (signal.aborted) return
        accept(value); setNotice('Einrichtung verschlüsselt gespeichert. Prüfe jetzt die Verbindung und die Cloud-Freigabe unten.'); await onChanged?.()
    })
    const test = () => run(async signal => {
        const result = await api.request<{ ok: boolean; modelsVerified: boolean; inferenceTested: boolean; unverifiedComponents?: Slot[] }>(`${path}/test`, { method: 'POST', body: {}, signal })
        if (signal.aborted) return
        if (!result.ok || result.inferenceTested) throw new Error('Unexpected connection result')
        setTested(result.modelsVerified)
        setNotice(result.modelsVerified
            ? 'API-Keys akzeptiert, Modelle im Katalog gefunden und Graphdatenbank erreichbar. Keine kostenpflichtige KI-Anfrage ausgeführt; die Modellkompatibilität ist damit noch nicht getestet.'
            : `Graphdatenbank erreichbar; verfügbare Anbieter-Kataloge geprüft. Für ${(result.unverifiedComponents ?? ['embedding']).map(slot => labels[slot]).join(', ')} gibt es keinen Modellkatalog: API-Key und Modell bleiben ungeprüft. Keine kostenpflichtige KI-Anfrage ausgeführt.`)
        await onChanged?.()
    })
    const disconnect = () => run(async signal => {
        setKeys(emptyKeys())
        const value = await api.request<MemoryProviderStatus>(path, { method: 'DELETE', body: { version: status!.version }, signal })
        if (!signal.aborted) { accept(value); setNotice('Projektverbindung entfernt. Lokales Wissen bleibt erhalten; neue Cloud-Aufträge benötigen eine erneute Einrichtung.'); await onChanged?.() }
    })
    const reload = () => run(async signal => {
        const value = await api.request<MemoryProviderStatus>(path, { signal })
        if (!signal.aborted) accept(value)
    })
    const validSlot = (slot: Slot) => {
        const value = config[slot]
        if (value.provider === 'rrf') return true
        return Boolean(value.model.trim() && (keys[slot].trim() || retainedKey(slot)) && validPrice(value.inputUsdPerMTok)
            && (!('outputUsdPerMTok' in value) || validPrice(value.outputUsdPerMTok) && Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens >= 256 && value.maxOutputTokens <= 4096)
            && (!('dimensions' in value) || Number.isInteger(value.dimensions) && (value.provider === 'voyage' ? [256, 512, 1024, 2048].includes(value.dimensions) : value.dimensions >= 1 && value.dimensions <= 3072)))
    }
    const canSave = Boolean(status && (['llm', 'embedding', 'reranker'] as const).every(validSlot))
    const component = (slot: Slot, available: Provider[], description: string) => {
        const value = config[slot], title = labels[slot], provider = value.provider
        return <fieldset className="ev-memory-component" key={slot} disabled={busy}><legend>{title}</legend>
            <p className="ev-muted">{description}</p>
            <Field label={`${title}: Anbieter`}><select aria-label={`${title}: Anbieter`} value={provider} onChange={event => switchProvider(slot, event.target.value as Provider)}>{available.map(id => <option key={id} value={id}>{providers[id]}</option>)}</select></Field>
            {provider === 'rrf' ? <p className="ev-muted">Kombiniert die Rangfolgen der Text- und Vektorsuche direkt in Graphiti. Kein zusätzlicher API-Key und keine Kosten für einen separaten Reranker.</p> : <>
                <Field label={`${title}: API-Key`} hint={retainedKey(slot) ? 'Schlüssel gespeichert. Leer lassen, um ihn für diesen Anbieter zu behalten.' : 'Verschlüsselt im Projektspeicher; wird weder Agenten ausgegeben noch im Browser gespeichert.'}><input aria-label={`${title}: API-Key`} type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} value={keys[slot]} placeholder={retainedKey(slot) ? 'Schlüssel gespeichert' : 'API-Key einfügen'} onChange={event => { setKeys(current => ({ ...current, [slot]: event.target.value })); setCatalogs(current => ({ ...current, [slot]: [] })); edited() }} /></Field>
                <div className="ev-actions"><a href={links[provider].key} target="_blank" rel="noopener noreferrer">API-Key bei {providers[provider]} erstellen ↗</a>{provider !== 'voyage' && <button type="button" disabled={busy || (!keys[slot].trim() && !retainedKey(slot))} onClick={() => void fetchModels(slot)}>{title}: Modelle laden</button>}</div>
                {provider === 'voyage' && <p className="ev-muted">Voyage bietet keinen Modellkatalog für diese Einrichtung. Modell-ID aus der <a href={slot === 'embedding' ? 'https://docs.voyageai.com/docs/embeddings' : 'https://docs.voyageai.com/docs/reranker'} target="_blank" rel="noopener noreferrer">Anbieterdokumentation</a> übernehmen. Speichern und Verbindungstest prüfen diesen Schlüssel nicht durch eine kostenpflichtige Anfrage.</p>}
                <div className="ev-form-grid"><Field label={`${title}: Modell`} hint={provider === 'voyage' ? 'Exakte Modell-ID des Anbieters.' : 'Modelle werden direkt vom Anbieter geladen. Auch neue Modell-IDs sind zulässig; beim Speichern wird der Katalog geprüft.'}><input aria-label={`${title}: Modell`} required maxLength={200} autoComplete="off" spellCheck={false} list={`memory-models-${slot}`} value={value.model} onChange={event => change(slot, { model: event.target.value, inputUsdPerMTok: '', ...('outputUsdPerMTok' in value ? { outputUsdPerMTok: '' } : {}) })} /><datalist id={`memory-models-${slot}`}>{catalogs[slot].map(id => <option key={id} value={id} />)}</datalist></Field>
                    {slot === 'embedding' && <Field label="Embeddings: Dimensionen" hint="Muss vom Modell unterstützt werden. Voyage: 256, 512, 1024 oder 2048. OpenAI: bis 3072. Bestehende Graphdaten behalten ihre Vektorgröße."><input aria-label="Embeddings: Dimensionen" type="number" min="1" max={config.embedding.provider === 'voyage' ? 2048 : 3072} step="1" required value={config.embedding.dimensions} onChange={event => change('embedding', { dimensions: Number(event.target.value) })} /></Field>}
                </div>
                <details className="ev-disclosure" open={pricesOpen[slot]} onToggle={event => { const open = event.currentTarget.open; setPricesOpen(current => current[slot] === open ? current : { ...current, [slot]: open }) }}><summary>{title}: Preise und Limits</summary>
                    <p className="ev-muted">Aktuelle <a href={links[provider].pricing} target="_blank" rel="noopener noreferrer">Anbieterpreise</a> in USD je Million Tokens eintragen. Der Modellkatalog liefert keine Preise; diese Werte steuern die Budgetkontrolle.</p>
                    <div className="ev-form-grid"><Field label={`${title}: Eingabe`}><input aria-label={`${title}: Eingabe`} type="number" min="0.000001" max="1000000" step="any" required value={value.inputUsdPerMTok} onChange={event => change(slot, { inputUsdPerMTok: event.target.value })} /></Field>
                        {'outputUsdPerMTok' in value && <><Field label={`${title}: Ausgabe`}><input aria-label={`${title}: Ausgabe`} type="number" min="0.000001" max="1000000" step="any" required value={value.outputUsdPerMTok} onChange={event => change(slot, { outputUsdPerMTok: event.target.value })} /></Field><Field label={`${title}: Maximale Ausgabetokens`}><input aria-label={`${title}: Maximale Ausgabetokens`} type="number" min="256" max="4096" step="1" required value={value.maxOutputTokens} onChange={event => change(slot, { maxOutputTokens: Number(event.target.value) })} /></Field></>}
                    </div>
                </details>
                {slot === 'reranker' && provider === 'openai' && <p className="ev-muted">Dieses Modell muss Chat Completions mit Logprobs unterstützen. Nicht jedes Modell im Katalog ist dafür geeignet.</p>}
            </>}
        </fieldset>
    }
    return <div id="memory-provider"><Panel title="Graph-Memory einrichten" description="Sprachmodell, Embeddings und Suchtrefferbewertung unabhängig wählen. Die Einrichtung gilt für dieses Projekt und wird ohne Neustart übernommen.">
        {loading ? <Loading /> : <>
            <ol className="ev-memory-steps" aria-label="Einrichtungsstatus"><li data-complete={Boolean(status?.apiKeyConfigured)}><span>1</span> API-Keys {status?.apiKeyConfigured ? 'gespeichert' : 'hinterlegen'}</li><li data-complete={Boolean(status?.configured)}><span>2</span> Modelle {status?.configured ? 'gespeichert' : 'auswählen'}</li><li data-complete={tested}><span>3</span> Verbindung {tested ? 'geprüft' : 'prüfen'}</li><li data-complete={budgetReady}><span>4</span> <a href="#memory-budget">Cloud und Budget {budgetReady ? 'freigegeben' : 'freigeben'}</a></li></ol>
            {status?.source === 'environment' && <p className="ev-muted">Noch keine Projektverbindung gespeichert. Falls der Betreiber einen allgemeinen Zugang eingerichtet hat, gilt dieser bis zum Speichern einer eigenen Projektverbindung.</p>}
            {!admin ? <p className="ev-muted">Ein Projektadministrator kann hier Anbieter, API-Keys, Modelle und Preise verwalten. {status?.configured ? `Aktuell: ${status.config?.llm.model ?? 'Betreiberkonfiguration'}.` : 'Graph-Memory ist noch nicht eingerichtet.'}</p> : status && <form className="ev-stack" onSubmit={submit(() => void save())}>
                <p className="ev-muted">Claude kann Wissen extrahieren; für Suchvektoren braucht es zusätzlich OpenAI oder Voyage AI. Mit Claude + Voyage + lokaler Suchtrefferbewertung ist kein OpenAI-Key nötig. Deine Claude- und Codex-Anmeldung unter „Abos verbinden“ ersetzt keine API-Keys.</p>
                {component('llm', ['anthropic', 'openai'], 'Liest Inhalte und extrahiert Wissen und Beziehungen für den Graphen.')}
                {component('embedding', ['voyage', 'openai'], 'Wandelt Inhalte und Suchanfragen in vergleichbare Vektoren um.')}
                {(status.boundEmbeddingModel || status.embeddingLocked) && <p className="ev-muted">Ein Embedding-Wechsel ist nur möglich, wenn der Graph nachweislich leer ist. Anbieter, Modell und Dimensionen werden beim Speichern geprüft; vorhandene Graphdaten werden nicht überschrieben.{status.boundEmbeddingModel && ` Gebunden: ${status.boundEmbeddingProvider ?? 'OpenAI'} / ${status.boundEmbeddingModel} / ${status.boundEmbeddingDimensions ?? 1536} Dimensionen.`}</p>}
                {component('reranker', ['rrf', 'voyage', 'openai'], 'Bestimmt die Reihenfolge der gefundenen Fakten. Ein externer Reranker verursacht zusätzliche API-Kosten.')}
                <p className="ev-muted">Neue und wartende Aufträge verwenden die gespeicherte Einrichtung, sobald Cloud-Verarbeitung und Budget freigegeben sind. Schlüssel je Funktion ausdrücklich hinterlegen; sie werden beim Anbieterwechsel nicht übernommen. Änderungen können eine Passkey-Bestätigung erfordern.</p>
                <div className="ev-actions"><button className="ev-primary" disabled={busy || !canSave || !dirty}>Einrichtung speichern</button><button type="button" disabled={busy || !status.configured || dirty} onClick={() => void test()}>Verbindung testen</button><button type="button" disabled={busy} onClick={() => void reload()}>Stand neu laden</button></div>
            </form>}
            {admin && status?.apiKeyConfigured && <div className="ev-actions ev-memory-disconnect"><ConfirmButton label="Verbindung entfernen" detail="Cloud-Verbindung dieses Projekts entfernen? Lokales Wissen bleibt erhalten." disabled={busy} onConfirm={() => void disconnect()} /></div>}
            {admin && status?.source === 'environment' && <div className="ev-actions ev-memory-disconnect"><ConfirmButton label="Betreiberzugang für dieses Projekt sperren" detail="Einen eventuell vorhandenen allgemeinen Memory-Zugang für dieses Projekt sperren? Lokales Wissen bleibt erhalten." disabled={busy} onConfirm={() => void disconnect()} /></div>}
            {!status && admin && <button disabled={busy} onClick={() => void reload()}>Einrichtung erneut laden</button>}
        </>}
        <ErrorNotice error={error} />{notice && <p className="ev-notice" role="status">{notice}</p>}
    </Panel></div>
}
