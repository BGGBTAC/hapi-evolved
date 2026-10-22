import { afterEach, expect, test } from 'bun:test'
import { createServer as createHttpServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { browserTargetHost, createBrowserEgress, type Resolver } from './browserEgress'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const PUBLIC = '93.184.215.14'

async function setup(resolver: Resolver) {
    const origin = createHttpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`origin:${req.headers.host}:${req.url}:${req.headers['proxy-authorization'] ?? ''}`) })
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
    const dialed: string[] = []
    const egress = createBrowserEgress({ port: 0, resolver, dial: (address, port) => { dialed.push(`${address}:${port}`); return connect({ host: '127.0.0.1', port: (origin.address() as AddressInfo).port }) } })
    await new Promise<void>(resolve => egress.listening ? resolve() : egress.once('listening', () => resolve()))
    cleanup.push(() => { egress.close(); origin.close() })
    return { port: (egress.address() as AddressInfo).port, dialed }
}
function raw(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => socket.write(payload))
        let data = ''
        socket.on('data', chunk => { data += chunk.toString('utf8'); if (data.includes('\r\n\r\n') && /^HTTP\/1\.1 (?:403|400|502)/.test(data)) socket.end() })
        socket.on('end', () => resolve(data)); socket.on('close', () => resolve(data)); socket.on('error', reject)
        setTimeout(() => { socket.destroy(); resolve(data) }, 1500)
    })
}
const publicResolver: Resolver = async () => [{ address: PUBLIC, family: 4 }]

test('host canonicalization refuses encoded, abbreviated, single-label and zoned forms', () => {
    for (const bad of ['2130706433', '0x7f000001', '0x7f.0x0.0x0.0x1', '127.1', '0177.0.0.1', '017700000001', 'localhost', 'foo.localhost', 'intranet', '[fe80::1%eth0]', '[::ffff:127.0.0.1', 'a..b', '-a.com', 'x.123'])
        expect(browserTargetHost(bad)).toBeNull()
    expect(browserTargetHost('Example.COM.')).toBe('example.com')
    expect(browserTargetHost('8.8.8.8')).toBe('8.8.8.8')
    expect(browserTargetHost('[2001:4860:4860::8888]')).toBe('2001:4860:4860::8888')
})

test('HTTP forward to all public sites on port 80 with the pinned address; proxy headers are stripped', async () => {
    const f = await setup(publicResolver)
    const reply = await raw(f.port, 'GET http://www.public.test/a?b=1 HTTP/1.1\r\nHost: www.public.test\r\nProxy-Authorization: secret\r\nConnection: close\r\n\r\n')
    expect(reply).toStartWith('HTTP/1.1 200')
    expect(reply).toContain('origin:www.public.test:/a?b=1:')
    expect(f.dialed).toEqual([`${PUBLIC}:80`])
})

test('private, loopback, link-local, metadata, mapped and mixed answers are denied for HTTP and CONNECT', async () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.17.0.2', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
        const f = await setup(async () => [{ address, family: address.includes(':') ? 6 : 4 }])
        expect(await raw(f.port, 'GET http://rebind.test/ HTTP/1.1\r\nHost: rebind.test\r\n\r\n')).toStartWith('HTTP/1.1 403')
        expect(await raw(f.port, 'CONNECT rebind.test:443 HTTP/1.1\r\nHost: rebind.test:443\r\n\r\n')).toStartWith('HTTP/1.1 403')
        expect(f.dialed).toEqual([])
    }
    const mixed = await setup(async () => [{ address: PUBLIC, family: 4 }, { address: '10.1.2.3', family: 4 }])
    expect(await raw(mixed.port, 'CONNECT mixed.test:443 HTTP/1.1\r\nHost: mixed.test:443\r\n\r\n')).toStartWith('HTTP/1.1 403')
    expect(mixed.dialed).toEqual([])
})

test('IP literals, encoded hosts and non-web ports are checked without DNS', async () => {
    let lookups = 0
    const f = await setup(async () => { lookups++; return [{ address: PUBLIC, family: 4 }] })
    for (const payload of [
        'GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nHost: x.test\r\n\r\n',
        'GET http://0x7f000001/ HTTP/1.1\r\nHost: x.test\r\n\r\n',
        'GET http://[::1]/ HTTP/1.1\r\nHost: x.test\r\n\r\n',
        'GET http://www.public.test:8080/ HTTP/1.1\r\nHost: x.test\r\n\r\n',
        'GET https://www.public.test/ HTTP/1.1\r\nHost: x.test\r\n\r\n',
        'GET http://user:pw@www.public.test/ HTTP/1.1\r\nHost: x.test\r\n\r\n',
        'CONNECT www.public.test:22 HTTP/1.1\r\nHost: www.public.test:22\r\n\r\n',
        'CONNECT 2130706433:443 HTTP/1.1\r\nHost: 2130706433:443\r\n\r\n',
        'CONNECT [::ffff:7f00:1]:443 HTTP/1.1\r\nHost: [::ffff:7f00:1]:443\r\n\r\n',
        'CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: 10.0.0.1:443\r\n\r\n',
    ]) expect(await raw(f.port, payload)).toMatch(/^HTTP\/1\.1 40[03]/)
    expect(lookups).toBe(0)
    expect(await raw(f.port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n')).toStartWith('HTTP/1.1 400')
    expect(f.dialed).toEqual([])
})

test('CONNECT on 443 and 80 tunnels to the single resolved public address (no second resolution)', async () => {
    let lookups = 0
    const f = await setup(async () => { lookups++; return lookups === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }] })
    const reply = await raw(f.port, 'CONNECT www.public.test:443 HTTP/1.1\r\nHost: www.public.test:443\r\n\r\nGET /tunnel HTTP/1.1\r\nHost: www.public.test\r\nConnection: close\r\n\r\n')
    expect(reply).toStartWith('HTTP/1.1 200 Connection Established')
    expect(reply).toContain('origin:www.public.test:/tunnel')
    expect(f.dialed).toEqual([`${PUBLIC}:443`])
    expect(lookups).toBe(1)
    // The next request resolves again and the rebound private answer is refused.
    expect(await raw(f.port, 'CONNECT www.public.test:80 HTTP/1.1\r\nHost: www.public.test:80\r\n\r\n')).toStartWith('HTTP/1.1 403')
})

test('an oversized but complete request head in a single chunk is refused before DNS or dial', async () => {
    let lookups = 0
    const f = await setup(async () => { lookups++; return [{ address: PUBLIC, family: 4 }] })
    const big = `GET http://www.public.test/ HTTP/1.1\r\nHost: www.public.test\r\nX-Fill: ${'a'.repeat(40 * 1024)}\r\n\r\n`
    expect(await raw(f.port, big)).toStartWith('HTTP/1.1 400')
    const bigConnect = `CONNECT www.public.test:443 HTTP/1.1\r\nHost: www.public.test:443\r\nX-Fill: ${'a'.repeat(40 * 1024)}\r\n\r\n`
    expect(await raw(f.port, bigConnect)).toStartWith('HTTP/1.1 400')
    expect(lookups).toBe(0)
    expect(f.dialed).toEqual([])
})
