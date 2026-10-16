import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunnerProxy, allowedProxyPath, queuedPacketBytes } from './server'
import { Server as Engine } from '@socket.io/bun-engine'
import { Server } from 'socket.io'
import { io as connect } from 'socket.io-client'
import { RpcRegistry } from '../../hub/src/socket/rpcRegistry'
import { registerRpcHandlers } from '../../hub/src/socket/handlers/cli/rpcHandlers'
import type { CliSocketWithData } from '../../hub/src/socket/socketTypes'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

async function eventually(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5000
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message)
        await Bun.sleep(10)
    }
}

function rpcFixture(auth: Record<string, unknown> = { clientType: 'machine-scoped', machineId: 'machine-a' }) {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-proxy-rpc-')), leaseFile = join(directory, 'lease')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(leaseFile, 'synthetic-lease', { mode: 0o600 })
    const state = { leaseCalls: 0, effects: 0, revoked: false }
    function startHub(port = 0) {
        const engine = new Engine({ path: '/socket.io/' }), io = new Server(), registry = new RpcRegistry()
        const registrations: string[] = [], registrationPayloads: unknown[][] = [], observed: string[] = []
        io.bind(engine)
        const namespace = io.of('/cli')
        namespace.use((socket, next) => socket.handshake.auth.token === 'x'.repeat(43) ? next() : next(new Error('bad token')))
        namespace.on('connection', socket => {
            registerRpcHandlers(socket as CliSocketWithData, registry, {
                authorizeTarget: (kind, id) => id === (kind === 'machine' ? 'machine-a' : 'session-a') && !state.revoked,
            })
            socket.on('disconnect', () => registry.unregisterAll(socket))
            socket.on('rpc-register', (...args: unknown[]) => {
                registrations.push((args[0] as { method: string }).method); registrationPayloads.push(args)
            })
            socket.on('effect', (value: unknown, ack: (value: unknown) => void) => { state.effects++; ack(value) })
            socket.on('echo', (value: unknown, ack: (value: unknown) => void) => ack(value))
            socket.on('observe-registry', (method: string, ack: (value: boolean) => void) => {
                observed.push(method)
                ack(registry.getSocketIdForMethod(method, 'machine') === socket.id)
            })
        })
        const handler = engine.handler()
        const server = Bun.serve({ ...handler, hostname: '127.0.0.1', port, fetch(request, server) {
            if (new URL(request.url).pathname.startsWith('/socket.io/')) return handler.fetch(request, server)
            if (new URL(request.url).pathname === '/api/evolved/runner/token') {
                state.leaseCalls++
                return state.revoked ? Response.json({ error: 'revoked' }, { status: 401 })
                    : Response.json({ token: 'x'.repeat(43), projectId: 'a', expiresAt: Date.now() + 900_000 })
            }
            return new Response('Not found', { status: 404 })
        } })
        return { server, io, namespace, registry,
            lookup: (method: string) => registry.getSocketIdForMethod(method, auth.clientType === 'session-scoped' ? 'session' : 'machine'),
            registrations, registrationPayloads, observed, close() { io.close(); return server.stop(true) } }
    }
    let hub = startHub()
    cleanup.push(() => { void hub.close() })
    const proxy = createRunnerProxy({ hubUrl: hub.server.url.toString(), leaseFile, projectId: 'a', port: 0 })
    cleanup.push(proxy.close)
    const client = connect(new URL('/cli', proxy.server.url).toString(), {
        transports: ['websocket'], autoConnect: false,
        auth: { token: 'evolved-local', ...auth },
    })
    cleanup.push(() => { client.disconnect() })
    return { state, client, get hub() { return hub }, async restart(beforeRestart?: () => void | Promise<void>) {
        const port = hub.server.port!
        // A real Hub outage loses the transport, without an explicit namespace
        // disconnect packet (which is how capability expiry is signalled).
        for (const socket of hub.namespace.sockets.values()) socket.conn.close()
        void hub.close()
        await beforeRestart?.()
        hub = startHub(port)
    } }
}

for (const reason of ['hub restart', 'capability renewal'] as const) test(`RPC registrations recover after ${reason} without reconnecting the CLI or replaying side effects`, async () => {
    const fixture = rpcFixture(), { client, state } = fixture
    const method = 'machine-a:read-state', removed = 'machine-a:removed'
    let connects = 0, disconnects = 0
    // Native RpcHandlerManager re-registers only on downstream connect.
    client.on('connect', () => { connects++; client.emit('rpc-register', { method }); client.emit('rpc-register', { method: removed }) })
    client.on('disconnect', () => { disconnects++ })
    client.on('rpc-request', (request: { method: string }, ack: (value: unknown) => void) => ack({ method: request.method, readOnly: true }))
    client.connect()
    await eventually(() => fixture.hub.lookup(removed) !== null, 'initial RPC registrations missing')
    client.emit('rpc-unregister', { method: removed })
    await eventually(() => fixture.hub.lookup(removed) === null, 'RPC unregister missing')
    expect(fixture.hub.registrations.filter(value => value === method)).toHaveLength(1)
    expect(await client.timeout(5000).emitWithAck('effect', 'acknowledged once')).toBe('acknowledged once')
    const previousSocketId = fixture.hub.lookup(method)!
    if (reason === 'hub restart') await fixture.restart()
    else fixture.hub.namespace.sockets.get(previousSocketId)!.disconnect(true)
    await eventually(() => {
        const id = fixture.hub.lookup(method)
        return id !== null && id !== previousSocketId
    }, `RPC registration was not restored after ${reason}`)
    expect(fixture.hub.lookup(removed)).toBeNull()
    const active = fixture.hub.namespace.sockets.get(fixture.hub.lookup(method)!)!
    expect(await active.timeout(5000).emitWithAck('rpc-request', { method })).toEqual({ method, readOnly: true })
    expect(Buffer.from(await client.timeout(5000).emitWithAck('echo', Buffer.from([0, 1, 254, 255])))).toEqual(Buffer.from([0, 1, 254, 255]))
    expect(state.effects).toBe(1)
    expect(connects).toBe(1)
    expect(disconnects).toBe(0)
    expect(state.leaseCalls).toBe(reason === 'hub restart' ? 1 : 2)
    expect(fixture.hub.registrations.filter(value => value === method)).toHaveLength(reason === 'hub restart' ? 1 : 2)
}, 12_000)

test('only the final RPC registration state is restored before queued events', async () => {
    const fixture = rpcFixture(), { client } = fixture
    const oldMethod = 'machine-a:old', newMethod = 'machine-a:new', transient = 'machine-a:transient'
    client.on('connect', () => client.emit('rpc-register', { method: oldMethod }))
    client.connect()
    await eventually(() => fixture.hub.lookup(oldMethod) !== null, 'initial registration missing')
    let queued: Promise<unknown> | undefined
    await fixture.restart(async () => {
        await Bun.sleep(30)
        client.emit('rpc-unregister', { method: oldMethod })
        client.emit('rpc-register', { method: transient })
        client.emit('rpc-unregister', { method: transient })
        client.emit('rpc-register', { method: newMethod, ignored: 'do not retain' })
        client.emit('rpc-register', { method: newMethod })
        queued = client.timeout(5000).emitWithAck('observe-registry', newMethod)
        await Bun.sleep(30)
    })
    expect(await queued).toBe(true)
    expect(fixture.hub.registrations).toEqual([newMethod])
    expect(fixture.hub.registrationPayloads).toEqual([[{ method: newMethod }]])
    expect(fixture.hub.lookup(oldMethod)).toBeNull()
    expect(fixture.hub.lookup(transient)).toBeNull()
}, 10_000)

test('a delayed old Hub acknowledgement cannot satisfy a new Hub RPC with the same packet ID', async () => {
    const fixture = rpcFixture(), { client } = fixture
    const method = 'machine-a:delayed'
    const callbacks: Array<(value: string) => void> = []
    client.on('connect', () => client.emit('rpc-register', { method }))
    client.on('rpc-request', (_request: unknown, ack: (value: string) => void) => { callbacks.push(ack) })
    client.connect()
    await eventually(() => fixture.hub.lookup(method) !== null, 'initial registration missing')
    const oldSocket = fixture.hub.namespace.sockets.get(fixture.hub.lookup(method)!)!
    // Both fresh Hub namespaces allocate their first outgoing acknowledgement ID.
    oldSocket.emit('rpc-request', { method }, () => {})
    await eventually(() => callbacks.length === 1, 'old RPC missing')
    await fixture.restart()
    await eventually(() => fixture.hub.lookup(method) !== null, 'restored registration missing')
    const newSocket = fixture.hub.namespace.sockets.get(fixture.hub.lookup(method)!)!
    let result: unknown
    const newReply = newSocket.timeout(5000).emitWithAck('rpc-request', { method }).then(value => { result = value; return value })
    await eventually(() => callbacks.length === 2, 'new RPC missing')
    callbacks[0]!('obsolete response')
    await Bun.sleep(30)
    expect(result).toBeUndefined()
    callbacks[1]!('current response')
    expect(await newReply).toBe('current response')
}, 10_000)

test('RPC registrations validate scope, normalize payloads and bound retained state without disconnecting the CLI', async () => {
    const fixture = rpcFixture(), { client } = fixture
    const errors: unknown[] = []
    let disconnected = false
    client.on('error', error => { errors.push(error) })
    client.on('disconnect', () => { disconnected = true })
    client.connect()
    await eventually(() => client.connected, 'CLI did not connect')
    for (const payload of [null, [], { method: 1 }, { method: '' }, { method: 'other:read' }, { method: 'machine-a:' },
        { method: 'machine-a:line\nbreak' }, { method: `machine-a:${'ä'.repeat(252)}` }]) client.emit('rpc-register', payload)
    const first = 'machine-a:method-0'
    client.emit('rpc-register', { method: first, extra: { payload: Buffer.alloc(1024) } }, () => {})
    for (let index = 0; index < 256; index++) client.emit('rpc-register', { method: `machine-a:method-${index}` })
    client.emit('rpc-register', { method: 'machine-a:overflow' })
    // A normal event is an ordering barrier for registration controls.
    expect(await client.timeout(5000).emitWithAck('echo', 'barrier')).toBe('barrier')
    expect(errors).toHaveLength(9)
    expect(fixture.hub.lookup('machine-a:overflow')).toBeNull()
    expect(fixture.hub.registrationPayloads.every(args => args.length === 1 && Object.keys(args[0] as object).join(',') === 'method')).toBe(true)
    expect(disconnected).toBe(false)
    client.emit('rpc-unregister', { method: first })
    client.emit('rpc-register', { method: 'machine-a:replacement' })
    expect(await client.timeout(5000).emitWithAck('echo', 'barrier')).toBe('barrier')
    await fixture.restart()
    await eventually(() => fixture.hub.lookup('machine-a:replacement') !== null, 'replacement registration missing')
    expect(fixture.hub.registrations).toHaveLength(256)
    expect(new Set(fixture.hub.registrations).size).toBe(256)
    expect(fixture.hub.lookup(first)).toBeNull()
    expect(disconnected).toBe(false)
}, 10_000)

test('RPC registration aggregate byte budget is reclaimed by unregister', async () => {
    const fixture = rpcFixture(), { client } = fixture
    let errors = 0
    client.on('error', () => { errors++ })
    client.connect()
    await eventually(() => client.connected, 'CLI did not connect')
    const method = (index: number) => `machine-a:${String(index).padStart(3, '0')}:${'a'.repeat(498)}`
    expect(Buffer.byteLength(method(0))).toBe(512)
    for (let index = 0; index < 128; index++) client.emit('rpc-register', { method: method(index) })
    client.emit('rpc-register', { method: method(128) })
    expect(await client.timeout(5000).emitWithAck('echo', 'barrier')).toBe('barrier')
    expect(errors).toBe(1)
    expect(fixture.hub.lookup(method(128))).toBeNull()
    client.emit('rpc-unregister', { method: method(0) })
    client.emit('rpc-register', { method: method(128) })
    expect(await client.timeout(5000).emitWithAck('observe-registry', method(128))).toBe(true)
    expect(errors).toBe(1)
}, 10_000)

test('session-scoped registrations recover while the downstream session stays connected', async () => {
    const fixture = rpcFixture({ clientType: 'session-scoped', sessionId: 'session-a' }), { client } = fixture
    const method = 'session-a:terminal-open'
    let connects = 0
    client.on('connect', () => { connects++; client.emit('rpc-register', { method }) })
    client.connect()
    await eventually(() => fixture.hub.lookup(method) !== null, 'initial session registration missing')
    await fixture.restart()
    await eventually(() => fixture.hub.lookup(method) !== null, 'restored session registration missing')
    expect(fixture.hub.registrations).toEqual([method])
    expect(connects).toBe(1)
}, 10_000)

test('ambiguous or oversized handshake scopes cannot be used for cached registrations', async () => {
    for (const auth of [
        { clientType: 'unknown', machineId: 'machine-a' },
        { clientType: 'machine-scoped', machineId: '' },
        { clientType: 'machine-scoped', machineId: 'machine-a:other' },
        { clientType: 'machine-scoped', machineId: 'ä'.repeat(65) },
        { clientType: 'machine-scoped', machineId: 'machine-a\n' },
    ]) {
        const fixture = rpcFixture(auth), { client } = fixture
        let rejected = 0
        client.on('error', () => { rejected++ })
        client.connect()
        await eventually(() => client.connected, 'CLI did not connect')
        client.emit('rpc-register', { method: `${auth.machineId}:read` })
        expect(await client.timeout(5000).emitWithAck('echo', 'barrier')).toBe('barrier')
        expect(fixture.hub.registrations).toHaveLength(0)
        expect(rejected).toBe(1)
    }
})

test('capability renewal after lease revocation disconnects instead of replaying registrations', async () => {
    const fixture = rpcFixture(), { client, state } = fixture
    const method = 'machine-a:read'
    client.on('connect', () => client.emit('rpc-register', { method }))
    client.connect()
    await eventually(() => fixture.hub.lookup(method) !== null, 'initial registration missing')
    const socketId = fixture.hub.lookup(method)!
    state.revoked = true
    fixture.hub.namespace.sockets.get(socketId)!.disconnect(true)
    await eventually(() => !client.connected, 'revoked runner remained connected')
    expect(state.leaseCalls).toBe(2)
    expect(client.active).toBe(false)
    expect(fixture.hub.lookup(method)).toBeNull()
    expect(fixture.hub.registrations).toEqual([method])
})

test('proxy routes cannot expose account, vault, bootstrap or lease operations', () => {
    for (const path of ['/api/auth', '/api/evolved/auth/bootstrap', '/api/evolved/runner/token', '/api/evolved/projects/a/secrets', '/api/evolved/projects/a/capabilities']) expect(allowedProxyPath(path)).toBe(false)
    expect(allowedProxyPath('/api/evolved/projects/a/codegraph/impact')).toBe(true)
})
test('repository proxy routes admit only exact methods, IDs and query shapes', () => {
    const base = '/api/evolved/projects/a', job = '768237a3-3378-4384-aaaf-eed31ae931e9'
    for (const query of ['', '?workspace=0', '?workspace=1']) expect(allowedProxyPath(`${base}/repositories`, 'GET', query)).toBe(true)
    expect(allowedProxyPath(`${base}/repositories/42/sync`, 'POST')).toBe(true)
    expect(allowedProxyPath(`${base}/repository-jobs/${job}`, 'GET')).toBe(true)
    expect(allowedProxyPath(`${base}/repositories/42/authorization`, 'GET', `?jobId=${job}`)).toBe(true)
    for (const [path, method, query] of [
        [`${base}/repositories`, 'POST', ''], [`${base}/repositories`, 'HEAD', ''],
        [`${base}/repositories`, 'GET', '?workspace=0&workspace=1'], [`${base}/repositories`, 'GET', '?workspace=2'],
        [`${base}/repositories`, 'GET', '?token=value'], [`${base}/repositories`, 'GET', '?%77orkspace=0'],
        [`${base}/repositories/42/sync`, 'GET', ''], [`${base}/repositories/42/sync`, 'POST', '?force=1'],
        [`${base}/repositories/042/sync`, 'POST', ''], [`${base}/repositories/owner%2Frepo/sync`, 'POST', ''],
        [`${base}/repositories/42/sync/extra`, 'POST', ''], [`${base}/repository-jobs/${job}`, 'POST', ''],
        [`${base}/repository-jobs/${job}`, 'GET', '?extra=1'], [`${base}/repository-jobs/not-a-uuid`, 'GET', ''],
        [`${base}/repositories/42/authorization`, 'GET', ''], [`${base}/repositories/42/authorization`, 'POST', `?jobId=${job}`],
        [`${base}/repositories/42/authorization`, 'GET', `?jobId=${job}&jobId=${job}`], [`${base}/repositories/42/authorization`, 'GET', `?jobId=${job}&project=b`],
        ['/api/evolved/projects/a%2fb/repositories', 'GET', ''], [`${base}/github`, 'GET', ''],
    ]) expect(allowedProxyPath(path, method, query)).toBe(false)
})
test('project MCP proxy permits only agent discovery and calls, never browser configuration or arbitrary tool paths', () => {
    const base = '/api/evolved/projects/a/mcp', id = '768237a3-3378-4384-aaaf-eed31ae931e9'
    expect(allowedProxyPath(`${base}/servers`, 'GET')).toBe(true)
    expect(allowedProxyPath(`${base}/servers/${id}/tools`, 'GET')).toBe(true)
    expect(allowedProxyPath(`${base}/servers/${id}/call`, 'POST')).toBe(true)
    expect(allowedProxyPath(`${base}/servers/${id}/query`, 'POST')).toBe(true)
    for (const [path, method, query] of [
        [base, 'GET', ''], [base, 'POST', ''], [`${base}/${id}`, 'PUT', ''], [`${base}/${id}`, 'DELETE', ''],
        [`${base}/${id}/discover`, 'POST', ''], [`${base}/servers`, 'POST', ''], [`${base}/servers`, 'HEAD', ''],
        [`${base}/servers/${id}/tools`, 'POST', ''], [`${base}/servers/${id}/call`, 'GET', ''],
        [`${base}/servers/${id}/query`, 'GET', ''], [`${base}/servers/${id}/query`, 'POST', '?readOnly=0'],
        [`${base}/servers/${id}/call`, 'POST', '?projectId=b'], [`${base}/servers`, 'GET', '?includeDisabled=true'],
        [`${base}/servers/${id}/tools`, 'GET', '?token=secret'], [`${base}/servers/${id}/call/extra`, 'POST', ''],
        [`${base}/servers/invalid-id/call`, 'POST', ''], [`${base}/servers/${id}%2fcall`, 'POST', ''],
        [`${base}/servers/${id}/tool-name`, 'POST', ''], ['/api/evolved/projects/a%2fb/mcp/servers', 'GET', ''],
    ]) expect(allowedProxyPath(path, method, query)).toBe(false)
})

test('Codegraph proxy grants only actual GET reader routes and never reindex or other mutations', () => {
    const base = '/api/evolved/projects/a/codegraph'
    for (const operation of ['status', 'search', 'graph', 'node', 'impact', 'affected']) {
        expect(allowedProxyPath(`${base}/${operation}`, 'GET', '?q=example')).toBe(true)
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) expect(allowedProxyPath(`${base}/${operation}`, method)).toBe(false)
    }
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect(allowedProxyPath(`${base}/reindex`, method)).toBe(false)
        expect(allowedProxyPath(`${base}/unknown`, method)).toBe(false)
        expect(allowedProxyPath(`${base}/status/extra`, method)).toBe(false)
        expect(allowedProxyPath('/api/evolved/projects/a%2fb/codegraph/status', method)).toBe(false)
    }
})

test('MCP proxy retains exact project, current upstream denials and tool results without credentials or automatic retries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-mcp-proxy-')), leaseFile = join(directory, 'lease')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(leaseFile, 'synthetic-lease', { mode: 0o600 })
    const forwarded: Array<{ path: string; method: string; authorization: string | null; cookie: string | null; key: string | null; body: unknown }> = []
    let enabled = true
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/api/evolved/runner/token') return Response.json({ token: 'x'.repeat(43), projectId: 'a', expiresAt: Date.now() + 900_000 })
        forwarded.push({ path, method: request.method, authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie'), key: request.headers.get('x-api-key'), body: request.method === 'POST' ? await request.json() : undefined })
        return enabled ? Response.json({ content: [{ type: 'text', text: 'Tool output' }], structuredContent: { count: 1 }, isError: true })
            : Response.json({ error: 'Disabled', code: 'mcp_disabled' }, { status: 403 })
    } })
    cleanup.push(() => hub.stop(true))
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'a', port: 0 })
    cleanup.push(proxy.close)
    const id = '768237a3-3378-4384-aaaf-eed31ae931e9', path = `/api/evolved/projects/a/mcp/servers/${id}/call`
    const body = { toolName: 'docs/query.v2', arguments: { query: 'public docs' }, version: 2, catalogRevision: 'a'.repeat(64) }
    const response = await fetch(new URL(path, proxy.server.url), { method: 'POST', headers: { authorization: 'Bearer caller-forgery', cookie: 'browser-session=forgery', 'x-api-key': 'must-not-forward', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ content: [{ type: 'text', text: 'Tool output' }], structuredContent: { count: 1 }, isError: true })
    expect(forwarded).toEqual([{ path, method: 'POST', authorization: `Bearer ${'x'.repeat(43)}`, cookie: null, key: null, body }])
    expect((await fetch(new URL('/api/evolved/projects/b/mcp/servers', proxy.server.url))).status).toBe(403)
    expect((await fetch(new URL(`/api/evolved/projects/a/mcp/${id}/discover`, proxy.server.url), { method: 'POST', body: '{}' })).status).toBe(403)
    expect(forwarded).toHaveLength(1)
    enabled = false
    const denied = await fetch(new URL(path, proxy.server.url), { method: 'POST', body: JSON.stringify(body) })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Disabled', code: 'mcp_disabled' })
    expect(forwarded).toHaveLength(2)
})

test('repository sync renews a short-lived cached capability before forwarding the job', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-repository-renew-')), leaseFile = join(directory, 'lease')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(leaseFile, 'synthetic-lease', { mode: 0o600 })
    let exchanges = 0
    const forwarded: string[] = []
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        if (new URL(request.url).pathname === '/api/evolved/runner/token') {
            exchanges++
            return Response.json({ token: (exchanges === 1 ? 'x' : 'y').repeat(43), projectId: 'a', expiresAt: Date.now() + (exchanges === 1 ? 120_000 : 900_000) })
        }
        forwarded.push(request.headers.get('authorization') ?? '')
        return Response.json({ ok: true })
    } })
    cleanup.push(() => hub.stop(true))
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'a', port: 0 })
    cleanup.push(proxy.close)
    expect((await fetch(new URL('/api/evolved/projects/a/repositories?workspace=0', proxy.server.url))).status).toBe(200)
    expect(exchanges).toBe(1)
    expect((await fetch(new URL('/api/evolved/projects/a/repositories/42/sync', proxy.server.url), { method: 'POST', body: '{}' })).status).toBe(200)
    expect(exchanges).toBe(2)
    expect(forwarded).toEqual([`Bearer ${'x'.repeat(43)}`, `Bearer ${'y'.repeat(43)}`])
})
test('repository requests retain project isolation, broker credentials and exact query forwarding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-repository-proxy-')), leaseFile = join(directory, 'lease')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(leaseFile, 'synthetic-lease', { mode: 0o600 })
    const forwarded: Array<{ path: string; method: string; authorization: string | null; cookie: string | null; body: string }> = []
    let revoked = false
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/api/evolved/runner/token') return Response.json({ token: 'x'.repeat(43), projectId: 'a', expiresAt: Date.now() + 900_000 })
        forwarded.push({ path: url.pathname + url.search, method: request.method, authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie'), body: await request.text() })
        return revoked ? Response.json({ code: 'revoked' }, { status: 403 }) : Response.json({ repositories: [{ id: '42', fullName: 'owner/repo' }] })
    } })
    cleanup.push(() => hub.stop(true))
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'a', port: 0 })
    cleanup.push(proxy.close)
    const base = '/api/evolved/projects/a', job = '768237a3-3378-4384-aaaf-eed31ae931e9'
    const response = await fetch(new URL(`${base}/repositories?workspace=0`, proxy.server.url), { headers: { authorization: 'Bearer attacker', cookie: 'session=bad' } })
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('x'.repeat(43))
    expect(forwarded[0]).toEqual({ path: `${base}/repositories?workspace=0`, method: 'GET', authorization: `Bearer ${'x'.repeat(43)}`, cookie: null, body: '' })
    const body = JSON.stringify({ action: 'clone', requestId: job })
    expect((await fetch(new URL(`${base}/repositories/42/sync`, proxy.server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(200)
    expect(forwarded[1].body).toBe(body)
    expect((await fetch(new URL(`${base}/repositories/42/authorization?jobId=${job}`, proxy.server.url))).status).toBe(200)
    expect((await fetch(new URL(`${base}/repository-jobs/${job}`, proxy.server.url))).status).toBe(200)
    for (const [path, options] of [
        ['/api/evolved/projects/b/repositories?workspace=0', {}],
        [`${base}/repositories?workspace=0&workspace=1`, {}],
        [`${base}/repositories/42/sync?force=1`, { method: 'POST' }],
        [`${base}/repositories`, { headers: { origin: 'https://browser.test' } }],
    ] as const) expect((await fetch(new URL(path, proxy.server.url), options)).status).toBe(403)
    expect(forwarded).toHaveLength(4)
    revoked = true
    expect((await fetch(new URL(`${base}/repositories?workspace=0`, proxy.server.url))).status).toBe(403)
})
test('queued socket budget counts binary and UTF-8 bytes and bounds nested objects', () => {
    expect(queuedPacketBytes([Buffer.alloc(1024), 'ä'])).toBeGreaterThanOrEqual(1026)
    expect(queuedPacketBytes({ bytes: new Uint8Array(9 * 1024 * 1024) })).toBeGreaterThan(8 * 1024 * 1024)
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(queuedPacketBytes(cyclic)).toBeGreaterThan(8 * 1024 * 1024)
})
for (const permanent of [false, true]) test(`proxy holds ${permanent ? 'permanent' : 'timed'} credentials, preserves socket acknowledgements and denies browser/cross-project access`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-proxy-test-')), leaseFile = join(directory, 'lease')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(leaseFile, 'synthetic-lease', { mode: 0o600 })
    const token = 'x'.repeat(43)
    const engine = new Engine({ path: '/socket.io/' }), io = new Server()
    io.bind(engine)
    io.of('/cli').use((socket, next) => socket.handshake.auth.token === token ? next() : next(new Error('bad token')))
    io.of('/cli').on('connection', socket => {
        socket.on('echo', (value, ack) => ack({ value, accepted: true }))
        socket.on('expire', () => socket.disconnect(true))
        socket.emit('from-hub', { ok: true })
    })
    const handler = engine.handler()
    let leaseCalls = 0, revoked = false
    const hub = Bun.serve({ ...handler, hostname: '127.0.0.1', port: 0, fetch: async (request, server) => {
        const path = new URL(request.url).pathname
        if (path.startsWith('/socket.io/')) return handler.fetch(request, server)
        if (path === '/api/evolved/runner/authority') {
            expect(request.headers.get('authorization')).toBe('Bearer synthetic-lease')
            return revoked ? Response.json({ error: 'revoked' }, { status: 401 }) : Response.json({ projectId: 'a', profile: 'restricted', rootPath: '/workspaces/a', expiresAt: permanent ? null : Date.now() + 900000 })
        }
        if (path === '/api/evolved/runner/token') {
            expect(request.headers.get('authorization')).toBe('Bearer synthetic-lease'); leaseCalls++
            return Response.json({ token, expiresAt: Date.now() + 900000, projectId: 'a' })
        }
        expect(request.headers.get('authorization')).toBe(`Bearer ${token}`)
        expect(request.headers.get('cookie')).toBeNull()
        return Response.json({ ok: true })
    } })
    cleanup.push(() => { io.close(); hub.stop(true) })
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'a', port: 0 })
    cleanup.push(proxy.close)
    const url = proxy.server.url
    expect((await fetch(new URL('/cli/sessions', url), { headers: { authorization: 'Bearer spoof', cookie: 'ambient=bad' } })).status).toBe(200)
    expect((await fetch(new URL('/cli/sessions', url), { headers: { origin: 'https://evil.test' } })).status).toBe(403)
    expect((await fetch(new URL('/api/evolved/projects/b/memory', url))).status).toBe(403)
    const socket = connect(new URL('/cli', url).toString(), { transports: ['websocket'], auth: { token: 'evolved-local', clientType: 'session-scoped', sessionId: 'one' } })
    cleanup.push(() => { socket.disconnect() })
    const reply = await new Promise((resolve, reject) => {
        socket.on('connect_error', reject)
        socket.on('connect', () => socket.timeout(5000).emit('echo', 'payload', (error: Error | null, value: unknown) => error ? reject(error) : resolve(value)))
    })
    expect(reply).toEqual({ value: 'payload', accepted: true })
    expect(leaseCalls).toBe(1)
    // A Hub disconnect on capability expiry must renew and reconnect without
    // exposing either credential to the downstream runner.
    const reconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('renewal timeout')), 5000)
        io.of('/cli').once('connection', () => { clearTimeout(timer); resolve() })
    })
    socket.emit('expire')
    await reconnected
    const afterRenewal = await new Promise((resolve, reject) => socket.timeout(5000).emit('echo', 'renewed', (error: Error | null, value: unknown) => error ? reject(error) : resolve(value)))
    expect(afterRenewal).toEqual({ value: 'renewed', accepted: true })
    expect(leaseCalls).toBe(2)
    const authority = await fetch(new URL('/evolved-runner-authority', url))
    expect(authority.status).toBe(200)
    const state = await authority.json() as Record<string, unknown>
    expect(state.projectId).toBe('a')
    if (permanent) expect(state.expiresAt).toBeNull()
    else expect(state.expiresAt).toBeGreaterThan(Date.now())
    expect(Object.keys(state).sort()).toEqual(['expiresAt', 'profile', 'projectId', 'rootPath'])
    expect((await fetch(new URL('/evolved-runner-authority', url), { headers: { origin: 'https://browser.test' } })).status).toBe(403)
    revoked = true
    expect((await fetch(new URL('/evolved-runner-authority', url))).status).toBe(403)
}, 10000)

test('a permanent lease never permits missing, permanent or overlong exchanged capabilities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-proxy-bounded-')), leaseFile = join(directory, 'lease')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(leaseFile, 'synthetic-permanent-lease', { mode: 0o600 })
    let expiresAt: unknown = null, forwarded = 0
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        if (new URL(request.url).pathname === '/api/evolved/runner/token') {
            return Response.json({ token: 'x'.repeat(43), projectId: 'a', expiresAt })
        }
        forwarded++
        return Response.json({ ok: true })
    } })
    cleanup.push(() => hub.stop(true))
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: 'a', port: 0 })
    cleanup.push(proxy.close)
    for (const invalid of [null, undefined, String(Date.now() + 60_000), Date.now() - 1, Date.now() + 990_000, Date.now() + 3600_000]) {
        expiresAt = invalid
        expect((await fetch(new URL('/cli/sessions', proxy.server.url))).status).toBe(503)
    }
    expect(forwarded).toBe(0)
    // A valid 15-minute capability from a Hub whose clock is five seconds ahead.
    expiresAt = Date.now() + 905_000
    expect((await fetch(new URL('/cli/sessions', proxy.server.url))).status).toBe(200)
    expect(forwarded).toBe(1)
})
