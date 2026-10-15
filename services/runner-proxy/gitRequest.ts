import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { EvolvedError } from '../../hub/src/evolved/store'
import { GIT_REQUEST_LIMIT, parseGitRequest, readGitBody, type GitOperation } from '../../hub/src/evolved/githubProtocol'

export type RunnerGitRequest = { git: GitOperation; gzip: boolean }

/** Git compresses multi-ref fetch negotiations. Normalize only that read operation
 * at the local boundary; Hub/Vault still authorize and sign plain bounded bytes. */
export function parseRunnerGitRequest(request: Request, prefix: string): RunnerGitRequest {
    const encoding = request.headers.get('content-encoding')
    if (encoding === null) return { git: parseGitRequest(request, prefix), gzip: false }
    if (encoding !== 'gzip') throw new EvolvedError('git_protocol_denied', 'Unsupported Git content encoding.', 400)
    const headers = new Headers(request.headers)
    headers.delete('content-encoding'); headers.delete('content-length')
    // This is metadata only: do not tee, consume or decode an unvalidated route.
    const git = parseGitRequest(new Request(request.url, { method: request.method, headers }), prefix)
    if (git.advertisement || git.service !== 'git-upload-pack' || request.method !== 'POST') {
        throw new EvolvedError('git_protocol_denied', 'Compressed requests are supported only for Git fetch.', 400)
    }
    return { git, gzip: true }
}

export async function readRunnerGitBody(request: Request, parsed: RunnerGitRequest,
    limits: { wire?: number; expanded?: number } = {}): Promise<Buffer> {
    const wireLimit = limits.wire ?? GIT_REQUEST_LIMIT, expandedLimit = limits.expanded ?? GIT_REQUEST_LIMIT
    if (!parsed.gzip) return readGitBody(request, Math.min(wireLimit, expandedLimit))
    request.signal.throwIfAborted()
    const declared = request.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > wireLimit)) {
        throw new EvolvedError('git_body_too_large', 'Git request exceeds its size limit.', 413)
    }
    const reader = request.body?.getReader()
    if (!reader) throw new EvolvedError('git_body_invalid', 'Invalid compressed Git request.', 400)
    const cancelInput = () => { void reader.cancel().catch(() => {}) }
    request.signal.addEventListener('abort', cancelInput, { once: true })
    if (request.signal.aborted) cancelInput()
    let wireBytes = 0, expandedBytes = 0
    const chunks: Buffer[] = []
    const source = Readable.from((async function* () {
        try {
            while (true) {
                const part = await reader.read()
                request.signal.throwIfAborted()
                if (part.done) break
                wireBytes += part.value.byteLength
                if (wireBytes > wireLimit) throw new EvolvedError('git_body_too_large', 'Git request exceeds its size limit.', 413)
                yield part.value
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    })(), { objectMode: false, highWaterMark: 64 * 1024 })
    const decoder = createGunzip({ chunkSize: 64 * 1024 })
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
        expandedBytes += chunk.byteLength
        if (expandedBytes > expandedLimit) callback(new EvolvedError('git_body_too_large', 'Expanded Git request exceeds its size limit.', 413))
        else { chunks.push(chunk); callback() }
    } })
    // An output/decoder error must also unblock a pending network read, even if
    // the peer never finishes sending its compressed request.
    for (const stream of [source, decoder, sink]) stream.once('error', cancelInput)
    try {
        await pipeline(source, decoder, sink, { signal: request.signal })
        request.signal.throwIfAborted()
        return Buffer.concat(chunks, expandedBytes)
    } catch (error) {
        request.signal.throwIfAborted()
        if (error instanceof EvolvedError) throw error
        throw new EvolvedError('git_body_invalid', 'Invalid compressed Git request.', 400)
    } finally {
        request.signal.removeEventListener('abort', cancelInput)
        source.destroy(); decoder.destroy(); sink.destroy()
        await reader.cancel().catch(() => {})
    }
}
