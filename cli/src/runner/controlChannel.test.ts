import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const debug = vi.hoisted(() => vi.fn())
vi.mock('@/ui/logger', () => ({ logger: { debug } }))

import { configuration } from '@/configuration'
import { writeRunnerState } from '@/persistence'
import {
    listRunnerSessions,
    notifyRunnerSessionStarted,
    spawnRunnerSession,
    stopRunnerHttp,
    stopRunnerSession
} from './controlClient'
import { startRunnerControlServer } from './controlServer'

/** Real loopback control server + real client, joined only through runner.state.json. */
describe('runner control channel (server + client)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hapi-control-channel-'))
    const originalStateFile = configuration.runnerStateFile
    const handlers = {
        getChildren: vi.fn(() => [{ startedBy: 'runner', happySessionId: 'session-a', pid: 4242 }] as never),
        stopSession: vi.fn(async () => 'stopped' as const),
        spawnSession: vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-b' })),
        requestShutdown: vi.fn(),
        onHappySessionWebhook: vi.fn()
    }
    let server: Awaited<ReturnType<typeof startRunnerControlServer>>

    function writeState(controlToken: string | undefined): void {
        writeRunnerState({
            pid: process.pid,
            httpPort: server.port,
            ...(controlToken ? { controlToken } : {}),
            startTime: 'now',
            startedWithCliVersion: 'test'
        })
    }

    beforeAll(async () => {
        Object.defineProperty(configuration, 'runnerStateFile', { value: join(home, 'runner.state.json'), configurable: true })
        server = await startRunnerControlServer(handlers)
    })

    afterAll(async () => {
        await server.stop()
        Object.defineProperty(configuration, 'runnerStateFile', { value: originalStateFile, configurable: true })
        rmSync(home, { recursive: true, force: true })
    })

    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        for (const call of debug.mock.calls) expect(call.map(String).join(' ')).not.toContain(server.token)
    })

    it('runs list, notify, spawn, stop-session and stop with the state-file token', async () => {
        writeState(server.token)

        await expect(notifyRunnerSessionStarted('session-a', { path: '/work' } as never)).resolves.toEqual({ status: 'ok' })
        expect(handlers.onHappySessionWebhook).toHaveBeenCalledWith('session-a', { path: '/work' })

        await expect(listRunnerSessions()).resolves.toEqual([{ startedBy: 'runner', happySessionId: 'session-a', pid: 4242 }])

        await expect(spawnRunnerSession('/work', 'session-b')).resolves.toMatchObject({ success: true, sessionId: 'session-b' })
        expect(handlers.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ directory: '/work', sessionId: 'session-b' }))

        await expect(stopRunnerSession('session-a')).resolves.toBe('stopped')
        expect(handlers.stopSession).toHaveBeenCalledWith('session-a')

        await stopRunnerHttp()
        await vi.waitFor(() => expect(handlers.requestShutdown).toHaveBeenCalledTimes(1))
    })

    it.each([
        ['an older client or runner state without a token', undefined],
        ['a stale token from a previous runner', 'stale-token-from-previous-runner']
    ])('fails closed with an explicit error for %s', async (_label, token) => {
        writeState(token)

        const spawned = await spawnRunnerSession('/work', 'session-b')
        expect(spawned.error).toContain('Runner rejected control request /spawn-session (HTTP 401)')
        expect(spawned.error).toContain('hapi runner stop')
        await expect(listRunnerSessions()).resolves.toEqual([])
        await expect(stopRunnerSession('session-a')).resolves.toBe('still_alive')
        await expect(notifyRunnerSessionStarted('session-a', {} as never)).resolves.toMatchObject({ error: expect.stringContaining('HTTP 401') })
        await stopRunnerHttp()

        expect(handlers.spawnSession).not.toHaveBeenCalled()
        expect(handlers.stopSession).not.toHaveBeenCalled()
        expect(handlers.onHappySessionWebhook).not.toHaveBeenCalled()
        await new Promise((resolve) => setTimeout(resolve, 80))
        expect(handlers.requestShutdown).not.toHaveBeenCalled()
    })
})
