import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SyncEngine } from '../sync/syncEngine'
import { EvolvedError, EvolvedStore, type AgentProfile } from './store'
import { authenticateEvolvedRequest, parseBody, requireFreshPasskey, requireHuman, type EvolvedEnv } from './security'
import { permissionAllowed, projectPermissionMode } from './bridge'

type Schedule = { id: string; project_id: string; user_id: string; session_id: string; name: string; prompt: string; cron: string; profile: AgentProfile; enabled: number; next_at: number; created_at: number }
function cronField(source: string, min: number, max: number): Set<number> {
    const result = new Set<number>()
    for (const part of source.split(',')) {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
        if (!match) throw new EvolvedError('invalid_cron', 'Use five numeric UTC cron fields (*, ranges, lists and steps).')
        const [low, high] = match[1] === '*' ? [min, max] : match[1]!.split('-').map(Number)
        const start = low!, end = high ?? (match[2] ? max : low!), step = match[2] ? Number(match[2]) : 1
        if (start < min || end > max || end < start || step < 1 || step > max + 1) throw new EvolvedError('invalid_cron', 'Cron value is outside its valid range.')
        for (let n = start; n <= end; n += step) result.add(n)
    }
    return result
}
export function nextCronTime(cron: string, after: number): number {
    const fields = cron.trim().split(/\s+/)
    if (fields.length !== 5 || cron.length > 120 || !Number.isFinite(after)) throw new EvolvedError('invalid_cron', 'Expected five UTC cron fields.')
    const sets = fields.map((field, index) => cronField(field, [0, 0, 1, 1, 0][index]!, [59, 23, 31, 12, 7][index]!))
    if (sets[4]!.delete(7)) sets[4]!.add(0)
    const start = Math.floor(after / 60_000) * 60_000 + 60_000
    // Advance by calendar units rather than scanning millions of minutes for an impossible date.
    const d = new Date(start), end = start + 366 * 5 * 86400_000
    while (d.getTime() < end) {
        if (!sets[3]!.has(d.getUTCMonth() + 1)) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0, 0, 0); continue }
        const day = sets[2]!.has(d.getUTCDate()), weekday = sets[4]!.has(d.getUTCDay())
        // Vixie cron: when either day field starts with '*', both fields must match.
        const dateMatches = fields[2]!.startsWith('*') || fields[4]!.startsWith('*') ? day && weekday : day || weekday
        if (!dateMatches) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0); continue }
        if (!sets[1]!.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0); continue }
        if (!sets[0]!.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0); continue }
        return d.getTime()
    }
    throw new EvolvedError('invalid_cron', 'Cron has no occurrence within five years.')
}
export class ScheduleService {
    private running = false
    constructor(readonly store: EvolvedStore, private readonly getEngine: () => SyncEngine | null) {
        store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_schedules(
            id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES evolved_users(id),session_id TEXT NOT NULL,name TEXT NOT NULL,prompt TEXT NOT NULL,cron TEXT NOT NULL,profile TEXT NOT NULL,enabled INTEGER NOT NULL,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS evolved_schedules_due ON evolved_schedules(enabled,next_at);
            CREATE TABLE IF NOT EXISTS evolved_schedule_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES evolved_schedules(id) ON DELETE CASCADE,scheduled_at INTEGER NOT NULL,state TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL,UNIQUE(schedule_id,scheduled_at));`)
        // The process may have died after external delivery. Never silently replay it.
        store.db.prepare("UPDATE evolved_schedule_runs SET state='indeterminate',detail='Hub restarted during dispatch; inspect the target session.' WHERE state='dispatching'").run()
    }
    private authorize(row: Schedule) {
        const project = this.store.requireProject(row.user_id, row.project_id, 'admin')
        if (project.profile !== row.profile) throw new EvolvedError('profile_changed', 'Schedule requires renewed approval after a profile change.', 403)
        const leases = this.store.db.prepare("SELECT user_id FROM evolved_runner_leases WHERE project_id=? AND profile=? AND revoked_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value='runner:connect')").all(project.id, project.profile, this.store.now()) as Array<{ user_id: string }>
        const authorized = leases.some(lease => { try { this.store.requireProject(lease.user_id, project.id, 'admin'); return true } catch { return false } })
        if (!authorized) throw new EvolvedError('runner_unavailable', 'No authorized runner lease is available.', 403)
        return project
    }
    async tick(): Promise<void> {
        const engine = this.getEngine()
        if (this.running || !engine) return
        this.running = true
        try {
            const now = this.store.now()
            const rows = this.store.db.prepare('SELECT * FROM evolved_schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at LIMIT 20').all(now) as Schedule[]
            for (const row of rows) {
                const claimNow = this.store.now()
                const runId = randomUUID()
                const claimed = this.store.db.transaction(() => {
                    const update = this.store.db.prepare('UPDATE evolved_schedules SET next_at=? WHERE id=? AND enabled=1 AND next_at=?').run(nextCronTime(row.cron, claimNow), row.id, row.next_at)
                    if (!update.changes) return false
                    return this.store.db.prepare("INSERT OR IGNORE INTO evolved_schedule_runs VALUES(?,?,?,'dispatching',NULL,?)").run(runId, row.id, row.next_at, claimNow).changes > 0
                })()
                if (!claimed) continue
                const finish = (state: string, detail: string | null = null) => this.store.db.prepare('UPDATE evolved_schedule_runs SET state=?,detail=? WHERE id=?').run(state, detail, runId)
                try {
                    if (claimNow - row.next_at >= 60_000) { finish('skipped', 'Missed occurrence; catch-up is disabled.'); continue }
                    const project = this.authorize(row)
                    let target = engine.getSessionByNamespace(row.session_id, project.namespace)
                    if (!target) throw new EvolvedError('target_missing', 'Target session is unavailable.', 404)
                    if (!['claude', 'codex'].includes(target.metadata?.flavor ?? 'claude')) throw new EvolvedError('unsupported_agent', 'Only Claude and Codex are supported.')
                    if (target.thinking || (target.backgroundTaskCount ?? 0) > 0 || Object.keys(target.agentState?.requests ?? {}).length > 0) { finish('skipped', 'Target is busy or waiting for operator input.'); continue }
                    if (!permissionAllowed(project, target.permissionMode)) throw new EvolvedError('profile_denied', 'Target permission mode exceeds the approved profile.', 403)
                    if (!target.active) {
                        const result = await engine.resumeSession(target.id, project.namespace, { permissionMode: projectPermissionMode(project, target.metadata?.flavor) })
                        if (result.type !== 'success') throw new EvolvedError('resume_failed', 'Target could not be resumed.', 409)
                        target = engine.getSessionByNamespace(result.sessionId, project.namespace)
                        if (!target) throw new EvolvedError('target_missing', 'Resumed session is unavailable in this project.', 409)
                    }
                    // Revocation, deletion, profile or operator changes during resume win.
                    this.authorize(row)
                    if (this.store.now() - row.next_at >= 60_000) { finish('skipped', 'Occurrence expired while preparing the target.'); continue }
                    const stillEnabled = this.store.db.prepare('SELECT 1 FROM evolved_schedules WHERE id=? AND enabled=1 AND user_id=? AND profile=?').get(row.id, row.user_id, row.profile)
                    if (!stillEnabled) throw new EvolvedError('schedule_cancelled', 'Schedule was changed while preparing the run.', 409)
                    if (target.id !== row.session_id) this.store.db.prepare('UPDATE evolved_schedules SET session_id=? WHERE id=?').run(target.id, row.id)
                    await engine.sendMessage(target.id, { text: row.prompt, localId: `schedule:${runId}` })
                    finish('accepted', 'Prompt persisted; acceptance is not proof of successful task completion.')
                } catch (error) {
                    finish(error instanceof EvolvedError ? 'failed' : 'indeterminate', error instanceof EvolvedError ? error.message : 'Dispatch outcome is uncertain; inspect the target session.')
                    if (error instanceof EvolvedError && ['forbidden', 'profile_changed'].includes(error.code)) this.store.db.prepare('UPDATE evolved_schedules SET enabled=0 WHERE id=?').run(row.id)
                }
            }
            this.store.db.prepare('DELETE FROM evolved_schedule_runs WHERE created_at<?').run(now - 30 * 86400_000)
        } finally { this.running = false }
    }
    start(): () => void {
        const timer = setInterval(() => { void this.tick().catch(() => {}) }, 5000)
        timer.unref()
        return () => clearInterval(timer)
    }
}
export function createScheduleRoutes(service: ScheduleService, getEngine: () => SyncEngine | null): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>(), store = service.store
    app.use('*', async (c, next) => {
        if (!/\/projects\/[^/]+\/schedules(?:\/[^/]+(?:\/runs)?)?$/.test(c.req.path)) return next()
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal); store.requireProject(principal.user.id, c.req.param('id') ?? c.req.path.split('/projects/')[1]!.split('/')[0]!, 'admin')
        if (!['GET', 'HEAD'].includes(c.req.method)) requireFreshPasskey(c, store, principal)
        c.set('principal', principal)
        return next()
    })
    app.get('/projects/:id/schedules', c => { store.requireProject(c.get('principal').user.id, c.req.param('id'), 'admin'); return c.json({ schedules: store.db.prepare('SELECT id,session_id AS sessionId,name,prompt,cron,profile,enabled,next_at AS nextAt,created_at AS createdAt FROM evolved_schedules WHERE project_id=? ORDER BY created_at DESC').all(c.req.param('id')), timezone: 'UTC' }) })
    app.post('/projects/:id/schedules', async c => {
        const body = await parseBody(c, z.object({ sessionId: z.string().min(1).max(128), name: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(32_000), cron: z.string().min(1).max(120) }).strict())
        const project = store.requireProject(c.get('principal').user.id, c.req.param('id'), 'admin')
        if (!getEngine()?.getSessionByNamespace(body.sessionId, project.namespace)) throw new EvolvedError('target_missing', 'Select a session in this project.', 404)
        const count = store.db.prepare('SELECT COUNT(*) AS n FROM evolved_schedules WHERE project_id=?').get(project.id) as { n: number }
        if (count.n >= 100) throw new EvolvedError('quota', 'A project may have at most 100 schedules.', 409)
        const id = randomUUID(), now = store.now(), nextAt = nextCronTime(body.cron, now)
        store.db.prepare('INSERT INTO evolved_schedules VALUES(?,?,?,?,?,?,?,?,1,?,?)').run(id, project.id, c.get('principal').user.id, body.sessionId, body.name, body.prompt, body.cron, project.profile, nextAt, now)
        store.audit(c.get('principal').user.id, project.id, 'schedule.created', id)
        return c.json({ id, nextAt, timezone: 'UTC' }, 201)
    })
    app.patch('/projects/:id/schedules/:scheduleId', async c => {
        const body = await parseBody(c, z.object({ enabled: z.boolean() }).strict())
        const row = store.db.prepare('SELECT * FROM evolved_schedules WHERE id=? AND project_id=?').get(c.req.param('scheduleId'), c.req.param('id')) as Schedule | null
        if (!row) throw new EvolvedError('not_found', 'Schedule not found.', 404)
        const project = store.requireProject(c.get('principal').user.id, row.project_id, 'admin')
        store.db.prepare('UPDATE evolved_schedules SET enabled=?,profile=?,user_id=?,next_at=? WHERE id=?').run(body.enabled ? 1 : 0, project.profile, c.get('principal').user.id, nextCronTime(row.cron, store.now()), row.id)
        store.audit(c.get('principal').user.id, project.id, body.enabled ? 'schedule.enabled' : 'schedule.disabled', row.id)
        return c.json({ ok: true })
    })
    app.delete('/projects/:id/schedules/:scheduleId', c => {
        store.requireProject(c.get('principal').user.id, c.req.param('id'), 'admin')
        store.db.prepare('DELETE FROM evolved_schedules WHERE id=? AND project_id=?').run(c.req.param('scheduleId'), c.req.param('id'))
        store.audit(c.get('principal').user.id, c.req.param('id'), 'schedule.deleted', c.req.param('scheduleId'))
        return c.json({ ok: true })
    })
    app.get('/projects/:id/schedules/:scheduleId/runs', c => { store.requireProject(c.get('principal').user.id, c.req.param('id'), 'admin'); return c.json({ runs: store.db.prepare('SELECT r.id,r.scheduled_at AS scheduledAt,r.state,r.detail,r.created_at AS createdAt FROM evolved_schedule_runs r JOIN evolved_schedules s ON s.id=r.schedule_id WHERE s.id=? AND s.project_id=? ORDER BY r.scheduled_at DESC LIMIT 100').all(c.req.param('scheduleId'), c.req.param('id')) }) })
    return app
}
