import { expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { EvolvedClient } from './client'
import { registerEvolvedTools } from './mcp'

it('credential discovery uses only its bound project metadata route, never the environment-delivery endpoint', async () => {
    const metadata = { credentials: [{ envName: 'PROJECT_SECRET_CANARY', version: 2 }], restartRequired: true }
    const request = vi.fn(async () => metadata)
    const api = { projectPath: (suffix: string) => `/projects/project-one${suffix}`, request } as unknown as EvolvedClient
    const server = new McpServer({ name: 'credential-metadata-test', version: '1' })
    const caller = new Client({ name: 'credential-metadata-client', version: '1' })
    registerEvolvedTools(server, api, new Set(['evolved_agent_credentials']))
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await caller.connect(clientTransport)
    try {
        const tools = (await caller.listTools()).tools
        expect(tools.map(tool => tool.name)).toEqual(['evolved_agent_credentials'])
        expect(tools[0].description).toContain('never values')
        expect(tools[0].description).toContain('restarted')
        const result = await caller.callTool({ name: 'evolved_agent_credentials', arguments: { projectId: 'other-project', includeValues: true } })
        expect(result.isError).not.toBe(true)
        expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(metadata)
        expect(request).toHaveBeenCalledExactlyOnceWith('/projects/project-one/agent-credentials', 'GET', undefined, undefined)
        expect(JSON.stringify(request.mock.calls)).not.toContain('runner-environment')
        expect(JSON.stringify(result)).not.toContain('synthetic-child-credential-must-never-be-printed')
    } finally { await caller.close(); await server.close() }
})
