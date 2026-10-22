import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEvolvedOperatingContext, getEvolvedLiveAccessContext, getEvolvedOperatingContext, withEvolvedOperatingContext } from './operatingContext'
import { EVOLVED_CAPABILITIES, EVOLVED_CAPABILITY_TOPICS, getEvolvedCapability } from './capabilities'

afterEach(() => vi.unstubAllEnvs())

describe('Evolved operating context boundaries', () => {
    it('automatically supplies every feature summary without embedding the full reference library', () => {
        const context = getEvolvedOperatingContext({ HAPI_EVOLVED_PROXY: '1' })
        for (const topic of EVOLVED_CAPABILITY_TOPICS) {
            const capability = EVOLVED_CAPABILITIES[topic]
            expect(capability.id).toBe(topic)
            expect(context).toContain(`- ${topic} [${capability.access}]: ${capability.summary}`)
            expect(context).not.toContain(capability.details)
        }
        // Instructions are repeated across lifecycle/connection boundaries. Keep
        // the always-present rules/index bounded; details stay in the lookup tool.
        expect(context.length).toBeLessThan(11_000)
        expect(getEvolvedCapability('__proto__')).toBeUndefined()
        expect(getEvolvedCapability('constructor')).toBeUndefined()
    })
    it('resolves managed capability mode at call time without reading credentials or project text', () => {
        vi.stubEnv('HAPI_EVOLVED_PROXY', '')
        vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '')
        expect(getEvolvedOperatingContext()).toBe('')
        vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '/does-not-exist/secret')
        expect(getEvolvedOperatingContext()).toBe(buildEvolvedOperatingContext())
        expect(getEvolvedOperatingContext({ HAPI_EVOLVED_PROXY: '1', EVOLVED_PROJECT_DIRECTORY: 'untrusted project text', CLI_API_TOKEN: 'secret value' })).toBe(buildEvolvedOperatingContext())
        expect(getEvolvedOperatingContext({ EVOLVED_PROJECT_ID: 'alone-is-not-a-capability' })).toBe('')
    })

    it('retains custom instructions and deduplicates repeated resume composition', () => {
        const env = { HAPI_EVOLVED_PROXY: '1' }
        const base = 'Native instructions\nUser instructions\n[HAPI-eVolved operating context v1]'
        const once = withEvolvedOperatingContext(base, env)
        expect(once.startsWith(base)).toBe(true)
        expect(once.endsWith(buildEvolvedOperatingContext())).toBe(true)
        expect(withEvolvedOperatingContext(once, env)).toBe(once)
        expect(withEvolvedOperatingContext(base, {})).toBe(base)
    })

    it('includes only validated live rights and reports an unavailable snapshot without guessing', async () => {
        const client = {
            projectId: 'project-one',
            projectPath: (suffix: string) => `/projects/project-one${suffix}`,
            request: vi.fn(async () => ({ projectId: 'project-one', profile: 'workspace', scopes: ['runner:connect', 'git:read'], peerCommunicationEnabled: true, actionIds: ['resource-1'], token: 'private-token' }))
        } as unknown as import('./client').EvolvedClient
        const env = { HAPI_EVOLVED_PROXY: '1' }
        const context = await getEvolvedLiveAccessContext(client, env)
        expect(context).toContain('profile: workspace; runner scopes: runner:connect, git:read')
        expect(context).toContain('inter-agent communication: enabled')
        expect(context).not.toContain('private-token')
        expect(context).not.toContain('resource-1')
        expect(vi.mocked(client.request)).toHaveBeenCalledWith('/projects/project-one/agent-access', 'GET', undefined, {}, { timeoutMs: 2500 })
        vi.mocked(client.request).mockResolvedValueOnce({ projectId: 'another-project', profile: 'extended', scopes: ['git:write'] })
        expect(await getEvolvedLiveAccessContext(client, env)).toContain('access unavailable')
    })
})
