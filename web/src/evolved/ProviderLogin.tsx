import { useCallback, useEffect, useRef, useState } from 'react'
import { useEvolved } from './auth'
import { EvolvedApiError, isProjectAdmin, projectPath, type EvolvedApi } from './api'
import { ConfirmButton, ErrorNotice, Field, Panel, formatDate, submit } from './ui'

type Provider = 'codex' | 'claude'
type ProviderSummary = { provider: Provider; status: 'connected' | 'disconnected' | 'unavailable'; method: 'subscription' | 'api-key' | null; checkedAt: number | null }
type ProviderSnapshot = { runner: { status: 'unconfigured' | 'offline' | 'starting' | 'ready' | 'error'; managed: boolean }; providers: ProviderSummary[] }
type LoginOperation = { id: string; provider: Provider; state: 'starting' | 'waiting' | 'connected' | 'failed' | 'cancelled' | 'expired'; flow: 'device' | 'code' | null; verificationUrl?: string; userCode?: string; expiresAt: number; message?: string }
const providerNames = { codex: 'Codex', claude: 'Claude' } as const
const activeOperation = (operation: LoginOperation | null) => operation?.state === 'starting' || operation?.state === 'waiting'
const aborted = (failure: unknown) => failure instanceof Error && failure.name === 'AbortError'
const missingOperation = (failure: unknown) => failure instanceof EvolvedApiError && (failure.status === 404 || failure.code === 'operation_not_found')

/** Login links are only offered for the exact native provider endpoints. */
export function providerVerificationUrl(provider: Provider, value?: string): string | null {
    if (!value) return null
    try {
        const url = new URL(value)
        const expected = provider === 'codex' ? 'https://auth.openai.com/codex/device' : 'https://claude.com/cai/oauth/authorize'
        if (url.username || url.password || url.hash || `${url.origin}${url.pathname}` !== expected) return null
        return url.href
    } catch { return null }
}

function useScopedRequest(api: EvolvedApi) {
    const mounted = useRef(true)
    const pending = useRef(new Set<AbortController>())
    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; for (const controller of pending.current) controller.abort(); pending.current.clear() }
    }, [])
    const request = useCallback(async <T,>(path: string, options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> => {
        if (!mounted.current || options.signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError')
        const controller = new AbortController()
        const cancel = () => controller.abort()
        options.signal?.addEventListener('abort', cancel, { once: true })
        if (options.signal?.aborted) controller.abort()
        pending.current.add(controller)
        try {
            const result = await api.request<T>(path, { ...options, signal: controller.signal })
            if (!mounted.current || controller.signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
            return result
        } finally {
            pending.current.delete(controller)
            options.signal?.removeEventListener('abort', cancel)
        }
    }, [api])
    return { request, mounted }
}

function ProviderMark({ provider }: { provider: Provider }) {
    return <span className="ev-provider-mark" aria-hidden="true"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{provider === 'codex' ? <><path d="m8 6-5 6 5 6m8-12 5 6-5 6m-3-15-2 18" /></> : <><path d="M12 2v20M2 12h20M5 5l14 14M5 19 19 5M8 3l8 18M3 8l18 8M3 16l18-8M8 21 16 3" /></>}</svg></span>
}

function ProviderCard({ api, base, provider, summary, ready, onRefresh }: { api: EvolvedApi; base: string; provider: Provider; summary?: ProviderSummary; ready: boolean; onRefresh: () => Promise<void> }) {
    const { request, mounted } = useScopedRequest(api)
    const [operation, setOperation] = useState<LoginOperation | null>(null)
    const [busy, setBusy] = useState<'start' | 'code' | 'cancel' | 'logout' | 'refresh' | null>(null)
    const [error, setError] = useState<unknown>(null)
    const [code, setCode] = useState('')
    const [copied, setCopied] = useState(false)
    const mutation = useRef(0)
    const path = `${base}/${provider}`
    const name = providerNames[provider]
    const pending = activeOperation(operation)
    const connected = summary?.status === 'connected'
    const subscription = connected && summary.method === 'subscription'
    const verificationUrl = providerVerificationUrl(provider, operation?.verificationUrl)
    const acceptOperation = useCallback((next: LoginOperation) => {
        if (next.provider !== provider || !next.id || !Number.isFinite(next.expiresAt)) throw new Error('Ungültige Antwort zur Anbieteranmeldung.')
        // Completed operations must never retain their one-time login challenges in the UI.
        setOperation(activeOperation(next) ? next : { ...next, verificationUrl: undefined, userCode: undefined })
        if (!activeOperation(next)) setCode('')
    }, [provider])
    const forgetMissingOperation = useCallback(async () => {
        setOperation(previous => previous ? { ...previous, state: 'failed', verificationUrl: undefined, userCode: undefined, message: 'Dieser Anmeldevorgang ist nicht mehr verfügbar. Starte die Anmeldung erneut.' } : null)
        setCode(''); setError(null)
        await onRefresh().catch(() => {})
    }, [onRefresh])

    useEffect(() => {
        if (!operation || !pending || busy) return
        let alive = true
        let timer: ReturnType<typeof setTimeout>
        const controller = new AbortController()
        const id = operation.id
        const currentMutation = mutation.current
        const poll = async () => {
            try {
                const result = await request<{ operation: LoginOperation }>(`${path}/login/${encodeURIComponent(id)}`, { signal: controller.signal })
                if (!alive || mutation.current !== currentMutation) return
                if (result.operation.id !== id) throw new Error('Die Anmeldung konnte nicht zugeordnet werden.')
                acceptOperation(result.operation)
                setError(null)
                if (result.operation.state === 'connected') await onRefresh()
            } catch (failure) {
                if (alive && mutation.current === currentMutation && !aborted(failure)) {
                    if (missingOperation(failure)) await forgetMissingOperation()
                    else setError(failure)
                }
            }
            finally { if (alive) timer = setTimeout(poll, 2000) }
        }
        timer = setTimeout(poll, 1000)
        return () => { alive = false; clearTimeout(timer); controller.abort() }
    }, [operation?.id, operation?.state, pending, busy, path, request, onRefresh, acceptOperation, forgetMissingOperation])

    const action = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
        if (busy) return
        mutation.current++
        setBusy(kind); setError(null); setCopied(false)
        try { await work() }
        catch (failure) {
            if (mounted.current && !aborted(failure)) {
                if (kind !== 'start' && pending && missingOperation(failure)) await forgetMissingOperation()
                else setError(failure)
            }
        }
        finally { if (mounted.current) setBusy(null) }
    }
    const start = () => void action('start', async () => {
        setCode('')
        const result = await request<{ operation: LoginOperation }>(`${path}/login`, { method: 'POST', body: {} })
        acceptOperation(result.operation)
        if (result.operation.state === 'connected') await onRefresh()
    })
    const cancel = () => void action('cancel', async () => {
        if (!operation) return
        await request(`${path}/login/${encodeURIComponent(operation.id)}`, { method: 'DELETE' })
        setOperation(null); setCode(''); await onRefresh()
    })
    const logout = () => void action('logout', async () => {
        await request(path, { method: 'DELETE' })
        setOperation(null); setCode(''); await onRefresh()
    })
    const refresh = () => void action('refresh', async () => {
        if (operation && pending) {
            const result = await request<{ operation: LoginOperation }>(`${path}/login/${encodeURIComponent(operation.id)}`)
            acceptOperation(result.operation)
        }
        await onRefresh()
    })
    const submitCode = () => void action('code', async () => {
        if (!operation || !code.trim()) return
        const entered = code.trim(); setCode('')
        const result = await request<{ operation: LoginOperation }>(`${path}/login/${encodeURIComponent(operation.id)}/code`, { method: 'POST', body: { code: entered } })
        acceptOperation(result.operation)
        if (result.operation.state === 'connected') await onRefresh()
    })
    const statusText = busy === 'start' ? 'Anmeldung wird vorbereitet …' : pending ? operation?.state === 'starting' ? 'Anmeldung wird vorbereitet …' : 'Bestätigung beim Anbieter ausstehend' : subscription ? 'Abo verbunden' : connected ? summary.method === 'api-key' ? 'API-Schlüssel eingerichtet' : 'Angemeldet · Anmeldeart unbekannt' : summary?.status === 'disconnected' ? 'Noch nicht verbunden' : 'Status nicht verfügbar'
    return <section className="ev-provider-card" data-provider={provider} aria-label={`${name}-Anmeldung`}>
        <header><ProviderMark provider={provider} /><div><h2>{name}</h2><p>{provider === 'codex' ? 'Mit deinem ChatGPT-Abo' : 'Mit deinem Claude-Abo'}</p></div></header>
        <div><p className="ev-provider-state" data-state={subscription ? 'connected' : pending || busy === 'start' ? 'pending' : 'unknown'} role="status">{statusText}</p>{summary?.checkedAt && !pending ? <p className="ev-provider-caption">Zuletzt geprüft: {formatDate(summary.checkedAt)}</p> : null}</div>
        {connected && !subscription && <p className="ev-provider-caption">Diese Anmeldung ist kein bestätigter Abo-Zugang. Melde das bisherige Konto ausdrücklich ab, bevor du dein Abo verbindest.</p>}
        {pending && operation && <div className="ev-provider-progress">
            {operation.state === 'starting' ? <p>{busy === 'code' ? 'Bestätigung wird geprüft …' : 'Dein Runner und die sichere Anbieteranmeldung werden vorbereitet.'}</p> : <>
                {verificationUrl ? <a className="ev-provider-link" href={verificationUrl} target="_blank" rel="noopener noreferrer">{provider === 'codex' ? 'Bei ChatGPT anmelden' : 'Bei Claude anmelden'}<span aria-hidden="true">↗</span></a> : <p role="alert">Der Anbieterlink ist noch nicht verfügbar. Aktualisiere den Status oder starte die Anmeldung neu.</p>}
                {operation.flow === 'device' && operation.userCode && <><p className="ev-provider-caption">Gib diesen einmaligen Code auf der Anbieterseite ein.</p><div className="ev-provider-code"><output aria-label="Gerätecode">{operation.userCode}</output><button onClick={() => { void navigator.clipboard.writeText(operation.userCode!).then(() => { if (mounted.current) setCopied(true) }).catch(() => { if (mounted.current) setError(new Error('Kopieren nicht möglich. Übertrage den angezeigten Code von Hand.')) }) }}>{copied ? 'Kopiert' : 'Code kopieren'}</button></div><p className="ev-provider-caption">Die Bestätigung wird automatisch erkannt.</p></>}
                {operation.flow === 'code' && <form className="ev-stack" onSubmit={submit(submitCode)}><Field label="Claude-Bestätigungscode" hint="Füge nach der Anmeldung den vollständigen Code einschließlich #State von Claude ein."><input aria-label="Claude-Bestätigungscode" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} value={code} maxLength={4096} required onChange={event => setCode(event.target.value)} /></Field><button className="ev-primary" disabled={!!busy || !code.trim()}>Anmeldung bestätigen</button></form>}
                <p className="ev-provider-caption">Gültig bis {formatDate(operation.expiresAt)}. Anmeldedaten bleiben auf deinem Runner.</p>
            </>}
        </div>}
        {operation && !pending && operation.state !== 'connected' && <p className="ev-provider-caption" role="status">{operation.state === 'cancelled' ? 'Anmeldung abgebrochen.' : operation.state === 'expired' ? 'Die Anmeldung ist abgelaufen. Du kannst sie neu starten.' : operation.message ?? 'Die Anmeldung ist fehlgeschlagen. Versuche es erneut.'}</p>}
        <ErrorNotice error={error} />
        <div className="ev-actions">{pending ? <button disabled={!!busy} onClick={cancel}>Abbrechen</button> : connected ? <ConfirmButton label={`${name} abmelden`} detail={`${name} auf diesem Runner abmelden? Für neue Agentensitzungen ist anschließend eine erneute Anmeldung nötig.`} disabled={!!busy} onConfirm={logout} /> : <button className="ev-primary" disabled={!ready || !!busy} onClick={start}>{busy === 'start' ? 'Wird vorbereitet …' : `Mit ${name} verbinden`}</button>}<button aria-label={`${name}-Status aktualisieren`} disabled={!!busy} onClick={refresh}>Aktualisieren</button></div>
    </section>
}

function ProviderConnections() {
    const { api, project } = useEvolved()
    const { request, mounted } = useScopedRequest(api)
    const [snapshot, setSnapshot] = useState<ProviderSnapshot | null>(null)
    const [error, setError] = useState<unknown>(null)
    const [loading, setLoading] = useState(true)
    const generation = useRef(0)
    const admin = isProjectAdmin(project?.role)
    const base = project ? `${projectPath(project.id)}/providers` : ''
    const refresh = useCallback(async () => {
        if (!base || !admin) return
        const revision = ++generation.current
        setLoading(true)
        try {
            const next = await request<ProviderSnapshot>(base)
            if (revision === generation.current) { setSnapshot(next); setError(null) }
        } catch (failure) {
            if (mounted.current && revision === generation.current && !aborted(failure)) { setSnapshot(null); setError(failure) }
            throw failure
        } finally { if (mounted.current && revision === generation.current) setLoading(false) }
    }, [base, admin, mounted, request])
    useEffect(() => { void refresh().catch(() => {}) }, [refresh])
    if (!project) return <Panel title="Abos verbinden"><p>Wähle zuerst ein Projekt. Deine Anbieteranmeldungen werden auf dessen eigenem Runner gespeichert.</p><a className="ev-provider-link" href="/evolved?tab=projects">Projekte öffnen</a></Panel>
    if (!admin) return <Panel title="Abos verbinden"><p>Ein Projektadministrator kann hier Claude und Codex mit dem Runner verbinden. Die Anmeldung bleibt für dieses Projekt auf dem Runner gespeichert.</p></Panel>
    return <div className="ev-stack" data-testid="provider-connections"><div className="ev-provider-setup"><div><h2>Deine Abos. Dein Runner.</h2><p className="ev-provider-caption">Verbinde Claude oder ChatGPT. Einen fehlenden Runner richten wir beim Verbinden automatisch ein.</p></div></div>
        <ErrorNotice error={error} />{!!error && <button onClick={() => void refresh().catch(() => {})}>Status erneut laden</button>}
        {snapshot?.runner.status === 'starting' && <p className="ev-provider-caption" role="status">Dein Runner wird eingerichtet …</p>}
        <div className="ev-provider-grid">{(['codex', 'claude'] as const).map(provider => <ProviderCard key={provider} api={api} base={base} provider={provider} summary={snapshot?.providers.find(item => item.provider === provider)} ready={!!snapshot && !loading} onRefresh={refresh} />)}</div>
        <details className="ev-disclosure"><summary>So funktioniert die Anmeldung</summary><div className="ev-stack"><p>Bestätige die Anmeldung auf der offiziellen Seite des Anbieters. Bei Codex gibst du dort den Gerätecode ein. Bei Claude fügst du den zurückgegebenen Bestätigungscode hier ein.</p><p>Passwörter und dauerhafte Anmeldedaten bleiben beim Anbieter beziehungsweise auf deinem Runner. Der HAPI-Passkey bestätigt nur, dass du die Verbindung verwalten darfst.</p><p>„Abo verbunden“ erscheint erst nach der Statusprüfung der Anbieter-CLI. Ein online gemeldeter Runner oder eine Kapazitätsanzeige reicht dafür nicht aus.</p></div></details>
    </div>
}

export function ProviderLoginPanel() {
    const { api, me, project } = useEvolved()
    return <ProviderConnections key={`${api.baseUrl}:${me.user.id}:${project?.id ?? 'none'}:${project?.role}:${project?.profile}`} />
}
