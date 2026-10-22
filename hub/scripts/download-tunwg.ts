/**
 * Download tunwg binaries for all platforms
 *
 * Downloads pinned tunwg binaries from the official GitHub release and verifies
 * each one against the SHA-256 recorded in tunwg-manifest.ts. Existing files
 * are verified too; a mismatch fails instead of being skipped or overwritten.
 * Output directory: shared/tools/tunwg/
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, linkSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TUNWG_ARTIFACTS, TUNWG_LICENSE, TUNWG_RELEASE_TAG, type PinnedArtifact } from './tunwg-manifest'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type DownloadOptions = {
    toolsDir: string
    artifacts?: readonly PinnedArtifact[]
    fetchImpl?: FetchLike
    log?: (message: string) => void
    timeoutMs?: number
}

export class ArtifactVerificationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ArtifactVerificationError'
    }
}

export function defaultArtifacts(): PinnedArtifact[] {
    return [...Object.values(TUNWG_ARTIFACTS), TUNWG_LICENSE]
}

export function sha256Hex(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex')
}

function verifyBytes(artifact: PinnedArtifact, data: Uint8Array, origin: string): void {
    if (data.byteLength !== artifact.size) {
        throw new ArtifactVerificationError(
            `${artifact.fileName} from ${origin}: expected ${artifact.size} bytes, got ${data.byteLength}`
        )
    }
    const actual = sha256Hex(data)
    if (actual !== artifact.sha256) {
        throw new ArtifactVerificationError(
            `${artifact.fileName} from ${origin}: SHA-256 mismatch (expected ${artifact.sha256}, got ${actual})`
        )
    }
}

/**
 * Returns true when a verified file is already present, false when absent.
 * Throws when something exists at the path but does not match the pin.
 */
function checkExisting(artifact: PinnedArtifact, destPath: string): boolean {
    const hint = `Remove it and rerun to fetch ${TUNWG_RELEASE_TAG}.`
    let fd: number
    try {
        fd = openSync(destPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return false
        if (code === 'ELOOP' || code === 'EISDIR') {
            throw new ArtifactVerificationError(`Existing ${destPath} is not a regular file. ${hint}`)
        }
        throw error
    }
    try {
        // Validate and read the same descriptor. Bound allocation even when a
        // file is replaced/grows concurrently, and never block on a FIFO.
        const stats = fstatSync(fd)
        if (!stats.isFile()) {
            throw new ArtifactVerificationError(`Existing ${destPath} is not a regular file`)
        }
        if (stats.size !== artifact.size) {
            throw new ArtifactVerificationError(`${artifact.fileName}: expected ${artifact.size} bytes, got ${stats.size}`)
        }
        const buffer = Buffer.alloc(artifact.size + 1)
        let length = 0
        while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, length)
            if (count === 0) break
            length += count
        }
        verifyBytes(artifact, buffer.subarray(0, length), destPath)
        if (artifact.executable) fchmodSync(fd, 0o755)
        return true
    } catch (error) {
        if (error instanceof ArtifactVerificationError) {
            throw new ArtifactVerificationError(`${error.message}. ${hint}`)
        }
        throw error
    } finally {
        closeSync(fd)
    }
}

async function readBounded(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
    if (!response.body) {
        throw new ArtifactVerificationError(`${url}: empty response body`)
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) {
            break
        }
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            throw new ArtifactVerificationError(`${url}: response exceeds expected ${maxBytes} bytes`)
        }
        chunks.push(value)
    }

    const data = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
    }
    return data
}

async function downloadVerified(
    artifact: PinnedArtifact,
    destPath: string,
    fetchImpl: FetchLike,
    timeoutMs: number,
    log: (message: string) => void
): Promise<void> {
    log(`Downloading ${artifact.url}...`)

    const response = await fetchImpl(artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
        throw new Error(`Failed to download ${artifact.url}: ${response.status} ${response.statusText}`)
    }

    const data = await readBounded(response, artifact.size, artifact.url)
    verifyBytes(artifact, data, artifact.url)

    // Only verified bytes reach the destination, via a temp file and atomic no-clobber publication.
    mkdirSync(dirname(destPath), { recursive: true })
    const tempPath = `${destPath}.download-${randomBytes(6).toString('hex')}`
    let created = false
    try {
        writeFileSync(tempPath, data, { flag: 'wx', mode: artifact.executable ? 0o755 : 0o644 })
        created = true
        if (artifact.executable) {
            chmodSync(tempPath, 0o755)
        }
        // A destination created during the fetch must not be overwritten.
        linkSync(tempPath, destPath)
    } finally {
        if (created) rmSync(tempPath, { force: true })
    }

    log(`  -> ${destPath} (${(data.byteLength / 1024 / 1024).toFixed(2)} MB, sha256 ${artifact.sha256})`)
}

export async function downloadTunwg(options: DownloadOptions): Promise<void> {
    const artifacts = options.artifacts ?? defaultArtifacts()
    const fetchImpl = options.fetchImpl ?? fetch
    const log = options.log ?? console.log
    const timeoutMs = options.timeoutMs ?? 120_000

    for (const artifact of artifacts) {
        const destPath = join(options.toolsDir, artifact.fileName)
        if (checkExisting(artifact, destPath)) {
            log(`Verified existing ${artifact.fileName}`)
            continue
        }
        await downloadVerified(artifact, destPath, fetchImpl, timeoutMs, log)
    }
}

async function main(): Promise<void> {
    const scriptDir = dirname(fileURLToPath(import.meta.url))
    const toolsDir = join(scriptDir, '..', '..', 'shared', 'tools', 'tunwg')

    console.log(`Downloading tunwg ${TUNWG_RELEASE_TAG} binaries...\n`)
    await downloadTunwg({ toolsDir })
    console.log('\nDone!')
}

if (import.meta.main) {
    main().catch((error) => {
        console.error('Error:', error)
        process.exit(1)
    })
}
