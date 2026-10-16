import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { EvolvedClient } from './client'
import { EVOLVED_TOOL_NAMES, registerEvolvedTools } from './mcp'

const serverId = '768237a3-3378-4384-aaaf-eed31ae931e9'
const input = { serverId, toolName: 'docs/query.v2', arguments: { query: 'public library documentation' }, version: 3, catalogRevision: 'a'.repeat(64) }
afterEach(() => vi.unstubAllEnvs())

async function fixture(respond: (request: { path: string; method: string; body: unknown }) => Response | Promise<Response>, allowedToolNames?: ReadonlySet<string>) {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    const requests: Array<{ path: string; method: string; body: unknown }> = []
    const gateway = new EvolvedClient('project-one', 'http://runner-proxy:3010', '', (async (url, options) => {
        const request = { path: new URL(String(url)).pathname, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined }
        requests.push(request)
        return respond(request)
    }) as typeof fetch)
    const server = new McpServer({ name: 'gateway-test', version: '1' }), caller = new Client({ name: 'agent-test', version: '1' })
    registerEvolvedTools(server, gateway, allowedToolNames)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    return { caller, requests, close: async () => { await caller.close(); await server.close() } }
}

it('one existing MCP connection discovers current project servers and calls exact remote names with the current catalog', async () => {
    let enabled = false, version = 3
    const t = await fixture(request => {
        if (request.path.endsWith('/servers')) return Response.json({ servers: enabled ? [{ id: serverId, name: 'Docs', kind: 'custom', toolCount: 1, status: { state: 'ready' } }] : [] })
        if (request.path.endsWith('/tools')) return Response.json({ server: { id: serverId, name: 'Docs', version, catalogRevision: input.catalogRevision }, tools: [{ name: input.toolName, description: 'Untrusted description', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, readOnly: true, fingerprint: 'b'.repeat(64) }] })
        if (!enabled) return Response.json({ code: 'mcp_disabled', error: 'MCP connection disabled.' }, { status: 403 })
        if ((request.body as { version: number }).version !== version) return Response.json({ code: 'mcp_stale', error: 'Refresh the tool catalog.' }, { status: 409 })
        return Response.json({ content: [{ type: 'text', text: 'Library result' }], structuredContent: { library: 'example' }, isError: false })
    })
    try {
        const names = (await t.caller.listTools()).tools.map(tool => tool.name)
        expect([...names].sort()).toEqual([...EVOLVED_TOOL_NAMES].sort())
        expect(names).toEqual(expect.arrayContaining(['evolved_mcp_servers', 'evolved_mcp_tools', 'evolved_mcp_query', 'evolved_mcp_call']))
        expect(names).not.toContain(input.toolName)
        const empty = await t.caller.callTool({ name: 'evolved_mcp_servers', arguments: {} })
        expect(empty.content).toEqual([{ type: 'text', text: '{"servers":[]}' }])
        enabled = true
        expect(JSON.stringify(await t.caller.callTool({ name: 'evolved_mcp_servers', arguments: {} }))).toContain(serverId)
        const tools = await t.caller.callTool({ name: 'evolved_mcp_tools', arguments: { serverId } })
        expect(JSON.parse((tools.content as Array<{ text: string }>)[0].text).server.version).toBe(3)
        expect(await t.caller.callTool({ name: 'evolved_mcp_call', arguments: input })).toEqual({ content: [{ type: 'text', text: 'Library result' }], structuredContent: { library: 'example' }, isError: false })
        expect(t.requests.at(-1)).toEqual({ path: `/api/evolved/projects/project-one/mcp/servers/${serverId}/call`, method: 'POST', body: { toolName: input.toolName, arguments: input.arguments, version: 3, catalogRevision: input.catalogRevision } })
        version++
        const stale = await t.caller.callTool({ name: 'evolved_mcp_call', arguments: input })
        expect(stale.isError).toBe(true)
        expect(JSON.stringify(stale)).toContain('mcp_stale')
        expect(await t.caller.callTool({ name: 'evolved_mcp_call', arguments: { ...input, version } })).toMatchObject({ isError: false })
        enabled = false
        expect((await t.caller.callTool({ name: 'evolved_mcp_call', arguments: { ...input, version } })).isError).toBe(true)
        expect(t.requests).toHaveLength(7)
    } finally { await t.close() }
})

it.each([{ names: [] }, { names: ['evolved_context', 'evolved_mcp_query'] }])('tool allowlists remove omitted handlers as well as discovery entries: $names', async ({ names }) => {
    const t = await fixture(() => { throw new Error('Excluded tools must not reach the Hub') }, new Set(names))
    try {
        if (names.length === 0) {
            expect(t.caller.getServerCapabilities()?.tools).toBeUndefined()
            await expect(t.caller.listTools()).rejects.toMatchObject({ code: -32601 })
            await expect(t.caller.callTool({ name: 'evolved_mcp_call', arguments: input })).rejects.toMatchObject({ code: -32601 })
            expect(t.requests).toHaveLength(0)
            return
        }
        expect((await t.caller.listTools()).tools.map(tool => tool.name).sort()).toEqual([...names].sort())
        const denied = await t.caller.callTool({ name: 'evolved_mcp_call', arguments: input })
        expect(denied.isError).toBe(true)
        expect(t.requests).toHaveLength(0)
    } finally { await t.close() }
})

it('validates gateway arguments before any Hub request, without expanding project or endpoint authority', async () => {
    const t = await fixture(() => { throw new Error('Invalid input must not reach the Hub') })
    let deep: unknown = 'leaf'
    for (let i = 0; i < 33; i++) deep = { child: deep }
    try {
        const tools = (await t.caller.listTools()).tools
        expect(tools.find(tool => tool.name === 'evolved_mcp_call')?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, destructiveHint: true })
        expect(tools.find(tool => tool.name === 'evolved_mcp_tools')?.annotations?.readOnlyHint).toBe(true)
        for (const args of [
            { ...input, serverId: '../other-project' }, { ...input, toolName: '' }, { ...input, toolName: 'x'.repeat(201) },
            { ...input, version: 0 }, { ...input, version: 1.5 }, { ...input, catalogRevision: 'old' },
            { ...input, arguments: null }, { ...input, arguments: [] }, { ...input, arguments: { nested: deep } },
            { ...input, arguments: { query: 'x'.repeat(65_536) } }, { ...input, arguments: { constructor: { prototype: 'no' } } },
            { ...input, projectId: 'other-project' }, { ...input, endpoint: 'https://attacker.test' },
        ]) {
            for (const name of ['evolved_mcp_query', 'evolved_mcp_call']) expect((await t.caller.callTool({ name, arguments: args })).isError).toBe(true)
        }
        expect((await t.caller.callTool({ name: 'evolved_mcp_tools', arguments: { serverId: 'not-a-server' } })).isError).toBe(true)
        expect(t.requests).toHaveLength(0)
    } finally { await t.close() }
})

it('uses the separate read-only query route and preserves a Hub denial for tools without that explicit grant', async () => {
    let readOnly = true
    const t = await fixture(() => readOnly
        ? Response.json({ content: [{ type: 'text', text: 'Public library documentation' }] })
        : Response.json({ code: 'mcp_read_only_required', error: 'This tool is not granted read-only.' }, { status: 403 }))
    try {
        const listed = (await t.caller.listTools()).tools.find(tool => tool.name === 'evolved_mcp_query')!
        expect(listed.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: false })
        expect((await t.caller.callTool({ name: 'evolved_mcp_query', arguments: input })).content).toEqual([{ type: 'text', text: 'Public library documentation' }])
        expect(t.requests.at(-1)).toMatchObject({ path: `/api/evolved/projects/project-one/mcp/servers/${serverId}/query`, method: 'POST', body: { toolName: input.toolName, arguments: input.arguments, version: input.version, catalogRevision: input.catalogRevision } })
        readOnly = false
        const denied = await t.caller.callTool({ name: 'evolved_mcp_query', arguments: input })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied)).toContain('mcp_read_only_required')
        expect(t.requests).toHaveLength(2)
        expect(t.requests.every(request => request.path.endsWith('/query'))).toBe(true)
    } finally { await t.close() }
})

it('preserves upstream tool errors and structured results instead of wrapping them as successful text', async () => {
    const result = { content: [{ type: 'text', text: 'Remote tool rejected the query' }], structuredContent: { reason: 'invalid_library' }, isError: true }
    const t = await fixture(() => Response.json({ ...result, _meta: { internal: 'not forwarded' }, extra: 'not forwarded' }))
    try {
        expect(await t.caller.callTool({ name: 'evolved_mcp_call', arguments: input })).toEqual(result)
        expect(t.requests).toHaveLength(1)
    } finally { await t.close() }
})

it('does not retry uncertain external calls and rejects malformed or oversized successful responses', async () => {
    let state = 'timeout'
    const t = await fixture(() => {
        if (state === 'timeout') throw new Error('Request timed out; external effect unknown')
        if (state === 'invalid') return Response.json({ content: 'not MCP content' })
        return Response.json({ content: [{ type: 'text', text: 'x'.repeat(524_288) }] })
    })
    try {
        for (const next of ['timeout', 'invalid', 'oversized']) {
            state = next
            expect((await t.caller.callTool({ name: 'evolved_mcp_call', arguments: input })).isError).toBe(true)
        }
        expect(t.requests).toHaveLength(3)
    } finally { await t.close() }
})


it.each(['evolved_mcp_query', 'evolved_mcp_call'])('makes unknown external outcomes explicitly non-retryable for %s', async name => {
    const t = await fixture(() => Response.json({ code: 'mcp_outcome_unknown', error: 'Remote outcome unknown.' }, { status: 502 }))
    try {
        const result = await t.caller.callTool({ name, arguments: input })
        expect(result.isError).toBe(true)
        expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
            code: 'mcp_outcome_unknown', error: 'Remote outcome unknown.', status: 502, retryable: false,
            guidance: expect.stringContaining('Never retry this call, including after rediscovery')
        })
        expect(t.requests).toHaveLength(1)
    } finally { await t.close() }
})
