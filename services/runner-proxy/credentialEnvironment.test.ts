import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunnerProxy, allowedProxyPath } from './server'

const cleanup: Array<() => void> = []
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f() })
function setup() {
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
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), projectId: 'project-a', leaseFile, port: 0, host: '127.0.0.1' })
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
