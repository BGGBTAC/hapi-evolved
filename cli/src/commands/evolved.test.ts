import { afterEach, expect, it, vi } from 'vitest'
import { EvolvedClient, evolvedClientFromEnvironment } from '@/evolved/client'
import { evolvedCommand } from './evolved'

vi.mock('@/evolved/client', async importOriginal => ({ ...await importOriginal<typeof import('@/evolved/client')>(), evolvedClientFromEnvironment: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
function setup() {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _options?: RequestInit) => Response.json({ job: { id: '768237a3-3378-4384-aaaf-eed31ae931e9', state: 'running' } }))
    const client = new EvolvedClient('test-project', 'http://runner-proxy:3010', '', fetcher as unknown as typeof fetch)
    vi.mocked(evolvedClientFromEnvironment).mockReturnValue(client)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    return { fetcher, output }
}
const run = (...commandArgs: string[]) => evolvedCommand.run({ args: ['evolved', ...commandArgs], subcommand: 'evolved', commandArgs })
it('lists exact repository metadata by default and optionally inspects the project workspace', async () => {
    const t = setup()
    await run('repositories')
    expect(String(t.fetcher.mock.calls[0][0])).toBe('http://runner-proxy:3010/api/evolved/projects/test-project/repositories?workspace=0')
    await run('repositories', '--workspace')
    expect(String(t.fetcher.mock.calls[1][0])).toContain('workspace=1')
    await expect(run('repositories', 'another-project')).rejects.toThrow('Unknown command')
    expect(t.fetcher).toHaveBeenCalledTimes(2)
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
    expect(t.output.mock.calls[0][0]).toContain('hapi evolved sync <clone|pull> <repository-id> [--request-id <UUID>]')
    expect(t.output.mock.calls[0][0]).toContain('no gh or raw token')
    expect(t.fetcher).not.toHaveBeenCalled()
})
