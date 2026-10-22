import type { AgentProfile } from './store'

/** Built-in project services supplied to every managed runner. External resource
 * actions still need a separately selected resource:execute scope and action IDs. */
export function standardRunnerScopes(profile: AgentProfile): string[] {
    return [
        'runner:connect', 'git:read', 'memory:read', 'memory:write', 'codegraph:read',
        'peers:read', 'peers:send', 'peers:manage',
        ...(profile === 'restricted' ? [] : ['git:write']),
    ]
}
