import { afterEach, expect, test } from 'bun:test'
import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type Socket } from 'socket.io'
import { io as connect } from 'socket.io-client'
import { installLiveAuthorization } from '../../hub/src/socket/server'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
for (const broadcast of [false, true]) test(`revocation blocks an immediate ${broadcast ? 'room broadcast' : 'direct packet'} before the idle sweep`, async () => {
    const engine = new Engine({ path: '/socket.io/' }), io = new Server()
    io.bind(engine)
    let valid = true, connected!: Socket
    const ns = io.of('/cli')
    ns.use((socket, next) => { installLiveAuthorization(socket, () => valid); next() })
    ns.on('connection', socket => { connected = socket; socket.join('private') })
    const handler = engine.handler()
    const server = Bun.serve({ ...handler, hostname: '127.0.0.1', port: 0, fetch: handler.fetch })
    cleanups.push(() => { io.close(); server.stop(true) })
    const client = connect(new URL('/cli', server.url).toString(), { transports: ['websocket'], reconnection: false })
    cleanups.push(() => { client.disconnect() })
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject) })
    const received: unknown[] = []
    client.on('private-data', value => received.push(value))
    const disconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connection was not revoked')), 1500)
        client.once('disconnect', () => { clearTimeout(timer); resolve() })
    })
    valid = false
    if (broadcast) ns.to('private').emit('private-data', 'must-not-arrive')
    else connected.emit('private-data', 'must-not-arrive')
    await disconnected
    expect(received).toEqual([])
})
