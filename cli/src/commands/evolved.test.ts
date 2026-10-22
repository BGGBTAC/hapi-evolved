import { afterEach, expect, it, vi } from 'vitest'
import { EvolvedClient, evolvedClientFromEnvironment } from '@/evolved/client'
import { EVOLVED_CAPABILITY_TOPICS, getEvolvedCapability } from '@/evolved/capabilities'
import { buildEvolvedOperatingContext, EVOLVED_OPERATING_CONTEXT_VERSION } from '@/evolved/operatingContext'
import { evolvedCommand } from './evolved'

vi.mock('@/evolved/client', async importOriginal => ({ ...await importOriginal<typeof import('@/evolved/client')>(), evolvedClientFromEnvironment: vi.fn() }))
const originalExitCode = process.exitCode
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); process.exitCode = originalExitCode })
function setup() {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _options?: RequestInit) => Response.json({ job: { id: '768237a3-3378-4384-aaaf-eed31ae931e9', state: 'running' } }))
    const client = new EvolvedClient('test-project', 'http://runner-proxy:3010', '', fetcher as unknown as typeof fetch)
    vi.mocked(evolvedClientFromEnvironment).mockReturnValue(client)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    return { fetcher, output }
}
const run = (...commandArgs: string[]) => evolvedCommand.run({ args: ['evolved', ...commandArgs], subcommand: 'evolved', commandArgs })
function offlineSetup() {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '')
    vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '')
    vi.stubEnv('EVOLVED_PROJECT_ID', '')
    vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:9')
    const createClient = vi.mocked(evolvedClientFromEnvironment).mockClear().mockImplementation(() => { throw new Error('Context must not initialize an API client') })
    const fetcher = vi.fn(() => { throw new Error('Context must not access a Hub') })
    vi.stubGlobal('fetch', fetcher)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
    return { createClient, fetcher, output, error }
}
it.each([false, true])('prints the canonical operating context offline, even with an unreadable capability: %s', async staleCapability => {
    const t = offlineSetup()
    if (staleCapability) vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '/does-not-exist/private-capability')
    await run('context')
    expect(JSON.parse(t.output.mock.calls[0][0])).toEqual({ version: EVOLVED_OPERATING_CONTEXT_VERSION, instructions: buildEvolvedOperatingContext() })
    expect(t.createClient).not.toHaveBeenCalled()
    expect(t.fetcher).not.toHaveBeenCalled()
    expect(t.error).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
    expect(JSON.stringify(t.output.mock.calls)).not.toContain('/does-not-exist/private-capability')
})
it('reads every advertised topic locally without requiring project configuration or a client', async () => {
    const t = offlineSetup()
    for (const topic of EVOLVED_CAPABILITY_TOPICS) {
        await run('context', topic)
        expect(JSON.parse(t.output.mock.calls.at(-1)![0])).toEqual({ version: EVOLVED_OPERATING_CONTEXT_VERSION, topic, instructions: getEvolvedCapability(topic)!.details })
    }
    expect(t.output).toHaveBeenCalledTimes(EVOLVED_CAPABILITY_TOPICS.length)
    expect(t.createClient).not.toHaveBeenCalled()
    expect(t.fetcher).not.toHaveBeenCalled()
})
it.each([['unknown-topic'], [''], ['memory', 'extra']])('rejects invalid context arguments locally with valid topics: %j', async (...args) => {
    const t = offlineSetup()
    await run('context', ...args)
    expect(process.exitCode).toBe(1)
    expect(t.error).toHaveBeenCalledOnce()
    expect(t.error.mock.calls[0][0]).toContain('Usage: hapi evolved context [topic]')
    for (const topic of EVOLVED_CAPABILITY_TOPICS) expect(t.error.mock.calls[0][0]).toContain(topic)
    expect(t.output).not.toHaveBeenCalled()
    expect(t.createClient).not.toHaveBeenCalled()
    expect(t.fetcher).not.toHaveBeenCalled()
})
it('lists exact repository metadata by default and optionally inspects the project workspace', async () => {
    const t = setup()
    await run('repositories')
    expect(String(t.fetcher.mock.calls[0][0])).toBe('http://runner-proxy:3010/api/evolved/projects/test-project/repositories?workspace=0')
    await run('repositories', '--workspace')
    expect(String(t.fetcher.mock.calls[1][0])).toContain('workspace=1')
    await expect(run('repositories', 'another-project')).rejects.toThrow('Unknown command')
    expect(t.fetcher).toHaveBeenCalledTimes(2)
})
it('shows live project access with the local CLI fallback', async () => {
    const t = setup()
    await run('access')
    expect(String(t.fetcher.mock.calls[0][0])).toBe('http://runner-proxy:3010/api/evolved/projects/test-project/agent-access')
    await expect(run('access', 'other-project')).rejects.toThrow('Unknown command')
    expect(t.fetcher).toHaveBeenCalledTimes(1)
})
it('starts clone without UUID boilerplate, allows explicit reconciliation and polls without another POST', async () => {
    const t = setup()
    await run('sync', 'clone', '42')
    const initial = JSON.parse(t.output.mock.calls[0][0])
    expect(initial.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ action: 'clone', requestId: initial.requestId }) })
    await run('sync', 'clone', '42', '--request-id', initial.requestId)
    expect(t.fetcher.mock.calls[1][1]).toMatchObject({ body: JSON.stringify({ action: 'clone', requestId: initial.requestId }) })
    await run('sync', 'status', initial.job.id)
    expect(t.fetcher.mock.calls[2][1]).toMatchObject({ method: 'GET' })
    expect(String(t.fetcher.mock.calls[2][0])).toContain(`/repository-jobs/${initial.job.id}`)
})
it('rejects invalid operation, IDs, mixed options and path injection before any API request', async () => {
    const t = setup()
    for (const args of [['sync', 'push', '42'], ['sync', 'clone', '../42'], ['sync', 'clone', '42', '--request-id', 'invalid'], ['sync', 'pull', '42', '--force'], ['sync', 'status', '../../other'], ['sync', 'clone', '42', '--request-id']]) {
        await expect(run(...args)).rejects.toThrow()
    }
    expect(t.fetcher).not.toHaveBeenCalled()
})
it('prints actionable help without requiring runner credentials or initialization', async () => {
    const t = setup()
    await run('--help')
    expect(t.output.mock.calls[0][0]).toContain('hapi evolved context [topic]')
    expect(t.output.mock.calls[0][0]).toContain('hapi evolved sync <clone|pull> <repository-id> [--request-id <UUID>]')
    expect(t.output.mock.calls[0][0]).toContain('no gh or raw token')
    expect(t.fetcher).not.toHaveBeenCalled()
})
