import { afterEach, expect, it, vi } from 'vitest'
import { initializePeerToolsPolicy, peerToolsExposed, peerScopeAllowed } from './evolvedPeer'
import { listPeerSessions, searchPeerSessions, pingPeer, inspectPeer } from './pingPeer'
import { getSystemPrompt } from '@/claude/utils/systemPrompt'
import { getCodexSystemPrompt } from '@/codex/utils/systemPrompt'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it('Evolved peer transport uses scoped endpoints and never exchanges an owner credential', async () => {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1'); vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:9999'); vi.stubEnv('EVOLVED_PROJECT_ID', 'project'); vi.stubEnv('HAPI_SESSION_ID', 'sender')
    const calls: Array<{ path: string; body: unknown }> = []
    const peer = { id: 'aaaaaaaa-1111-1111-1111-111111111111', active: true, metadata: { name: 'Peer', flavor: 'codex' } }
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
        calls.push({ path: url.pathname, body: options.body ? JSON.parse(String(options.body)) : undefined })
        const value = url.pathname.endsWith('/status') ? { enabled: true, scopes: ['peers:read', 'peers:send'] }
            : url.pathname.endsWith('/messages') ? { sessionId: peer.id, resumed: false, name: 'Peer' }
            : url.pathname.endsWith(peer.id) ? { session: peer, messages: [] } : { sessions: [peer] }
        return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    }))
    expect(await initializePeerToolsPolicy()).toBe(true)
    expect(await listPeerSessions()).toHaveLength(1)
    expect(await searchPeerSessions({ query: 'Peer' })).toHaveLength(1)
    expect((await pingPeer({ sessionIdPrefix: 'aaaaaaaa', message: '/clear', deliveryId: 'reusable' })).sessionId).toBe(peer.id)
    expect((await inspectPeer({ sessionIdPrefix: 'aaaaaaaa' })).name).toBe('Peer')
    expect(calls.every(call => call.path.startsWith('/api/evolved/peers'))).toBe(true)
    expect(calls.find(call => call.path.endsWith('/messages'))?.body).toMatchObject({ deliveryId: 'reusable', senderSessionId: 'sender', recipientSessionId: peer.id, text: '/clear' })
})
it('operator exposure controls remove peer guidance and fail closed when policy cannot load', async () => {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1'); vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:9999'); vi.stubEnv('EVOLVED_PROJECT_ID', 'project'); vi.stubEnv('HAPI_PEER_TOOLS', '0')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    expect(await initializePeerToolsPolicy()).toBe(false)
    expect(peerToolsExposed()).toBe(false)
    expect(getSystemPrompt()).not.toContain('mcp__hapi__ping_peer')
    expect(getSystemPrompt()).not.toContain('mcp__hapi__search_peers')
    expect(getCodexSystemPrompt()).not.toContain('functions.hapi__ping_peer')
    expect(getCodexSystemPrompt()).not.toContain('functions.hapi__search_peers')
})


it('read-only capability exposure never advertises send or manage, and retries need caller-owned IDs', async () => {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1'); vi.stubEnv('HAPI_PEER_TOOLS', '1'); vi.stubEnv('HAPI_PEER_SCOPES', 'peers:read')
    expect(peerScopeAllowed('peers:read')).toBe(true)
    expect(peerScopeAllowed('peers:send')).toBe(false)
    expect(peerScopeAllowed('peers:manage')).toBe(false)
    expect(getSystemPrompt()).not.toContain('mcp__hapi__ping_peer')
    await expect(pingPeer({ sessionIdPrefix: 'aaaaaaaa', message: 'hello' })).rejects.toThrow('stable deliveryId')
})
