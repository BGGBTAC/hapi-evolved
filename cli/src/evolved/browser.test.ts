import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { EvolvedClient } from './client'
import { registerEvolvedTools } from './mcp'

afterEach(() => vi.unstubAllEnvs())
const revision = 'c'.repeat(64)

async function setup(respond: (url: string, body: string) => Response, base = 'http://runner-proxy:3010') {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = []
    const client = new EvolvedClient('project-one', base, '', (async (url, options) => {
        calls.push({ url: String(url), method: options?.method ?? 'GET', headers: new Headers(options?.headers), body: String(options?.body ?? '') })
        return respond(String(url), String(options?.body ?? ''))
    }) as typeof fetch)
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    return { caller, calls }
}

it('browser tools are discoverable with exact schemas and annotations; actions are not read-only', async () => {
    const t = await setup(() => Response.json({ enabled: true }))
    const tools = (await t.caller.listTools()).tools
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
    for (const name of ['evolved_browser_status', 'evolved_browser_tools', 'evolved_browser_query']) expect(byName[name]?.annotations?.readOnlyHint).toBe(true)
    expect(byName.evolved_browser_call?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(JSON.stringify(byName.evolved_browser_call?.inputSchema)).toContain('camofox_evaluate')
    expect(JSON.stringify(byName.evolved_browser_call?.inputSchema)).not.toContain('camofox_import_cookies')
    await t.caller.close()
})

it('uses only the fixed runner-proxy relay, without credentials, and passes exactly the four fields', async () => {
    const t = await setup(url => url.endsWith('/call')
        ? Response.json({ content: [{ type: 'text', text: '{"result":{"tabId":"t1"}}' }] })
        : Response.json({ enabled: true, version: 2, catalogRevision: revision }))
    const status = await t.caller.callTool({ name: 'evolved_browser_status', arguments: {} })
    expect(status.isError).not.toBe(true)
    const result = await t.caller.callTool({ name: 'evolved_browser_call', arguments: { toolName: 'camofox_create_tab', arguments: { url: 'https://public.test/' }, version: 2, catalogRevision: revision } })
    expect(result.isError).not.toBe(true)
    expect(t.calls.map(call => `${call.method} ${call.url}`)).toEqual(['GET http://runner-proxy:3010/api/evolved/projects/project-one/browser/agent', 'POST http://runner-proxy:3010/evolved-browser/call'])
    expect(t.calls[1]!.headers.has('authorization')).toBe(false)
    expect(JSON.parse(t.calls[1]!.body)).toEqual({ toolName: 'camofox_create_tab', arguments: { url: 'https://public.test/' }, version: 2, catalogRevision: revision })
    const injected = await t.caller.callTool({ name: 'evolved_browser_call', arguments: { toolName: 'camofox_list_tabs', arguments: {}, version: 2, catalogRevision: revision, userId: 'other' } })
    expect(injected.isError).toBe(true)
    expect(t.calls).toHaveLength(2)
    await t.caller.close()
})

it('unknown outcomes are reported as non-retryable and outside managed runners the browser is unavailable', async () => {
    const t = await setup(() => Response.json({ code: 'browser_outcome_unknown', error: 'maybe happened' }, { status: 502 }))
    const result = await t.caller.callTool({ name: 'evolved_browser_call', arguments: { toolName: 'camofox_click', arguments: { tabId: 't', ref: 'e1' }, version: 2, catalogRevision: revision } })
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'browser_outcome_unknown', retryable: false })
    await t.caller.close()
    const outside = await setup(() => Response.json({ enabled: true, available: false, managedRunner: false, tools: [{ name: 'camofox_list_tabs', readOnly: true }] }), 'http://127.0.0.1:3010')
    // Discovery still reports actual rights outside the managed runner; actions are refused locally.
    const known = await outside.caller.callTool({ name: 'evolved_browser_status', arguments: {} })
    expect(JSON.parse((known.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ enabled: true, managedRunner: false, grantedTools: [{ name: 'camofox_list_tabs', readOnly: true }] })
    const denied = await outside.caller.callTool({ name: 'evolved_browser_call', arguments: { toolName: 'camofox_list_tabs', arguments: {}, version: 2, catalogRevision: revision } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('browser_unavailable')
    expect(outside.calls).toHaveLength(1)
    await outside.caller.close()
})
