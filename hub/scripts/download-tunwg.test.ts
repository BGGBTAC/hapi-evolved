import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactVerificationError, defaultArtifacts, downloadTunwg, sha256Hex } from './download-tunwg'
import { TUNWG_ARTIFACTS, TUNWG_LICENSE, TUNWG_RELEASE_COMMIT, type PinnedArtifact } from './tunwg-manifest'

const encoder = new TextEncoder()
const GOOD = encoder.encode('synthetic tunwg binary v1')
const TAMPERED = encoder.encode('synthetic tunwg binary v2')

function artifact(overrides: Partial<PinnedArtifact> = {}): PinnedArtifact {
    return {
        fileName: 'tunwg-x64-linux',
        url: 'https://example.invalid/tunwg',
        sha256: sha256Hex(GOOD),
        size: GOOD.byteLength,
        executable: true,
        ...overrides
    }
}

type Call = { url: string; init: RequestInit }

function fakeFetch(responses: Record<string, () => Response>) {
    const calls: Call[] = []
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
        calls.push({ url, init })
        const make = responses[url]
        if (!make) {
            return new Response('not found', { status: 404, statusText: 'Not Found' })
        }
        return make()
    }
    return { fetchImpl, calls }
}

let toolsDir: string
const quiet = () => {}
const realFetch = globalThis.fetch

beforeEach(() => {
    toolsDir = mkdtempSync(join(tmpdir(), 'tunwg-download-test-'))
    // Guard: these tests must never reach the network.
    globalThis.fetch = (async () => {
        throw new Error('unexpected real network call')
    }) as unknown as typeof fetch
})

afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(toolsDir, { recursive: true, force: true })
})

function leftovers(): string[] {
    return existsSync(toolsDir) ? readdirSync(toolsDir).filter((name) => name.includes('.download-')) : []
}

describe('pinned tunwg manifest', () => {
    it('keeps the supported five-platform matrix with dev file names', () => {
        expect(Object.keys(TUNWG_ARTIFACTS).sort()).toEqual(
            ['arm64-darwin', 'arm64-linux', 'x64-darwin', 'x64-linux', 'x64-win32']
        )
        for (const [platform, pinned] of Object.entries(TUNWG_ARTIFACTS)) {
            const isWin = platform.includes('win32')
            expect(pinned.fileName).toBe(`tunwg-${platform}${isWin ? '.exe' : ''}`)
            expect(pinned.executable).toBe(!isWin)
        }
    })

    it('pins immutable release URLs and well-formed digests', () => {
        for (const pinned of defaultArtifacts()) {
            expect(pinned.url.startsWith('https://')).toBe(true)
            expect(pinned.url).not.toContain('/latest/')
            expect(pinned.url).not.toContain('refs/heads')
            expect(pinned.sha256).toMatch(/^[0-9a-f]{64}$/)
            expect(pinned.size).toBeGreaterThan(0)
        }
        expect(TUNWG_LICENSE.url).toContain(TUNWG_RELEASE_COMMIT)
    })

    it('matches the committed LICENSE', () => {
        const committed = readFileSync(join(import.meta.dir, '..', '..', 'shared', 'tools', 'tunwg', 'LICENSE'))
        expect(committed.byteLength).toBe(TUNWG_LICENSE.size)
        expect(sha256Hex(committed)).toBe(TUNWG_LICENSE.sha256)
    })
})

describe('downloadTunwg', () => {
    it('writes a verified download as an executable file', async () => {
        const pinned = artifact()
        const { fetchImpl, calls } = fakeFetch({ [pinned.url]: () => new Response(GOOD) })

        await downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl, log: quiet })

        const dest = join(toolsDir, pinned.fileName)
        expect(new Uint8Array(readFileSync(dest))).toEqual(GOOD)
        if (process.platform !== 'win32') {
            expect(statSync(dest).mode & 0o777).toBe(0o755)
        }
        expect(calls).toHaveLength(1)
        expect(calls[0].init.redirect).toBe('follow')
        expect(leftovers()).toEqual([])
    })

    it('creates the tools directory when missing', async () => {
        const pinned = artifact({ fileName: 'LICENSE', executable: false })
        const nested = join(toolsDir, 'shared', 'tools', 'tunwg')
        const { fetchImpl } = fakeFetch({ [pinned.url]: () => new Response(GOOD) })

        await downloadTunwg({ toolsDir: nested, artifacts: [pinned], fetchImpl, log: quiet })

        expect(new Uint8Array(readFileSync(join(nested, 'LICENSE')))).toEqual(GOOD)
    })

    it('rejects a tampered response without writing anything', async () => {
        const pinned = artifact()
        const { fetchImpl } = fakeFetch({ [pinned.url]: () => new Response(TAMPERED) })

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl, log: quiet }))
            .rejects.toThrow(/SHA-256 mismatch/)

        expect(existsSync(join(toolsDir, pinned.fileName))).toBe(false)
        expect(leftovers()).toEqual([])
    })

    it('rejects an oversized response without writing anything', async () => {
        const pinned = artifact()
        const oversized = new Uint8Array(GOOD.byteLength + 1024)
        const { fetchImpl } = fakeFetch({ [pinned.url]: () => new Response(oversized) })

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl, log: quiet }))
            .rejects.toThrow(/exceeds expected/)

        expect(existsSync(join(toolsDir, pinned.fileName))).toBe(false)
    })

    it('rejects a truncated response', async () => {
        const pinned = artifact()
        const { fetchImpl } = fakeFetch({ [pinned.url]: () => new Response(GOOD.slice(0, 5)) })

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl, log: quiet }))
            .rejects.toBeInstanceOf(ArtifactVerificationError)

        expect(existsSync(join(toolsDir, pinned.fileName))).toBe(false)
    })

    it('fails on HTTP errors and missing release assets', async () => {
        const pinned = artifact()
        const missing = fakeFetch({})
        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl: missing.fetchImpl, log: quiet }))
            .rejects.toThrow(/404 Not Found/)

        const failing = fakeFetch({
            [pinned.url]: () => new Response('boom', { status: 502, statusText: 'Bad Gateway' })
        })
        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl: failing.fetchImpl, log: quiet }))
            .rejects.toThrow(/502 Bad Gateway/)

        expect(existsSync(join(toolsDir, pinned.fileName))).toBe(false)
    })

    it('propagates network errors', async () => {
        const pinned = artifact()
        const fetchImpl = async (): Promise<Response> => {
            throw new TypeError('network down')
        }

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl, log: quiet }))
            .rejects.toThrow('network down')
        expect(existsSync(join(toolsDir, pinned.fileName))).toBe(false)
    })

    it('keeps a valid existing file without a network call', async () => {
        const pinned = artifact()
        const dest = join(toolsDir, pinned.fileName)
        writeFileSync(dest, GOOD, { mode: 0o644 })
        const { fetchImpl, calls } = fakeFetch({})

        await downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl, log: quiet })

        expect(calls).toHaveLength(0)
        expect(new Uint8Array(readFileSync(dest))).toEqual(GOOD)
        if (process.platform !== 'win32') {
            expect(statSync(dest).mode & 0o777).toBe(0o755)
        }
    })

    it('fails closed on a wrong existing file and leaves it untouched', async () => {
        const pinned = artifact()
        const dest = join(toolsDir, pinned.fileName)
        writeFileSync(dest, TAMPERED)
        const { fetchImpl, calls } = fakeFetch({ [pinned.url]: () => new Response(GOOD) })

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl, log: quiet }))
            .rejects.toThrow(/SHA-256 mismatch.*Remove it and rerun/)

        expect(calls).toHaveLength(0)
        expect(new Uint8Array(readFileSync(dest))).toEqual(TAMPERED)
    })

    it('fails closed on an existing file of the wrong size', async () => {
        const pinned = artifact()
        writeFileSync(join(toolsDir, pinned.fileName), new Uint8Array(0))

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl: fakeFetch({}).fetchImpl, log: quiet }))
            .rejects.toThrow(/expected \d+ bytes, got 0/)
    })

    it('rejects a non-regular existing path', async () => {
        const pinned = artifact()
        mkdirSync(join(toolsDir, pinned.fileName))

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl: fakeFetch({}).fetchImpl, log: quiet }))
            .rejects.toThrow(/not a regular file/)
    })

    it.skipIf(process.platform === 'win32')('rejects a symlink even to valid content', async () => {
        const pinned = artifact()
        const target = join(toolsDir, 'elsewhere')
        writeFileSync(target, GOOD)
        symlinkSync(target, join(toolsDir, pinned.fileName))

        await expect(downloadTunwg({ toolsDir, artifacts: [pinned], fetchImpl: fakeFetch({}).fetchImpl, log: quiet }))
            .rejects.toThrow(/not a regular file/)
    })

    it('stops at the first failing artifact', async () => {
        const first = artifact({ fileName: 'tunwg-x64-linux', url: 'https://example.invalid/a' })
        const second = artifact({ fileName: 'tunwg-arm64-linux', url: 'https://example.invalid/b' })
        const { fetchImpl, calls } = fakeFetch({
            [first.url]: () => new Response(TAMPERED),
            [second.url]: () => new Response(GOOD)
        })

        await expect(downloadTunwg({ toolsDir, artifacts: [first, second], fetchImpl, log: quiet }))
            .rejects.toBeInstanceOf(ArtifactVerificationError)

        expect(calls.map((call) => call.url)).toEqual([first.url])
        expect(existsSync(join(toolsDir, second.fileName))).toBe(false)
    })
})
