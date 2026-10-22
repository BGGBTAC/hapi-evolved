import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowedGatewayPath, createRunnerProxy, type PeerRole } from './server'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const project = '11111111-1111-4111-8111-111111111111'

function setup(roles: Partial<Record<PeerRole, string[]>>) {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-proxy-peers-')), leaseFile = join(directory, 'lease')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(leaseFile, 'synthetic-lease', { mode: 0o600 })
    const seen: Array<{ path: string; authorization: string | null; body: string }> = []
    const hub = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/api/evolved/runner/token') return Response.json({ token: 'x'.repeat(43), projectId: project, expiresAt: Date.now() + 900_000 })
        seen.push({ path, authorization: request.headers.get('authorization'), body: await request.text() })
        return Response.json({ ok: true, path })
    } })
    const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        seen.push({ path: `gateway:${new URL(request.url).pathname}`, authorization: request.headers.get('authorization'), body: await request.text() })
        return Response.json({ relayed: true })
    } })
    cleanup.push(() => { hub.stop(true); gateway.stop(true) })
    const proxy = createRunnerProxy({ hubUrl: hub.url.toString(), leaseFile, projectId: project, port: 0, allowLoopbackPeer: false,
        peerLookup: async role => roles[role] ?? [], browserGatewayUrl: gateway.url.toString() })
    cleanup.push(() => proxy.close())
    const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${proxy.server.port}${path}`, init)
    return { request, seen }
}

test('only fixed browser authorize/report paths of the own project are gateway paths', () => {
    expect(allowedGatewayPath(`/api/evolved/projects/${project}/browser/authorize`, 'POST', '', project)).toBe(true)
    expect(allowedGatewayPath(`/api/evolved/projects/${project}/browser/report`, 'POST', '', project)).toBe(true)
    expect(allowedGatewayPath(`/api/evolved/projects/other/browser/authorize`, 'POST', '', project)).toBe(false)
    expect(allowedGatewayPath(`/api/evolved/projects/${project}/browser/authorize`, 'GET', '', project)).toBe(false)
    expect(allowedGatewayPath(`/api/evolved/projects/${project}/browser/authorize`, 'POST', '?x=1', project)).toBe(false)
    expect(allowedGatewayPath(`/api/evolved/projects/${project}/browser`, 'PUT', '', project)).toBe(false)
    expect(allowedGatewayPath(`/api/evolved/projects/${project}/memory`, 'POST', '', project)).toBe(false)
})

test('unknown peers are denied everything, including health and the browser relay', async () => {
    const f = setup({})
    for (const path of ['/health', '/api/evolved/memory/search?q=x', '/evolved-browser/status', '/evolved-runner-authority']) expect((await f.request(path)).status).toBe(403)
    expect(f.seen).toEqual([])
})

test('the gateway peer reaches only its two Hub routes with the proxy grant, never memory, Git, credentials or the relay', async () => {
    const f = setup({ 'browser-gateway': ['127.0.0.1'] })
    for (const [path, init] of [
        [`/api/evolved/projects/${project}/memory`, { method: 'POST', body: '{}' }],
        ['/api/evolved/memory/search?q=x', {}],
        [`/api/evolved/projects/${project}/agent-credentials`, {}],
        ['/evolved-runner-environment', { method: 'POST', body: '{}' }],
        ['/evolved-git/github.com/o/r.git/info/refs?service=git-upload-pack', {}],
        ['/evolved-browser/call', { method: 'POST', body: '{}' }],
        [`/api/evolved/projects/${project}/browser/agent`, {}],
        [`/api/evolved/projects/other/browser/authorize`, { method: 'POST', body: '{}' }],
        ['/socket.io/?EIO=4&transport=polling', {}],
    ] as const) expect((await f.request(path, init as RequestInit)).status).toBe(403)
    expect(f.seen).toEqual([])
    const response = await f.request(`/api/evolved/projects/${project}/browser/authorize`, { method: 'POST', body: '{"phase":"catalog"}', headers: { authorization: 'Bearer attacker' } })
    expect(response.status).toBe(200)
    expect(f.seen).toEqual([{ path: `/api/evolved/projects/${project}/browser/authorize`, authorization: `Bearer ${'x'.repeat(43)}`, body: '{"phase":"catalog"}' }])
})

test('the runner reaches the fixed browser relay but not the gateway-only Hub routes', async () => {
    const f = setup({ runner: ['127.0.0.1'] })
    expect((await f.request(`/api/evolved/projects/${project}/browser/authorize`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await f.request(`/api/evolved/projects/${project}/browser/report`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await f.request('/evolved-browser/call?target=http://hub:3006', { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await f.request('/evolved-browser/call', { method: 'GET' })).status).toBe(403)
    expect((await f.request('/evolved-browser/stop', { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await f.request('/evolved-browser/status')).status).toBe(403)
    expect((await f.request(`/api/evolved/projects/other/browser/agent`)).status).toBe(403)
    expect((await f.request(`/api/evolved/projects/${project}/browser/agent?x=1`)).status).toBe(403)
    expect((await f.request(`/api/evolved/projects/${project}/browser/agent`)).status).toBe(200)
    f.seen.length = 0
    const relayed = await f.request('/evolved-browser/call', { method: 'POST', body: '{"toolName":"camofox_list_tabs"}', headers: { authorization: 'Bearer agent-chosen', 'x-forwarded-host': 'evil' } })
    expect(relayed.status).toBe(200)
    expect(f.seen).toEqual([{ path: 'gateway:/evolved-browser/call', authorization: null, body: '{"toolName":"camofox_list_tabs"}' }])
    expect((await f.request('/evolved-browser/call', { method: 'POST', body: 'x'.repeat(81 * 1024) })).status).toBe(413)
    expect((await f.request('/health')).status).not.toBe(403)
})
