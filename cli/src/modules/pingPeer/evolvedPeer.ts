import { evolvedClientFromEnvironment } from '@/evolved/client'

export function isEvolvedPeerMode(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.HAPI_EVOLVED_PROXY === '1' || Boolean(env.HAPI_EVOLVED_CAPABILITY_FILE)
}
export function peerToolsExposed(env: NodeJS.ProcessEnv = process.env): boolean {
    // In Evolved mode this is discoverability, not authorization. The Hub checks
    // the current project policy and capability scope on every peer request.
    return isEvolvedPeerMode(env) || env.HAPI_PEER_TOOLS !== '0'
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
