import { Server as Engine } from '@socket.io/bun-engine'
import { Server } from 'socket.io'
import { io as connect } from 'socket.io-client'
import { privateFile } from '../../hub/src/evolved/store'
import { SOCKET_MAX_HTTP_BUFFER_SIZE } from '../../hub/src/socket/socketLimits'
import { boundedGitResponse, GIT_TIMEOUT_MS, gitPath } from '../../hub/src/evolved/githubProtocol'
import { parseRunnerGitRequest, readRunnerGitBody } from './gitRequest'
import { readCredentialResponse } from '../../shared/src/credentialTransport'

type Grant = { token: string; expiresAt: number; projectId: string }
const MAX_PENDING_BYTES = 8 * 1024 * 1024
const MAX_RPC_METHODS = 256
const MAX_RPC_METHOD_BYTES = 512
const MAX_RPC_REGISTRATION_BYTES = 64 * 1024
// Hub-issued capabilities last at most 15 minutes. Allow bounded clock skew
// when a project proxy and the Hub run on different hosts.
const MAX_GRANT_REMAINING_MS = 900_000 + 60_000
export function queuedPacketBytes(value: unknown, depth = 0): number {
    if (depth > 32) return MAX_PENDING_BYTES + 1
    if (typeof value === 'string') return Buffer.byteLength(value)
    if (value instanceof ArrayBuffer) return value.byteLength
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (value && typeof value === 'object') {
        let total = 0
        for (const [key, item] of Object.entries(value)) {
            total += Buffer.byteLength(key) + queuedPacketBytes(item, depth + 1)
            if (total > MAX_PENDING_BYTES) return total
        }
        return total
    }
    return 8
}
export function allowedProxyPath(path: string, method = 'GET', search = ''): boolean {
    if (/^\/api\/evolved\/projects\/[A-Za-z0-9_-]{1,80}\/agent-credentials$/.test(path)) return method === 'GET' && search === ''
    const mcp = /^\/api\/evolved\/projects\/[A-Za-z0-9_-]{1,80}\/mcp\/servers(?:\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/(tools|query|call))?$/.exec(path)
    if (mcp) return search === '' && method === (mcp[2] === 'call' || mcp[2] === 'query' ? 'POST' : 'GET')
    if (/^\/api\/evolved\/projects\/[^/]+\/codegraph(?:\/|$)/.test(path)) {
        return method === 'GET' && /^\/api\/evolved\/projects\/[A-Za-z0-9_-]{1,80}\/codegraph\/(status|search|graph|node|impact|affected)$/.test(path)
    }
    const repositories = /^\/api\/evolved\/projects\/[A-Za-z0-9_-]{1,80}\/(repositories(?:\/([1-9][0-9]{0,19})\/(sync|authorization))?|repository-jobs\/([a-fA-F0-9-]+))$/.exec(path)
    if (repositories) {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (repositories[4]) return method === 'GET' && search === '' && uuid.test(repositories[4])
        if (repositories[3] === 'sync') return method === 'POST' && search === ''
        if (repositories[3] === 'authorization') return method === 'GET' && search.startsWith('?jobId=') && uuid.test(search.slice(7))
        return method === 'GET' && ['', '?workspace=0', '?workspace=1'].includes(search)
    }
    // No browser authentication, vault administration or lease issuance through the proxy.
    return path === '/health' || /^\/cli\//.test(path)
        || /^\/api\/evolved\/peers(?:\/[a-zA-Z0-9_-]+)?$/.test(path)
        || /^\/api\/evolved\/github-pr\/(?:features|link)$/.test(path)
        || /^\/api\/evolved\/(memory\/search|projects\/[^/]+\/(memory(?:\/.*)?|resources(?:\/.*)?))$/.test(path)
}
export function createRunnerProxy(config: { hubUrl: string; leaseFile: string; projectId: string; host?: string; port?: number }) {
    const hub = new URL(config.hubUrl)
    if (hub.username || hub.password || !['http:', 'https:'].includes(hub.protocol)) throw new Error('Invalid Hub URL')
    let grant: Grant | null = null, renewing: Promise<Grant> | null = null
    const gitTransfers = new Set<AbortController>()
    async function current(minRemainingMs = 30_000): Promise<Grant> {
        if (grant && grant.expiresAt > Date.now() + minRemainingMs) return grant
        if (renewing) return renewing
        renewing = (async () => {
            const lease = privateFile(config.leaseFile).toString('utf8').trim()
            const response = await fetch(new URL('/api/evolved/runner/token', hub), { method: 'POST',
                headers: { authorization: `Bearer ${lease}`, 'content-type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(10_000) })
            const next = await response.json() as Grant
            if (!response.ok || !/^[A-Za-z0-9_-]{43}$/.test(next.token ?? '') || next.projectId !== config.projectId
                || typeof next.expiresAt !== 'number' || !Number.isFinite(next.expiresAt)
                || next.expiresAt <= Date.now() || next.expiresAt > Date.now() + MAX_GRANT_REMAINING_MS) throw new Error('Runner lease unavailable or revoked')
            grant = next
            return next
        })().finally(() => { renewing = null })
        return renewing
    }
    const io = new Server({ maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE })
    const engine = new Engine({ path: '/socket.io/', maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE, allowRequest: async req => {
        // This listener is on a per-project isolated network and is never public.
        if (req.headers.get('origin')) throw 'Browser access denied'
    } })
    io.bind(engine)
    const namespace = io.of('/cli')
    namespace.use(async (socket, next) => {
        try { await current(); next() } catch { next(new Error('Runner lease unavailable')) }
    })
    namespace.on('connection', socket => {
        let closed = false
        const auth = socket.handshake.auth as Record<string, unknown>
        const scope = auth.clientType === 'machine-scoped' ? auth.machineId
            : auth.clientType === 'session-scoped' ? auth.sessionId : null
        const rpcPrefix = typeof scope === 'string' && scope.length > 0 && Buffer.byteLength(scope) <= 128
            && !/[:\s\p{C}]/u.test(scope) ? `${scope}:` : null
        const rpcMethods = new Set<string>()
        let rpcMethodBytes = 0, generation = 0
        const upstream = connect(new URL('/cli', hub).toString(), {
            path: '/socket.io/', transports: ['websocket'], reconnection: true,
            reconnectionDelay: 1000, reconnectionDelayMax: 5000,
            auth: callback => { void current().then(value => {
                if (!closed) callback({ token: value.token, clientType: auth.clientType, sessionId: auth.sessionId, machineId: auth.machineId })
            }).catch(() => socket.disconnect(true)) }
        })
        const pending: Array<[string, unknown[]]> = []
        let pendingBytes = 0
        upstream.on('connect', () => {
            generation++
            if (closed || !socket.connected) { upstream.disconnect(); return }
            // Restore only declarative registrations, before queued live events.
            // Keeping the CLI connected avoids stopping its browser terminals
            // whenever the Hub restarts or its short-lived capability rotates.
            for (const method of rpcMethods) upstream.emit('rpc-register', { method })
            pendingBytes = 0
            for (const [event, args] of pending.splice(0)) upstream.emit(event, ...args)
        })
        // Use explicit listeners, including acknowledgement functions: Socket.IO's
        // codecs preserve binary payloads and acknowledgement IDs in both directions.
        socket.onAny((event: string, ...args: unknown[]) => {
            if (closed || !socket.connected) return
            if (event === 'rpc-register' || event === 'rpc-unregister') {
                const payload = args[0]
                const method = payload && typeof payload === 'object' && !Array.isArray(payload)
                    ? (payload as Record<string, unknown>).method : null
                if (!rpcPrefix || typeof method !== 'string' || !method.startsWith(rpcPrefix)
                    || method.length <= rpcPrefix.length || Buffer.byteLength(method) > MAX_RPC_METHOD_BYTES
                    || /[\s\p{C}]/u.test(method)) {
                    socket.emit('error', { message: 'RPC registration rejected' }); return
                }
                const bytes = Buffer.byteLength(method)
                if (event === 'rpc-register' && !rpcMethods.has(method)) {
                    if (rpcMethods.size >= MAX_RPC_METHODS || rpcMethodBytes + bytes > MAX_RPC_REGISTRATION_BYTES) {
                        socket.emit('error', { message: 'RPC registration limit reached' }); return
                    }
                    rpcMethods.add(method); rpcMethodBytes += bytes
                } else if (event === 'rpc-unregister' && rpcMethods.delete(method)) rpcMethodBytes -= bytes
                // No payload extras, ACKs or duplicate pending copies are retained.
                // The Hub independently checks the authenticated namespace's ownership.
                if (upstream.connected) upstream.emit(event, { method })
                return
            }
            if (!upstream.connected) {
                pendingBytes += Buffer.byteLength(event) + queuedPacketBytes(args)
                if (pending.length >= 128 || pendingBytes > MAX_PENDING_BYTES) { socket.disconnect(true); return }
                pending.push([event, args]); return
            }
            upstream.emit(event, ...args)
        })
        upstream.onAny((event: string, ...args: unknown[]) => {
            if (closed || !socket.connected) return
            const receivedGeneration = generation
            socket.emit(event, ...args.map(arg => typeof arg === 'function' ? (...values: unknown[]) => {
                // Socket.IO reuses this client object across Hub connections. An old
                // response must never acknowledge a new connection's reused packet ID.
                if (!closed && upstream.connected && generation === receivedGeneration) arg(...values)
            } : arg))
        })
        upstream.on('connect_error', () => { socket.emit('error', { message: 'Runner authorization unavailable' }) })
        upstream.on('disconnect', reason => {
            generation++
            if (reason === 'io server disconnect') {
                grant = null
                if (!closed) void current().then(() => { if (!closed) upstream.connect() }).catch(() => socket.disconnect(true))
            }
        })
        socket.on('disconnect', () => {
            closed = true; generation++; pending.length = 0; pendingBytes = 0
            rpcMethods.clear(); rpcMethodBytes = 0; upstream.disconnect()
        })
    })
    const handler = engine.handler()
    const server = Bun.serve({ hostname: config.host ?? '127.0.0.1', port: config.port ?? 3010,
        ...handler,
        maxRequestBodySize: 68 * 1024 * 1024,
        fetch: async (request, server) => {
            const url = new URL(request.url)
            if (url.pathname.startsWith('/socket.io/')) return handler.fetch(request, server)
            if (request.headers.has('origin')) return new Response('Browser access denied', { status: 403 })
            if (url.pathname.startsWith('/evolved-git/')) {
                if (gitTransfers.size >= 2) return new Response('Git transfer limit reached', { status: 429 })
                const controller = new AbortController()
                const cancelled = () => controller.abort()
                const timeout = setTimeout(cancelled, GIT_TIMEOUT_MS)
                request.signal.addEventListener('abort', cancelled, { once: true })
                if (request.signal.aborted) cancelled()
                gitTransfers.add(controller)
                const finish = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', cancelled); gitTransfers.delete(controller) }
                try {
                    const parsed = parseRunnerGitRequest(request, '/evolved-git/github.com/'), { git } = parsed
                    const access = await current()
                    const body = await readRunnerGitBody(new Request(request, { signal: controller.signal }), parsed)
                    const headers = new Headers({ authorization: `Bearer ${access.token}` })
                    if (!git.advertisement) headers.set('content-type', `application/x-${git.service}-request`)
                    if (git.protocol) headers.set('git-protocol', git.protocol)
                    const response = await fetch(new URL(`/api/evolved/projects/${config.projectId}/git/${gitPath(git)}`, hub), {
                        method: git.advertisement ? 'GET' : 'POST', headers, body: git.advertisement ? undefined : body,
                        redirect: 'error', signal: controller.signal,
                    })
                    if (response.status === 401) grant = null
                    const type = `application/x-${git.service}-${git.advertisement ? 'advertisement' : 'result'}`
                    if (response.status !== 200 || response.headers.get('content-type') !== type) {
                        await response.body?.cancel(); finish()
                        return new Response('Git operation denied or interrupted; inspect remote refs before retrying a push.', { status: response.status === 200 ? 502 : response.status })
                    }
                    return boundedGitResponse(new Response(response.body, { headers: { 'content-type': type, 'cache-control': 'no-store' } }), controller, finish)
                } catch {
                    controller.abort(); finish()
                    return new Response('Git operation denied or interrupted; inspect remote refs before retrying a push.', { status: 502 })
                }
            }
            if (url.pathname === '/evolved-runner-environment') {
                if (request.method !== 'POST' || url.search || request.headers.has('cookie')) return new Response('Endpoint denied', { status: 403 })
                try {
                    // Only the literal empty body is admitted; never proxy caller-supplied scope.
                    const reader = request.body?.getReader()
                    if (!reader) return new Response('Invalid request', { status: 400 })
                    let body = ''
                    try {
                        for (;;) {
                            const { done, value } = await reader.read()
                            if (done) break
                            if (value.length + body.length > 2) return new Response('Invalid request', { status: 400 })
                            body += new TextDecoder().decode(value)
                        }
                    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
                    if (body !== '{}') return new Response('Invalid request', { status: 400 })
                    const lease = privateFile(config.leaseFile).toString('utf8').trim()
                    const response = await fetch(new URL('/api/evolved/runner/environment', hub), {
                        method: 'POST', headers: { authorization: `Bearer ${lease}`, 'content-type': 'application/json' }, body: '{}',
                        redirect: 'error', signal: AbortSignal.timeout(10_000)
                    })
                    if (response.status === 429) {
                        await response.body?.cancel()
                        return new Response('Project credential delivery busy', { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': '1' } })
                    }
                    const bundle = await readCredentialResponse(response, config.projectId)
                    return Response.json({ projectId: config.projectId, ...bundle }, { headers: { 'cache-control': 'no-store' } })
                } catch { return new Response('Project credential delivery unavailable', { status: 503, headers: { 'cache-control': 'no-store' } }) }
            }
            if (url.pathname === '/evolved-runner-authority' && request.method === 'GET') {
                try {
                    const lease = privateFile(config.leaseFile).toString('utf8').trim()
                    const response = await fetch(new URL('/api/evolved/runner/authority', hub), {
                        headers: { authorization: `Bearer ${lease}` }, redirect: 'error', signal: AbortSignal.timeout(1800)
                    })
                    const state = await response.json() as { projectId?: string; profile?: string; rootPath?: string; expiresAt?: number | null }
                    if (!response.ok || state.projectId !== config.projectId) return new Response('Runner lease unavailable', { status: 403 })
                    return Response.json({ projectId: state.projectId, profile: state.profile, rootPath: state.rootPath, expiresAt: state.expiresAt }, { headers: { 'cache-control': 'no-store' } })
                } catch { return new Response('Runner authority unavailable', { status: 503 }) }
            }
            if (!allowedProxyPath(url.pathname, request.method, url.search)) return new Response('Endpoint denied', { status: 403 })
            if (/^\/api\/evolved\/projects\//.test(url.pathname) && url.pathname.split('/')[4] !== config.projectId) return new Response('Project denied', { status: 403 })
            try {
                // A sync job can run for five minutes. Renew before admission so its
                // initiating capability cannot naturally expire during that window.
                const repositorySync = request.method === 'POST' && /\/repositories\/[1-9][0-9]{0,19}\/sync$/.test(url.pathname)
                const access = await current(repositorySync ? 360_000 : 30_000)
                const headers = new Headers({ authorization: `Bearer ${access.token}` })
                for (const name of ['content-type', 'idempotency-key']) { const value = request.headers.get(name); if (value) headers.set(name, value) }
                const response = await fetch(new URL(url.pathname + url.search, hub), { method: request.method, headers,
                    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
                    redirect: 'error', signal: AbortSignal.timeout(70_000) })
                if (response.status === 401) grant = null
                return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } })
            } catch { return new Response('Runner lease unavailable', { status: 503 }) }
        }
    })
    return { server, close: () => { for (const controller of gitTransfers) controller.abort(); io.close(); server.stop(true) } }
}
if (import.meta.main) {
    const hubUrl = process.env.EVOLVED_HUB_URL, leaseFile = process.env.EVOLVED_RUNNER_LEASE_FILE, projectId = process.env.EVOLVED_PROJECT_ID
    if (!hubUrl || !leaseFile || !projectId) throw new Error('Hub URL, project ID and runner lease file are required')
    const proxy = createRunnerProxy({ hubUrl, leaseFile, projectId, host: process.env.EVOLVED_PROXY_HOST, port: Number(process.env.EVOLVED_PROXY_PORT ?? 3010) })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { proxy.close(); process.exit(0) })
}
