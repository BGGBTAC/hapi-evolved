import { revokeBrowserCloudConsent } from '@/hooks/browserCloudSpeech'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiClient } from '@/api/client'
import { useServerUrl } from '@/hooks/useServerUrl'
import { clearAllMessageWindows } from '@/lib/message-window-store'
import { EvolvedApi, EvolvedApiError, hubUrl, type EvolvedMe, type EvolvedProject } from './api'
import { authenticatePasskey, createPasskey, type AuthenticationOptionsJSON, type RegistrationOptionsJSON } from './webauthn'
import { ActionStatus, ErrorNotice, Field, Loading, Panel, submit, useAction } from './ui'
import { EvolvedBrand } from './Brand'
import { PluginThemeSync } from './PluginThemeSync'
import './evolved.css'

export type EvolvedSession = {
    api: EvolvedApi
    me: EvolvedMe
    project: EvolvedProject | null
    selectProject: (id: string) => void
    refresh: () => Promise<void>
    logout: () => Promise<void>
    reauthenticate: () => Promise<void>
}
const EvolvedContext = createContext<EvolvedSession | null>(null)
export function useOptionalEvolved(): EvolvedSession | null { return useContext(EvolvedContext) }
export function useEvolved(): EvolvedSession {
    const context = useOptionalEvolved()
    if (!context) throw new Error('Evolved-Anmeldung ist nicht verfügbar.')
    return context
}
export type EvolvedBridge = { api: ApiClient; token: string; projectId: string }

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
    const action = useAction()
    const [saved, setSaved] = useState(false)
    const download = () => {
        const blob = new Blob([`HAPI Evolved – Wiederherstellungscodes\nJeder Code ist nur einmal gültig.\n\n${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'hapi-evolved-recovery-codes.txt'
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return <Panel title="Wiederherstellungscodes sichern" description="Diese Codes werden einmal angezeigt. Bewahre sie außerhalb von HAPI an einem sicheren Ort auf. Jeder Code funktioniert einmal.">
        <ul className="ev-recovery-codes">{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul>
        <div className="ev-actions"><button onClick={download}>Als Datei speichern</button><button onClick={() => void action.run(async () => { await navigator.clipboard.writeText(codes.join('\n')) }, 'Codes kopiert.')}>Kopieren</button></div>
        <label className="ev-check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />Ich habe die Codes sicher gespeichert.</label>
        <button className="ev-primary" disabled={!saved} onClick={onDone}>Weiter</button><ActionStatus action={action} />
    </Panel>
}

export async function enrollPasskey(api: EvolvedApi): Promise<{ recoveryCodes?: string[] }> {
    const challenge = await api.request<{ challengeId: string; options: RegistrationOptionsJSON }>('/auth/registration/options', { method: 'POST', body: {} })
    const response = await createPasskey(challenge.options)
    return api.request('/auth/registration/verify', { method: 'POST', body: { challengeId: challenge.challengeId, response } })
}

type PendingEnrollment = { displayName: string; expiresAt: number }
function EvolvedLogin({ api, initialized, enrollment, onAuthenticated }: { api: EvolvedApi; initialized: boolean; enrollment: PendingEnrollment | null; onAuthenticated: () => Promise<void> }) {
    const [invitation] = useState(() => new URLSearchParams(window.location.search).get('invite') ?? '')
    const [mode, setMode] = useState<'login' | 'enroll' | 'recovery'>(() => !initialized || invitation || enrollment ? 'enroll' : 'login')
    const [displayName, setDisplayName] = useState(enrollment?.displayName ?? '')
    const [bootstrapToken, setBootstrapToken] = useState(invitation)
    const [recoveryCode, setRecoveryCode] = useState('')
    const [enrollmentStarted, setEnrollmentStarted] = useState(!!enrollment)
    const [codes, setCodes] = useState<string[] | null>(null)
    const action = useAction()
    useEffect(() => {
        const url = new URL(window.location.href)
        for (const key of ['invite', 'token']) url.searchParams.delete(key)
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }, [])
    const login = () => void action.run(async () => {
        const challenge = await api.request<{ challengeId: string; options: AuthenticationOptionsJSON }>('/auth/login/options', { method: 'POST', body: displayName.trim() ? { displayName: displayName.trim() } : {} })
        const response = await authenticatePasskey(challenge.options)
        await api.request('/auth/login/verify', { method: 'POST', body: { challengeId: challenge.challengeId, response } })
        await onAuthenticated()
    })
    const register = () => void action.run(async () => {
        if (!enrollmentStarted) {
            await api.request('/auth/bootstrap', { method: 'POST', body: { token: bootstrapToken.trim(), displayName: displayName.trim() } })
            setEnrollmentStarted(true)
            setBootstrapToken('')
        }
        try {
            const result = await enrollPasskey(api)
            if (result.recoveryCodes?.length) setCodes(result.recoveryCodes)
            else await onAuthenticated()
        } catch (failure) {
            if (failure instanceof EvolvedApiError && failure.code === 'enrollment_required') setEnrollmentStarted(false)
            throw failure
        }
    })
    return <main lang="de" className="evolved ev-login"><div className="ev-login-layout">
        <section className="ev-login-story"><EvolvedBrand /><h1>Deine Ideen.<br />Deine Agenten.<br /><em>Ein Arbeitsplatz.</em></h1><p>Vom ersten Gedanken bis zum fertigen Projekt. Code, Wissen und Agenten – verbunden in HAPI-eVolved.</p><ul className="ev-login-features"><li>Passkey-Anmeldung</li><li>Projektgebundene Zugänge</li><li>Dein eigener Hub</li></ul></section>
        <div className="ev-login-card">
        {codes ? <RecoveryCodes codes={codes} onDone={() => { setCodes(null); void action.run(onAuthenticated) }} /> : <Panel title={mode === 'enroll' ? initialized ? 'Einladung annehmen' : 'Arbeitsplatz einrichten' : mode === 'recovery' ? 'Zugang wiederherstellen' : 'Willkommen zurück'}>
            <p className="ev-muted">{mode === 'enroll' ? 'Erstelle deinen Passkey mit dem Einrichtungs- oder Einladungscode.' : mode === 'recovery' ? 'Verwende einen deiner einmaligen Wiederherstellungscodes. Anschließend kannst du einen neuen Passkey hinzufügen.' : 'Melde dich mit deinem Passkey an.'}</p>
            <form className="ev-stack" onSubmit={submit(mode === 'login' ? login : mode === 'enroll' ? register : () => void action.run(async () => {
                await api.request('/auth/recovery', { method: 'POST', body: { displayName: displayName.trim(), code: recoveryCode.trim() } })
                setRecoveryCode('')
                await onAuthenticated()
            }))}>
                <Field label={mode === 'login' ? 'Benutzername (optional)' : 'Benutzername'}><input autoComplete="username webauthn" value={displayName} onChange={event => setDisplayName(event.target.value)} required={mode !== 'login'} readOnly={mode === 'enroll' && enrollmentStarted} maxLength={100} /></Field>
                {mode === 'enroll' && !enrollmentStarted && <Field label={initialized ? 'Einladungscode' : 'Einrichtungscode'} hint="Den ersten Einrichtungscode erhältst du beim Start des Hubs."><input type="password" autoComplete="off" value={bootstrapToken} onChange={event => setBootstrapToken(event.target.value)} required /></Field>}
                {mode === 'recovery' && <Field label="Wiederherstellungscode"><input type="password" autoComplete="off" value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} required /></Field>}
                <button className="ev-primary" disabled={action.busy}>{action.busy ? 'Bitte bestätigen …' : mode === 'enroll' ? 'Passkey erstellen' : mode === 'recovery' ? 'Zugang wiederherstellen' : 'Mit Passkey anmelden'}</button>
            </form>
            <ActionStatus action={action} />
            {initialized && <div className="ev-actions ev-login-alternatives">{mode !== 'login' && <button onClick={() => { setMode('login'); action.clear() }}>Zur Anmeldung</button>}{mode !== 'recovery' && <button onClick={() => { setMode('recovery'); action.clear() }}>Passkey verloren</button>}{mode !== 'enroll' && <button onClick={() => { setMode('enroll'); action.clear() }}>Einladung annehmen</button>}</div>}
        </Panel>}
        <p className="ev-login-note">Dein Passkey bleibt auf deinem Gerät oder in deinem Passwortmanager.</p>
        </div></div></main>
}

export function EvolvedBoundary({ legacy, authenticated, onboarding }: {
    legacy: ReactNode
    authenticated: (bridge: EvolvedBridge) => ReactNode
    onboarding: ReactNode
}) {
    const { baseUrl } = useServerUrl()
    const [mode, setMode] = useState<'loading' | 'legacy' | 'evolved'>('loading')
    const [error, setError] = useState<unknown>(null)
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        const controller = new AbortController()
        setMode('loading')
        setError(null)
        void fetch(hubUrl(baseUrl, '/health'), { credentials: 'include', cache: 'no-store', signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw new Error(`Hub nicht erreichbar (${response.status}).`)
                return response.json() as Promise<{ evolved?: { enabled?: boolean } }>
            })
            .then(health => { if (!controller.signal.aborted) setMode(health.evolved?.enabled === true ? 'evolved' : 'legacy') })
            .catch(failure => { if (!controller.signal.aborted) setError(failure) })
        return () => controller.abort()
    }, [baseUrl, attempt])
    if (error) return <main lang="de" className="evolved ev-login"><ErrorNotice error={error} /><button onClick={() => setAttempt(value => value + 1)}>Erneut verbinden</button></main>
    if (mode === 'loading') return <main lang="de" className="evolved ev-login"><Loading /></main>
    if (mode === 'legacy') return legacy
    return <EvolvedSessionProvider key={baseUrl} baseUrl={baseUrl} authenticated={authenticated} onboarding={onboarding} />
}

function EvolvedSessionProvider({ baseUrl, authenticated, onboarding }: {
    baseUrl: string
    authenticated: (bridge: EvolvedBridge) => ReactNode
    onboarding: ReactNode
}) {
    const api = useMemo(() => new EvolvedApi(baseUrl), [baseUrl])
    const queryClient = useQueryClient()
    const [initialized, setInitialized] = useState(true)
    const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null)
    const [ready, setReady] = useState(false)
    const [me, setMe] = useState<EvolvedMe | null>(null)
    const [projectId, setProjectId] = useState<string | null>(null)
    const [token, setToken] = useState<string | null>(null)
    const [tokenProjectId, setTokenProjectId] = useState<string | null>(null)
    const tokenRef = useRef<string | null>(null)
    const tokenRequest = useRef(0)
    const successfulTokenRequest = useRef(0)
    const principalRef = useRef<string | null>(null)
    const authEpoch = useRef(0)
    const projectRef = useRef(projectId)
    projectRef.current = projectId
    const [error, setError] = useState<unknown>(null)
    const [bridgeError, setBridgeError] = useState<unknown>(null)
    const [bridgeRefreshFailed, setBridgeRefreshFailed] = useState(false)
    const refresh = useCallback(async () => {
        const epoch = authEpoch.current
        const status = await api.request<{ initialized: boolean; authenticated: boolean; enrollment?: PendingEnrollment | null }>('/auth/status')
        if (epoch !== authEpoch.current) return
        setInitialized(status.initialized)
        setEnrollment(status.enrollment ?? null)
        if (!status.authenticated) {
            authEpoch.current++
            queryClient.clear()
            clearAllMessageWindows()
            revokeBrowserCloudConsent()
            principalRef.current = null
            projectRef.current = null
            setProjectId(null)
            setMe(null)
            setToken(null)
            setBridgeRefreshFailed(false)
            tokenRef.current = null
            setReady(true)
            return
        }
        const next = await api.request<EvolvedMe>('/me')
        if (epoch !== authEpoch.current) return
        let saved: string | null = null
        try { saved = localStorage.getItem(`hapi.evolved.project:${baseUrl}:${next.user.id}`) } catch { /* storage optional */ }
        const nextProject = next.accessibleProjects.some(project => project.id === projectRef.current) ? projectRef.current : next.accessibleProjects.some(project => project.id === saved) ? saved : next.accessibleProjects[0]?.id ?? null
        if (principalRef.current !== next.user.id || projectRef.current !== nextProject) {
            authEpoch.current++
            queryClient.clear()
            clearAllMessageWindows()
            revokeBrowserCloudConsent()
            tokenRef.current = null
            setToken(null)
            setTokenProjectId(null)
            setBridgeError(null)
            setBridgeRefreshFailed(false)
        }
        principalRef.current = next.user.id
        projectRef.current = nextProject
        setMe(next)
        setProjectId(nextProject)
        setReady(true)
        setError(null)
    }, [api, baseUrl, queryClient])
    useEffect(() => { void refresh().catch(setError) }, [refresh])
    const selectProject = useCallback((id: string) => {
        if (!me?.accessibleProjects.some(project => project.id === id) || id === projectId) return
        queryClient.clear()
        clearAllMessageWindows()
            revokeBrowserCloudConsent()
        tokenRef.current = null
        setToken(null)
        setBridgeError(null)
        setBridgeRefreshFailed(false)
        projectRef.current = id
        setProjectId(id)
        try { localStorage.setItem(`hapi.evolved.project:${baseUrl}:${me.user.id}`, id) } catch { /* storage optional */ }
    }, [me, projectId, queryClient, baseUrl])
    const issueToken = useCallback(async (): Promise<string | null> => {
        if (!projectId) return null
        const epoch = authEpoch.current
        const request = ++tokenRequest.current
        try {
            const result = await api.request<{ token: string }>(`/session-token?projectId=${encodeURIComponent(projectId)}`)
            if (projectRef.current !== projectId || epoch !== authEpoch.current) return null
            // Only a newer success supersedes this result. A newer temporary
            // failure must not prevent an in-flight renewal from recovering.
            if (request < successfulTokenRequest.current) return result.token
            successfulTokenRequest.current = request
            tokenRef.current = result.token
            setToken(result.token)
            setTokenProjectId(projectId)
            setBridgeError(null)
            setBridgeRefreshFailed(false)
            return result.token
        } catch (failure) {
            if (projectRef.current !== projectId || epoch !== authEpoch.current) return null
            const rejected = failure instanceof EvolvedApiError && (failure.status === 401 || failure.status === 403)
            if (rejected ? request < successfulTokenRequest.current : request !== tokenRequest.current) return null
            const temporary = failure instanceof TypeError || failure instanceof EvolvedApiError && (failure.status === 429 || failure.status >= 500)
            if (temporary && tokenRef.current) {
                // A failed renewal does not revoke the current project authority.
                // Keep drafts mounted, but never report the stale token as a
                // successful refresh to API clients that might replay a request.
                setBridgeRefreshFailed(true)
                return null
            }
            authEpoch.current++
            setBridgeRefreshFailed(false)
            tokenRef.current = null
            setToken(null)
            if (failure instanceof EvolvedApiError && failure.status === 401) {
                queryClient.clear()
                clearAllMessageWindows()
            revokeBrowserCloudConsent()
                principalRef.current = null
                projectRef.current = null
                setProjectId(null)
                setMe(null)
            } else setBridgeError(failure)
            return null
        }
    }, [api, projectId, queryClient])
    useEffect(() => {
        if (!me || !projectId) return
        void issueToken()
        const interval = setInterval(() => { void issueToken() }, 180_000)
        return () => clearInterval(interval)
    }, [me?.user.id, projectId, issueToken])
    const authorityEpoch = authEpoch.current
    const hubApi = useMemo(() => new ApiClient('', {
        baseUrl,
        credentials: 'include',
        getProjectId: () => projectId,
        getToken: () => tokenRef.current,
        onUnauthorized: issueToken,
        isAuthorityCurrent: () => authEpoch.current === authorityEpoch && projectRef.current === projectId,
    }), [baseUrl, projectId, issueToken, authorityEpoch])
    const reauthenticate = async () => {
        const challenge = await api.request<{ challengeId: string; options: AuthenticationOptionsJSON }>('/auth/login/options', { method: 'POST', body: { displayName: me!.user.displayName } })
        const response = await authenticatePasskey(challenge.options)
        const result = await api.request<{ principal: EvolvedMe }>('/auth/login/verify', { method: 'POST', body: { challengeId: challenge.challengeId, response } })
        if (result.principal.user.id !== me!.user.id) {
            authEpoch.current++
            queryClient.clear()
            clearAllMessageWindows()
            revokeBrowserCloudConsent()
            tokenRef.current = null
            setToken(null)
            setBridgeRefreshFailed(false)
            await refresh()
            throw new Error('Du hast ein anderes Konto gewählt. Prüfe das aktive Projekt und starte die Aktion erneut.')
        }
        await issueToken()
    }
    useEffect(() => {
        api.setStepUpHandler(reauthenticate)
        return () => api.setStepUpHandler(null)
    })
    const reloadContext = async () => { await refresh(); if (projectId) await issueToken() }
    const logout = async () => {
        await api.request('/auth/logout', { method: 'POST', body: {} })
        // A failed logout leaves the current session usable so the user can
        // retry. Advance authority only after the server confirms revocation.
        authEpoch.current++
        queryClient.clear()
        clearAllMessageWindows()
            revokeBrowserCloudConsent()
        principalRef.current = null
        projectRef.current = null
        setProjectId(null)
        tokenRef.current = null
        setToken(null)
        setBridgeRefreshFailed(false)
        setMe(null)
    }
    if (error) return <main lang="de" className="evolved ev-login"><ErrorNotice error={error} /><button onClick={() => void refresh().catch(setError)}>Erneut versuchen</button></main>
    if (!ready) return <main lang="de" className="evolved ev-login"><Loading /></main>
    if (!me) return <EvolvedLogin api={api} initialized={initialized} enrollment={enrollment} onAuthenticated={refresh} />
    const project = me.accessibleProjects.find(item => item.id === projectId) ?? null
    return <EvolvedContext.Provider value={{ api, me, project, selectProject, refresh: reloadContext, logout, reauthenticate }}>
        <PluginThemeSync key={`${api.baseUrl}:${me.user.id}`} api={api} userId={me.user.id} />
        {!project ? onboarding : bridgeError ? <main lang="de" className="evolved ev-login"><ErrorNotice error={bridgeError} /><button onClick={() => void issueToken()}>Projekt erneut öffnen</button><button onClick={() => void logout()}>Abmelden</button></main> : !token || tokenProjectId !== projectId ? <main lang="de" className="evolved ev-login"><Loading /></main> : <>
            {bridgeRefreshFailed && <aside lang="de" className="evolved ev-auth-refresh-warning" role="status"><p>Die Verbindung konnte gerade nicht erneuert werden. Deine offenen Eingaben bleiben erhalten.</p><button onClick={() => void issueToken()}>Verbindung erneut prüfen</button></aside>}
            {authenticated({ api: hubApi, token, projectId: project.id })}
        </>}
    </EvolvedContext.Provider>
}
