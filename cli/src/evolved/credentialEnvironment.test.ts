import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { resolveAgentCredentialEnvironment, withAgentCredentialEnvironment } from './credentialEnvironment'

const projectId = 'project-child-test'
const canary = 'synthetic-child-credential-must-never-be-printed'
const unavailable = 'Project credential delivery unavailable. Check Project Vault agent access and the project service.'
const environment = (): NodeJS.ProcessEnv => ({ HAPI_EVOLVED_PROXY: '1', HAPI_EVOLVED_URL: 'http://runner-proxy:3010', EVOLVED_PROJECT_ID: projectId })
const response = (patch: Record<string, unknown> = {}) => Response.json({ projectId, revision: 'b'.repeat(64), environment: { PROJECT_SECRET_CANARY: canary }, ...patch })
const fetcher = (reply: () => Response | Promise<Response> = () => response()) => vi.fn(async () => await reply()) as ReturnType<typeof vi.fn> & typeof fetch

afterEach(() => vi.restoreAllMocks())

async function expectSanitizedFailure(env: NodeJS.ProcessEnv, transport: typeof fetch) {
    let caught: unknown
    try { await resolveAgentCredentialEnvironment(env, transport) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(unavailable)
    expect(String(caught)).not.toContain(canary)
    expect((caught as Error).stack).not.toContain(canary)
}

describe('agent child credential environment', () => {
    it('retries bounded read-only admission contention so simultaneous starts can recover', async () => {
        let calls = 0
        const transport = fetcher(() => ++calls < 3 ? new Response('busy', { status: 429 }) : response())
        expect(await resolveAgentCredentialEnvironment(environment(), transport)).toEqual({ PROJECT_SECRET_CANARY: canary })
        expect(calls).toBe(3)
        const denied = fetcher(() => new Response('busy', { status: 429 }))
        await expectSanitizedFailure(environment(), denied)
        expect(denied).toHaveBeenCalledTimes(3)
    })
    it('explicitly unsets every inherited credential when managed grants are empty, including extra spawn environment', () => {
        const parent = { ...environment(), PROJECT_SECRET_CANARY: 'synthetic-old-value', PROJECT_SECRET_MALFORMED_lower: 'synthetic-old-value', NORMAL_PARENT: 'keep-parent' }
        const extra = { PROJECT_SECRET_EXTRA: 'synthetic-extra-value', NORMAL_EXTRA: 'keep-extra' }
        const child = withAgentCredentialEnvironment(parent, extra, {})
        for (const name of ['PROJECT_SECRET_CANARY', 'PROJECT_SECRET_MALFORMED_lower', 'PROJECT_SECRET_EXTRA']) {
            // Keeping an own undefined property prevents a later ambient spread
            // in spawnHappyCLI from restoring the revoked value.
            expect(Object.hasOwn(child, name)).toBe(true)
            expect(child[name]).toBeUndefined()
        }
        expect(child).toMatchObject({ NORMAL_PARENT: 'keep-parent', NORMAL_EXTRA: 'keep-extra' })
        expect(parent.PROJECT_SECRET_CANARY).toBe('synthetic-old-value')
        expect(extra.PROJECT_SECRET_EXTRA).toBe('synthetic-extra-value')
    })

    it('fresh project grants override both stale parent and extra values without mutating either input', () => {
        const parent = { ...environment(), PROJECT_SECRET_CANARY: 'synthetic-stale-parent' }
        const extra = { PROJECT_SECRET_CANARY: 'synthetic-stale-extra' }
        expect(withAgentCredentialEnvironment(parent, extra, { PROJECT_SECRET_CANARY: canary }).PROJECT_SECRET_CANARY).toBe(canary)
        expect(parent.PROJECT_SECRET_CANARY).toBe('synthetic-stale-parent')
        expect(extra.PROJECT_SECRET_CANARY).toBe('synthetic-stale-extra')
    })

    it('preserves user-owned environment outside managed Evolved mode', () => {
        expect(withAgentCredentialEnvironment({ PROJECT_SECRET_CANARY: 'legacy-parent' }, { PROJECT_SECRET_EXTRA: 'legacy-extra' }, {}))
            .toEqual({ PROJECT_SECRET_CANARY: 'legacy-parent', PROJECT_SECRET_EXTRA: 'legacy-extra' })
    })

    it.each([undefined, '', '0', 'false', 'true'])('does not fetch or require Evolved configuration in legacy mode %s', async flag => {
        const transport = fetcher(() => { throw new Error(canary) })
        expect(await resolveAgentCredentialEnvironment({ HAPI_EVOLVED_PROXY: flag, HAPI_EVOLVED_URL: 'invalid' }, transport)).toEqual({})
        expect(transport).not.toHaveBeenCalled()
    })

    it('uses only the fixed proxy endpoint with no redirects, credential body, or bearer forwarding', async () => {
        const transport = fetcher()
        const env = { ...environment(), HAPI_EVOLVED_TOKEN: 'synthetic-token-must-not-be-forwarded' }
        expect(await resolveAgentCredentialEnvironment(env, transport)).toEqual({ PROJECT_SECRET_CANARY: canary })
        expect(transport).toHaveBeenCalledTimes(1)
        const [url, init] = transport.mock.calls[0] as unknown as [URL, RequestInit]
        expect(url.href).toBe('http://runner-proxy:3010/evolved-runner-environment')
        expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'error' })
        expect(init.signal).toBeInstanceOf(AbortSignal)
        expect(init.signal?.aborted).toBe(false)
        expect(JSON.stringify(init)).not.toContain('synthetic-token')
        expect(JSON.stringify(init)).not.toContain(canary)
    })

    it.each([
        'https://runner-proxy:3010', 'http://runner-proxy', 'http://runner-proxy:3011', 'http://localhost:3010',
        'http://runner-proxy.evil:3010', 'http://runner-proxy:3010@evil.example', 'http://user:password@runner-proxy:3010',
        'http://runner-proxy:3010/not-root', 'http://runner-proxy:3010/?redirect=evil', 'http://runner-proxy:3010/#fragment',
        'file:///etc/passwd', '',
    ])('rejects a non-project proxy destination before fetching: %s', async base => {
        const transport = fetcher()
        await expectSanitizedFailure({ ...environment(), HAPI_EVOLVED_URL: base }, transport)
        expect(transport).not.toHaveBeenCalled()
    })

    it.each(['', '../other-project', 'project/id', 'with space', 'project\nheader', 'a'.repeat(81)])('rejects invalid project binding %s without fetching', async id => {
        const transport = fetcher()
        await expectSanitizedFailure({ ...environment(), EVOLVED_PROJECT_ID: id }, transport)
        expect(transport).not.toHaveBeenCalled()
    })

    it('rejects wrong-project and unsafe-name responses without leaking credential diagnostics', async () => {
        for (const reply of [
            () => response({ projectId: 'other-project' }),
            () => response({ environment: { NODE_OPTIONS: canary } }),
            () => new Response(canary, { status: 502 }),
            () => { throw new Error(canary) },
        ]) await expectSanitizedFailure(environment(), fetcher(reply))
    })

    it('bounds delivery with a deadline and converts abort diagnostics into a static error', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new Error(canary)))
        const transport = vi.fn(async (_url: URL | string, init?: RequestInit) => { init?.signal?.throwIfAborted(); return response() }) as unknown as typeof fetch
        await expectSanitizedFailure(environment(), transport)
        expect(timeout).toHaveBeenCalledWith(15_000)
    })

    it('delivers a synthetic credential to a real child without changing the runner environment or printing the value', async () => {
        expect(Object.hasOwn(process.env, 'PROJECT_SECRET_CANARY')).toBe(false)
        const env = environment()
        const delegated = await resolveAgentCredentialEnvironment(env, fetcher())
        expect(Object.hasOwn(env, 'PROJECT_SECRET_CANARY')).toBe(false)
        expect(Object.hasOwn(process.env, 'PROJECT_SECRET_CANARY')).toBe(false)
        const expectedHash = createHash('sha256').update(canary).digest('hex')
        const parent = { ...env, PROJECT_SECRET_CANARY: 'synthetic-stale-parent', PROJECT_SECRET_REVOKED: 'synthetic-revoked-value' }
        const childEnvironment = withAgentCredentialEnvironment(parent, {}, delegated)
        const script = `const {createHash}=require('node:crypto');const value=process.env.PROJECT_SECRET_CANARY;if('PROJECT_SECRET_REVOKED' in process.env)process.exit(43);if(process.argv[1]==='absent'){if('PROJECT_SECRET_CANARY' in process.env)process.exit(44);process.stdout.write('credential-absent')}else{if(!value||createHash('sha256').update(value).digest('hex')!==process.argv[1])process.exit(42);process.stdout.write('credential-present')}`
        const result = await promisify(execFile)(process.execPath, ['-e', script, expectedHash], {
            env: childEnvironment, timeout: 5_000, maxBuffer: 1024,
        })
        expect(result.stdout).toBe('credential-present')
        expect(result.stderr).toBe('')
        expect(result.stdout).not.toContain(canary)
        const empty = withAgentCredentialEnvironment(parent, {}, {})
        const revoked = await promisify(execFile)(process.execPath, ['-e', script, 'absent'], { env: empty, timeout: 5_000, maxBuffer: 1024 })
        expect(revoked.stdout).toBe('credential-absent')
        expect(revoked.stderr).toBe('')
        expect(parent.PROJECT_SECRET_CANARY).toBe('synthetic-stale-parent')
        expect(Object.hasOwn(process.env, 'PROJECT_SECRET_CANARY')).toBe(false)
    })
})
