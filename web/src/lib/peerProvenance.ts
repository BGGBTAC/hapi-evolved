export function parsePeerProvenance(meta: unknown): { trust: 'project-runner'; claimedSenderSessionId: string } | undefined {
    if (!meta || typeof meta !== 'object') return undefined
    const peer = (meta as { peer?: unknown }).peer
    if (!peer || typeof peer !== 'object') return undefined
    const value = peer as Record<string, unknown>
    if (value.trust !== 'project-runner' || typeof value.claimedSenderSessionId !== 'string' || !/^[\w-]{1,128}$/.test(value.claimedSenderSessionId)) return undefined
    return { trust: 'project-runner', claimedSenderSessionId: value.claimedSenderSessionId }
}
