import { createServer } from 'node:http'
import { BlockList, connect, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const reserved = new BlockList()
for (const [address, prefix] of [['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]] as const) reserved.addSubnet(address, prefix, 'ipv4')
// Protocol assignments (including Teredo), documentation, 6to4 and future
// documentation space are not ordinary public service destinations.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) reserved.addSubnet(address, prefix, 'ipv6')
export function publicAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number)
        return !reserved.check(address, 'ipv4') && !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)))
    }
    // Global unicast only. Denies mapped IPv4, ULA, loopback, link-local and multicast.
    return isIP(address) === 6 && /^[23][a-f0-9]{3}:/i.test(address) && !reserved.check(address, 'ipv6')
}
export function connectTarget(target: string, allowedHosts: Set<string>): string | null {
    const match = /^([a-z0-9.-]+):443$/i.exec(target)
    const host = match?.[1].toLowerCase()
    // This proxy serves internal Git requests and legacy HTTPS clients. Runners
    // have their own direct Internet connection; this is not their network policy.
    return host && !isIP(host) && (!allowedHosts.size || allowedHosts.has(host)) ? host : null
}
export function createModelEgress(hosts: string[], port = 3128, host = '127.0.0.1') {
    const allowed = new Set(hosts.map(value => value.trim().toLowerCase()).filter(Boolean))
    let count = 0
    const server = createServer((_req, res) => { res.writeHead(405); res.end('HTTPS CONNECT only') })
    server.on('connect', async (request, client, head) => {
        const hostname = connectTarget(request.url ?? '', allowed)
        if (!hostname || count >= 64) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
        count++
        let released = false
        const release = () => { if (!released) { released = true; count-- } }
        client.on('close', release); client.on('error', () => client.destroy())
        const socket = client as import('node:net').Socket
        socket.setTimeout(120_000, () => client.destroy())
        try {
            const addresses = await lookup(hostname, { all: true })
            if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw new Error('Nonpublic address')
            if (client.destroyed) return
            // Connect to the verified IP, not a second DNS resolution (rebinding).
            const destination = addresses.find(value => value.family === 4) ?? addresses[0]
            const upstream = connect({ host: destination.address, port: 443 })
            upstream.setTimeout(120_000, () => upstream.destroy())
            upstream.once('connect', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                if (head.length) upstream.write(head)
                client.pipe(upstream); upstream.pipe(client)
            })
            upstream.on('error', () => client.destroy())
            upstream.on('close', () => client.destroy())
            client.on('close', () => upstream.destroy())
        } catch { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') }
    })
    server.listen(port, host)
    return server
}
if (import.meta.main) {
    const hosts = (process.env.EVOLVED_EGRESS_HOSTS ?? '').split(',')
    createModelEgress(hosts, Number(process.env.EVOLVED_EGRESS_PORT ?? 3128), process.env.EVOLVED_EGRESS_HOST ?? '127.0.0.1')
}
