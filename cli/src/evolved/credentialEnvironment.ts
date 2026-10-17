import { readCredentialResponse } from '@hapi/protocol/credentialTransport'

/** Undefined entries also override spawnHappyCLI's ambient-environment merge. */
export function withAgentCredentialEnvironment(parent: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv, granted: Record<string, string>): NodeJS.ProcessEnv {
    const result = { ...parent, ...extra }
    if (parent.HAPI_EVOLVED_PROXY === '1') {
        for (const name of Object.keys(result)) if (name.startsWith('PROJECT_SECRET_')) result[name] = undefined
    }
    return { ...result, ...granted }
}

/** Fetch only into a new child's environment. Never mutate the long-lived runner's environment. */
export async function resolveAgentCredentialEnvironment(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<Record<string, string>> {
    if (env.HAPI_EVOLVED_PROXY !== '1') return {}
    try {
        const projectId = env.EVOLVED_PROJECT_ID ?? ''
        const base = new URL(env.HAPI_EVOLVED_URL ?? '')
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId) || base.origin !== 'http://runner-proxy:3010' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error()
        const signal = AbortSignal.timeout(15_000)
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await fetcher(new URL('/evolved-runner-environment', base), {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'error', signal
            })
            if (response.status === 429 && attempt < 2) {
                await response.body?.cancel()
                await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)))
                signal.throwIfAborted()
                continue
            }
            return (await readCredentialResponse(response, projectId)).environment
        }
        throw new Error()
    } catch {
        throw new Error('Project credential delivery unavailable. Check Project Vault agent access and the project service.')
    }
}
