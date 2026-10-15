import { useCallback, useEffect, useRef, useState } from 'react'
import { Workbox } from 'workbox-window'

export const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
export const PWA_UPDATE_RELOAD_FALLBACK_MS = 2000

export async function requestPwaUpdateReload(
    updateSW: ((reloadPage?: boolean) => Promise<void>) | null | undefined,
    options: {
        reloadPage?: () => void
        setTimeoutFn?: typeof setTimeout
        clearTimeoutFn?: typeof clearTimeout
    } = {},
): Promise<void> {
    const reloadPage = options.reloadPage ?? (() => window.location.reload())
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout

    if (!updateSW) {
        reloadPage()
        return
    }

    let reloaded = false
    const doReload = () => {
        if (reloaded) {
            return
        }
        reloaded = true
        reloadPage()
    }

    const onControllerChange = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        if (fallbackTimer !== undefined) clearTimeoutFn(fallbackTimer)
        doReload()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    try {
        await updateSW(true)
    } catch (error) {
        console.error('PWA update failed', error)
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        if (fallbackTimer !== undefined) {
            clearTimeoutFn(fallbackTimer)
        }
        doReload()
        return
    }

    if (reloaded) return
    fallbackTimer = setTimeoutFn(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        doReload()
    }, PWA_UPDATE_RELOAD_FALLBACK_MS)
}

export function setupRegistrationUpdateChecks(
    registration: ServiceWorkerRegistration,
): () => void {
    // An offline update check must not become an unhandled rejection.
    const check = () => { void registration.update().catch(() => {}) }
    const intervalId = window.setInterval(() => {
        check()
    }, PWA_UPDATE_CHECK_INTERVAL_MS)

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            check()
        }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
        window.clearInterval(intervalId)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
}

export function usePwaUpdate() {
    const [needRefresh, setNeedRefresh] = useState(false)
    const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
    const cleanupRef = useRef<(() => void) | null>(null)

    useEffect(() => {
        if (!('serviceWorker' in navigator)) return
        let disposed = false
        // The plugin's prompt helper also installs a controlling→reload listener
        // in OTHER tabs. Register directly so only this tab's explicit action
        // below can request a document reload. Existing old tabs keep old code.
        const base = import.meta.env.BASE_URL
        const workbox = new Workbox(`${base}${import.meta.env.DEV ? 'dev-sw.js?dev-sw' : 'sw.js'}`, {
            scope: base,
            type: import.meta.env.DEV ? 'module' : 'classic',
        })
        const onWaiting = () => { if (!disposed) setNeedRefresh(true) }
        workbox.addEventListener('waiting', onWaiting)
        const registrationPromise = workbox.register()
        void registrationPromise.then(registration => {
            if (disposed || !registration) return
            if (registration.waiting) onWaiting()
            cleanupRef.current = setupRegistrationUpdateChecks(registration)
        }).catch(error => { if (!disposed) console.error('SW registration error:', error) })
        updateSWRef.current = async () => {
            await registrationPromise
            if (!disposed) workbox.messageSkipWaiting()
        }

        return () => {
            disposed = true
            workbox.removeEventListener('waiting', onWaiting)
            cleanupRef.current?.()
            cleanupRef.current = null
            updateSWRef.current = null
        }
    }, [])

    const reload = useCallback(() => {
        void requestPwaUpdateReload(updateSWRef.current)
    }, [])

    return { needRefresh, reload }
}
