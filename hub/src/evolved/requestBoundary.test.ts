import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { EvolvedError, EvolvedStore } from './store'
import { createEvolvedRequestGuard } from './security'
import { createPeerRoutes } from './peers'
import { createScheduleRoutes, ScheduleService } from './schedules'
import { createGithubPrRunnerRoutes } from './githubPr'

const stores: EvolvedStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function setup(outerBoundary = true) {
    const store = new EvolvedStore(':memory:'); stores.push(store)
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('admin', 'Admin', 1, Date.now())
    const team = store.createTeam('admin', 'Team'), project = store.createProject('admin', team.id, 'Project')
    const cookie = store.createSession('admin'), origin = 'https://hapi.example.test'
    const app = new Hono()
    if (outerBoundary) {
        app.use('*', createEvolvedRequestGuard(origin))
        app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'Request body exceeds 1 MiB.', code: 'body_too_large' }, 413) }))
    }
    app.route('/api/evolved', createPeerRoutes(store, () => null))
    app.route('/api/evolved', createScheduleRoutes(new ScheduleService(store, () => null), () => null))
    app.route('/api/evolved', createGithubPrRunnerRoutes(store, () => null, '/unused-test-path'))
    app.onError((error, c) => c.json({ error: error.message }, error instanceof EvolvedError ? error.status as 400 : 500))
    return { store, project, cookie, origin, app }
}

test('outer Origin guard protects schedules and policy before body parsing, including ambient cookie plus Bearer', async () => {
    const t = setup()
    for (const path of [`/projects/${t.project.id}/schedules`, `/projects/${t.project.id}/peer-policy`]) {
        for (const origin of [undefined, 'https://untrusted.example.test']) {
            for (const authorization of [undefined, 'Bearer invalid']) {
                const response = await t.app.request(`/api/evolved${path}`, {
                    method: path.endsWith('peer-policy') ? 'PUT' : 'POST',
                    headers: { cookie: `__Host-hapi-evolved=${t.cookie}`, 'content-type': 'text/plain', ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) },
                    body: '{}'
                })
                expect(response.status).toBe(403)
                expect((await response.json() as { error: string }).error).toContain('origin')
            }
        }
    }
    expect(t.store.db.prepare('SELECT COUNT(*) AS n FROM evolved_schedules').get()).toEqual({ n: 0 })
    const accepted = await t.app.request(`/api/evolved/projects/${t.project.id}/peer-policy`, {
        method: 'PUT', headers: { cookie: `__Host-hapi-evolved=${t.cookie}`, origin: t.origin, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true })
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ enabled: true })
})

test('outer body limit rejects large declared payloads without consuming their streams', async () => {
    const t = setup()
    let reads = 0
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(1)); controller.close() } }, { highWaterMark: 0 })
    const request = new Request(`${t.origin}/api/evolved/peers/messages`, { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-length': String(10 * 1024 * 1024) }, body })
    expect((await t.app.request(request)).status).toBe(413)
    expect(reads).toBe(0)
})

test('module authentication rejects missing credentials before reading any payload', async () => {
    const t = setup(false)
    for (const [path, status] of [['/peers/messages', 401], [`/projects/${t.project.id}/schedules`, 401], ['/github-pr/link', 403]] as const) {
        let reads = 0
        const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.error(new Error('Request body must not be read')) } }, { highWaterMark: 0 })
        const request = new Request(`${t.origin}/api/evolved${path}`, { method: 'POST', body })
        expect((await t.app.request(request)).status).toBe(status)
        expect(reads).toBe(0)
    }
})

test('unauthenticated chunked payloads are rejected with bounded buffering', async () => {
    const t = setup()
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(256 * 1024)); if (chunks === 40) controller.close() } }, { highWaterMark: 0 })
    const request = new Request(`${t.origin}/api/evolved/peers/messages`, { method: 'POST', headers: { authorization: 'Bearer invalid' }, body })
    expect((await t.app.request(request)).status).toBe(401)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chunks).toBeLessThanOrEqual(5)
})
