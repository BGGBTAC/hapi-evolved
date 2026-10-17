import { describe, expect, test } from 'bun:test'
import { readCredentialResponse } from './credentialTransport'

const projectId = 'project-transport-test'
const canary = 'synthetic-transport-secret-must-not-appear-in-errors'
const unavailable = 'Project credential delivery unavailable. Check Project Vault agent access and the project service.'
const bundle = (environment: Record<string, unknown> = { PROJECT_SECRET_CANARY: canary }) => ({
    projectId, revision: 'a'.repeat(64), environment,
})

async function expectSanitizedFailure(response: Response, expectedProject = projectId) {
    let caught: unknown
    try { await readCredentialResponse(response, expectedProject) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(unavailable)
    expect(String(caught)).not.toContain(canary)
    expect((caught as Error).stack).not.toContain(canary)
}

describe('project credential response boundary', () => {
    test('validates the project and preserves UTF-8 values across arbitrary stream boundaries', async () => {
        const original = bundle({ PROJECT_SECRET_CANARY: `${canary}ä🔒\nquoted"` })
        const bytes = new TextEncoder().encode(JSON.stringify(original))
        let offset = 0
        const response = new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset === bytes.length) return controller.close()
                const end = Math.min(offset + 3, bytes.length)
                controller.enqueue(bytes.slice(offset, end))
                offset = end
            },
        }))
        expect(await readCredentialResponse(response, projectId)).toEqual({ revision: original.revision, environment: original.environment })
        expect(response.body?.locked).toBe(false)
    })

    test('accepts an explicitly empty grant bundle without guessing inherited credentials', async () => {
        expect(await readCredentialResponse(Response.json(bundle({})), projectId)).toEqual({ revision: 'a'.repeat(64), environment: {} })
    })

    test('stops and cancels an oversized streaming body before parsing or reading indefinitely', async () => {
        let produced = 0, cancelled = false
        const chunkBytes = 16_384
        const response = new Response(new ReadableStream<Uint8Array>({
            pull(controller) { produced += chunkBytes; controller.enqueue(new Uint8Array(chunkBytes).fill(65)) },
            cancel() { cancelled = true },
        }, { highWaterMark: 0 }))
        await expectSanitizedFailure(response)
        expect(cancelled).toBe(true)
        expect(produced).toBeGreaterThan(6 * 64 * 1024 + 8192)
        expect(produced).toBeLessThanOrEqual(6 * 64 * 1024 + 8192 + 2 * chunkBytes)
        expect(response.body?.locked).toBe(false)
    })

    test('rejects a valid response for another project without exposing its values', async () => {
        await expectSanitizedFailure(Response.json(bundle()), 'another-project')
    })

    test('does not expose non-success, malformed JSON or stream diagnostics', async () => {
        await expectSanitizedFailure(new Response(canary, { status: 403 }))
        await expectSanitizedFailure(new Response(`invalid-json-${canary}`))
        await expectSanitizedFailure(new Response(null, { status: 204 }))
        await expectSanitizedFailure(new Response(new ReadableStream({ start(controller) { controller.error(new Error(canary)) } })))
    })

    test('rejects loader, network, provider and malformed environment names', async () => {
        for (const name of ['PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'EVOLVED_PROJECT_ID', 'PROJECT_SECRET_', 'PROJECT_SECRET_lowercase', 'PROJECT_SECRET_A\nPATH', `PROJECT_SECRET_${'A'.repeat(66)}`, '__proto__']) {
            await expectSanitizedFailure(Response.json(bundle(Object.fromEntries([[name, canary]]))))
        }
    })

    test('rejects NUL, non-string values, excessive grants, excessive bytes and extra metadata', async () => {
        const invalid = [
            bundle({ PROJECT_SECRET_CANARY: `${canary}\0` }),
            bundle({ PROJECT_SECRET_CANARY: { private: canary } }),
            bundle({ PROJECT_SECRET_CANARY: `${canary}${'x'.repeat(64 * 1024)}` }),
            bundle(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`PROJECT_SECRET_KEY_${i}`, canary]))),
            { ...bundle(), revision: canary },
            { ...bundle(), privateDiagnostic: canary },
            [bundle()],
        ]
        for (const value of invalid) await expectSanitizedFailure(Response.json(value))
    })
})
