import { GIT_TIMEOUT_MS, gitPath, parseGitRequest, type GitOperation } from '../../hub/src/evolved/githubProtocol'

const githubOrigin = 'https://github.com'
const publicEgress = 'http://egress:3128'
const redirects = new Set([301, 302, 307, 308])
export type PublicGitFetcher = (input: string | URL, options: RequestInit & { proxy: string }) => Promise<Response>

/** Public reads do not consume project credentials or require a repository grant.
 * A GitHub authentication/not-found response may fall back to the private broker. */
export async function fetchPublicGit(git: GitOperation, body: Uint8Array, signal: AbortSignal, fetcher: PublicGitFetcher = fetch): Promise<Response | null> {
    if (git.service !== 'git-upload-pack') return null
    if (git.advertisement && body.byteLength !== 0) throw new Error('Invalid public Git advertisement request')
    const headers = new Headers({ 'user-agent': 'HAPI-eVolved/0.1.0', 'accept-encoding': 'identity' })
    if (!git.advertisement) headers.set('content-type', 'application/x-git-upload-pack-request')
    if (git.protocol) headers.set('git-protocol', git.protocol)
    let target = new URL(gitPath(git), githubOrigin)
    for (let hops = 0; ; hops++) {
        signal.throwIfAborted()
        const options: RequestInit & { proxy: string } = {
            method: git.advertisement ? 'GET' : 'POST', headers, body: git.advertisement ? undefined : Buffer.from(body),
            redirect: 'manual', signal, proxy: publicEgress,
        }
        const response = await fetcher(target, options)
        if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted() }
        if ([401, 403, 404].includes(response.status)) { await response.body?.cancel(); return null }
        if (redirects.has(response.status)) {
            await response.body?.cancel()
            const location = response.headers.get('location')
            if (hops >= 3 || !location) throw new Error('Public Git redirect denied')
            const next = new URL(location, target)
            if (next.origin !== githubOrigin || next.username || next.password || next.hash) throw new Error('Public Git redirect denied')
            const operation = parseGitRequest(new Request(next.toString(), { method: options.method, headers }), '/')
            if (operation.service !== git.service || operation.advertisement !== git.advertisement) throw new Error('Public Git redirect denied')
            target = new URL(gitPath(operation), githubOrigin)
            continue
        }
        const type = `application/x-git-upload-pack-${git.advertisement ? 'advertisement' : 'result'}`
        if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim() !== type || response.headers.has('content-encoding')) {
            await response.body?.cancel()
            throw new Error('Public Git transfer failed')
        }
        return new Response(response.body, { headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }
}

/** Public packs have no credential-broker byte/total-duration limit. Keep the
 * transfer pool, backpressure, client cancellation and an inactivity deadline. */
export function streamPublicGit(response: Response, controller: AbortController, finish: () => void, idleTimeoutMs = GIT_TIMEOUT_MS): Response {
    const reader = response.body?.getReader()
    if (!reader) { finish(); return new Response(null, { status: response.status, headers: response.headers }) }
    let timer: ReturnType<typeof setTimeout> | undefined, finished = false
    let sink: ReadableStreamDefaultController<Uint8Array>
    const stop = (error?: Error, cancel = false) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', aborted)
        void reader.cancel().catch(() => {})
        // A disconnected client no longer has a consumer to receive a stream
        // error. Close it quietly while still aborting its upstream fetch.
        if (!cancel) { if (error) sink.error(error); else sink.close() }
        finish()
    }
    const aborted = () => stop()
    const progress = () => {
        clearTimeout(timer)
        timer = setTimeout(() => { stop(new Error('Public Git transfer timed out')); controller.abort() }, idleTimeoutMs)
    }
    const body = new ReadableStream<Uint8Array>({
        start(target) {
            sink = target
            controller.signal.addEventListener('abort', aborted, { once: true })
            if (controller.signal.aborted) aborted(); else progress()
        },
        async pull(target) {
            try {
                const part = await reader.read()
                if (finished) return
                if (part.done) { stop(); return }
                progress(); target.enqueue(part.value)
            } catch {
                if (!finished) { stop(new Error('Public Git transfer interrupted')); controller.abort() }
            }
        },
        cancel() { stop(undefined, true); controller.abort() },
    })
    return new Response(body, { status: response.status, headers: response.headers })
}
