import { open, realpath, stat } from 'node:fs/promises'
import { excludedSourcePath, containsCredential as currentContainsCredential } from '@hapi/protocol/evolvedSourcePolicy'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryError, MemoryLedger, memoryHash, type MemorySource } from './memoryStore'
import { EvolvedStore, EvolvedError } from './store'
import type { MemoryProviderOperation, MemoryProviderResolver } from './memoryProvider'

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
    available(projectId?: string): Promise<boolean>
    prepare?(projectId: string): Promise<void>
    request(path: string, payload: Record<string, unknown>, revalidate?: () => void | Promise<void>): Promise<Record<string, unknown>>
}
class MemoryRequestNotSent extends Error {
    constructor(readonly original: unknown) { super('Memory request was not sent') }
}
export class HttpMemoryBackend implements MemoryBackend {
    constructor(private url?: string, private token?: string, private provider?: MemoryProviderResolver, private using?: MemoryProviderOperation) {}
    async prepare(projectId: string): Promise<void> {
        // First setup must not manufacture an uncertain graph binding by reserving
        // budget for a job whose provider/database is not configured yet.
        if (!await this.available(projectId)) throw new MemoryError('Memory provider or database is not ready', 503)
    }
    async available(projectId?: string): Promise<boolean> {
        if (!this.url || !this.token) return false
        try {
            const config = projectId && this.provider ? await this.provider(projectId) : undefined
            if (config === null) return false
            const response = await fetch(`${this.url}${config ? '/configuration/check' : '/health'}`, {
                method: config ? 'POST' : 'GET', redirect: 'error',
                headers: { authorization: `Bearer ${this.token}`, ...(config ? { 'content-type': 'application/json' } : {}) },
                ...(config ? { body: JSON.stringify({ providerConfig: config }) } : {}), signal: AbortSignal.timeout(5000),
            })
            return response.ok
        }
        catch { return false }
    }
    async request(path: string, payload: Record<string, unknown>, revalidate?: () => void | Promise<void>): Promise<Record<string, unknown>> {
        if (path !== '/ingest' && path !== '/search') {
            if (!this.url || !this.token) throw new MemoryError('Memory graph service is not configured', 503)
            // Reconciliation/deletion never carry provider credentials.
            const { providerConfig: _untrusted, ...base } = payload
            return this.send(path, base)
        }
        let transportStarted = false
        try {
            if (!this.url || !this.token) throw new MemoryError('Memory graph service is not configured', 503)
            const send = (body: Record<string, unknown>) => {
                transportStarted = true
                return this.send(path, body)
            }
            if (this.provider) {
                const projects = payload.projects
                const projectId = path === '/ingest' ? payload.projectId : Array.isArray(projects) && projects.length === 1 ? projects[0]?.projectId : undefined
                if (typeof projectId !== 'string' || !projectId) throw new MemoryError('A single project is required for memory processing', 400)
                const run = async () => {
                    const config = await this.provider!(projectId)
                    if (config === null) throw new MemoryError('Project memory provider is disabled', 503)
                    if (revalidate) await revalidate()
                    const { providerConfig: _untrusted, ...base } = payload
                    return send({ ...base, ...(config ? { providerConfig: config } : {}) })
                }
                return await (this.using ? this.using(projectId, run) : run())
            }
            const { providerConfig: _untrusted, ...base } = payload
            if (revalidate) await revalidate()
            return await send(base)
        } catch (error) {
            if (!transportStarted) throw new MemoryRequestNotSent(error)
            throw error
        }
    }
    private async send(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        let response: Response
        try {
            response = await fetch(`${this.url}${path}`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) })
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
    private async requestWithBudget(projectId: string, operationId: string, path: '/ingest' | '/search', payload: Record<string, unknown>, revalidate: () => void | Promise<void>, taskId?: string): Promise<Record<string, unknown>> {
        const { created, budgetMicros } = this.store.db.transaction(() => {
            // Checking inside the same write transaction also covers a crash between
            // an earlier reserve and the task's reservation_id update.
            const prior = this.store.db.query('SELECT 1 FROM evolved_memory_reservations WHERE id=?').get(operationId)
            const budgetMicros = this.ledger.reserve(projectId, operationId)
            if (taskId) this.ledger.taskReservation(taskId, operationId)
            return { created: !prior, budgetMicros }
        }).immediate()
        try { return await this.backend.request(path, { ...payload, operationId, budgetMicros }, revalidate) }
        catch (error) {
            if (error instanceof MemoryRequestNotSent) {
                if (created) this.store.db.transaction(() => {
                    const removed = this.store.db.query("DELETE FROM evolved_memory_reservations WHERE id=? AND project_id=? AND state='reserved' AND spent_micros=0").run(operationId, projectId)
                    if (removed.changes) this.store.db.query('UPDATE evolved_memory_tasks SET reservation_id=NULL WHERE project_id=? AND reservation_id=?').run(projectId, operationId)
                }).immediate()
                // Retain the original authorization error and its terminal handling.
                throw error.original
            }
            throw error
        }
    }
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
            const revalidate = () => {
                this.store.requireProject(task!.actor_id, task!.project_id, 'member')
                for (const source of item.sources) this.store.requireProject(task!.actor_id, source.projectId)
                const current = this.ledger.settings(task!.project_id)
                if (!current.enabled || !current.cloudAllowed || current.generation !== task!.generation || !this.ledger.get(task!.project_id, item.id)) throw new MemoryError('Memory processing permission or generation changed', 409)
            }
            if (!task.reservation_id && this.backend.prepare) { await this.backend.prepare(task.project_id); revalidate() }
            const reservationId = task.reservation_id ?? task.id
            const result = await this.requestWithBudget(task.project_id, reservationId, '/ingest', { projectId: task.project_id, generation: task.generation,
                memoryId: item.id, title: item.title, body: item.body, sources: item.sources, referenceTime: new Date(item.createdAt).toISOString() }, revalidate, task.id)
            if (typeof result.spentMicros !== 'number') throw new MemoryError('Missing memory cost receipt', 502)
            this.ledger.settle(reservationId, result.spentMicros)
            if (result.ok === false) {
                // A terminal, receipted failure must not be reissued with an already settled budget.
                this.ledger.fail(task, 'Graph extraction failed')
                return true
            }
            this.ledger.complete(task)
            return true
        } catch (error) {
            if (task && error instanceof EvolvedError && [401, 403, 404].includes(error.status)) {
                this.ledger.fail(task, 'Authorization revoked')
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
    /** Session events only invalidate existing provenance; knowledge requires explicit intake. */
    reconcileHubMessage(input: { namespace: string; sessionId: string; messageId: string; content: unknown }): number {
        const project = this.store.listProjectsForService().find(project => project.namespace === input.namespace)
        if (!project) return 0
        const prior = this.ledger.chatSourceHashes(project.id, input.sessionId, input.messageId)
        if (!prior.length) return 0
        const body = JSON.stringify(input.content)
        if (typeof body === 'string' && prior.every(hash => hash === memoryHash(body))) return 0
        return this.ledger.forgetSource(project.id, 'system:source-change', input.sessionId, input.messageId)
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
            const result = await this.requestWithBudget(projectId, operationId, '/search', { projects: [{ projectId, generation: settings.generation }], query, limit }, async () => {
                if (revalidate) await revalidate()
                this.store.requireProject(actorId, projectId)
                const current = this.ledger.settings(projectId)
                if (!current.enabled || !current.cloudAllowed || current.generation !== settings.generation) throw new MemoryError('Memory processing permission or generation changed', 409)
            })
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
