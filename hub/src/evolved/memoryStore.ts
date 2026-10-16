import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'

export class MemoryError extends Error {
    constructor(message: string, readonly status: number = 400) { super(message) }
}
export type MemorySource = {
    projectId: string; kind: 'manual' | 'chat' | 'code' | 'attachment'; hash: string
    path?: string; commit?: string; sessionId?: string; messageId?: string; origin?: string
}
export type MemoryItem = {
    id: string; projectId: string; title: string; body: string; status: 'proposed' | 'verified'
    createdAt: number; sources: MemorySource[]; indexState: string; archivedImport: boolean
}
export type MemorySettings = { enabled: boolean; cloudAllowed: boolean; monthlyBudgetMicros: number; jobBudgetMicros: number }
export type MemoryTask = { id: string; project_id: string; item_id: string | null; actor_id: string; kind: string; generation: number; reservation_id: string | null; lease_until: number }
type ItemRow = { id: string; project_id: string; title: string; body: string; status: 'proposed' | 'verified'; created_at: number; index_state: string; content_hash: string; archived_import: number }

export function memoryHash(content: string): string { return createHash('sha256').update(content).digest('hex') }

/** Ledger is authoritative; the external graph is a rebuildable projection. Currency is integer USD millionths. */
export class MemoryLedger {
    constructor(readonly db: Database) {
        db.exec(`
            PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS evolved_memory_settings (
                project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, cloud_allowed INTEGER NOT NULL DEFAULT 0,
                monthly_budget_micros INTEGER NOT NULL DEFAULT 0, job_budget_micros INTEGER NOT NULL DEFAULT 0,
                generation INTEGER NOT NULL DEFAULT 0, approved_by TEXT
            );
            CREATE TABLE IF NOT EXISTS evolved_memory_items (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('proposed','verified')), created_at INTEGER NOT NULL,
                index_state TEXT NOT NULL DEFAULT 'pending', content_hash TEXT NOT NULL, archived_import INTEGER NOT NULL DEFAULT 0,
                UNIQUE(project_id,content_hash)
            );
            CREATE INDEX IF NOT EXISTS evolved_memory_project ON evolved_memory_items(project_id,created_at DESC);
            CREATE TABLE IF NOT EXISTS evolved_memory_sources (
                item_id TEXT NOT NULL REFERENCES evolved_memory_items(id) ON DELETE CASCADE,
                project_id TEXT NOT NULL, source_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS evolved_memory_source_lookup ON evolved_memory_sources(project_id,json_extract(source_json,'$.sessionId'),json_extract(source_json,'$.messageId'));
            CREATE INDEX IF NOT EXISTS evolved_memory_source_kind ON evolved_memory_sources(project_id,json_extract(source_json,'$.kind'));
            CREATE INDEX IF NOT EXISTS evolved_memory_source_item ON evolved_memory_sources(item_id);
            CREATE TABLE IF NOT EXISTS evolved_memory_reservations (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, period TEXT NOT NULL,
                reserved_micros INTEGER NOT NULL CHECK(reserved_micros>=0), spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
                state TEXT NOT NULL CHECK(state IN ('reserved','settled')), created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS evolved_memory_cost ON evolved_memory_reservations(project_id,period);
            CREATE TABLE IF NOT EXISTS evolved_memory_tasks (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, item_id TEXT, actor_id TEXT NOT NULL,
                kind TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
                reservation_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT, created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS evolved_memory_queue ON evolved_memory_tasks(state,lease_until,created_at);
            CREATE INDEX IF NOT EXISTS evolved_memory_task_item ON evolved_memory_tasks(item_id,project_id,kind,created_at DESC,id DESC);
            CREATE TABLE IF NOT EXISTS evolved_memory_migrations(name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
        `)
        const columns = db.query('PRAGMA table_info(evolved_memory_settings)').all() as { name: string }[]
        if (!columns.some(column => column.name === 'approved_by')) db.exec('ALTER TABLE evolved_memory_settings ADD COLUMN approved_by TEXT')
        const itemColumns = db.query('PRAGMA table_info(evolved_memory_items)').all() as { name: string }[]
        if (!itemColumns.some(column => column.name === 'archived_import')) db.exec('ALTER TABLE evolved_memory_items ADD COLUMN archived_import INTEGER NOT NULL DEFAULT 0')
        this.archiveLegacyConversationImports()
    }
    /** One-time, conservative classification; archived text and provenance are retained verbatim. */
    private archiveLegacyConversationImports(): void {
        // Without the audit table we cannot rule out an explicit human/agent intake.
        if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evolved_audit'").get()) return
        // Classification probes each item's provenance and audit history. Index
        // those keys before scanning flooded legacy ledgers during Hub startup.
        this.db.exec('CREATE INDEX IF NOT EXISTS evolved_memory_audit_target ON evolved_audit(target_id,action)')
        this.db.transaction(() => {
            const migration = 'archive-automatic-conversations-v1'
            if (this.db.query('SELECT 1 FROM evolved_memory_migrations WHERE name=?').get(migration)) return
            const rows = this.db.query(`SELECT i.* FROM evolved_memory_items i WHERE i.archived_import=0 AND i.status='proposed'
                AND i.title LIKE 'Conversation %' AND NOT EXISTS(SELECT 1 FROM evolved_audit a
                    WHERE a.target_id=i.id AND a.action LIKE 'memory.%')`).all() as ItemRow[]
            const projects = new Set<string>()
            for (const row of rows) {
                const sources = this.db.query('SELECT project_id,source_json FROM evolved_memory_sources WHERE item_id=?').all(row.id) as { project_id: string; source_json: string }[]
                try {
                    if (sources.length !== 1 || sources[0].project_id !== row.project_id) continue
                    const source = JSON.parse(sources[0].source_json) as MemorySource
                    if (!source || source.projectId !== row.project_id || source.kind !== 'chat'
                        || typeof source.sessionId !== 'string' || !source.sessionId || typeof source.messageId !== 'string' || !source.messageId
                        || source.origin !== `hub:session:${source.sessionId}` || source.hash !== memoryHash(row.body)
                        || Object.keys(source).some(key => !['projectId', 'kind', 'sessionId', 'messageId', 'origin', 'hash'].includes(key))
                        || row.title !== `Conversation ${source.sessionId.slice(0, 12)}`) continue
                    const envelope = JSON.parse(row.body) as Record<string, unknown>
                    if (!envelope || Array.isArray(envelope) || !['user', 'agent'].includes(String(envelope.role))
                        || Object.keys(envelope).some(key => !['role', 'content', 'meta', 'localKey'].includes(key))
                        || !envelope.content || typeof envelope.content !== 'object' || Array.isArray(envelope.content)
                        || typeof (envelope.content as Record<string, unknown>).type !== 'string'
                        || JSON.stringify(envelope) !== row.body
                        || row.content_hash !== memoryHash(JSON.stringify({ title: row.title, body: row.body, sources: [source] }))) continue
                } catch { continue /* Ambiguous/malformed old records remain active; never guess provenance. */ }
                // Database errors must roll back the migration, never mark a
                // partially applied classification as completed.
                this.db.query("UPDATE evolved_memory_items SET archived_import=1,index_state='archived' WHERE id=?").run(row.id)
                projects.add(row.project_id)
            }
            for (const projectId of projects) this.invalidateProjection(projectId, 'system:archive-imports')
            this.db.query('INSERT INTO evolved_memory_migrations VALUES(?,?)').run(migration, Date.now())
        }).immediate()
    }
    settings(projectId: string): MemorySettings & { generation: number; approvedBy: string | null } {
        const row = this.db.query('SELECT * FROM evolved_memory_settings WHERE project_id=?').get(projectId) as {
            enabled: number; cloud_allowed: number; monthly_budget_micros: number; job_budget_micros: number; generation: number; approved_by: string | null
        } | null
        return { enabled: !!row?.enabled, cloudAllowed: !!row?.cloud_allowed, monthlyBudgetMicros: row?.monthly_budget_micros ?? 0,
            jobBudgetMicros: row?.job_budget_micros ?? 0, generation: row?.generation ?? 0, approvedBy: row?.approved_by ?? null }
    }
    configure(projectId: string, changes: Partial<MemorySettings>, approvedBy?: string): MemorySettings {
        const settings = { ...this.settings(projectId), ...changes }
        for (const value of [settings.monthlyBudgetMicros, settings.jobBudgetMicros]) {
            if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new MemoryError('Invalid memory budget')
        }
        if (settings.enabled && (!settings.cloudAllowed || settings.monthlyBudgetMicros <= 0 || settings.jobBudgetMicros <= 0)) {
            throw new MemoryError('Enable cloud processing only after setting a monthly and per-operation budget')
        }
        if (settings.jobBudgetMicros > settings.monthlyBudgetMicros) throw new MemoryError('Operation budget exceeds monthly budget')
        this.db.query(`INSERT INTO evolved_memory_settings(project_id,enabled,cloud_allowed,monthly_budget_micros,job_budget_micros)
            VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,cloud_allowed=excluded.cloud_allowed,
            monthly_budget_micros=excluded.monthly_budget_micros,job_budget_micros=excluded.job_budget_micros`)
            .run(projectId, +settings.enabled, +settings.cloudAllowed, settings.monthlyBudgetMicros, settings.jobBudgetMicros)
        if (approvedBy) this.db.query('UPDATE evolved_memory_settings SET approved_by=? WHERE project_id=?').run(approvedBy, projectId)
        return settings
    }
    budget(projectId: string, period = new Date().toISOString().slice(0, 7)) {
        const row = this.db.query(`SELECT COALESCE(SUM(spent_micros),0) AS spent,
            COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros ELSE 0 END),0) AS reserved
            FROM evolved_memory_reservations WHERE project_id=? AND period=?`).get(projectId, period) as { spent: number; reserved: number }
        return { spentMicros: row.spent, reservedMicros: row.reserved, limitMicros: this.settings(projectId).monthlyBudgetMicros, period }
    }
    reserve(projectId: string, id: string, amount?: number): number {
        return this.db.transaction(() => {
            const existing = this.db.query('SELECT project_id,reserved_micros FROM evolved_memory_reservations WHERE id=?').get(id) as { project_id: string; reserved_micros: number } | null
            if (existing) {
                if (existing.project_id !== projectId) throw new MemoryError('Reservation scope mismatch', 403)
                return existing.reserved_micros
            }
            const settings = this.settings(projectId)
            if (!settings.enabled || !settings.cloudAllowed) throw new MemoryError('Cloud memory processing is disabled', 409)
            const requested = amount ?? settings.jobBudgetMicros
            if (!Number.isSafeInteger(requested) || requested <= 0 || requested > settings.jobBudgetMicros) throw new MemoryError('Invalid reservation')
            const budget = this.budget(projectId)
            if (budget.spentMicros + budget.reservedMicros + requested > budget.limitMicros) throw new MemoryError('Monthly memory budget exhausted', 402)
            this.db.query(`INSERT INTO evolved_memory_reservations(id,project_id,period,reserved_micros,state,created_at) VALUES(?,?,?,?,'reserved',?)`)
                .run(id, projectId, budget.period, requested, Date.now())
            return requested
        }).immediate()
    }
    settle(id: string, spentMicros: number): void {
        this.db.transaction(() => {
            const row = this.db.query('SELECT reserved_micros,state,spent_micros FROM evolved_memory_reservations WHERE id=?').get(id) as { reserved_micros: number; state: string; spent_micros: number } | null
            if (!row) throw new MemoryError('Unknown reservation')
            if (!Number.isSafeInteger(spentMicros) || spentMicros < 0 || spentMicros > row.reserved_micros) throw new MemoryError('Backend exceeded reserved budget', 502)
            if (row.state === 'settled') {
                if (row.spent_micros !== spentMicros) throw new MemoryError('Conflicting cost receipt', 502)
                return
            }
            this.db.query("UPDATE evolved_memory_reservations SET state='settled',spent_micros=? WHERE id=?").run(spentMicros, id)
        }).immediate()
    }
    pendingReservations(): Array<{ id: string; project_id: string }> {
        return this.db.query("SELECT id,project_id FROM evolved_memory_reservations WHERE state='reserved' ORDER BY created_at LIMIT 10").all() as Array<{ id: string; project_id: string }>
    }
    private item(row: ItemRow): MemoryItem {
        const sources = this.db.query('SELECT source_json FROM evolved_memory_sources WHERE item_id=?').all(row.id) as { source_json: string }[]
        return { id: row.id, projectId: row.project_id, title: row.title, body: row.body, status: row.status, createdAt: row.created_at,
            sources: sources.map(source => JSON.parse(source.source_json) as MemorySource), indexState: row.index_state, archivedImport: !!row.archived_import }
    }
    get(projectId: string, id: string, includeArchived = false): MemoryItem | null {
        const row = this.db.query(`SELECT * FROM evolved_memory_items WHERE id=? AND project_id=? ${includeArchived ? '' : 'AND archived_import=0'}`).get(id, projectId) as ItemRow | null
        return row ? this.item(row) : null
    }
    list(projectId: string, limit = 100, view: 'active' | 'imports' = 'active', offset = 0): MemoryItem[] {
        return (this.db.query('SELECT * FROM evolved_memory_items WHERE project_id=? AND archived_import=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(projectId, +(view === 'imports'), Math.min(200, limit), offset) as ItemRow[]).map(row => this.item(row))
    }
    archivedImports(projectId: string): number {
        return (this.db.query('SELECT COUNT(*) AS count FROM evolved_memory_items WHERE project_id=? AND archived_import=1').get(projectId) as { count: number }).count
    }
    create(projectId: string, actorId: string, title: string, body: string, sources: MemorySource[]): MemoryItem {
        if (!title.trim() || title.length > 200 || !body.trim() || body.length > 50_000) throw new MemoryError('Invalid memory title or body')
        return this.db.transaction(() => {
            const hash = memoryHash(JSON.stringify({ title, body, sources }))
            const existing = this.db.query('SELECT * FROM evolved_memory_items WHERE project_id=? AND content_hash=?').get(projectId, hash) as ItemRow | null
            if (existing?.archived_import) throw new MemoryError('Archived import cannot be reused; propose a new knowledge summary', 409)
            if (existing) return this.item(existing)
            const id = randomUUID()
            this.db.query(`INSERT INTO evolved_memory_items(id,project_id,title,body,status,created_at,content_hash) VALUES(?,?,?,?,'proposed',?,?)`)
                .run(id, projectId, title, body, Date.now(), hash)
            for (const source of sources) this.db.query('INSERT INTO evolved_memory_sources(item_id,project_id,source_json) VALUES(?,?,?)').run(id, source.projectId, JSON.stringify(source))
            this.queue(projectId, actorId, 'index', id)
            return this.get(projectId, id)!
        }).immediate()
    }
    setStatus(projectId: string, id: string, status: 'proposed' | 'verified'): MemoryItem {
        if (this.get(projectId, id, true)?.archivedImport) throw new MemoryError('Archived imports cannot be verified or restored', 409)
        const result = this.db.query('UPDATE evolved_memory_items SET status=? WHERE id=? AND project_id=? AND archived_import=0').run(status, id, projectId)
        if (!result.changes) throw new MemoryError('Memory not found', 404)
        return this.get(projectId, id)!
    }
    /** Invalidate the entire derived graph immediately, then rebuild from retained sources after its purge. */
    forget(projectId: string, id: string, actorId: string): { generation: number; taskId: string | null } {
        if (!this.get(projectId, id, true)) throw new MemoryError('Memory not found', 404)
        return this.forgetIds(projectId, [id], actorId)
    }
    forgetSource(projectId: string, actorId: string, sessionId: string, messageId?: string): number {
        const rows = this.db.query(`SELECT DISTINCT item_id FROM evolved_memory_sources WHERE project_id=?
            AND json_extract(source_json,'$.sessionId')=? ${messageId ? "AND json_extract(source_json,'$.messageId')=?" : ''}`)
            .all(...(messageId ? [projectId, sessionId, messageId] : [projectId, sessionId])) as { item_id: string }[]
        if (rows.length) this.forgetIds(projectId, rows.map(row => row.item_id), actorId)
        return rows.length
    }
    sources(projectId?: string): Array<{ itemId: string; projectId: string; source: MemorySource }> {
        const rows = this.db.query(`SELECT item_id,project_id,source_json FROM evolved_memory_sources ${projectId ? 'WHERE project_id=?' : ''}`)
            .all(...(projectId ? [projectId] : [])) as Array<{ item_id: string; project_id: string; source_json: string }>
        return rows.map(row => ({ itemId: row.item_id, projectId: row.project_id, source: JSON.parse(row.source_json) as MemorySource }))
    }
    chatSourceHashes(projectId: string, sessionId: string, messageId: string): string[] {
        return (this.db.query("SELECT json_extract(source_json,'$.hash') AS hash FROM evolved_memory_sources WHERE project_id=? AND json_extract(source_json,'$.kind')='chat' AND json_extract(source_json,'$.sessionId')=? AND json_extract(source_json,'$.messageId')=? AND json_extract(source_json,'$.origin')=?")
            .all(projectId, sessionId, messageId, `hub:session:${sessionId}`) as { hash: string }[]).map(row => row.hash)
    }
    fileSources(projectId: string): Array<{ itemId: string; source: MemorySource }> {
        return (this.db.query("SELECT item_id,source_json FROM evolved_memory_sources WHERE project_id=? AND json_extract(source_json,'$.kind') IN ('code','attachment')")
            .all(projectId) as { item_id: string; source_json: string }[]).map(row => ({ itemId: row.item_id, source: JSON.parse(row.source_json) as MemorySource }))
    }
    forgetEntries(projectId: string, ids: string[], actorId: string): void {
        if (ids.length) this.forgetIds(projectId, ids, actorId)
    }
    forgetProject(projectId: string): void {
        this.db.transaction(() => {
            const items = this.db.query('SELECT id FROM evolved_memory_items WHERE project_id=?').all(projectId) as { id: string }[]
            this.forgetIds(projectId, items.map(item => item.id), 'system:project-deletion', true)
            this.db.query('DELETE FROM evolved_memory_sources WHERE project_id=?').run(projectId)
            this.db.query('DELETE FROM evolved_memory_settings WHERE project_id=?').run(projectId)
            this.db.query("DELETE FROM evolved_memory_tasks WHERE project_id=? AND kind!='purge'").run(projectId)
        }).immediate()
    }
    private forgetIds(projectId: string, ids: string[], actorId: string, forceProjection = false): { generation: number; taskId: string | null } {
        return this.db.transaction(() => {
            let activeAffected = forceProjection
            for (const id of ids) {
                activeAffected ||= !!this.db.query('SELECT 1 FROM evolved_memory_items WHERE id=? AND project_id=? AND archived_import=0').get(id, projectId)
                this.db.query('DELETE FROM evolved_memory_sources WHERE item_id=? AND project_id=?').run(id, projectId)
                this.db.query('DELETE FROM evolved_memory_items WHERE id=? AND project_id=?').run(id, projectId)
            }
            // Quarantine already invalidated this import's graph generation.
            // Deleting archived rows must not trigger another paid active rebuild.
            return activeAffected ? this.invalidateProjection(projectId, actorId) : { generation: this.settings(projectId).generation, taskId: null }
        }).immediate()
    }
    private invalidateProjection(projectId: string, actorId: string): { generation: number; taskId: string } {
        const previous = this.settings(projectId)
        // Rebuild only successful or currently pending work. A source lifecycle
        // change must not retry historical paid failures under fresh operation IDs.
        const items = this.db.query(`SELECT i.id,(SELECT t.actor_id FROM evolved_memory_tasks t WHERE t.item_id=i.id AND t.project_id=i.project_id
            AND t.kind='index' ORDER BY t.created_at DESC,t.id DESC LIMIT 1) AS actor_id FROM evolved_memory_items i WHERE i.project_id=? AND i.archived_import=0
            AND (i.index_state='indexed' OR EXISTS(SELECT 1 FROM evolved_memory_tasks t WHERE t.item_id=i.id
                AND t.project_id=i.project_id AND t.kind='index' AND t.generation=? AND t.state IN ('queued','running')))`)
            .all(projectId, previous.generation) as { id: string; actor_id: string | null }[]
        this.db.query("UPDATE evolved_memory_tasks SET state='cancelled',error=NULL WHERE project_id=? AND kind='index' AND state IN ('queued','running')").run(projectId)
        this.db.query(`INSERT INTO evolved_memory_settings(project_id,generation) VALUES(?,1)
            ON CONFLICT(project_id) DO UPDATE SET generation=generation+1`).run(projectId)
        const generation = this.settings(projectId).generation
        const taskId = this.queue(projectId, actorId, 'purge', null)
        for (const item of items) {
            this.db.query("UPDATE evolved_memory_items SET index_state='pending' WHERE id=? AND archived_import=0").run(item.id)
            // Preserve the concrete task principal. A former spending approver
            // may have left; a revoked task actor must not gain an admin fallback.
            // processOne rechecks this actor's current project/source access.
            this.queue(projectId, item.actor_id ?? previous.approvedBy ?? actorId, 'index', item.id)
        }
        return { generation, taskId }
    }
    private queue(projectId: string, actorId: string, kind: string, itemId: string | null): string {
        const id = randomUUID()
        this.db.query('INSERT INTO evolved_memory_tasks(id,project_id,item_id,actor_id,kind,generation,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(id, projectId, itemId, actorId, kind, this.settings(projectId).generation, Date.now())
        return id
    }
    claim(now = Date.now()): MemoryTask | null {
        return this.db.transaction(() => {
            const task = this.db.query(`SELECT t.* FROM evolved_memory_tasks t LEFT JOIN evolved_memory_settings s ON s.project_id=t.project_id
                WHERE (t.state='queued' OR (t.state='running' AND t.lease_until<?)) AND t.lease_until<=?
                AND (t.kind='purge' OR (s.enabled=1 AND s.cloud_allowed=1))
                AND (t.kind='purge' OR (t.generation=s.generation AND EXISTS(SELECT 1 FROM evolved_memory_items i WHERE i.id=t.item_id AND i.project_id=t.project_id AND i.archived_import=0)))
                AND (t.kind='purge' OR NOT EXISTS(SELECT 1 FROM evolved_memory_tasks p WHERE p.project_id=t.project_id AND p.kind='purge' AND p.state IN ('queued','running')))
                ORDER BY CASE WHEN t.kind='purge' THEN 0 ELSE 1 END,t.created_at LIMIT 1`).get(now, now) as MemoryTask | null
            if (!task) return null
            const lease = now + 180_000
            this.db.query("UPDATE evolved_memory_tasks SET state='running',lease_until=?,attempts=attempts+1 WHERE id=?").run(lease, task.id)
            return { ...task, lease_until: lease }
        }).immediate()
    }
    taskReservation(taskId: string, reservationId: string): void {
        this.db.query('UPDATE evolved_memory_tasks SET reservation_id=? WHERE id=?').run(reservationId, taskId)
    }
    complete(task: MemoryTask): void {
        this.db.transaction(() => {
            const changed = this.db.query("UPDATE evolved_memory_tasks SET state='complete',error=NULL WHERE id=? AND state='running' AND lease_until=?")
                .run(task.id, task.lease_until)
            if (changed.changes && task.item_id && task.generation === this.settings(task.project_id).generation) {
                this.db.query("UPDATE evolved_memory_items SET index_state='indexed' WHERE id=? AND project_id=? AND archived_import=0").run(task.item_id, task.project_id)
            }
        }).immediate()
    }
    fail(task: MemoryTask, error: string): void {
        this.db.transaction(() => {
            const changed = this.db.query(`UPDATE evolved_memory_tasks SET state='failed',error=? WHERE id=? AND state='running'
                AND lease_until=? AND generation=? AND EXISTS(SELECT 1 FROM evolved_memory_settings s WHERE s.project_id=? AND s.generation=?)`)
                .run(error, task.id, task.lease_until, task.generation, task.project_id, task.generation)
            if (changed.changes && task.item_id) this.db.query("UPDATE evolved_memory_items SET index_state='error' WHERE id=? AND project_id=? AND archived_import=0").run(task.item_id, task.project_id)
        }).immediate()
    }
    retry(task: MemoryTask, error: string): void {
        this.db.query("UPDATE evolved_memory_tasks SET state='queued',lease_until=?,error=? WHERE id=? AND state='running' AND lease_until=?")
            .run(Date.now() + 60_000, error.slice(0, 200), task.id, task.lease_until)
    }
    search(projectIds: string[], query: string, limit = 30): MemoryItem[] {
        if (!projectIds.length) return []
        const pattern = `%${query.replace(/[\\%_]/g, char => `\\${char}`)}%`
        const rows = this.db.query(`SELECT * FROM evolved_memory_items WHERE archived_import=0 AND project_id IN (${projectIds.map(() => '?').join(',')})
            AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`)
            .all(...projectIds, pattern, pattern, Math.min(100, limit)) as ItemRow[]
        return rows.map(row => this.item(row))
    }
}
