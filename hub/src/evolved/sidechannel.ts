import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { SyncEngine } from '../sync/syncEngine'
import { EvolvedError, EvolvedStore, privateFile } from './store'
import { assertOrigin, authenticateEvolvedRequest, parseBody, requireHuman, type EvolvedEnv } from './security'

const maxInputChars = 8000, maxOutputTokens = 1024, maxResponseBytes = 65_536
export type SidechannelConfig = { url: string; model: string; key: string; dailyTokens: number }
export function sidechannelConfig(env: NodeJS.ProcessEnv = process.env): SidechannelConfig | null {
    if (env.EVOLVED_SIDECHANNEL_ADAPTER !== 'openai-chat-completions-v1') return null
    try {
        const url = new URL(env.EVOLVED_SIDECHANNEL_URL ?? '')
        const local = env.EVOLVED_SIDECHANNEL_ALLOW_LOOPBACK_HTTP === '1' && ['127.0.0.1', '[::1]'].includes(url.hostname)
        if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return null
        const model = env.EVOLVED_SIDECHANNEL_MODEL ?? '', dailyTokens = Number(env.EVOLVED_SIDECHANNEL_DAILY_TOKENS)
        if (!model.trim() || model.length > 200 || /[\x00-\x1f\x7f]/.test(model) || !Number.isSafeInteger(dailyTokens) || dailyTokens < 33_280 || dailyTokens > 100_000_000) return null
        const bytes = privateFile(env.EVOLVED_SIDECHANNEL_KEY_FILE ?? '')
        if (bytes.length > 4096) return null
        const key = bytes.toString('utf8').replace(/\r?\n$/, '')
        if (!/^[\x21-\x7e]+$/.test(key)) return null
        return { url: url.toString(), model, dailyTokens, key }
    } catch { return null }
}

export type SidechannelFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
type Usage = { usedTokens: number | null; usageAnomaly: boolean; reply: string; truncated: boolean }
/** Fixed adapter contract, not a general provider SDK. No tool execution or context. */
export async function requestSidechannel(config: SidechannelConfig, text: string, fetcher: SidechannelFetch = fetch): Promise<Usage> {
    const response = await fetcher(config.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: text }], max_tokens: maxOutputTokens, stream: false })
    })
    if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
        await response.body?.cancel(); throw new EvolvedError('provider_error', 'The configured side provider rejected the request.', 502)
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try {
        while (true) {
            const next = await reader.read(); if (next.done) break
            size += next.value.byteLength
            if (size > maxResponseBytes) throw new EvolvedError('provider_error', 'Side provider response exceeded the size limit.', 502)
            chunks.push(next.value)
        }
    } finally { await reader.cancel().catch(() => undefined) }
    let value: { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown; function_call?: unknown }; finish_reason?: string }>; usage?: Record<string, unknown> }
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new EvolvedError('provider_error', 'Invalid side provider response.', 502) }
    const usage = value.usage, integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    const sum = integer(usage?.prompt_tokens) && integer(usage?.completion_tokens) ? usage.prompt_tokens + usage.completion_tokens : null
    const candidates = [sum, usage?.total_tokens].filter(integer)
    const usedTokens = candidates.length ? Math.max(...candidates) : null
    const usageAnomaly = [usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens, sum]
        .some(value => value !== undefined && value !== null && !integer(value))
    const choice = value.choices?.[0], message = choice?.message
    // Preserve usage even when the provider violated the text-only contract.
    return { usedTokens, usageAnomaly, reply: typeof message?.content === 'string' && !message.tool_calls && !message.function_call
        ? message.content.replace(/[\u202a-\u202e\u2066-\u2069]/g, '') : '', truncated: choice?.finish_reason === 'length' }
}

export class SidechannelService {
    readonly configId: string
    constructor(readonly store: EvolvedStore, readonly config: SidechannelConfig | null, private fetcher: SidechannelFetch = fetch) {
        this.configId = createHash('sha256').update(JSON.stringify(config ? [config.url, config.model, config.dailyTokens] : [])).digest('hex')
        store.db.exec(`CREATE TABLE IF NOT EXISTS evolved_sidechannel_ops (
            project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,
            actor_id TEXT NOT NULL REFERENCES evolved_users(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL, utc_day TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL,
            state TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER,
            PRIMARY KEY(project_id,actor_id,request_id));
            CREATE INDEX IF NOT EXISTS evolved_sidechannel_budget ON evolved_sidechannel_ops(project_id,utc_day);
            CREATE TABLE IF NOT EXISTS evolved_sidechannel_blocked(config_id TEXT PRIMARY KEY);`)
    }
    private day() { return new Date(this.store.now()).toISOString().slice(0, 10) }
    status(projectId: string, utcDay = this.day()) {
        const enabled = !!this.config && !this.store.db.prepare('SELECT 1 FROM evolved_sidechannel_blocked WHERE config_id=?').get(this.configId)
        const spent = (this.store.db.prepare('SELECT COALESCE(SUM(charged),0) AS n FROM evolved_sidechannel_ops WHERE project_id=? AND utc_day=?').get(projectId, utcDay) as { n: number }).n
        return { enabled, model: this.config?.model ?? null, provider: this.config ? new URL(this.config.url).origin : null,
            remainingTokens: this.config ? Math.max(0, this.config.dailyTokens - spent) : 0, maxInputChars, maxOutputTokens }
    }
    async ask(projectId: string, actorId: string, requestId: string, text: string, revalidate: () => Promise<void>) {
        const config = this.config
        if (!config || !this.status(projectId).enabled) throw new EvolvedError('disabled', 'The text side channel is not configured or has been disabled.', 503)
        const reserved = Buffer.byteLength(text) + maxOutputTokens + 256
        this.store.db.transaction(() => {
            const now = this.store.now(), utcDay = new Date(now).toISOString().slice(0, 10)
            const prior = this.store.db.prepare('SELECT state FROM evolved_sidechannel_ops WHERE project_id=? AND actor_id=? AND request_id=?').get(projectId, actorId, requestId) as { state: string } | null
            if (prior) throw new EvolvedError(prior.state === 'done' ? 'already_completed' : 'indeterminate', 'This request was already accepted. It will not be sent again.', 409)
            // Persistent leases also bound concurrency across multiple hub processes.
            const inflight = this.store.db.prepare("SELECT project_id,actor_id FROM evolved_sidechannel_ops WHERE state='pending' AND created_at>?").all(now - 60_000) as Array<{ project_id: string; actor_id: string }>
            if (inflight.length >= 4 || inflight.some(row => row.actor_id === actorId)) throw new EvolvedError('busy', 'A side request is still running. Try later.', 429)
            if (!this.status(projectId, utcDay).enabled) throw new EvolvedError('disabled', 'Side provider is disabled.', 503)
            if (this.status(projectId, utcDay).remainingTokens < reserved) throw new EvolvedError('quota', 'The daily side-channel token budget is exhausted.', 429)
            this.store.db.prepare("INSERT INTO evolved_sidechannel_ops VALUES(?,?,?,?,?,?,'pending',?,NULL)").run(projectId, actorId, requestId, utcDay, reserved, reserved, now)
        }).immediate()
        const settle = (state: string, charged: number) => this.store.db.prepare('UPDATE evolved_sidechannel_ops SET state=?,charged=?,settled_at=? WHERE project_id=? AND actor_id=? AND request_id=?').run(state, charged, this.store.now(), projectId, actorId, requestId)
        try { await revalidate() } catch (error) { settle('released', 0); throw error }
        let result: Usage
        try { result = await requestSidechannel(config, text, this.fetcher) }
        catch { settle('indeterminate', reserved); throw new EvolvedError('provider_error', 'The side request could not be confirmed. Its budget reservation is retained.', 502) }
        const usage = result.usedTokens
        const validUsage = usage !== null && Number.isSafeInteger(usage) && usage >= 0
        this.store.db.transaction(() => {
            settle('done', result.usageAnomaly ? Math.max(config.dailyTokens, usage ?? 0) : validUsage ? usage! : reserved)
            if (result.usageAnomaly || (validUsage && usage! > reserved)) this.store.db.prepare('INSERT OR IGNORE INTO evolved_sidechannel_blocked VALUES(?)').run(this.configId)
        })()
        await revalidate()
        if (!result.reply) throw new EvolvedError('provider_error', 'The side provider returned no text-only answer.', 502)
        return { reply: result.reply, model: config.model, usedTokens: validUsage ? usage : null, truncated: result.truncated }
    }
}

export function createSidechannelRoutes(service: SidechannelService, getEngine: () => SyncEngine | null, origin: string): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>(), path = '/projects/:id/sidechannel', { store } = service
    app.use(path, bodyLimit({ maxSize: 200_000 })) // JSON escapes may expand the 32 KB text limit.
    app.use(path, async (c, next) => {
        if (c.req.header('authorization')) throw new EvolvedError('forbidden', 'Only human browser sessions may use the side channel.', 403)
        assertOrigin(c.req.raw, origin)
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal); store.requireProject(principal.user.id, c.req.param('id')!, 'member')
        c.set('principal', principal); return next()
    })
    app.get(path, c => c.json(service.status(c.req.param('id'))))
    app.post(path, async c => {
        if (!/^application\/json(?:;|$)/i.test(c.req.header('content-type') ?? '')) throw new EvolvedError('invalid_body', 'JSON request required.')
        const body = await parseBody(c, z.object({ sessionId: z.string().min(1).max(128), requestId: z.string().uuid(), text: z.string().min(1).max(16_000)
            .refine(value => !!value.trim() && [...value].length <= maxInputChars && Buffer.byteLength(value) <= 32_000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) }).strict())
        const actorId = c.get('principal').user.id, projectId = c.req.param('id')
        const revalidate = async () => {
            const current = await authenticateEvolvedRequest(c.req.raw, store)
            if (!current || current.user.id !== actorId || current.capability) throw new EvolvedError('forbidden', 'Authorization expired.', 403)
            const project = store.requireProject(actorId, projectId, 'member')
            if (!getEngine()?.getSessionByNamespace(body.sessionId, project.namespace)) throw new EvolvedError('forbidden', 'Session is unavailable in this project.', 403)
        }
        await revalidate()
        return c.json(await service.ask(projectId, actorId, body.requestId, body.text, revalidate))
    })
    return app
}
