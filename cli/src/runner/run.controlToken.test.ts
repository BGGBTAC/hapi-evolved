import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const TOKEN = 'control-token-must-stay-local-0123456789abcdef'

const mocks = vi.hoisted(() => ({
    requestShutdown: null as null | (() => void),
    debug: vi.fn(),
    getOrCreateMachine: vi.fn(),
    updateRunnerState: vi.fn(async (_update: unknown) => {}),
    setRPCHandlers: vi.fn(),
}))

vi.mock('./controlServer', () => ({
    startRunnerControlServer: async (handlers: { requestShutdown: () => void }) => {
        mocks.requestShutdown = handlers.requestShutdown
        return { port: 43210, token: 'control-token-must-stay-local-0123456789abcdef', stop: async () => {} }
    }
}))
vi.mock('./controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: async () => false,
    stopRunner: async () => {},
    cleanupRunnerState: async () => {},
    getInstalledCliMtimeMs: () => undefined,
    waitForRunnerHandoff: async () => false,
}))
vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    acquireRunnerLock: async () => ({}),
    releaseRunnerLock: async () => {},
}))
vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            getOrCreateMachine: async (args: unknown) => {
                mocks.getOrCreateMachine(args)
                return { id: 'machine' }
            },
            machineSyncClient: () => ({
                setRPCHandlers: mocks.setRPCHandlers,
                connect: () => {},
                updateRunnerState: mocks.updateRunnerState,
                shutdown: () => {},
            }),
        }),
    },
}))
vi.mock('@/modules/common/cursorModelsPrewarm', () => ({ scheduleCursorModelsPrewarm: () => {} }))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ machineId: 'machine' }) }))
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug, debugLargeJson: mocks.debug, warn: mocks.debug, info: mocks.debug, logFilePath: '/dev/null' } }))
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }))
vi.mock('@/codex/shared/registry', () => ({
    readRuntimes: async () => [],
    findRuntime: async () => undefined,
    runtimeAuthHash: () => 'test-auth',
    runtimeMayBeAlive: () => false,
}))

import { configuration } from '@/configuration'
import { startRunner } from './run'

describe('runner control token lifecycle', () => {
    const home = mkdtempSync(join(tmpdir(), 'hapi-control-token-'))
    afterAll(() => rmSync(home, { recursive: true, force: true }))

    it('keeps the token in the private heartbeat state only', async () => {
        const stateFile = join(home, 'runner.state.json')
        const originalStateFile = configuration.runnerStateFile
        const exited = new Error('process.exit')
        const consoleLines: unknown[][] = []
        vi.spyOn(process, 'on').mockReturnValue(process)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw exited })
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { consoleLines.push(args) })
        vi.stubEnv('HAPI_RUNNER_HANDOFF_FROM_PID', '')
        vi.stubEnv('HAPI_RUNNER_HEARTBEAT_INTERVAL', '20')
        vi.stubEnv('HAPI_DISABLE_VERSION_HANDOFF', '1')
        Object.defineProperty(configuration, 'runnerStateFile', { value: stateFile, configurable: true })
        try {
            const running = startRunner()
            let heartbeat: Record<string, unknown> | null = null
            await vi.waitFor(() => {
                heartbeat = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>
                expect(heartbeat.lastHeartbeat).toBeTypeOf('string')
            }, { timeout: 5_000, interval: 20 })

            expect(heartbeat!.controlToken).toBe(TOKEN)
            expect(heartbeat!.httpPort).toBe(43210)
            if (process.platform !== 'win32') expect(statSync(stateFile).mode & 0o777).toBe(0o600)

            mocks.requestShutdown!()
            await expect(running).rejects.toBe(exited)

            // Hub registration, runner-state updates, RPC handlers, logs and the banner never carry it.
            const runnerStates = mocks.updateRunnerState.mock.calls.map(([update]) =>
                (update as (state: Record<string, unknown> | null) => unknown)({ status: 'running', httpPort: 43210 }))
            const outbound = JSON.stringify({
                machine: mocks.getOrCreateMachine.mock.calls,
                runnerStates,
                rpc: mocks.setRPCHandlers.mock.calls.map(([handlers]) => Object.keys(handlers as object)),
                logs: mocks.debug.mock.calls.map((args) => args.map(String)),
                console: consoleLines.map((args) => args.map(String)),
            })
            expect(mocks.getOrCreateMachine).toHaveBeenCalledTimes(1)
            expect(outbound).toContain('43210')
            expect(outbound).not.toContain(TOKEN)
        } finally {
            Object.defineProperty(configuration, 'runnerStateFile', { value: originalStateFile, configurable: true })
            vi.restoreAllMocks()
            vi.unstubAllEnvs()
        }
    })
})
