import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunnerProxy, allowedProxyPath, queuedPacketBytes } from './server'
import { Server as Engine } from '@socket.io/bun-engine'
import { Server } from 'socket.io'
import { io as connect } from 'socket.io-client'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
test('proxy routes cannot expose account, vault, bootstrap or lease operations', () => {
    for (const path of ['/api/auth', '/api/evolved/auth/bootstrap', '/api/evolved/runner/token', '/api/evolved/projects/a/secrets', '/api/evolved/projects/a/capabilities']) expect(allowedProxyPath(path)).toBe(false)
    expect(allowedProxyPath('/api/evolved/projects/a/codegraph/impact')).toBe(true)
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
