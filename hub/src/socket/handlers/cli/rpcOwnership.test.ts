import { afterEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Server as Engine } from '@socket.io/bun-engine'
import { Server } from 'socket.io'
import { io as connect, type Socket as ClientSocket } from 'socket.io-client'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { Store } from '../../../store'
import { RpcGateway, RpcTargetMissingError, RpcResponseInvalidatedError } from '../../../sync/rpcGateway'
import { RpcRegistry, type RpcTargetKind } from '../../rpcRegistry'
import { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import { registerCliHandlers } from './index'

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })

function fixture() {
    const store = new Store(':memory:'), registry = new RpcRegistry()
    const engine = new Engine({ path: '/socket.io/' }), io = new Server()
    const revoked = new Set<string>()
    io.bind(engine)
    io.of('/cli').use((socket, next) => {
        // Synthetic authenticated identities: the namespace is chosen by this
        // server mapping, never by the client's claimed machine/session ID.
        const namespace = ({ 'token-a': 'project-a', 'token-b': 'project-b', 'token-legacy': 'default' } as Record<string, string>)[socket.handshake.auth.token]
        if (!namespace) return next(new Error('unauthorized'))
        socket.data.namespace = namespace
        socket.data.isAuthorized = () => !revoked.has(socket.id)
        next()
    })
    io.of('/cli').on('connection', socket => registerCliHandlers(socket as CliSocketWithData, {
        io: io as SocketServer, store, rpcRegistry: registry,
        terminalRegistry: new TerminalRegistry({ idleTimeoutMs: 1000 }),
    }))
    const server = Bun.serve({ ...engine.handler(), hostname: '127.0.0.1', port: 0 })
    const clients: ClientSocket[] = []
    cleanups.push(() => { clients.forEach(client => client.disconnect()); io.close(); server.stop(true); store.close() })
    async function client(token: 'a' | 'b' | 'legacy', kind: RpcTargetKind, id: string) {
        const client = connect(new URL('/cli', server.url).toString(), {
            transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { token: `token-${token}`, clientType: `${kind}-scoped`, [kind === 'machine' ? 'machineId' : 'sessionId']: id },
        })
        clients.push(client)
        await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); client.connect() })
        return client
    }
    const barrier = async (client: ClientSocket) => { await client.timeout(3000).emitWithAck('ping') }
    async function register(client: ClientSocket, method: string) { client.emit('rpc-register', { method }); await barrier(client) }
    return { store, registry, io, revoked, client, barrier, register, gateway: new RpcGateway(io, registry),
        db: (store as unknown as { db: Database }).db }
}

function respond(client: ClientSocket, owner: string) {
    const calls: unknown[] = []
    client.on('rpc-request', (request: unknown, ack: (result: unknown) => void) => { calls.push(request); ack({ success: true, content: owner, entries: [{ name: owner, type: 'file' }] }) })
    return calls
}

test('real CLI handlers reject forged foreign targets and prefixes while preserving both namespaces and legacy clients', async () => {
    const f = fixture()
    for (const [id, ns] of [['a', 'project-a'], ['b', 'project-b'], ['legacy', 'default']]) f.store.machines.getOrCreateMachine(id!, null, null, ns!)
    const ownA = await f.client('a', 'machine', 'a'), ownB = await f.client('b', 'machine', 'b')
    const legacy = await f.client('legacy', 'machine', 'legacy'), forged = await f.client('a', 'machine', 'b')
    const aCalls = respond(ownA, 'a'), bCalls = respond(ownB, 'b'), forgedCalls = respond(forged, 'forged')
    respond(legacy, 'legacy')
    await f.register(ownA, `a:${RPC_METHODS.ListMachineDirectory}`)
    await f.register(ownB, `b:${RPC_METHODS.ListMachineDirectory}`)
    await f.register(legacy, `legacy:${RPC_METHODS.ListMachineDirectory}`)
    await f.register(forged, `b:${RPC_METHODS.ListMachineDirectory}`)
    await f.register(ownA, `b:${RPC_METHODS.ListMachineDirectory}`)
    expect(await f.gateway.listMachineDirectory('b', '/synthetic')).toMatchObject({ success: true, entries: [{ name: 'b' }] })
    expect(await f.gateway.listMachineDirectory('a', '/synthetic')).toMatchObject({ success: true, entries: [{ name: 'a' }] })
    expect(await f.gateway.listMachineDirectory('legacy', '/synthetic')).toMatchObject({ success: true, entries: [{ name: 'legacy' }] })
    expect(aCalls).toHaveLength(1); expect(bCalls).toHaveLength(1); expect(forgedCalls).toHaveLength(0)
})

test('machine and session IDs cannot collide in the RPC registry', async () => {
    const f = fixture(), session = f.store.sessions.getOrCreateSession('victim', null, null, 'project-b')
    f.store.machines.getOrCreateMachine(session.id, null, null, 'project-a')
    const owner = await f.client('b', 'session', session.id), machine = await f.client('a', 'machine', session.id)
    const method = `${session.id}:${RPC_METHODS.ReadFile}`
    respond(owner, 'session-owner'); const wrongCalls = respond(machine, 'machine-owner')
    await f.register(owner, method); await f.register(machine, method)
    expect(f.registry.getSocketIdForMethod(method, 'session')).toBe(owner.id!)
    expect(f.registry.getSocketIdForMethod(method, 'machine')).toBe(machine.id!)
    expect(await f.gateway.readSessionFile(session.id, '/synthetic')).toMatchObject({ success: true, content: 'session-owner' })
    expect(wrongCalls).toHaveLength(0)
})

for (const mutation of ['namespace', 'delete', 'revoke', 'throw'] as const) {
    test(`fresh ${mutation} check denies dispatch and does not deliver RPC parameters`, async () => {
        const f = fixture(), session = f.store.sessions.getOrCreateSession('fresh', null, null, 'project-a')
        const client = await f.client('a', 'session', session.id), calls = respond(client, 'a')
        await f.register(client, `${session.id}:${RPC_METHODS.ReadFile}`)
        if (mutation === 'namespace') f.db.query('UPDATE sessions SET namespace = ? WHERE id = ?').run('project-b', session.id)
        if (mutation === 'delete') f.store.sessions.deleteSession(session.id, 'project-a')
        if (mutation === 'revoke') f.revoked.add(client.id!)
        if (mutation === 'throw') f.io.of('/cli').sockets.get(client.id!)!.data.isAuthorized = () => { throw new Error('synthetic authority failure') }
        await expect(f.gateway.readSessionFile(session.id, '/never-deliver')).rejects.toBeInstanceOf(RpcTargetMissingError)
        expect(calls).toHaveLength(0)
    })
}

for (const mutation of ['namespace', 'delete', 'revoke', 'replace-registration'] as const) {
    test(`a ${mutation} during a real RPC discards the old acknowledgement`, async () => {
        const f = fixture(), session = f.store.sessions.getOrCreateSession('pending', null, null, 'project-a')
        const client = await f.client('a', 'session', session.id), method = `${session.id}:${RPC_METHODS.ReadFile}`
        await f.register(client, method)
        let acknowledge!: (response: unknown) => void
        const received = new Promise<void>(resolve => client.on('rpc-request', (_request: unknown, ack: typeof acknowledge) => { acknowledge = ack; resolve() }))
        const result = f.gateway.readSessionFile(session.id, '/synthetic').catch(error => error)
        await received
        if (mutation === 'namespace') f.db.query('UPDATE sessions SET namespace = ? WHERE id = ?').run('project-b', session.id)
        if (mutation === 'delete') f.store.sessions.deleteSession(session.id, 'project-a')
        if (mutation === 'revoke') f.revoked.add(client.id!)
        if (mutation === 'replace-registration') { client.emit('rpc-unregister', { method }); await f.register(client, method) }
        acknowledge({ success: true, content: 'obsolete synthetic reply' })
        const error = await result
        expect(error).toBeInstanceOf(RpcResponseInvalidatedError)
        expect(error).not.toBeInstanceOf(RpcTargetMissingError)
    })
}

test('old unregister and disconnect cannot erase a replacement registration', async () => {
    const f = fixture(); f.store.machines.getOrCreateMachine('a', null, null, 'project-a')
    const old = await f.client('a', 'machine', 'a'), current = await f.client('a', 'machine', 'a')
    const method = `a:${RPC_METHODS.ListMachineDirectory}`
    await f.register(old, method); await f.register(current, method); respond(current, 'current')
    old.emit('rpc-unregister', { method }); await f.barrier(old)
    expect(f.registry.getSocketIdForMethod(method, 'machine')).toBe(current.id!)
    const disconnected = new Promise<void>(resolve => f.io.of('/cli').sockets.get(old.id!)!.once('disconnect', () => resolve()))
    old.disconnect(); await disconnected
    expect(await f.gateway.listMachineDirectory('a', '/synthetic')).toMatchObject({ success: true, entries: [{ name: 'current' }] })
})

test('direct Hub connections have bounded registrations and reject invalid Unicode/control syntax', async () => {
    const f = fixture(); f.store.machines.getOrCreateMachine('a', null, null, 'project-a')
    const client = await f.client('a', 'machine', 'a')
    const invalid = ['a:bad name', 'a:bad\nname', 'a:bad\u200bname', `a:${'é'.repeat(256)}`, 'a:']
    for (const method of invalid) client.emit('rpc-register', { method })
    for (let i = 0; i <= 256; i++) client.emit('rpc-register', { method: `a:method-${i}` })
    await f.barrier(client)
    for (const method of invalid) expect(f.registry.getSocketIdForMethod(method, 'machine')).toBeNull()
    expect(f.registry.getSocketIdForMethod('a:method-255', 'machine')).toBe(client.id!)
    expect(f.registry.getSocketIdForMethod('a:method-256', 'machine')).toBeNull()
    client.emit('rpc-unregister', { method: 'a:method-0' }); await f.register(client, 'a:method-256')
    expect(f.registry.getSocketIdForMethod('a:method-256', 'machine')).toBe(client.id!)
})

test('composed method prefixes never grant authority for a different target ID containing a colon', async () => {
    const f = fixture()
    f.store.machines.getOrCreateMachine('a', null, null, 'project-a')
    f.store.machines.getOrCreateMachine('a:b', null, null, 'project-b')
    const attacker = await f.client('a', 'machine', 'a'), calls = respond(attacker, 'attacker')
    const method = `a:b:${RPC_METHODS.ListMachineDirectory}`
    await f.register(attacker, method)
    // Registration is for target a and a method named b:<method>. The gateway
    // must use the separately supplied target a:b, never infer it from a prefix.
    expect(f.registry.getRegistration(method, 'machine', 'a')).not.toBeNull()
    await expect(f.gateway.listMachineDirectory('a:b', '/never-deliver')).rejects.toBeInstanceOf(RpcTargetMissingError)
    expect(calls).toHaveLength(0)
})

test('duplicate declarative registration preserves a pending response from the same connection', async () => {
    const f = fixture(); f.store.machines.getOrCreateMachine('a', null, null, 'project-a')
    const client = await f.client('a', 'machine', 'a'), method = `a:${RPC_METHODS.ListMachineDirectory}`
    await f.register(client, method)
    let acknowledge!: (response: unknown) => void
    const received = new Promise<void>(resolve => client.on('rpc-request', (_request: unknown, ack: typeof acknowledge) => { acknowledge = ack; resolve() }))
    const result = f.gateway.listMachineDirectory('a', '/synthetic')
    await received
    await f.register(client, method)
    acknowledge({ success: true, entries: [] })
    expect(await result).toEqual({ success: true, entries: [] })
})
