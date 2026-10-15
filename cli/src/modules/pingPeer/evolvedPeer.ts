import { evolvedClientFromEnvironment } from '@/evolved/client'

export function isEvolvedPeerMode(): boolean {
    return process.env.HAPI_EVOLVED_PROXY === '1' || Boolean(process.env.HAPI_EVOLVED_CAPABILITY_FILE)
}
export function peerToolsExposed(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.HAPI_PEER_TOOLS !== '0' && (!(env.HAPI_EVOLVED_PROXY === '1' || env.HAPI_EVOLVED_CAPABILITY_FILE) || env.HAPI_PEER_TOOLS === '1')
}
export function peerScopeAllowed(scope: 'peers:read' | 'peers:send' | 'peers:manage', env: NodeJS.ProcessEnv = process.env): boolean {
    if (!peerToolsExposed(env)) return false
    if (!(env.HAPI_EVOLVED_PROXY === '1' || env.HAPI_EVOLVED_CAPABILITY_FILE)) return true
    return (env.HAPI_PEER_SCOPES ?? '').split(',').includes(scope)
}
export async function initializePeerToolsPolicy(): Promise<boolean> {
    if (!isEvolvedPeerMode()) return peerToolsExposed()
    try {
        const policy = await evolvedClientFromEnvironment().request('/peers/status') as { enabled: boolean; scopes: string[] }
        process.env.HAPI_PEER_SCOPES = Array.isArray(policy.scopes) ? policy.scopes.filter(scope => ['peers:read', 'peers:send', 'peers:manage'].includes(scope)).join(',') : ''
        process.env.HAPI_PEER_TOOLS = policy.enabled && policy.scopes.includes('peers:read') ? '1' : '0'
    } catch { process.env.HAPI_PEER_TOOLS = '0'; process.env.HAPI_PEER_SCOPES = '' }
    return peerToolsExposed()
}
export function claimedPeerSource(explicit?: string): string {
    const source = explicit ?? process.env.HAPI_SESSION_ID
    if (!source) throw new Error('This peer action must run inside a HAPI session.')
    return source
}
export async function spawnEvolvedPeer(options: { remit: string; autoReport?: boolean; agent?: 'claude' | 'codex'; directory?: string; senderSessionId?: string; operationId: string }): Promise<unknown> {
    return evolvedClientFromEnvironment().request('/peers/spawn', 'POST', {
        ...options, senderSessionId: claimedPeerSource(options.senderSessionId), operationId: options.operationId
    })
}
export async function archiveEvolvedPeer(options: { sessionId: string; senderSessionId?: string; operationId: string }): Promise<unknown> {
    return evolvedClientFromEnvironment().request('/peers/archive', 'POST', {
        ...options, senderSessionId: claimedPeerSource(options.senderSessionId), operationId: options.operationId
    })
}
