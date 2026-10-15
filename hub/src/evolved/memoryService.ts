import { open, realpath, stat } from 'node:fs/promises'
import { excludedSourcePath, containsCredential as currentContainsCredential } from '@hapi/protocol/evolvedSourcePolicy'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryError, MemoryLedger, memoryHash, type MemorySource } from './memoryStore'
import { EvolvedStore, EvolvedError } from './store'

function legacyExcludedMemoryPath(path: string): boolean {
    return path.split(/[\\/]/).some(part => /^(?:\.env(?:\..*)?|secrets?|credentials?|\.ssh|\.aws|\.gnupg|\.git|\.codegraph.*|node_modules)$/i.test(part))
        || /\.(?:pem|p12|pfx|key|keystore|sqlite|db)$/i.test(path)
}
function legacyContainsCredential(content: string): boolean {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(content)
        || /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)\b["']?\s*[:=]\s*["']?[^\s"'${}]{12,}/i.test(content)
}

export const excludedMemoryPath = excludedSourcePath
export const containsCredential = currentContainsCredential

const memoryExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.swift', '.md', '.txt', '.json', '.yaml', '.yml', '.toml'])

export async function readMemorySource(root: string, path: string, policy: 'current' | 'legacy' = 'current'): Promise<string> {
    // Existing ledger facts keep their original policy during reconciliation.
    // Expanding intake exclusions must not silently purge previously accepted knowledge.
    const excludedMemoryPath = policy === 'legacy' ? legacyExcludedMemoryPath : excludedSourcePath
    const containsCredential = policy === 'legacy' ? legacyContainsCredential : currentContainsCredential
    if (!root || !path || isAbsolute(path) || excludedMemoryPath(path)) throw new MemoryError('Source path is excluded', 403)
    const canonicalRoot = await realpath(root)
    const canonicalFile = await realpath(resolve(canonicalRoot, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new MemoryError('Source file unavailable', 404)
        throw error
    })
    const rel = relative(canonicalRoot, canonicalFile)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || excludedMemoryPath(rel)) throw new MemoryError('Source outside project or excluded', 403)
    if (!memoryExtensions.has(extname(canonicalFile).toLowerCase())) throw new MemoryError('Unsupported memory source type', 403)
    const file = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        // Validate the opened inode, not just a path that a workspace process
        // could replace with a symlink between realpath and read.
        const openedInfo = await file.stat()
        if (!openedInfo.isFile() || policy !== 'legacy' && openedInfo.nlink !== 1) throw new MemoryError('Source must be a regular non-linked file', 403)
        const openedPath = process.platform === 'linux' ? await realpath(`/proc/self/fd/${file.fd}`) : await realpath(canonicalFile)
        const openedRelative = relative(canonicalRoot, openedPath)
        if (openedRelative === '..' || openedRelative.startsWith(`..${sep}`) || isAbsolute(openedRelative) || excludedMemoryPath(openedRelative)) throw new MemoryError('Source outside project or excluded', 403)
        if (!memoryExtensions.has(extname(openedPath).toLowerCase())) throw new MemoryError('Unsupported memory source type', 403)
        const info = await file.stat()
        const current = await stat(canonicalFile)
        if (info.dev !== current.dev || info.ino !== current.ino) throw new MemoryError('Source changed during read', 409)
        if (!info.isFile() || info.size > 50_000) throw new MemoryError('Source must be a text file smaller than 50 KB', 413)
        const buffer = Buffer.alloc(50_001)
        let total = 0
        while (total < buffer.length) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
            if (!bytesRead) break
            total += bytesRead
        }
        if (total > 50_000) throw new MemoryError('Source exceeds memory size limit', 413)
        const content = buffer.subarray(0, total).toString('utf8')
        if (content.includes('\0') || containsCredential(content)) throw new MemoryError('Source contains credentials or binary data', 422)
        return content
    } finally { await file.close() }
}

export type MemoryBackend = {
    available(): Promise<boolean>
    request(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
}
export class HttpMemoryBackend implements MemoryBackend {
    constructor(private url?: string, private token?: string) {}
    async available(): Promise<boolean> {
        if (!this.url || !this.token) return false
        try { const response = await fetch(`${this.url}/health`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(2000) }); return response.ok }
        catch { return false }
    }
    async request(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (!this.url || !this.token) throw new MemoryError('Memory graph service is not configured', 503)
        let response: Response
        try {
            response = await fetch(`${this.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) })
        } catch { throw new MemoryError('Memory graph service unavailable; budget reservation retained for reconciliation', 503) }
        const result = await response.json().catch(() => ({})) as Record<string, unknown>
        // A definitive cost receipt can be reconciled even for an interrupted model operation.
        if (!response.ok && typeof result.spentMicros !== 'number') throw new MemoryError('Memory graph service rejected the operation', response.status)
        return { ...result, ok: response.ok }
    }
}

export class MemoryService {
    readonly ledger: MemoryLedger
    private running = false
    private reconciling = false
    private reconcilingCosts = false
    constructor(readonly store: EvolvedStore, readonly backend: MemoryBackend) { this.ledger = new MemoryLedger(store.db) }
    async processOne(): Promise<boolean> {
        if (this.running) return false
        this.running = true
        let task
        try {
            task = this.ledger.claim()
            if (!task) return false
            // Purges must finish even if the original author has since lost membership.
            if (task.kind === 'purge') {
                await this.backend.request('/reset', { projectId: task.project_id, generation: task.generation, operationId: task.id })
                this.ledger.complete(task)
                return true
            }
            this.store.requireProject(task.actor_id, task.project_id, 'member')
            if (task.generation !== this.ledger.settings(task.project_id).generation) { this.ledger.complete(task); return true }
            const item = task.item_id ? this.ledger.get(task.project_id, task.item_id) : null
            if (!item) { this.ledger.complete(task); return true }
            for (const source of item.sources) this.store.requireProject(task.actor_id, source.projectId)
            const reservationId = task.reservation_id ?? task.id
            const budgetMicros = this.ledger.reserve(task.project_id, reservationId)
            this.ledger.taskReservation(task.id, reservationId)
            const result = await this.backend.request('/ingest', { operationId: reservationId, projectId: task.project_id, generation: task.generation,
                memoryId: item.id, title: item.title, body: item.body, sources: item.sources, referenceTime: new Date(item.createdAt).toISOString(), budgetMicros })
            if (typeof result.spentMicros !== 'number') throw new MemoryError('Missing memory cost receipt', 502)
            this.ledger.settle(reservationId, result.spentMicros)
            if (result.ok === false) {
                // A terminal, receipted failure must not be reissued with an already settled budget.
                this.store.db.query("UPDATE evolved_memory_tasks SET state='failed',error='Graph extraction failed' WHERE id=? AND state='running'").run(task.id)
                this.store.db.query("UPDATE evolved_memory_items SET index_state='error' WHERE id=?").run(item.id)
                return true
            }
            this.ledger.complete(task)
            return true
        } catch (error) {
            if (task && error instanceof EvolvedError && [401, 403, 404].includes(error.status)) {
                this.store.db.query("UPDATE evolved_memory_tasks SET state='failed',error='Authorization revoked' WHERE id=? AND state='running' AND lease_until=?").run(task.id, task.lease_until)
                if (task.item_id) this.store.db.query("UPDATE evolved_memory_items SET index_state='error' WHERE id=?").run(task.item_id)
            } else if (task) this.ledger.retry(task, error instanceof MemoryError ? error.message : 'Memory processing unavailable')
            return false
        } finally { this.running = false }
    }
    start(): () => void {
        const timer = setInterval(() => { void this.reconcileSources().then(() => this.reconcileReservations()).then(() => this.processOne()).catch(() => undefined) }, 3000)
        timer.unref()
        return () => clearInterval(timer)
    }
    async reconcileReservations(): Promise<void> {
        if (this.reconcilingCosts) return
        this.reconcilingCosts = true
        try {
            for (const pending of this.ledger.pendingReservations()) {
                try {
                    const receipt = await this.backend.request('/receipt', { operationId: pending.id })
                    if (receipt.projectId === pending.project_id && receipt.final === true && typeof receipt.spentMicros === 'number') this.ledger.settle(pending.id, receipt.spentMicros)
                } catch { /* Unknown/in-flight operations keep their conservative reservation. */ }
            }
        } finally { this.reconcilingCosts = false }
    }
    ingestChat(input: { projectId: string; actorId: string; namespace: string; sessionId: string; messageId: string; body: string }): boolean {
        const project = this.store.requireProject(input.actorId, input.projectId, 'member')
        if (project.namespace !== input.namespace || !this.ledger.settings(project.id).enabled) return false
        if (!input.body.trim() || input.body.length > 50_000 || containsCredential(input.body)) return false
        this.ledger.create(project.id, input.actorId, `Conversation ${input.sessionId.slice(0, 12)}`, input.body, [{
            kind: 'chat', projectId: project.id, sessionId: input.sessionId, messageId: input.messageId, hash: memoryHash(input.body)
        }])
        return true
    }
    /** Only persisted, newly received Hub messages call this hook; no historical DB import. */
    ingestHubEvent(input: { namespace: string; sessionId: string; messageId: string; body: string }): boolean {
        const project = this.store.listProjectsForService().find(project => project.namespace === input.namespace)
        if (!project) return false
        const settings = this.ledger.settings(project.id)
        if (!settings.enabled || !settings.approvedBy) return false
        try { this.store.requireProject(settings.approvedBy, project.id, 'admin') } catch { return false }
        if (!input.body.trim() || input.body.length > 50_000 || containsCredential(input.body)) return false
        const hash = memoryHash(input.body)
        const prior = this.ledger.chatSourceHashes(project.id, input.sessionId, input.messageId)
        if (prior.some(priorHash => priorHash !== hash)) this.ledger.forgetSource(project.id, settings.approvedBy, input.sessionId, input.messageId)
        this.ledger.create(project.id, settings.approvedBy, `Conversation ${input.sessionId.slice(0, 12)}`, input.body, [{
            projectId: project.id, kind: 'chat', sessionId: input.sessionId, messageId: input.messageId,
            origin: `hub:session:${input.sessionId}`, hash
        }])
        return true
    }
    forgetSession(namespace: string, sessionId: string): number {
        const project = this.store.listProjectsForService().find(project => project.namespace === namespace)
        if (!project) return 0
        return this.ledger.forgetSource(project.id, this.ledger.settings(project.id).approvedBy ?? 'system:source-deletion', sessionId)
    }
    forgetMessage(namespace: string, sessionId: string, messageId: string): number {
        const project = this.store.listProjectsForService().find(project => project.namespace === namespace)
        if (!project) return 0
        return this.ledger.forgetSource(project.id, this.ledger.settings(project.id).approvedBy ?? 'system:source-deletion', sessionId, messageId)
    }
    forgetProject(projectId: string): void { this.ledger.forgetProject(projectId) }
    /** File removal, replacement or newly detected credentials invalidate every derived fact before retrieval. */
    async reconcileSources(projectIds?: string[]): Promise<void> {
        // Explicit request-scoped checks may run alongside the background pass: ledger deletions are idempotent.
        if (!projectIds && this.reconciling) return
        if (!projectIds) this.reconciling = true
        try {
            const projects = this.store.listProjectsForService().filter(project => !projectIds || projectIds.includes(project.id))
            for (const project of projects) {
                const invalid = new Set<string>()
                for (const { itemId, source } of this.ledger.fileSources(project.id)) {
                    if (!['code', 'attachment'].includes(source.kind)) continue
                    try {
                        if (!source.path || memoryHash(await readMemorySource(project.rootPath, source.path, 'legacy')) !== source.hash) invalid.add(itemId)
                    } catch (error) {
                        if (error instanceof MemoryError && [403, 404, 413, 422].includes(error.status)) invalid.add(itemId)
                        else throw error
                    }
                }
                const existing = [...invalid].filter(id => !!this.ledger.get(project.id, id))
                this.ledger.forgetEntries(project.id, existing, this.ledger.settings(project.id).approvedBy ?? 'system:source-deletion')
            }
        } finally { if (!projectIds) this.reconciling = false }
    }
    async hybridSearch(actorId: string, projectIds: string[], query: string, limit = 30, revalidate?: () => Promise<void>) {
        // Revalidate membership immediately before search, including each source before results escape.
        for (const id of projectIds) this.store.requireProject(actorId, id)
        await this.reconcileSources(projectIds)
        const results: Record<string, unknown>[] = []
        for (const projectId of projectIds) {
            // Reconciliation and earlier project queries yield; permissions or
            // capability tokens may have been revoked before the next charge.
            if (revalidate) await revalidate()
            this.store.requireProject(actorId, projectId)
            const settings = this.ledger.settings(projectId)
            if (!settings.enabled || !settings.cloudAllowed) continue
            const operationId = randomUUID()
            const budgetMicros = this.ledger.reserve(projectId, operationId)
            const result = await this.backend.request('/search', { operationId, projects: [{ projectId, generation: settings.generation }], query, limit, budgetMicros })
            if (typeof result.spentMicros !== 'number') throw new MemoryError('Missing memory cost receipt', 502)
            this.ledger.settle(operationId, result.spentMicros)
            if (result.ok === false) throw new MemoryError('Memory search failed', 503)
            this.store.requireProject(actorId, projectId)
            if (settings.generation !== this.ledger.settings(projectId).generation) continue
            if (!Array.isArray(result.results)) throw new MemoryError('Invalid memory graph response', 502)
            for (const candidate of result.results) {
                if (!candidate || typeof candidate !== 'object') continue
                const fact = candidate as Record<string, unknown>
                if (!Array.isArray(fact.memoryIds) || !fact.memoryIds.length) continue
                const items = fact.memoryIds.map(id => this.ledger.get(projectId, String(id)))
                if (items.some(item => !item || item.indexState !== 'indexed')) continue
                for (const item of items) for (const source of item!.sources) this.store.requireProject(actorId, source.projectId)
                results.push({ ...fact, projectId, sources: items.flatMap(item => item!.sources), status: items.every(item => item!.status === 'verified') ? 'verified' : 'proposed' })
            }
        }
        return results.slice(0, limit)
    }
}
