import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import { DevelopmentIdSchema, GitRefSchema, OdooShEnvironmentIdSchema, type OdooShEnvironmentId } from '@hapi/protocol/evolvedDevelopment'
import { DevelopmentModuleActionBodySchema, type DevelopmentModuleActionBody } from '@hapi/protocol/developmentModules'

const repositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/)
const uuidSchema = z.string().uuid()
const REPOSITORY_REQUEST_TIMEOUT_MS = 45_000

export class EvolvedRequestError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly backendAvailable?: boolean) { super(message) }
}
export class EvolvedRepositorySyncError extends Error {
    constructor(readonly requestId: string, readonly reason: unknown) {
        super(`${reason instanceof Error ? reason.message : 'Repository sync request failed'}. Request ID: ${requestId}. Reuse this request ID after checking repository status; do not automatically start a new request.`)
    }
}

export class EvolvedClient {
    readonly base: URL
    constructor(readonly projectId: string, url: string, private readonly tokenFile: string, private readonly fetcher: typeof fetch = fetch) {
        this.base = new URL(url)
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new Error('EVOLVED_PROJECT_ID is required')
        const localProxy = process.env.HAPI_EVOLVED_PROXY === '1' && this.base.hostname === 'runner-proxy' && this.base.port === '3010'
        if (this.base.username || this.base.password || (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && (localProxy || ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname))))) throw new Error('HAPI_EVOLVED_URL requires HTTPS or the isolated runner proxy')
        if (!tokenFile && process.env.HAPI_EVOLVED_PROXY !== '1') throw new Error('HAPI_EVOLVED_CAPABILITY_FILE is required')
    }
    private token(): string {
        if (process.env.HAPI_EVOLVED_PROXY === '1') return 'evolved-local'
        const fd = openSync(this.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
            const st = fstatSync(fd)
            if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || st.size > 256 || (process.getuid && st.uid !== process.getuid())) throw new Error('Capability file must be private (0600) and owned by this user')
            const token = readFileSync(fd, 'utf8').trim()
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid capability file')
            return token
        } finally { closeSync(fd) }
    }
    async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, options?: { timeoutMs?: number }): Promise<unknown> {
        if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new Error('Invalid Evolved API path')
        const response = await this.fetcher(new URL(`/api/evolved${path}`, this.base), {
            method, headers: { ...headers, authorization: `Bearer ${this.token()}`, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(options?.timeoutMs ?? 70_000)
        })
        const payload: unknown = await response.json().catch(() => null)
        if (!response.ok) {
            const detail = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
            throw new EvolvedRequestError(typeof detail.error === 'string' ? detail.error : `Evolved request failed (${response.status})`, response.status,
                typeof detail.code === 'string' ? detail.code : undefined,
                typeof detail.backendAvailable === 'boolean' ? detail.backendAvailable : undefined)
        }
        if (payload === null) throw new Error('Invalid Evolved API response')
        return payload
    }
    projectPath(path: string): string { return `/projects/${encodeURIComponent(this.projectId)}${path}` }
    repositories(workspace = false): Promise<unknown> {
        return this.request(this.projectPath(`/repositories?workspace=${workspace ? '1' : '0'}`), 'GET', undefined, {}, { timeoutMs: REPOSITORY_REQUEST_TIMEOUT_MS })
    }
    async syncRepository(repositoryId: string, action: 'clone' | 'pull', requestId: string = randomUUID()): Promise<unknown> {
        if (!repositoryIdSchema.safeParse(repositoryId).success || !['clone', 'pull'].includes(action) || !uuidSchema.safeParse(requestId).success) {
            throw new Error('Repository sync requires a granted numeric repository ID, clone or pull, and a stable UUID requestId')
        }
        try {
            const payload = await this.request(this.projectPath(`/repositories/${repositoryId}/sync`), 'POST', { action, requestId }, {}, { timeoutMs: REPOSITORY_REQUEST_TIMEOUT_MS })
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid repository sync response')
            return { ...payload, requestId }
        } catch (error) { throw new EvolvedRepositorySyncError(requestId, error) }
    }
    /** Live project development context (data, never instructions). */
    developmentContext(): Promise<unknown> {
        return this.request(this.projectPath('/development/context'), 'GET', undefined, {}, { timeoutMs: 20_000 })
    }
    developmentKnowledge(query: { topic?: string; q?: string; limit?: number } = {}): Promise<unknown> {
        return this.request(this.projectPath(`/development/knowledge${knowledgeSearch(query)}`), 'GET', undefined, {}, { timeoutMs: 20_000 })
    }
    /** Contract v2: active development module (builtin or plugin) with state, digest and applicable content. */
    developmentModulesContext(): Promise<unknown> {
        return this.request(this.projectPath('/development/modules-context'), 'GET', undefined, {}, { timeoutMs: 20_000 })
    }
    developmentModulesKnowledge(query: { topic?: string; q?: string; limit?: number } = {}): Promise<unknown> {
        return this.request(this.projectPath(`/development/modules-knowledge${knowledgeSearch(query)}`), 'GET', undefined, {}, { timeoutMs: 20_000 })
    }
    /** Contract v2 doctor/inspect bound to the module id and digest the caller read from modules-context. */
    developmentModuleAction(action: 'doctor' | 'inspect', binding: DevelopmentModuleActionBody): Promise<unknown> {
        const body = DevelopmentModuleActionBodySchema.parse(binding)
        return this.request(this.projectPath(`/development/modules-${action}`), 'POST', { moduleId: body.moduleId, moduleDigest: body.moduleDigest }, {}, { timeoutMs: action === 'doctor' ? 40_000 : 55_000 })
    }
    /** Explicit target only: a ref, an Odoo.sh environment (its declared branch) or both (must agree). Nothing is inferred. */
    developmentBuildStatus(target: { ref?: string; environment?: OdooShEnvironmentId }): Promise<unknown> {
        const { ref, environment } = target
        if (ref === undefined && environment === undefined) throw new Error('Give a ref (branch or full SHA) or an Odoo.sh environment (staging or production)')
        if (ref !== undefined && !GitRefSchema.safeParse(ref).success) throw new Error('ref must be a full commit SHA or a branch name')
        if (environment !== undefined && !OdooShEnvironmentIdSchema.safeParse(environment).success) throw new Error('environment must be staging or production')
        const query = new URLSearchParams({ ...(ref !== undefined ? { ref } : {}), ...(environment !== undefined ? { environment } : {}) })
        return this.request(this.projectPath(`/development/build-status?${query}`), 'GET', undefined, {}, { timeoutMs: 30_000 })
    }
    /** Fixed read-only runner checks through the Hub; the Hub supplies settings and the authorised checkout. */
    developmentAction(action: 'doctor' | 'inspect'): Promise<unknown> {
        return this.request(this.projectPath(`/development/${action}`), 'POST', {}, {}, { timeoutMs: action === 'doctor' ? 40_000 : 55_000 })
    }
    repositoryJob(jobId: string): Promise<unknown> {
        if (!uuidSchema.safeParse(jobId).success) throw new Error('Repository jobId must be a UUID')
        return this.request(this.projectPath(`/repository-jobs/${jobId}`), 'GET', undefined, {}, { timeoutMs: REPOSITORY_REQUEST_TIMEOUT_MS })
    }
}
function knowledgeSearch(query: { topic?: string; q?: string; limit?: number }): string {
    const topic = query.topic === undefined ? undefined : DevelopmentIdSchema.parse(query.topic)
    const q = query.q === undefined ? undefined : z.string().trim().min(1).max(200).parse(query.q)
    const limit = query.limit === undefined ? undefined : z.number().int().min(1).max(20).parse(query.limit)
    if (topic && q) throw new Error('Use either a topic id or a search query')
    const params = new URLSearchParams()
    if (topic) params.set('topic', topic)
    if (q) params.set('q', q)
    if (limit !== undefined) params.set('limit', String(limit))
    return params.size ? `?${params}` : ''
}
export function evolvedClientFromEnvironment(): EvolvedClient {
    return new EvolvedClient(process.env.EVOLVED_PROJECT_ID ?? '', process.env.HAPI_EVOLVED_URL ?? process.env.HAPI_API_URL ?? 'http://127.0.0.1:3006', process.env.HAPI_EVOLVED_CAPABILITY_FILE ?? '')
}
