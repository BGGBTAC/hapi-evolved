import { expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { parseGitRequest } from '../../hub/src/evolved/githubProtocol'
import { parseRunnerGitRequest, readRunnerGitBody } from './gitRequest'

const prefix = '/evolved-git/github.com/'
const url = `http://runner-proxy:3010${prefix}owner/repo.git/git-upload-pack`
const headers = { 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip', 'git-protocol': 'version=2' }
function request(body: RequestInit['body'], options: RequestInit = {}) {
    return new Request(url, { method: 'POST', headers, body, ...options, duplex: 'half' } as RequestInit)
}
const read = (req: Request, limits?: { wire?: number; expanded?: number }) => readRunnerGitBody(req, parseRunnerGitRequest(req, prefix), limits)

test('only the local upload-pack POST parser accepts exact gzip without consuming the request', async () => {
    const body = gzipSync('0000'), req = request(body, { headers: { ...headers, 'content-length': String(body.length) } })
    expect(parseRunnerGitRequest(req, prefix)).toEqual({ git: { owner: 'owner', name: 'repo', service: 'git-upload-pack', advertisement: false, protocol: 'version=2' }, gzip: true })
    expect(req.bodyUsed).toBe(false)
    expect(() => parseGitRequest(req, prefix)).toThrow('uncompressed')
    expect((await read(req)).toString()).toBe('0000')
})
test('compressed metadata validation rejects push, GET, ambiguous encoding, paths, queries and protocol before body decoding', () => {
    const cases: Array<[string, RequestInit]> = [
        [url.replace('git-upload-pack', 'git-receive-pack'), { method: 'POST', headers: { ...headers, 'content-type': 'application/x-git-receive-pack-request' } }],
        [`http://runner-proxy:3010${prefix}owner/repo.git/info/refs?service=git-upload-pack`, { method: 'GET', headers }],
        [url + '?extra=1', { method: 'POST', headers }],
        [url.replace('owner/repo', 'owner%2fother/repo'), { method: 'POST', headers }],
        [url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } }],
        [url, { method: 'POST', headers: { ...headers, 'git-protocol': 'version=1' } }],
        ...['br', 'identity', 'gzip, gzip', 'GZIP'].map(encoding => [url, { method: 'POST', headers: { ...headers, 'content-encoding': encoding } }] as [string, RequestInit]),
    ]
    for (const [target, options] of cases) {
        const req = new Request(target, options)
        expect(() => parseRunnerGitRequest(req, prefix)).toThrow()
        expect(req.bodyUsed).toBe(false)
    }
})
test('plain Git requests keep their existing bounded path and exact bytes', async () => {
    const req = request('0000', { headers: { 'content-type': headers['content-type'] } })
    expect(parseRunnerGitRequest(req, prefix).gzip).toBe(false)
    expect((await read(req, { wire: 4, expanded: 4 })).toString()).toBe('0000')
    await expect(read(request('12345', { headers: { 'content-type': headers['content-type'] } }), { wire: 4 })).rejects.toMatchObject({ code: 'git_body_too_large' })
})
test('streamed gzip decoding retains all bytes and validates the trailer before forwarding', async () => {
    const plain = Buffer.concat([Buffer.from('000ccommand=fetch\n'), randomBytes(200_000)]), compressed = gzipSync(plain)
    let position = 0
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (position >= compressed.length) { controller.close(); return }
        controller.enqueue(compressed.subarray(position, position + 997)); position += 997
    } })
    expect(await read(request(body), { wire: compressed.length, expanded: plain.length })).toEqual(plain)
})
test.each([Buffer.from('not-gzip'), gzipSync('0000').subarray(0, -8), Buffer.alloc(0)])('malformed or truncated gzip never returns a body (%#)', async body => {
    await expect(read(request(body))).rejects.toMatchObject({ code: 'git_body_invalid', status: 400 })
})
test('declared and streamed compressed bytes have independent limits', async () => {
    const compressed = gzipSync(randomBytes(4096))
    await expect(read(request(compressed, { headers: { ...headers, 'content-length': String(compressed.length) } }), { wire: 1000 })).rejects.toMatchObject({ code: 'git_body_too_large', status: 413 })
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(compressed.subarray(0, 900)); c.enqueue(compressed.subarray(900)); }, cancel() { cancelled = true } })
    await expect(read(request(body), { wire: 1000, expanded: 100_000 })).rejects.toMatchObject({ code: 'git_body_too_large', status: 413 })
    expect(cancelled).toBe(true)
})
test('expansion limit cancels a peer which leaves its compressed input open', async () => {
    const compressed = gzipSync(Buffer.alloc(512_000, 97))
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(compressed) }, cancel() { cancelled = true } })
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000)
    try {
        await expect(read(request(body, { signal: controller.signal }), { wire: 4096, expanded: 100_000 })).rejects.toMatchObject({ code: 'git_body_too_large', status: 413 })
        expect(cancelled).toBe(true)
    } finally { clearTimeout(timer); controller.abort() }
}, 2000)
test.each(['AbortError', 'TimeoutError'])('client abort and the existing transfer deadline stop pending gzip input (%s)', async name => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(gzipSync('0000').subarray(0, 5)) }, cancel() { cancelled = true } })
    const controller = new AbortController(), req = request(body, { signal: controller.signal })
    const pending = read(req), timer = setTimeout(() => controller.abort(new DOMException('Stopped', name)), 10)
    try { await expect(pending).rejects.toMatchObject({ name }); expect(cancelled).toBe(true) }
    finally { clearTimeout(timer); controller.abort() }
}, 2000)
test('already-aborted requests fail before decoding', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(read(request(gzipSync('0000'), { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
})
