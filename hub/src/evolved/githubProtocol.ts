import { createHash } from 'node:crypto'
import { EvolvedError } from './store'
import { z } from 'zod'

export const GIT_REQUEST_LIMIT = 64 * 1024 * 1024
export const GIT_RESPONSE_LIMIT = 512 * 1024 * 1024
export const GIT_TIMEOUT_MS = 120_000
export type GitOperation = { owner: string; name: string; service: 'git-upload-pack' | 'git-receive-pack'; advertisement: boolean; protocol?: 'version=2' }
export type GitCredentialRequest = { userId: string; projectId: string; operation: 'githubGit'; payload: { git: GitOperation; profile: 'restricted' | 'workspace' | 'extended'; bodyHash: string } }
const credentialSchema = z.object({ userId: z.string().min(1).max(128), projectId: z.string().min(1).max(128), operation: z.literal('githubGit'), payload: z.object({
    git: z.object({ owner: z.string(), name: z.string(), service: z.enum(['git-upload-pack', 'git-receive-pack']), advertisement: z.boolean(), protocol: z.literal('version=2').optional() }).strict(),
    profile: z.enum(['restricted', 'workspace', 'extended']), bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict() })
export function parseGitCredentialRequest(value: unknown): GitCredentialRequest {
    const result = credentialSchema.safeParse(value)
    if (!result.success) throw new EvolvedError('git_capability_invalid', 'Invalid Git transport capability.', 400)
    gitPath(result.data.payload.git)
    return result.data
}

export function githubRepository(value: unknown): { owner: string; name: string } {
    if (typeof value !== 'string') throw new EvolvedError('invalid_repository', 'Use owner/repository, without a URL.')
    const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(value)
    if (!match || ['.', '..'].includes(match[2])) throw new EvolvedError('invalid_repository', 'Use owner/repository, without a URL.')
    return { owner: match[1], name: match[2] }
}

/** Accept only Git's three smart HTTP operations, never arbitrary GitHub paths. */
export function parseGitRequest(request: Request, prefix: string): GitOperation {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(prefix) || url.hash) throw new EvolvedError('git_path_denied', 'Git operation is not allowed.', 403)
    const match = /^([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname.slice(prefix.length))
    if (!match || /%/.test(url.pathname)) throw new EvolvedError('git_path_denied', 'Git operation is not allowed.', 403)
    const repoName = match[2].endsWith('.git') ? match[2].slice(0, -4) : match[2]
    const repository = githubRepository(`${match[1]}/${repoName}`)
    const advertisement = match[3] === 'info/refs'
    const service = advertisement ? url.searchParams.get('service') : match[3]
    if (!['git-upload-pack', 'git-receive-pack'].includes(service ?? '')
        || (advertisement ? request.method !== 'GET' || [...url.searchParams].length !== 1 : request.method !== 'POST' || url.search !== '')
        || (!advertisement && request.headers.get('content-type') !== `application/x-${service}-request`)
        || request.headers.has('content-encoding')) throw new EvolvedError('git_protocol_denied', 'Only uncompressed Git smart HTTP is supported.', 400)
    const protocol = request.headers.get('git-protocol')
    if (protocol && protocol !== 'version=2') throw new EvolvedError('git_protocol_denied', 'Unsupported Git protocol version.', 400)
    return { ...repository, service: service as GitOperation['service'], advertisement, ...(protocol ? { protocol: 'version=2' as const } : {}) }
}

export function gitPath(git: GitOperation): string {
    githubRepository(`${git.owner}/${git.name}`)
    if (!['git-upload-pack', 'git-receive-pack'].includes(git.service) || typeof git.advertisement !== 'boolean'
        || (git.protocol !== undefined && git.protocol !== 'version=2')) throw new EvolvedError('git_protocol_denied', 'Unsupported Git operation.', 400)
    return `${git.owner}/${git.name}.git/${git.advertisement ? `info/refs?service=${git.service}` : git.service}`
}

export function gitBodyHash(body: Uint8Array): string { return createHash('sha256').update(body).digest('hex') }

export async function readGitBody(request: Request, limit = GIT_REQUEST_LIMIT): Promise<Buffer> {
    request.signal.throwIfAborted()
    const declared = request.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new EvolvedError('git_body_too_large', 'Git request exceeds its size limit.', 413)
    const reader = request.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    const chunks: Uint8Array[] = []; let size = 0
    let expired = false
    const timeout = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, GIT_TIMEOUT_MS)
    const abort = () => { void reader.cancel().catch(() => {}) }
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    try {
        while (true) {
            const part = await reader.read()
            request.signal.throwIfAborted()
            if (expired) throw new EvolvedError('git_timeout', 'Git request timed out.', 408)
            if (part.done) return Buffer.concat(chunks, size)
            size += part.value.byteLength
            if (size > limit) throw new EvolvedError('git_body_too_large', 'Git request exceeds its size limit.', 413)
            chunks.push(part.value)
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); reader.releaseLock() }
}

/** Bound bytes without buffering a repository; cleanup on EOF, failure and client cancellation. */
export function boundedGitResponse(response: Response, controller: AbortController, finish: () => void, limit = GIT_RESPONSE_LIMIT): Response {
    const reader = response.body?.getReader()
    let size = 0, closed = false
    const close = () => { if (!closed) { closed = true; controller.signal.removeEventListener('abort', abort); finish() } }
    let sink: ReadableStreamDefaultController<Uint8Array> | undefined
    const abort = () => { void reader?.cancel().catch(() => {}); sink?.error(new Error('Git transfer cancelled')); close() }
    if (!reader) { close(); return new Response(null, { status: response.status, headers: response.headers }) }
    const stream = new ReadableStream<Uint8Array>({
        start(value) { sink = value; controller.signal.addEventListener('abort', abort, { once: true }); if (controller.signal.aborted) abort() },
        async pull(target) {
            try {
                const part = await reader.read()
                if (closed) return
                if (part.done) { target.close(); close(); return }
                size += part.value.byteLength
                if (size > limit) { controller.abort(); return }
                target.enqueue(part.value)
            } catch { if (!closed) { target.error(new Error('Git transfer interrupted')); close() } }
        },
        async cancel() { controller.abort(); await reader.cancel().catch(() => {}); close() },
    })
    return new Response(stream, { status: response.status, headers: response.headers })
}
