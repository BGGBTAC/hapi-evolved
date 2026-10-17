import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunnerProxy, allowedProxyPath } from './server'

const cleanup: Array<() => void> = []
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f() })
function setup(credentialRunnerLookup: () => Promise<readonly string[]> = async () => ['127.0.0.1']) {
    const dir = mkdtempSync(join(tmpdir(), 'credential-proxy-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const leaseFile = join(dir, 'lease'), lease = 'a'.repeat(43)
    writeFileSync(leaseFile, lease, { mode: 0o600 })
    const calls: Array<{ path: string; authorization: string | null; body: string }> = []
    let answer = () => Response.json({ projectId: 'project-a', revision: 'b'.repeat(64), environment: { PROJECT_SECRET_CANARY: 'synthetic-secret' } })
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body: await request.text() })
        return answer()
    } })
    cleanup.push(() => { hub.stop(true) })
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), projectId: 'project-a', leaseFile, port: 0, host: '127.0.0.1', credentialRunnerLookup })
    cleanup.push(proxy.close)
    const call = (path = '/evolved-runner-environment', init: RequestInit = {}) => fetch(new URL(path, proxy.server.url), { method: 'POST', body: '{}', ...init })
    return { calls, lease, call, answer: (fn: typeof answer) => { answer = fn } }
}
test('private delegation uses only the proxy lease and returns a project-bound, uncached bundle', async () => {
    const f = setup()
    const response = await f.call(undefined, { headers: { authorization: 'Bearer caller-controlled' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ projectId: 'project-a', revision: 'b'.repeat(64), environment: { PROJECT_SECRET_CANARY: 'synthetic-secret' } })
    expect(f.calls).toEqual([{ path: '/api/evolved/runner/environment', authorization: `Bearer ${f.lease}`, body: '{}' }])
})
test('browser, query, body and generic route bypasses never reach the Hub', async () => {
    const f = setup()
    for (const [path, init] of [
        ['/evolved-runner-environment', { headers: { origin: 'https://evil.example' } }],
        ['/evolved-runner-environment', { headers: { cookie: 'session=browser' } }],
        ['/evolved-runner-environment?projectId=foreign', {}],
        ['/evolved-runner-environment', { body: '{"projectId":"foreign"}' }],
        ['/evolved-runner-environment', { method: 'GET', body: undefined }],
        ['/api/evolved/runner/environment', {}],
        ['/api/evolved/projects/foreign/agent-credentials', { method: 'GET', body: undefined }],
    ] as Array<[string, RequestInit]>) expect((await f.call(path, init)).status).toBeGreaterThanOrEqual(400)
    expect(f.calls).toHaveLength(0)
    expect(allowedProxyPath('/api/evolved/projects/project-a/agent-credentials')).toBe(true)
    expect(allowedProxyPath('/api/evolved/projects/project-a/agent-credentials', 'POST')).toBe(false)
    expect(allowedProxyPath('/api/evolved/projects/project-a/secret-grants')).toBe(false)
})
test('denied, foreign and malformed credential responses cannot leak upstream diagnostics', async () => {
    const f = setup()
    for (const answer of [
        () => Response.json({ error: 'synthetic-secret' }, { status: 403 }),
        () => Response.json({ projectId: 'foreign', revision: 'b'.repeat(64), environment: { PROJECT_SECRET_CANARY: 'synthetic-secret' } }),
        () => Response.json({ projectId: 'project-a', revision: 'b'.repeat(64), environment: { NODE_OPTIONS: 'synthetic-secret' } }),
        () => new Response('synthetic-secret'.repeat(40_000)),
    ]) {
        f.answer(answer)
        const response = await f.call()
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain('synthetic-secret')
    }
})
test('admission contention remains retryable without forwarding upstream details', async () => {
    const f = setup()
    f.answer(() => new Response('synthetic-secret', { status: 429 }))
    const response = await f.call()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.text()).not.toContain('synthetic-secret')
})
test('a foreign socket peer cannot obtain project credentials by spoofing forwarding or authorization headers', async () => {
    // The actual loopback socket is 127.0.0.1; this project's runner is 127.0.0.2.
    let addresses = ['127.0.0.2']
    const f = setup(async () => addresses)
    const response = await f.call(undefined, { headers: { 'x-forwarded-for': '127.0.0.2', 'x-real-ip': '127.0.0.2', forwarded: 'for=127.0.0.2', authorization: 'Bearer caller-controlled' } })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('synthetic-secret')
    expect(f.calls).toHaveLength(0)
    addresses = ['127.0.0.1']
    expect((await f.call()).status).toBe(200)
})
test('the exact runner peer accepts IPv4-mapped IPv6 without trusting a foreign address', async () => {
    const f = setup(async () => ['::ffff:127.0.0.1'])
    expect((await f.call()).status).toBe(200)
    const foreign = setup(async () => ['::ffff:127.0.0.2'])
    expect((await foreign.call()).status).toBe(403)
    expect(foreign.calls).toHaveLength(0)
    expect(f.calls).toHaveLength(1)
})
test('missing or failed runner DNS denies delivery before reading credentials or contacting the Hub', async () => {
    for (const lookup of [async () => [] as string[], async () => { throw new Error('Synthetic DNS failure') }, async () => ['not-an-address'], async () => ['127.0.0.2']]) {
        const f = setup(lookup)
        const response = await f.call(undefined, { headers: { 'x-forwarded-for': '127.0.0.2' } })
        expect(response.status).toBe(403)
        expect(f.calls).toHaveLength(0)
    }
})
test('Hub redirects cannot forward the lease or disclose credential responses to another endpoint', async () => {
    let redirected = 0
    const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { redirected++; return new Response('unexpected') } })
    cleanup.push(() => { other.stop(true) })
    const f = setup()
    f.answer(() => new Response(null, { status: 307, headers: { location: other.url.toString() } }))
    expect((await f.call()).status).toBe(503)
    expect(redirected).toBe(0)
})
test('a stalled runner lookup is shared and fails closed within a bounded wait', async () => {
    let lookups = 0
    const f = setup(() => { lookups++; return new Promise(() => {}) })
    const replies = await Promise.all([f.call(), f.call()])
    expect(replies.map(response => response.status)).toEqual([403, 403])
    expect(lookups).toBe(1)
    expect(f.calls).toHaveLength(0)
})
