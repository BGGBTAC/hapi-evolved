import { describe, expect, test } from 'bun:test'
import { fetchPublicGit, streamPublicGit, type PublicGitFetcher } from './publicGit'
import type { GitOperation } from '../../hub/src/evolved/githubProtocol'

const advertisement: GitOperation = { owner: 'public', name: 'dependency', service: 'git-upload-pack', advertisement: true, protocol: 'version=2' }
const pack = { ...advertisement, advertisement: false }
const signal = () => new AbortController().signal
const response = (operation = advertisement, body: string | ReadableStream<Uint8Array> | null = '0000') => new Response(body, { headers: {
    'content-type': `application/x-git-upload-pack-${operation.advertisement ? 'advertisement' : 'result'}`,
    'set-cookie': 'must-not-cross=1', 'www-authenticate': 'Basic must-not-cross', location: 'https://untrusted.example',
} })

describe('anonymous GitHub transport', () => {
    test('uses only fixed destinations and fresh noncredential headers', async () => {
        const calls: Array<{ target: string; options: RequestInit & { proxy?: string } }> = []
        const fetcher = (async (input: string | URL | Request, options: RequestInit = {}) => {
            calls.push({ target: String(input), options })
            return response(pack)
        }) as PublicGitFetcher
        const body = Buffer.from('000ccommand=fetch\n0000')
        const result = await fetchPublicGit(pack, body, signal(), fetcher)
        expect(await result!.text()).toBe('0000')
        expect(calls).toHaveLength(1)
        expect(calls[0].target).toBe('https://github.com/public/dependency.git/git-upload-pack')
        expect(calls[0].options).toMatchObject({ method: 'POST', redirect: 'manual', proxy: 'http://egress:3128', body })
        expect(Object.fromEntries(new Headers(calls[0].options.headers))).toEqual({ 'accept-encoding': 'identity',
            'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2', 'user-agent': 'HAPI-eVolved/0.1.0' })
        expect([...result!.headers.keys()].sort()).toEqual(['cache-control', 'content-type', 'x-content-type-options'])
    })
    test.each([401, 403, 404])('anonymous access denial requests private fallback (%s)', async status => {
        let cancelled = false
        const fetcher = (async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status })) as PublicGitFetcher
        expect(await fetchPublicGit(advertisement, Buffer.alloc(0), signal(), fetcher)).toBeNull()
        expect(cancelled).toBe(true)
    })
    test.each([429, 500, 502])('reports upstream failure without sending private credentials (%s)', async status => {
        const fetcher = (async () => new Response(null, { status })) as PublicGitFetcher
        await expect(fetchPublicGit(advertisement, Buffer.alloc(0), signal(), fetcher)).rejects.toThrow('Public Git transfer failed')
    })
    test('push never enters the anonymous transport', async () => {
        let calls = 0
        const fetcher = (async () => { calls++; return response() }) as PublicGitFetcher
        expect(await fetchPublicGit({ ...advertisement, service: 'git-receive-pack' }, Buffer.alloc(0), signal(), fetcher)).toBeNull()
        expect(calls).toBe(0)
    })
    test('follows renamed repositories only on the same GitHub host and operation', async () => {
        const visited: string[] = []
        const fetcher = (async (input: string | URL | Request, options: RequestInit = {}) => {
            visited.push(String(input))
            expect(options.method).toBe('POST')
            expect(Buffer.from(options.body as Uint8Array).toString()).toBe('0000')
            return visited.length === 1 ? new Response(null, { status: 307, headers: { location: '/new-owner/renamed.git/git-upload-pack' } }) : response(pack)
        }) as PublicGitFetcher
        await (await fetchPublicGit(pack, Buffer.from('0000'), signal(), fetcher))!.text()
        expect(visited).toEqual(['https://github.com/public/dependency.git/git-upload-pack', 'https://github.com/new-owner/renamed.git/git-upload-pack'])
    })
    test.each(['https://other.example/o/r.git/info/refs?service=git-upload-pack', 'http://github.com/o/r.git/info/refs?service=git-upload-pack',
        'https://user:password@github.com/o/r.git/info/refs?service=git-upload-pack', '/o/r.git/info/refs?service=git-receive-pack',
        '/o/r.git/info/refs?service=git-upload-pack#fragment', '/o/r.git/config', '/o/r%2fescape.git/info/refs?service=git-upload-pack'])('rejects unsafe redirects before the next request (%s)', async location => {
        let calls = 0
        const fetcher = (async () => { calls++; return new Response(null, { status: 302, headers: { location } }) }) as PublicGitFetcher
        await expect(fetchPublicGit(advertisement, Buffer.alloc(0), signal(), fetcher)).rejects.toThrow()
        expect(calls).toBe(1)
    })
    test('bounds redirect chains and rejects wrong response types', async () => {
        let calls = 0
        const redirect = (async () => { calls++; return new Response(null, { status: 301, headers: { location: '/o/r.git/info/refs?service=git-upload-pack' } }) }) as PublicGitFetcher
        await expect(fetchPublicGit(advertisement, Buffer.alloc(0), signal(), redirect)).rejects.toThrow('redirect denied')
        expect(calls).toBe(4)
        const html = (async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })) as PublicGitFetcher
        await expect(fetchPublicGit(advertisement, Buffer.alloc(0), signal(), html)).rejects.toThrow('Public Git transfer failed')
    })
    test('passes cancellation through to the caller', async () => {
        const controller = new AbortController()
        const pending = fetchPublicGit(advertisement, Buffer.alloc(0), controller.signal, (async (_input: unknown, init?: RequestInit) => {
            expect(init?.signal).toBe(controller.signal)
            return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
        }) as PublicGitFetcher)
        controller.abort()
        await expect(pending).rejects.toThrow('cancelled')
    })
})

describe('public pack streaming', () => {
    test('streams more than the private broker 512-MiB ceiling without buffering a whole pack', async () => {
        const chunk = new Uint8Array(1024 * 1024), controller = new AbortController()
        let sent = 0, finished = 0, received = 0
        const source = new ReadableStream<Uint8Array>({ pull(sink) { if (sent++ === 513) sink.close(); else sink.enqueue(chunk) } })
        const reader = streamPublicGit(response(pack, source), controller, () => { finished++ }).body!.getReader()
        for (;;) { const part = await reader.read(); if (part.done) break; received += part.value.length }
        expect(received).toBe(513 * 1024 * 1024)
        expect(controller.signal.aborted).toBe(false)
        expect(finished).toBe(1)
    })
    test('progress extends the idle deadline beyond a total duration limit', async () => {
        let interval: ReturnType<typeof setInterval> | undefined, sent = 0, finished = 0
        const source = new ReadableStream<Uint8Array>({ start(sink) { interval = setInterval(() => {
            if (sent++ === 10) { clearInterval(interval); sink.close() } else sink.enqueue(new Uint8Array([1]))
        }, 10) }, cancel() { clearInterval(interval) } })
        const controller = new AbortController()
        try {
            expect((await streamPublicGit(response(pack, source), controller, () => { finished++ }, 60).arrayBuffer()).byteLength).toBe(10)
            expect(controller.signal.aborted).toBe(false)
            expect(finished).toBe(1)
        } finally { clearInterval(interval); controller.abort() }
    })
    test('idle timeout and client cancellation release the transfer slot and cancel upstream', async () => {
        for (const clientCancel of [false, true]) {
            let cancelled = false, finished = 0
            const controller = new AbortController(), source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
            const reader = streamPublicGit(response(pack, source), controller, () => { finished++ }, 10).body!.getReader()
            if (clientCancel) await reader.cancel()
            else await expect(reader.read()).rejects.toThrow('timed out')
            await Bun.sleep(1)
            expect(cancelled).toBe(true)
            expect(finished).toBe(1)
        }
    })
})
