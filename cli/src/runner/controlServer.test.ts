import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { startRunnerControlServer } from './controlServer'

type Server = Awaited<ReturnType<typeof startRunnerControlServer>>

function post(port: number, path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
        })
        req.on('error', reject)
        req.end(JSON.stringify({ sessionId: 'session-1' }))
    })
}

describe('runner control server access', () => {
    let server: Server | null = null
    const stopSession = vi.fn(async () => 'stopped' as const)

    afterEach(async () => {
        await server?.stop()
        server = null
        stopSession.mockClear()
    })

    async function start(): Promise<Server> {
        server = await startRunnerControlServer({
            getChildren: () => [],
            stopSession,
            spawnSession: vi.fn(),
            requestShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn()
        })
        return server
    }

    it('accepts requests that carry the runner token', async () => {
        const { port, token } = await start()

        expect(await post(port, '/stop-session', { Authorization: `Bearer ${token}` })).toBe(200)
        expect(stopSession).toHaveBeenCalledWith('session-1')
    })

    it('rejects requests without the runner token', async () => {
        const { port, token } = await start()

        expect(await post(port, '/stop-session', {})).toBe(401)
        expect(await post(port, '/stop-session', { Authorization: `Bearer ${token}x` })).toBe(401)
        expect(stopSession).not.toHaveBeenCalled()
    })

    it('rejects browser and DNS-rebound requests even with the token', async () => {
        const { port, token } = await start()
        const authorization = `Bearer ${token}`

        expect(await post(port, '/stop-session', { Authorization: authorization, Origin: 'https://example.test' })).toBe(403)
        expect(await post(port, '/stop-session', { Authorization: authorization, Host: `attacker.example:${port}` })).toBe(403)
        expect(stopSession).not.toHaveBeenCalled()
    })
})
