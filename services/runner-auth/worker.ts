import { readFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { NativeAuthController, AuthError, type Provider } from './controller'

const MAX_LINE = 8_192
const HEARTBEAT_TIMEOUT = 10_000
type Request = { requestId: string; action: string; provider?: Provider; operationId?: string; code?: string; refresh?: boolean }

export function parseRequest(value: unknown): Request {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('invalid_request', 'Ungültige Anfrage.')
    const request = value as Record<string, unknown>
    if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.requestId)
        || typeof request.action !== 'string' || !['status', 'start', 'get', 'code', 'cancel', 'logout', 'heartbeat', 'models'].includes(request.action)) {
        throw new AuthError('invalid_request', 'Ungültige Anfrage.')
    }
    const required: Record<string, string[]> = {
        status: [], heartbeat: [], start: ['provider'], logout: ['provider'], models: ['provider'],
        get: ['provider', 'operationId'], cancel: ['provider', 'operationId'], code: ['provider', 'operationId', 'code'],
    }
    const allowed = ['requestId', 'action', ...required[request.action]!, ...(request.action === 'models' ? ['refresh'] : [])]
    if (Object.keys(request).some(key => !allowed.includes(key)) || required[request.action]!.some(key => !(key in request))) throw new AuthError('invalid_request', 'Ungültige Anfrage.')
    if ('provider' in request && request.provider !== 'codex' && request.provider !== 'claude') throw new AuthError('invalid_request', 'Unbekannter Anbieter.')
    if ('operationId' in request && (typeof request.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(request.operationId))) throw new AuthError('invalid_request', 'Ungültiger Anmeldevorgang.')
    if ('code' in request && (typeof request.code !== 'string' || request.code.length > 2_100)) throw new AuthError('invalid_request', 'Ungültiger Anmeldecode.')
    if ('refresh' in request && typeof request.refresh !== 'boolean') throw new AuthError('invalid_request', 'Ungültige Aktualisierungsanfrage.')
    return request as Request
}

/** The operator must enter the container with setpriv before starting this worker. */
async function verifyPrivileges(): Promise<void> {
    if (!process.getuid || process.getuid() === 0 || process.getgid?.() === 0 || process.getgroups?.().some(group => group === 0)) throw new Error('Worker must be unprivileged')
    const status = await readFile('/proc/self/status', 'utf8')
    for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        const value = new RegExp(`^${field}:\\s*([0-9a-f]+)$`, 'mi').exec(status)?.[1]
        if (!value || BigInt(`0x${value}`) !== 0n) throw new Error('Worker must have no Linux capabilities')
    }
    if (!/^NoNewPrivs:\s*1$/m.test(status)) throw new Error('Worker must prevent privilege escalation')
}

export function serveRequests(controller: NativeAuthController, source: Readable, sink: Writable, heartbeatTimeout = HEARTBEAT_TIMEOUT): { close: () => Promise<void>; closed: Promise<void> } {
    let lastHeartbeat = Date.now()
    let stopping = false
    let input = ''
    let pending = 0
    let resolveClosed!: () => void
    const closed = new Promise<void>(resolve => { resolveClosed = resolve })
    const shutdown = async () => {
        if (stopping) return closed
        stopping = true
        clearInterval(watchdog)
        source.pause()
        await controller.close()
        resolveClosed()
    }
    const watchdog = setInterval(() => {
        if (Date.now() - lastHeartbeat >= Math.min(heartbeatTimeout, HEARTBEAT_TIMEOUT)) void shutdown()
    }, Math.min(250, heartbeatTimeout))
    const respond = (response: unknown) => {
        if (stopping) return
        if (sink.writableLength > 65_536) { void shutdown(); return }
        sink.write(`${JSON.stringify(response)}\n`)
    }
    const dispatch = async (raw: string) => {
        let requestId: string | null = null
        try {
            const value: unknown = JSON.parse(raw)
            if (value && typeof value === 'object' && 'requestId' in value
                && typeof value.requestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.requestId)) requestId = value.requestId
            const request = parseRequest(value)
            requestId = request.requestId
            let result: unknown
            switch (request.action) {
                case 'heartbeat': lastHeartbeat = Date.now(); result = { ok: true }; break
                case 'status': result = await controller.status(); break
                case 'models': result = await controller.models(request.provider!, request.refresh); break
                case 'start': result = await controller.start(request.provider!); break
                case 'get': result = controller.get(request.provider!, request.operationId!); break
                case 'code': result = await controller.code(request.provider!, request.operationId!, request.code!); break
                case 'cancel': result = await controller.cancel(request.provider!, request.operationId!); break
                case 'logout': result = await controller.logout(request.provider!); break
            }
            respond({ requestId, result })
        } catch (error) {
            respond({ requestId, error: error instanceof AuthError ? { code: error.code, message: error.message } : { code: 'native_auth_failed', message: 'Anmeldedienst konnte die Anfrage nicht abschließen.' } })
        } finally { pending-- }
    }
    source.setEncoding('utf8')
    source.on('data', (chunk: string) => {
        if (stopping) return
        if (Buffer.byteLength(chunk) > MAX_LINE * 16) { void shutdown(); return }
        input += chunk
        for (;;) {
            const newline = input.indexOf('\n')
            if (newline < 0) break
            if (newline > MAX_LINE || pending >= 16) { void shutdown(); return }
            const line = input.slice(0, newline)
            input = input.slice(newline + 1)
            pending++
            void dispatch(line)
        }
        if (Buffer.byteLength(input) > MAX_LINE) void shutdown()
    })
    source.once('end', () => { void shutdown() })
    source.once('error', () => { void shutdown() })
    sink.once('error', () => { void shutdown() })
    return { close: shutdown, closed }
}

export async function runWorker(): Promise<void> {
    process.umask(0o077)
    await verifyPrivileges()
    const controller = new NativeAuthController({ home: '/runner', codexPath: '/usr/local/bin/codex', claudePath: '/usr/local/bin/claude', proxyUrl: 'http://egress:3128' })
    await controller.initialize()
    const service = serveRequests(controller, process.stdin, process.stdout)
    process.once('SIGTERM', () => { void service.close() })
    process.once('SIGINT', () => { void service.close() })
    await service.closed
    process.exit(0)
}

if (import.meta.main) {
    runWorker().catch(() => {
        process.stderr.write('Native authentication worker could not start securely.\n')
        process.exit(1)
    })
}
