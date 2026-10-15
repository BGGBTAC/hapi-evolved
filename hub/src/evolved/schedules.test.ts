import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { EvolvedError, EvolvedStore } from './store'
import { createScheduleRoutes, nextCronTime, ScheduleService } from './schedules'
import type { SyncEngine } from '../sync/syncEngine'

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })
function setup() {
    let now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const store = new EvolvedStore(':memory:', { now: () => now }); cleanups.push(() => store.close())
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('alice', 'Alice', 1, now)
    const team = store.createTeam('alice', 'Team'), project = store.createProject('alice', team.id, 'P')
    store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run('lease', 'Runner', 'hash', 'alice', project.id, '["runner:connect"]', '[]', 'restricted', now, now + 86400_000)
    const calls: unknown[] = [], target = { id: 'session', namespace: project.namespace, active: false, thinking: false, permissionMode: 'read-only', metadata: { flavor: 'codex' } }
    const engine = { getSessionByNamespace: (id: string, ns: string) => id === target.id && ns === project.namespace ? target : undefined,
        resumeSession: async (...args: unknown[]) => { calls.push({ resume: args }); target.active = true; return { type: 'success', sessionId: target.id } },
        sendMessage: async (...args: unknown[]) => { calls.push({ send: args }); target.thinking = true }
    } as unknown as SyncEngine
    const service = new ScheduleService(store, () => engine)
    const app = new Hono().route('/api/evolved', createScheduleRoutes(service, () => engine))
    app.onError((error, c) => c.json({ error: error.message }, error instanceof EvolvedError ? error.status as 400 : 500))
    const cookie = store.createSession('alice')
    const request = (path: string, method = 'GET', body?: unknown, token = cookie) => app.request(`/api/evolved/projects/${project.id}/schedules${path}`, { method, headers: { cookie: `__Host-hapi-evolved=${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const create = () => request('', 'POST', { sessionId: target.id, name: 'Checks', prompt: 'Run tests', cron: '* * * * *' })
    return { store, project, target, calls, service, app, request, create, advance: (ms: number) => { now += ms } }
}
test('UTC cron parsing handles steps, month boundaries, leap years and invalid values', () => {
    expect(nextCronTime('*/15 9-17 * * 1-5', Date.UTC(2026, 0, 1, 9, 1))).toBe(Date.UTC(2026, 0, 1, 9, 15))
    expect(nextCronTime('0 0 29 2 *', Date.UTC(2026, 0, 1))).toBe(Date.UTC(2028, 1, 29))
    expect(nextCronTime('0 0 */2 * 1', Date.UTC(2026, 0, 1))).toBe(Date.UTC(2026, 0, 5))
    expect(nextCronTime('0 0 * * 7', Date.UTC(2026, 0, 1))).toBe(Date.UTC(2026, 0, 4))
    expect(() => nextCronTime('0 0 31 2 *', Date.UTC(2026, 0, 1))).toThrow()
    expect(() => nextCronTime('61 * * * *', Date.now())).toThrow()
    expect(() => nextCronTime('*/0 * * * *', Date.now())).toThrow()
})
test('durable schedule claims once, clamps resumed permissions, and skips overlapping work', async () => {
    const t = setup(), response = await t.create()
    expect(response.status).toBe(201)
    t.advance(60_000)
    await Promise.all([t.service.tick(), t.service.tick()])
    expect(t.calls).toHaveLength(2)
    expect(t.calls[0]).toEqual({ resume: ['session', t.project.namespace, { permissionMode: 'read-only' }] })
    const runs = t.store.db.prepare('SELECT * FROM evolved_schedule_runs').all() as Array<{ state: string }>
    expect(runs).toHaveLength(1); expect(runs[0]!.state).toBe('accepted')
    t.advance(60_000); await t.service.tick()
    expect(t.calls).toHaveLength(2)
    expect(t.store.db.prepare("SELECT COUNT(*) AS n FROM evolved_schedule_runs WHERE state='skipped'").get()).toEqual({ n: 1 })
})
test('missed runs do not catch up and revoking the lease prevents dispatch', async () => {
    const t = setup(); await t.create()
    t.advance(300_000); await t.service.tick()
    expect(t.calls).toHaveLength(0)
    t.store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=?').run(Date.now())
    t.advance(60_000); await t.service.tick()
    expect(t.calls).toHaveLength(0)
    expect(t.store.db.prepare("SELECT COUNT(*) AS n FROM evolved_schedule_runs WHERE state='failed'").get()).toEqual({ n: 1 })
})
test('a permanent runner still authorizes schedules after finite leases would expire and stops on revocation', async () => {
    const t = setup()
    t.store.db.exec('UPDATE evolved_runner_leases SET expires_at=NULL')
    expect((await t.create()).status).toBe(201)
    t.advance(31 * 86400_000)
    await t.service.tick() // Missed occurrences are still skipped, never replayed.
    expect(t.calls).toHaveLength(0)
    t.advance(60_000)
    await t.service.tick()
    expect(t.calls).toHaveLength(2)
    expect(t.store.db.query("SELECT COUNT(*) AS n FROM evolved_schedule_runs WHERE state='accepted'").get()).toEqual({ n: 1 })
    t.store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=?').run(t.store.now())
    t.target.thinking = false
    t.advance(60_000)
    await t.service.tick()
    expect(t.calls).toHaveLength(2)
    expect(t.store.db.query("SELECT COUNT(*) AS n FROM evolved_schedule_runs WHERE state='failed'").get()).toEqual({ n: 1 })
})
test('profile changes disable schedules and capabilities cannot create background rights', async () => {
    const t = setup(); await t.create()
    t.store.db.prepare("UPDATE evolved_projects SET profile='workspace'").run()
    t.advance(60_000); await t.service.tick()
    expect(t.calls).toHaveLength(0)
    expect(t.store.db.prepare('SELECT enabled FROM evolved_schedules').get()).toEqual({ enabled: 0 })
    const cap = t.store.issueCapability('alice', t.project.id, ['runner:connect'], [], 60)
    const response = await t.app.request(`/api/evolved/projects/${t.project.id}/schedules`, { method: 'POST', headers: { authorization: `Bearer ${cap.token}`, 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(403)
})
test('a dispatch interrupted by restart becomes indeterminate and is not replayed', async () => {
    const t = setup(), response = await t.create(), data = await response.json() as { id: string }
    t.store.db.prepare("INSERT INTO evolved_schedule_runs VALUES('run',?,?,'dispatching',NULL,?)").run(data.id, Date.now(), Date.now())
    new ScheduleService(t.store, () => null)
    expect(t.store.db.prepare("SELECT state FROM evolved_schedule_runs WHERE id='run'").get()).toEqual({ state: 'indeterminate' })
})


test('a slow resume never dispatches an expired occurrence or the later rows from a stale clock', async () => {
    const t = setup(); await t.create(); await t.create()
    const resume = (t.service as unknown as { getEngine: () => SyncEngine }).getEngine().resumeSession
    ;(t.service as unknown as { getEngine: () => SyncEngine }).getEngine().resumeSession = async (...args) => { t.advance(61_000); return resume(...args) }
    t.advance(60_000); await t.service.tick()
    expect(t.calls.filter(value => 'send' in (value as object))).toHaveLength(0)
    expect(t.store.db.prepare("SELECT COUNT(*) AS n FROM evolved_schedule_runs WHERE state='skipped'").get()).toEqual({ n: 2 })
})
