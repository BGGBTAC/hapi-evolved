import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ProviderCapacitySchema, type ProviderCapacity, type Session } from '@hapi/protocol'
import { createCapacityRoutes, projectCapacity } from './capacity'
import { EvolvedError, EvolvedStore } from './store'
import { SESSION_COOKIE } from './security'

const now = 2_000_000_000_000
const snapshot: ProviderCapacity = { provider: 'codex', source: 'codex-app-server', scope: 'account', observedAt: now,
    status: 'available', reason: null, windows: [{ id: 'codex:primary', usedPercent: 32, remainingPercent: 68, resetsAt: now + 60_000, durationMinutes: 300, status: 'allowed' }] }
const session = (value: unknown = snapshot, overrides: Partial<Session> = {}): Session => ({ id: 'sid', active: true, metadata: { flavor: 'codex', path: '/private/path', host: 'private-host' }, agentState: { providerCapacity: value }, ...overrides }) as Session
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

describe('capacity projection', () => {
    test('unknown is not a fabricated full subscription; independent sessions are never summed', () => {
        expect(projectCapacity('p', [], now).providers.every(item => item.status === 'unknown' && item.reports.length === 0)).toBe(true)
        const response = projectCapacity('p', [session(), session(snapshot, { id: 'other-account' })], now)
        expect(response.providers[1].reports.map(item => item.windows[0].remainingPercent)).toEqual([68, 68])
        expect(response.providers[1].reports[0].scope).toBe('account')
    })
    test('strips private fields and derives remaining only from genuine numeric usage', () => {
        const report = { ...snapshot, accountId: 'private-id', email: 'private-email', token: 'private-token', windows: [{ ...snapshot.windows[0], remainingPercent: 100, secret: 'private-window' }] }
        const result = projectCapacity('p', [session(report)], now)
        expect(result.providers[1].reports[0].windows[0].remainingPercent).toBe(68)
        expect(JSON.stringify(result)).not.toMatch(/private|accountId|token|email/)
        const unknown = projectCapacity('p', [session({ ...snapshot, windows: [{ ...snapshot.windows[0], usedPercent: null, remainingPercent: 100 }] })], now)
        expect(unknown.providers[1].reports[0].windows[0].remainingPercent).toBeNull()
        expect(unknown.providers[1].status).toBe('unknown')
    })
    test('marks inactive, expired reset, and old snapshots stale without resetting usage to zero', () => {
        for (const item of [session(snapshot, { active: false }), session({ ...snapshot, observedAt: now - 300_000 }), session({ ...snapshot, windows: [{ ...snapshot.windows[0], resetsAt: now }] })]) {
            const report = projectCapacity('p', [item], now).providers[1].reports[0]
            expect(report.stale).toBe(true)
            expect(report.windows[0].remainingPercent).toBe(68)
            expect(projectCapacity('p', [item], now).providers[1].status).toBe('unknown')
        }
        expect(projectCapacity('p', [session()], now).providers[1].reports[0].stale).toBe(false)
    })
    test('keeps stale independent windows visibly stale after a fresh partial update', () => {
        const value = { ...snapshot, windows: [snapshot.windows[0], { ...snapshot.windows[0], id: 'codex:secondary', observedAt: now - 600_000 }] }
        const result = projectCapacity('p', [session(value)], now).providers[1]
        expect(result.status).toBe('available')
        expect(result.reports[0].stale).toBe(false)
        expect(result.reports[0].windows.map(window => window.stale)).toEqual([false, true])
    })
    test('rejects invalid fields, unreasonable future clocks and mismatched sources', () => {
        for (const bad of [{ ...snapshot, observedAt: now + 60_000 }, { ...snapshot, source: 'claude-sdk' }, { ...snapshot, windows: [{ ...snapshot.windows[0], usedPercent: -2 }] }]) {
            expect(projectCapacity('p', [session(bad)], now).providers[1].reports).toEqual([])
        }
        expect(ProviderCapacitySchema.safeParse({ ...snapshot, windows: Array(33).fill(snapshot.windows[0]) }).success).toBe(false)
    })
})

test('real Evolved authentication scopes capacity to the project and rejects runner capabilities', async () => {
    const store = new EvolvedStore(':memory:', { now: () => now })
    cleanups.push(() => store.close())
    for (const id of ['admin', 'viewer', 'outsider']) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, id === 'admin' ? 1 : 0, now)
    const team = store.createTeam('admin', 'Team'), project = store.createProject('admin', team.id, 'Project')
    const otherTeam = store.createTeam('outsider', 'Other'), other = store.createProject('outsider', otherTeam.id, 'Other')
    store.setMember('admin', team.id, 'viewer', 'viewer')
    let seenNamespace = ''
    const engine = { getSessionsByNamespace(namespace: string) { seenNamespace = namespace; return namespace === project.namespace ? [session()] : [session(snapshot, { id: 'other-project' })] } }
    const origin = 'https://evolved.example.test', app = new Hono()
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code }, error.status as 400) : c.json({ error: 'test failed' }, 500))
    app.route('/api/evolved', createCapacityRoutes(store, () => engine, origin))
    const request = (headers: Record<string, string>, id = project.id) => app.request(`${origin}/api/evolved/projects/${id}/capacity`, { headers })
    expect((await request({})).status).toBe(401)
    const cookie = (id: string) => ({ cookie: `${SESSION_COOKIE}=${store.createSession(id)}` })
    expect((await request(cookie('outsider'))).status).toBe(403)
    const response = await request(cookie('viewer'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(seenNamespace).toBe(project.namespace)
    expect(JSON.stringify(await response.json())).not.toContain('other-project')
    expect((await request({ authorization: `Bearer ${store.issueCapability('admin', project.id, ['runner:connect'], [], 900).token}` })).status).toBe(403)
    expect((await request(cookie('viewer'), other.id)).status).toBe(403)
    store.setMember('admin', team.id, 'viewer', 'viewer')
    store.db.prepare('DELETE FROM evolved_team_members WHERE team_id=? AND user_id=?').run(team.id, 'viewer')
    expect((await request(cookie('viewer'))).status).toBe(403)
})
