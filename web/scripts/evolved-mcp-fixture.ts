import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectMcpRemote } from '../../hub/src/evolved/mcp'
import { normalizeMcpTools } from '../../hub/src/evolved/mcpVault'

/** Isolated browser harness only. Product auth, signed Vault, CAS and routes stay real. */
export function createMcpFixture(state: string): ProjectMcpRemote {
    const observed = { discoveries: 0, calls: 0, credentialAccepted: false, staleRejected: 0 }
    const record = () => writeFileSync(join(state, 'mcp-observed.json'), JSON.stringify(observed), { mode: 0o600 })
    const tools = normalizeMcpTools([
        { name: 'resolve-library-id', description: 'Find an exact library. External description rendered as text: <img src="https://tracking.invalid/pixel">', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'query-docs', description: 'Read current documentation and examples. '.repeat(30), inputSchema: { type: 'object', properties: { libraryId: { type: 'string' }, query: { type: 'string' } }, required: ['libraryId', 'query'] } },
        { name: `write-${'long-tool-name-'.repeat(9)}`, description: 'Synthetic mutation; never auto-approved as read-only.', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } },
    ], 'context7')
    record()
    return {
        async discover(config, revalidate) {
            if (config.endpoint !== 'https://mcp.context7.com/mcp' || config.credential.mode !== 'bearer' || config.credential.token !== 'synthetic-mcp-browser-private-key') throw new Error('Unexpected synthetic fixture configuration')
            observed.discoveries++; observed.credentialAccepted = true; record()
            const control = join(state, 'mcp-control.json')
            const delayMs = existsSync(control) ? Number(JSON.parse(readFileSync(control, 'utf8')).delayMs) : 0
            if (delayMs > 0 && delayMs <= 5000) await Bun.sleep(delayMs)
            try { await revalidate() } catch (error) { observed.staleRejected++; record(); throw error }
            return tools
        },
        async call() { observed.calls++; record(); throw new Error('Tool execution is forbidden in this discovery-only fixture') },
    }
}
