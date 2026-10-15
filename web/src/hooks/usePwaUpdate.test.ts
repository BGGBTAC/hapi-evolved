import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    PWA_UPDATE_CHECK_INTERVAL_MS,
    PWA_UPDATE_RELOAD_FALLBACK_MS,
    requestPwaUpdateReload,
    setupRegistrationUpdateChecks,
    usePwaUpdate,
} from '@/hooks/usePwaUpdate'

const workboxMock = vi.hoisted(() => ({ create: vi.fn() }))
const serviceWorkerListeners = new Map<string, Set<EventListener>>()

vi.mock('workbox-window', () => ({
    Workbox: class { constructor(...args: unknown[]) { return workboxMock.create(...args) } },
}))

beforeEach(() => {
    serviceWorkerListeners.clear()
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
            addEventListener: (type: string, listener: EventListener) => {
                const bucket = serviceWorkerListeners.get(type) ?? new Set<EventListener>()
                bucket.add(listener)
                serviceWorkerListeners.set(type, bucket)
            },
            removeEventListener: (type: string, listener: EventListener) => {
                serviceWorkerListeners.get(type)?.delete(listener)
            },
        },
    })
})

describe('setupRegistrationUpdateChecks', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('checks for updates on an hourly interval', () => {
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration

        const cleanup = setupRegistrationUpdateChecks(registration)

        vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS)
        expect(registration.update).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS)
        expect(registration.update).toHaveBeenCalledTimes(2)

        cleanup()
    })

    it('checks for updates when the tab becomes visible', () => {
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration

        const cleanup = setupRegistrationUpdateChecks(registration)

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(registration.update).not.toHaveBeenCalled()

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(registration.update).toHaveBeenCalledTimes(1)

        cleanup()
    })

    it('removes listeners and clears the interval on cleanup', () => {
        const registration = {
            update: vi.fn().mockResolvedValue(undefined),
        } as unknown as ServiceWorkerRegistration
        const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')
        const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

        const cleanup = setupRegistrationUpdateChecks(registration)
        cleanup()

        expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
        expect(clearIntervalSpy).toHaveBeenCalled()
    })
})

describe('requestPwaUpdateReload', () => {
    it('reloads immediately when updateSW is unavailable', async () => {
        const reloadPage = vi.fn()

        await requestPwaUpdateReload(null, { reloadPage })

        expect(reloadPage).toHaveBeenCalledTimes(1)
    })

    it('calls updateSW and reloads on controllerchange', async () => {
        const updateSW = vi.fn().mockImplementation(async () => {
            for (const listener of serviceWorkerListeners.get('controllerchange') ?? []) {
                listener(new Event('controllerchange'))
            }
        })
        const reloadPage = vi.fn()

        await requestPwaUpdateReload(updateSW, { reloadPage })

        expect(updateSW).toHaveBeenCalledWith(true)
        expect(reloadPage).toHaveBeenCalledTimes(1)
    })

    it('falls back to reload when controllerchange never fires', async () => {
        vi.useFakeTimers()

        const updateSW = vi.fn().mockResolvedValue(undefined)
        const reloadPage = vi.fn()

        const pending = requestPwaUpdateReload(updateSW, {
            reloadPage,
            setTimeoutFn: vi.fn((callback, delay) => {
                expect(delay).toBe(PWA_UPDATE_RELOAD_FALLBACK_MS)
                return setTimeout(callback, delay)
            }) as unknown as typeof setTimeout,
        })

        await pending
        vi.runAllTimers()

        expect(updateSW).toHaveBeenCalledWith(true)
        expect(reloadPage).toHaveBeenCalledTimes(1)

        vi.useRealTimers()
    })
})

describe('usePwaUpdate direct registration', () => {
    let waiting: (() => void) | undefined
    let registration: ServiceWorkerRegistration
    let worker: {
        register: ReturnType<typeof vi.fn>
        messageSkipWaiting: ReturnType<typeof vi.fn>
        addEventListener: ReturnType<typeof vi.fn>
        removeEventListener: ReturnType<typeof vi.fn>
    }
    beforeEach(() => {
        vi.useFakeTimers()
        vi.stubEnv('BASE_URL', '/')
        vi.stubEnv('DEV', false)
        waiting = undefined
        registration = { waiting: null, update: vi.fn().mockResolvedValue(undefined) } as unknown as ServiceWorkerRegistration
        worker = {
            register: vi.fn().mockResolvedValue(registration),
            messageSkipWaiting: vi.fn(),
            addEventListener: vi.fn((name, handler) => { if (name === 'waiting') waiting = handler }),
            removeEventListener: vi.fn(),
        }
        workboxMock.create.mockClear().mockReturnValue(worker)
    })
    afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

    it('registers one worker and exposes waiting state without subscribing to automatic reload events', async () => {
        const { result } = renderHook(() => usePwaUpdate())
        await act(async () => {})
        expect(workboxMock.create).toHaveBeenCalledExactlyOnceWith('/sw.js', { scope: '/', type: 'classic' })
        expect(worker.register).toHaveBeenCalledOnce()
        expect(worker.addEventListener.mock.calls.map(call => call[0])).toEqual(['waiting'])
        expect(result.current.needRefresh).toBe(false)
        act(() => waiting?.())
        expect(result.current.needRefresh).toBe(true)
        expect(worker.messageSkipWaiting).not.toHaveBeenCalled()
        expect(serviceWorkerListeners.get('controllerchange')?.size ?? 0).toBe(0)
    })

    it('preserves the production subpath and Vite development worker URL', async () => {
        vi.stubEnv('BASE_URL', '/hapi/')
        const first = renderHook(() => usePwaUpdate())
        await act(async () => {})
        expect(workboxMock.create).toHaveBeenLastCalledWith('/hapi/sw.js', { scope: '/hapi/', type: 'classic' })
        first.unmount()
        vi.stubEnv('DEV', true)
        renderHook(() => usePwaUpdate())
        await act(async () => {})
        expect(workboxMock.create).toHaveBeenLastCalledWith('/hapi/dev-sw.js?dev-sw', { scope: '/hapi/', type: 'module' })
    })

    it('recognizes an already waiting worker and keeps it waiting until the local explicit action', async () => {
        Object.defineProperty(registration, 'waiting', { value: {} })
        const { result } = renderHook(() => usePwaUpdate())
        await act(async () => {})
        expect(result.current.needRefresh).toBe(true)
        expect(worker.messageSkipWaiting).not.toHaveBeenCalled()
        await act(async () => { result.current.reload() })
        expect(worker.messageSkipWaiting).toHaveBeenCalledOnce()
        expect(serviceWorkerListeners.get('controllerchange')?.size).toBe(1)
        expect(result.current.needRefresh).toBe(true)
    })

    it('cleans update checks on unmount and ignores late registration resolution', async () => {
        let resolve!: (value: ServiceWorkerRegistration) => void
        worker.register.mockReturnValue(new Promise(done => { resolve = done }))
        const view = renderHook(() => usePwaUpdate())
        view.unmount()
        await act(async () => { resolve(registration) })
        act(() => { waiting?.(); vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS) })
        expect(registration.update).not.toHaveBeenCalled()
        expect(worker.removeEventListener).toHaveBeenCalledWith('waiting', expect.any(Function))
    })

    it('checks hourly and absorbs offline update failures', async () => {
        vi.mocked(registration.update).mockRejectedValue(new Error('offline'))
        const view = renderHook(() => usePwaUpdate())
        await act(async () => {})
        await act(async () => { vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS) })
        expect(registration.update).toHaveBeenCalledOnce()
        view.unmount()
        await act(async () => { vi.advanceTimersByTime(PWA_UPDATE_CHECK_INTERVAL_MS) })
        expect(registration.update).toHaveBeenCalledOnce()
    })
})
