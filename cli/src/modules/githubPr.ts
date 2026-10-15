import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v3'
import { parseGithubPrInput } from '@hapi/protocol'
import { evolvedClientFromEnvironment } from '@/evolved/client'
import { isEvolvedPeerMode } from './pingPeer/evolvedPeer'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const base = configuration.apiUrl.replace(/\/+$/, '')
    const auth = await fetch(`${base}/api/auth`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: buildHubRequestHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ accessToken: getAuthToken() }) })
    const credentials = await auth.json() as { token?: string }
    if (!auth.ok || !credentials.token) throw new Error('Hub authentication failed.')
    const response = await fetch(`${base}/api${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: buildHubRequestHeaders({ authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body) })
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new Error(result.error ?? 'PR link request failed.')
    return result
}
export async function githubPrEnabled(): Promise<boolean> {
    if (!process.env.HAPI_SESSION_ID) return false
    try {
        if (isEvolvedPeerMode()) return (await evolvedClientFromEnvironment().request('/github-pr/features', 'GET', undefined, {}, { timeoutMs: 2500 }) as { enabled: boolean }).enabled === true
        return (await request('/features')).githubPrAwareness?.enabled === true
    } catch { return false }
}
export async function linkGithubPr(pr: string, sessionId = process.env.HAPI_SESSION_ID): Promise<unknown> {
    if (!sessionId) throw new Error('link-pr must run inside a HAPI session.')
    const ref = parseGithubPrInput(pr)
    if (!ref) throw new Error('Use a github.com PR URL or owner/repository#number.')
    if (isEvolvedPeerMode()) return evolvedClientFromEnvironment().request('/github-pr/link', 'POST', { sessionId, pr: ref.url })
    return request(`/sessions/${encodeURIComponent(sessionId)}/link-pr`, 'POST', { pr: ref.url })
}
export function registerGithubPrTool(server: McpServer, sessionId?: string): void {
    server.registerTool<any, any>('link_pr', {
        description: 'Link an explicit GitHub PR to this HAPI session. No GitHub queries; do not infer from the title. Replaces the primary PR.',
        inputSchema: { pr: z.string().min(1).max(300).describe('github.com PR URL or owner/repository#number') }
    }, async ({ pr }: { pr: string }) => {
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(await linkGithubPr(pr, sessionId)) }] } }
        catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'PR link failed.' }] } }
    })
}
