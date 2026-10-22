import { connect, createServer as createNetServer, isIP, type Socket } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { publicAddress } from './egress'

/**
 * Egress for the optional project browser: every public Internet site over HTTP (80) and HTTPS/WSS
 * (CONNECT 443, CONNECT 80 for ws://). No site allowlist. Each request resolves its host once,
 * requires every address to be public unicast and connects to that verified address, so DNS
 * rebinding, redirects, subresources and page fetch() all meet the same rule. The browser has no
 * other network route. Nothing about destinations is logged.
 */
export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>
export type Dialer = (address: string, port: number) => Socket
const MAX_SOCKETS = 256
const IDLE_MS = 120_000

/** Canonical host or null. Encoded/abbreviated IPv4 (hex, octal, integer, short), zone IDs and single labels are refused. */
export function browserTargetHost(raw: string): string | null {
    let host = raw.toLowerCase()
    if (host.startsWith('[')) {
        if (!host.endsWith(']')) return null
        host = host.slice(1, -1)
        return isIP(host) === 6 && !host.includes('%') ? host : null
    }
    if (isIP(host) === 4) return /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(host) ? host : null
    if (host.endsWith('.')) host = host.slice(0, -1)
    const labels = host.split('.')
    if (host.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) return null
    if (labels.every(label => /^(?:0x[0-9a-f]*|[0-9]+)$/.test(label)) || /^[0-9]+$/.test(labels.at(-1)!)) return null
    if (labels.at(-1) === 'localhost') return null
    return host
}

export async function resolvePublic(host: string, resolver: Resolver): Promise<string> {
    if (isIP(host)) { if (!publicAddress(host)) throw new Error('Nonpublic address'); return host }
    const addresses = await resolver(host)
    if (!addresses.length || addresses.length > 64 || addresses.some(value => !publicAddress(value.address))) throw new Error('Nonpublic address')
    return (addresses.find(value => value.family === 4) ?? addresses[0]!).address
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'upgrade'])
const MAX_HEAD = 32 * 1024

/** One request per client connection. CONNECT tunnels; absolute-form HTTP is rewritten to origin-form with `Connection: close`. */
export function createBrowserEgress(options: { port?: number; host?: string; resolver?: Resolver; dial?: Dialer } = {}) {
    const resolver: Resolver = options.resolver ?? (host => dnsLookup(host, { all: true, verbatim: true }))
    const dial: Dialer = options.dial ?? ((address, port) => connect({ host: address, port }))
    let sockets = 0
    const server = createNetServer(client => {
        if (sockets >= MAX_SOCKETS) { client.destroy(); return }
        sockets++; let released = false
        client.once('close', () => { if (!released) { released = true; sockets-- } })
        client.setTimeout(IDLE_MS, () => client.destroy())
        client.on('error', () => client.destroy())
        const deny = (status: 400 | 403 | 502) => { client.end(`HTTP/1.1 ${status} ${status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`) }
        let buffered = Buffer.alloc(0)
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk])
            const end = buffered.indexOf('\r\n\r\n')
            if (end < 0) { if (buffered.length > MAX_HEAD) { client.off('data', onData); deny(400) } return }
            client.off('data', onData)
            // A complete but oversized head in one chunk is refused before parsing, DNS or dial.
            if (end > MAX_HEAD) { deny(400); return }
            client.pause()
            const head = buffered.subarray(0, end).toString('latin1'), rest = buffered.subarray(end + 4)
            void handle(head, rest).catch(() => deny(502))
        }
        client.on('data', onData)
        const tunnel = (address: string, port: number, first: Buffer | null, rest: Buffer) => {
            const upstream = dial(address, port)
            upstream.setTimeout(IDLE_MS, () => upstream.destroy())
            upstream.once('connect', () => {
                if (first) upstream.write(first); else client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                if (rest.length) upstream.write(rest)
                client.pipe(upstream); upstream.pipe(client); client.resume()
            })
            upstream.on('error', () => { if (!client.destroyed) deny(502) })
            upstream.on('close', () => client.destroy())
            client.on('close', () => upstream.destroy())
        }
        const handle = async (head: string, rest: Buffer) => {
            const [line, ...headerLines] = head.split('\r\n')
            const match = /^([A-Z]{3,10}) (\S+) HTTP\/1\.[01]$/.exec(line ?? '')
            if (!match) return deny(400)
            const [, method, target] = match
            if (method === 'CONNECT') {
                const authority = /^(\[[0-9a-f:.]+\]|[^:[\]/]+):(80|443)$/i.exec(target!)
                const host = authority ? browserTargetHost(authority[1]!) : null
                if (!authority || !host) return deny(403)
                let address: string
                try { address = await resolvePublic(host, resolver) } catch { return deny(403) }
                return tunnel(address, Number(authority[2]), null, rest)
            }
            let url: URL
            try { url = new URL(target!) } catch { return deny(400) }
            if (!/^https?:$/.test(url.protocol)) return deny(400)
            const host = browserTargetHost(url.hostname)
            if (url.protocol !== 'http:' || (url.port && url.port !== '80') || !host || url.username || url.password) return deny(403)
            let address: string
            try { address = await resolvePublic(host, resolver) } catch { return deny(403) }
            const headers = headerLines.filter(header => {
                const name = header.slice(0, header.indexOf(':')).trim().toLowerCase()
                return header.includes(':') && !HOP_HEADERS.has(name) && name !== 'host'
            })
            const first = Buffer.from([`${method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`, ...headers, 'Connection: close', '', ''].join('\r\n'), 'latin1')
            return tunnel(address, 80, first, rest)
        }
    })
    server.listen(options.port ?? 3128, options.host ?? '127.0.0.1')
    return server
}

if (import.meta.main) createBrowserEgress({ port: Number(process.env.EVOLVED_EGRESS_PORT ?? 3128), host: process.env.EVOLVED_EGRESS_HOST ?? '127.0.0.1' })
