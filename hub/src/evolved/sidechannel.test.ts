import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { EvolvedError, EvolvedStore } from './store'
import { SESSION_COOKIE } from './security'
import { SidechannelService, createSidechannelRoutes, requestSidechannel, sidechannelConfig, type SidechannelConfig, type SidechannelFetch } from './sidechannel'
import type { SyncEngine } from '../sync/syncEngine'

const config: SidechannelConfig = { url: 'https://provider.example/completions', key: 'synthetic-test-key', model: 'explicit-test-model', dailyTokens: 40_000 }
const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
const answer = (tokens: number | null = 20, reply = 'Side reply') => Response.json({ choices: [{ message: { content: reply } }], ...(tokens === null ? {} : { usage: { total_tokens: tokens } }) })
function setup(fetcher: SidechannelFetch = (async () => answer()) as SidechannelFetch, cfg: SidechannelConfig | null = config) {
    let now = Date.parse('2026-10-15T23:59:59Z'), sessionExists = true
    const store = new EvolvedStore(':memory:', { now: () => now }); cleanup.push(() => store.close())
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,1,?)').run('alice', 'Alice', now)
    const team = store.createTeam('alice', 'Team'), project = store.createProject('alice', team.id, 'Project')
    const token = store.createSession('alice'), origin = 'https://evolved.test'
    const service = new SidechannelService(store, cfg, fetcher)
    const engine = { getSessionByNamespace: (id: string, ns: string) => sessionExists && id === 'session' && ns === project.namespace ? {} : undefined } as SyncEngine
    const app = new Hono().route('/api/evolved', createSidechannelRoutes(service, () => engine, origin))
    app.onError((e, c) => c.json({ error: e.message, code: e instanceof EvolvedError ? e.code : 'internal' }, e instanceof EvolvedError ? e.status as 400 : 500))
    const call = (body?: unknown, headers: Record<string, string> = {}) => app.request(`${origin}/api/evolved/projects/${project.id}/sidechannel`, {
        method: body === undefined ? 'GET' : 'POST', headers: { cookie: `${SESSION_COOKIE}=${token}`, origin, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const body = { sessionId: 'session', requestId: randomUUID(), text: 'explicit question only' }
    return { store, service, project, token, call, body, setNow: (v: number) => { now = v }, deleteSession: () => { sessionExists = false } }
}
test('default off; explicit text-only request exposes model/provider but no key or main transcript', async () => {
    const off = setup(undefined, null)
    expect((await off.call(off.body)).status).toBe(503)
    let sent: any
    const t = setup((async (_url, init) => { sent = JSON.parse(String(init?.body)); return answer() }) as SidechannelFetch)
    const status = await (await t.call()).json() as any
    expect(status.provider).toBe('https://provider.example')
    expect(JSON.stringify(status)).not.toContain(config.key)
    expect((await t.call(t.body)).status).toBe(200)
    expect(sent).toEqual({ model: config.model, messages: [{ role: 'user', content: t.body.text }], max_tokens: 1024, stream: false })
    expect(JSON.stringify(t.store.db.prepare('SELECT * FROM evolved_sidechannel_ops').all())).not.toContain(t.body.text)
    expect(t.service.status(t.project.id).remainingTokens).toBe(39_980)
})
test('rejects bearer, foreign origin, viewer, cross-session and malformed input before sending', async () => {
    let calls = 0
    const t = setup((async () => { calls++; return answer() }) as SidechannelFetch)
    expect((await t.call(t.body, { authorization: 'Bearer irrelevant' })).status).toBe(403)
    expect((await t.call(t.body, { origin: 'https://foreign.example' })).status).toBe(403)
    expect((await t.call(t.body, { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await t.call({ ...t.body, sessionId: 'foreign' })).status).toBe(403)
    for (const text of ['', ' ', 'x\0', '😀'.repeat(8001)]) expect((await t.call({ ...t.body, text })).status).toBe(400)
    t.store.db.prepare('UPDATE evolved_team_members SET role=? WHERE user_id=?').run('viewer', 'alice')
    t.store.db.prepare('UPDATE evolved_project_roles SET role=? WHERE user_id=?').run('viewer', 'alice')
    // Global admins still need project membership under the normal store policy.
    t.store.db.prepare('UPDATE evolved_users SET is_admin=0 WHERE id=?').run('alice')
    expect((await t.call(t.body)).status).toBe(403)
    expect(calls).toBe(0)
})
test('idempotency never re-sends completed, failed or pending requests', async () => {
    let calls = 0
    const t = setup((async () => { calls++; return answer() }) as SidechannelFetch)
    expect((await t.call(t.body)).status).toBe(200)
    expect((await t.call(t.body)).status).toBe(409)
    expect((await t.call({ ...t.body, text: 'different' })).status).toBe(409)
    expect(calls).toBe(1)
    const failed = setup((async () => { throw new Error('private provider detail') }) as SidechannelFetch)
    const response = await failed.call(failed.body)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private provider detail')
    expect((await failed.call(failed.body)).status).toBe(409)
    expect(failed.service.status(failed.project.id).remainingTokens).toBeLessThan(40_000)
})
test('concurrent reservations enforce busy/quota without duplicate calls', async () => {
    let release!: (value: Response) => void
    const t = setup((async () => new Promise<Response>(resolve => { release = resolve })) as SidechannelFetch)
    const pending = t.call(t.body)
    while (!release) await new Promise(resolve => setTimeout(resolve, 1))
    expect((await t.call({ ...t.body, requestId: randomUUID() })).status).toBe(429)
    release(answer(null)); expect((await pending).status).toBe(200)
    t.store.db.prepare('UPDATE evolved_sidechannel_ops SET charged=39999').run()
    expect((await t.call({ ...t.body, requestId: randomUUID() })).status).toBe(429)
})
test('settlement uses original UTC day and revocation discards answer after accounting', async () => {
    let release!: (value: Response) => void
    const t = setup((async () => new Promise<Response>(resolve => { release = resolve })) as SidechannelFetch)
    const pending = t.call(t.body)
    while (!release) await new Promise(resolve => setTimeout(resolve, 1))
    t.setNow(Date.parse('2026-10-16T00:00:01Z')); t.deleteSession()
    release(answer(75))
    expect((await pending).status).toBe(403)
    expect(t.store.db.prepare('SELECT utc_day,charged,state FROM evolved_sidechannel_ops').get()).toEqual({ utc_day: '2026-10-15', charged: 75, state: 'done' })
    expect(t.service.status(t.project.id).remainingTokens).toBe(40_000)
})
test('overrun counts actual tokens and persists circuit breaker across instances', async () => {
    const t = setup((async () => answer(50_000)) as SidechannelFetch)
    expect((await t.call(t.body)).status).toBe(200)
    expect(t.service.status(t.project.id).enabled).toBe(false)
    expect(t.service.status(t.project.id).remainingTokens).toBe(0)
    expect(new SidechannelService(t.store, config).status(t.project.id).enabled).toBe(false)
})
test('takes the larger usage receipt and invalid/extreme usage cannot bypass the breaker', async () => {
    for (const usage of [{ prompt_tokens: 1, completion_tokens: 1, total_tokens: 200_000_000 }, { total_tokens: Number.MAX_SAFE_INTEGER + 1 }, { total_tokens: -1 }]) {
        const t = setup((async () => Response.json({ choices: [{ message: { content: 'reply' } }], usage })) as SidechannelFetch)
        expect((await t.call(t.body)).status).toBe(200)
        expect(t.service.status(t.project.id).enabled).toBe(false)
        expect(t.service.status(t.project.id).remainingTokens).toBe(0)
    }
})
test('stale pending reservations survive restart but do not permanently block new requests', async () => {
    const t = setup()
    t.store.db.prepare("INSERT INTO evolved_sidechannel_ops VALUES(?,?,?,?,?,?,'pending',?,NULL)").run(t.project.id, 'alice', t.body.requestId, '2026-10-15', 2000, 2000, Date.parse('2026-10-15T23:00:00Z'))
    const restarted = new SidechannelService(t.store, config, (async () => answer()) as SidechannelFetch)
    await expect(restarted.ask(t.project.id, 'alice', t.body.requestId, t.body.text, async () => {})).rejects.toMatchObject({ code: 'indeterminate' })
    expect((await t.call({ ...t.body, requestId: randomUUID() })).status).toBe(200)
    expect(t.service.status(t.project.id).remainingTokens).toBe(37_980)
})
test('accepts 8000 Unicode codepoints and rejects oversized response before parsing', async () => {
    const t = setup()
    expect((await t.call({ ...t.body, text: '😀'.repeat(8000) })).status).toBe(200)
    await expect(requestSidechannel(config, 'hello', (async () => new Response('x'.repeat(65_537), { headers: { 'content-type': 'application/json' } })) as SidechannelFetch)).rejects.toMatchObject({ code: 'provider_error' })
})
test('text-only response rejects tool calls but accounts usage; missing usage retains reservation', async () => {
    const t = setup((async () => Response.json({ choices: [{ message: { content: 'ignored', tool_calls: [{ name: 'danger' }] } }], usage: { total_tokens: 55 } })) as SidechannelFetch)
    expect((await t.call(t.body)).status).toBe(502)
    expect(t.service.status(t.project.id).remainingTokens).toBe(39_945)
    const missing = setup((async () => answer(null)) as SidechannelFetch)
    expect((await missing.call(missing.body)).status).toBe(200)
    expect(missing.service.status(missing.project.id).remainingTokens).toBe(40_000 - Buffer.byteLength(missing.body.text) - 1280)
})
test('configuration refuses unsafe key permissions, symlinks and implicit adapters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'btw-config-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const key = join(dir, 'key'); writeFileSync(key, 'synthetic-key\n', { mode: 0o600 })
    const env = { EVOLVED_SIDECHANNEL_ADAPTER: 'openai-chat-completions-v1', EVOLVED_SIDECHANNEL_URL: config.url, EVOLVED_SIDECHANNEL_MODEL: config.model, EVOLVED_SIDECHANNEL_DAILY_TOKENS: '40000', EVOLVED_SIDECHANNEL_KEY_FILE: key }
    expect(sidechannelConfig(env)?.key).toBe('synthetic-key')
    expect(sidechannelConfig({ ...env, EVOLVED_SIDECHANNEL_ADAPTER: '' })).toBeNull()
    expect(sidechannelConfig({ ...env, EVOLVED_SIDECHANNEL_URL: 'http://provider.example' })).toBeNull()
    symlinkSync(key, join(dir, 'link')); expect(sidechannelConfig({ ...env, EVOLVED_SIDECHANNEL_KEY_FILE: join(dir, 'link') })).toBeNull()
    chmodSync(key, 0o644); expect(sidechannelConfig(env)).toBeNull()
})
