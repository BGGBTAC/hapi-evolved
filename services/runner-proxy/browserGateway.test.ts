import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserRequest, createBrowserGateway } from './browserGateway'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const project = '11111111-1111-4111-8111-111111111111'
const KEY = 'K'.repeat(43)
const revision = 'a'.repeat(64)
const context = `hapi-${'b'.repeat(32)}`

async function setup(options: { echoKey?: boolean; peer?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'evolved-browser-gw-')), keyFile = join(dir, 'key')
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(keyFile, KEY, { mode: 0o600 })
    const state = { authorize: [] as Array<Record<string, unknown>>, reports: [] as Array<Record<string, unknown>>, upstream: [] as string[], deny: null as null | 'dispatch' | 'result' | 'all', enabled: true, probe: null as string | null, hold: null as Promise<void> | null }
    const tabs = new Map<string, string[]>()
    const browser = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const url = new URL(request.url)
        if (request.headers.get('authorization') !== `Bearer ${KEY}`) return Response.json({ error: 'Unauthorized' }, { status: 401 })
        const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await request.json() as Record<string, string>
        const user = url.searchParams.get('userId') ?? body.userId
        state.upstream.push(`${request.method} ${url.pathname}${url.search ? '?' : ''} ${user ?? ''}`)
        if (url.pathname === '/health') return Response.json({ ok: true, engine: 'camoufox' })
        if (url.pathname === '/tabs' && request.method === 'POST') { const id = crypto.randomUUID(); tabs.set(user!, [...(tabs.get(user!) ?? []), id]); return Response.json({ tabId: id, url: body.url ?? 'about:blank' }) }
        if (url.pathname === '/tabs') return Response.json({ running: true, tabs: (tabs.get(user!) ?? []).map(tabId => ({ tabId, url: 'https://public.test/', title: 'T' })) })
        if (url.pathname.startsWith('/sessions/') && request.method === 'DELETE') { tabs.delete(decodeURIComponent(url.pathname.slice(10))); return Response.json({ ok: true }) }
        const match = /^\/tabs\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname)
        if (!match || !(tabs.get(user!) ?? []).includes(match[1]!)) return Response.json({ error: 'Tab not found' }, { status: 404 })
        if (state.hold) await state.hold
        if (match[2] === 'screenshot') return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2]), { headers: { 'content-type': 'image/png' } })
        if (match[2] === 'snapshot') return Response.json({ snapshot: options.echoKey ? `leak ${KEY}` : '- heading "Synthetic" [e1]', screenshot: { data: 'AAAA' }, hasMore: false })
        if (match[2] === 'evaluate') return Response.json({ ok: true, result: 2 })
        if (!match[2] && request.method === 'DELETE') { tabs.set(user!, (tabs.get(user!) ?? []).filter(id => id !== match[1])); return Response.json({ ok: true }) }
        return Response.json({ ok: true, action: match[2] })
    } })
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const path = new URL(request.url).pathname, body = await request.json() as Record<string, unknown>
        if (path.endsWith('/report')) { state.reports.push(body); return Response.json({ enabled: state.enabled, probe: state.probe ? { id: state.probe } : null }) }
        state.authorize.push(body)
        if (state.deny === 'all' || state.deny === body.phase) return Response.json({ code: 'browser_disabled', error: 'disabled' }, { status: 403 })
        return Response.json({ projectId: project, contextId: context, sessionKey: 'hapi', version: 3, catalogRevision: revision, profile: 'workspace', tools: [{ name: 'camofox_create_tab', description: 'd', inputSchema: { type: 'object' }, readOnlyEligible: false }] })
    } })
    const gateway = createBrowserGateway({ projectId: project, keyFile, browserUrl: browser.url.toString(), proxyUrl: proxy.url.toString(), port: 0, reportIntervalMs: 3_600_000,
        allowLoopbackPeer: options.peer ?? true, peerLookup: async () => [] })
    cleanup.push(() => { gateway.close(); browser.stop(true); proxy.stop(true) })
    const call = async (toolName: string, args: Record<string, unknown> = {}, mode = 'call') => {
        const response = await fetch(`http://127.0.0.1:${gateway.server.port}/evolved-browser/${mode}`, { method: 'POST', body: JSON.stringify({ toolName, arguments: args, version: 3, catalogRevision: revision }) })
        return { status: response.status, body: await response.json() as any }
    }
    await gateway.initial
    return { gateway, state, tabs, call, port: gateway.server.port }
}

test('request table uses only fixed upstream routes and the Hub-derived identity', () => {
    expect(browserRequest('camofox_click', { tabId: 'a_b-1', ref: 'e1' }, context)).toEqual({ method: 'POST', path: '/tabs/a_b-1/click', body: { ref: 'e1', userId: context }, timeoutMs: 30_000 })
    expect(browserRequest('camofox_screenshot', { tabId: 't' }, context).path).toBe(`/tabs/t/screenshot?userId=${context}`)
    expect(browserRequest('camofox_create_tab', {}, context).body).toEqual({ userId: context, sessionKey: 'hapi' })
})

test('full synthetic flow: create, snapshot without embedded image, click, type, navigate, scroll, screenshot, evaluate, close', async () => {
    const f = await setup()
    const created = await f.call('camofox_create_tab', { url: 'https://public.test/' })
    expect(created.status).toBe(200)
    const tabId = JSON.parse(created.body.content[0].text).result.tabId
    const snapshot = await f.call('camofox_snapshot', { tabId }, 'query')
    expect(JSON.parse(snapshot.body.content[0].text).result).toEqual({ snapshot: '- heading "Synthetic" [e1]', hasMore: false })
    for (const [tool, args] of [['camofox_click', { tabId, ref: 'e1' }], ['camofox_type', { tabId, selector: '#q', text: 'hello', pressEnter: true }], ['camofox_navigate', { tabId, url: 'http://public.test/next' }], ['camofox_scroll', { tabId, direction: 'down', amount: 400 }], ['camofox_evaluate', { tabId, expression: '1+1' }]] as const)
        expect((await f.call(tool, args)).status).toBe(200)
    const shot = await f.call('camofox_screenshot', { tabId }, 'query')
    expect(shot.body.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect((await f.call('camofox_close_tab', { tabId })).status).toBe(200)
    expect((await f.call('camofox_snapshot', { tabId })).body.code).toBe('browser_tab_not_found')
    // Every authorized operation was checked twice (dispatch and result) with the caller's mode.
    const phases = f.state.authorize.filter(entry => entry.phase !== 'catalog').map(entry => `${entry.phase}:${entry.mode}:${entry.toolName}`)
    expect(phases.slice(0, 4)).toEqual(['dispatch:call:camofox_create_tab', 'result:call:camofox_create_tab', 'dispatch:query:camofox_snapshot', 'result:query:camofox_snapshot'])
    expect(f.state.upstream.filter(line => !line.startsWith('GET /health') && !line.includes('hapi-probe')).every(line => line.endsWith(context))).toBe(true)
})

test('caller cannot inject identity, unknown/foreign tab IDs or traversal; arguments are strictly validated', async () => {
    const f = await setup()
    f.tabs.set('hapi-foreign', ['foreign-tab'])
    const before = f.state.upstream.length
    expect((await f.call('camofox_snapshot', { tabId: 'foreign-tab' })).body.code).toBe('browser_tab_not_found')
    expect((await f.call('camofox_snapshot', { tabId: '../sessions/hapi-foreign' })).body.code).toBe('browser_invalid_arguments')
    expect((await f.call('camofox_list_tabs', { userId: 'hapi-foreign' })).body.code).toBe('browser_invalid_arguments')
    expect((await f.call('camofox_create_tab', { url: 'file:///etc/passwd' })).body.code).toBe('browser_invalid_arguments')
    expect((await f.call('camofox_create_tab', { url: 'https://user:pw@public.test/' })).body.code).toBe('browser_invalid_arguments')
    expect((await f.call('camofox_click', { tabId: 'x', ref: 'e1', selector: 'a' })).body.code).toBe('browser_invalid_arguments')
    const raw = await fetch(`http://127.0.0.1:${f.port}/evolved-browser/call`, { method: 'POST', body: JSON.stringify({ toolName: 'camofox_list_tabs', arguments: {}, version: 3, catalogRevision: revision, userId: 'x' }) })
    expect(raw.status).toBe(400)
    expect((await f.call('camofox_import_cookies', { cookiesPath: 'a' })).status).toBe(400)
    expect(f.state.upstream.length).toBe(before)
    // Listing re-learns only own tabs; a foreign tab never becomes addressable.
    await f.call('camofox_create_tab', {})
    const listed = JSON.parse((await f.call('camofox_list_tabs', {}, 'query')).body.content[0].text).result.tabs
    expect(listed).toHaveLength(1)
    expect((await f.call('camofox_snapshot', { tabId: 'foreign-tab' })).body.code).toBe('browser_tab_not_found')
})

test('revocation between dispatch and result withholds the result and closes the context; no retry', async () => {
    const f = await setup()
    const tabId = JSON.parse((await f.call('camofox_create_tab', {})).body.content[0].text).result.tabId
    f.state.deny = 'result'
    const withheld = await f.call('camofox_navigate', { tabId, url: 'https://public.test/' })
    expect(withheld.status).toBe(403)
    expect(withheld.body).toMatchObject({ code: 'browser_outcome_withheld', retryable: false })
    expect(f.state.upstream.filter(line => line.startsWith('POST /tabs/')).length).toBe(1)
    expect(f.state.upstream.at(-1)).toBe(`DELETE /sessions/${context} `)
    f.state.deny = 'dispatch'
    const before = f.state.upstream.length
    expect((await f.call('camofox_list_tabs', {})).status).toBe(403)
    expect(f.state.upstream.length).toBe(before)
})

test('timeouts after dispatch are unknown outcomes; key echoes are withheld; screenshots are bounded', async () => {
    const f = await setup({ echoKey: true })
    const tabId = JSON.parse((await f.call('camofox_create_tab', {})).body.content[0].text).result.tabId
    const echoed = await f.call('camofox_snapshot', { tabId })
    expect(echoed.body.code).toBe('browser_credential_echo')
    expect(JSON.stringify(echoed.body)).not.toContain(KEY)
    let release!: () => void
    f.state.hold = new Promise<void>(resolve => { release = resolve })
    const originalTimeout = AbortSignal.timeout
    AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 50)
    try {
        const unknown = await f.call('camofox_click', { tabId, ref: 'e1' })
        expect(unknown.body).toMatchObject({ code: 'browser_outcome_unknown', retryable: false })
    } finally { AbortSignal.timeout = originalTimeout; release() }
    expect(f.state.upstream.filter(line => line.startsWith('POST /tabs/') && line.includes('/click')).length).toBe(1)
})

test('status reports truthful health, startup engine probe and purges on disable', async () => {
    const f = await setup()
    expect(f.state.reports[0]).toMatchObject({ service: 'reachable', engine: 'ready', upstreamVersion: '1.18.1' })
    await f.gateway.report()
    // Later reports do not repeat the probe; the last verified result stays (gateway and Hub).
    expect(f.state.reports.at(-1)).toMatchObject({ service: 'reachable', engine: 'unknown' })
    expect(f.gateway.engineState()).toMatchObject({ state: 'ready' })
    expect(f.state.upstream.some(line => line.startsWith('POST /tabs') && line.includes('hapi-probe-'))).toBe(true)
    await f.call('camofox_create_tab', {})
    f.state.enabled = false
    await f.gateway.report()
    expect(f.state.upstream.at(-1)).toBe(`DELETE /sessions/${context} `)
    // Discovery is a Hub route now; the gateway serves only query/call.
    expect((await fetch(`http://127.0.0.1:${f.port}/evolved-browser/status`)).status).toBe(403)
    f.state.deny = 'all'
    expect((await f.call('camofox_list_tabs', {}, 'query')).status).toBe(403)
})

test('only the runner-proxy peer may call the gateway', async () => {
    const f = await setup({ peer: false })
    expect((await f.call('camofox_list_tabs')).status).toBe(403)
})
