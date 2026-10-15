import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolvedClient } from './client'
import { registerEvolvedTools } from './mcp'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-mcp-')); directories.push(directory)
    const tokenFile = join(directory, 'capability'), token = 'x'.repeat(43)
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = []
    const client = new EvolvedClient('project-one', 'https://evolved.test', tokenFile, (async (url, options) => {
        calls.push({ url: String(url), method: options?.method ?? 'GET', headers: new Headers(options?.headers), body: String(options?.body ?? '') })
        return Response.json({ results: [{ id: 'symbol' }] })
    }) as typeof fetch)
    return { client, calls, tokenFile, token }
}
it('MCP discovers real schemas, calls project-bound APIs and rejects invalid arguments', async () => {
    const t = setup(), server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const listing = await caller.listTools()
        expect(listing.tools.map(tool => tool.name)).toContain('evolved_codegraph')
        const result = await caller.callTool({ name: 'evolved_codegraph', arguments: { operation: 'search', q: 'Session' } })
        expect(result.isError).not.toBe(true)
        expect(t.calls[0].url).toBe('https://evolved.test/api/evolved/projects/project-one/codegraph/search?q=Session')
        expect(t.calls[0].headers.get('authorization')).toBe(`Bearer ${t.token}`)
        expect(JSON.stringify(result)).not.toContain(t.token)
        const bad = await caller.callTool({ name: 'evolved_codegraph', arguments: { operation: 'delete-everything' } })
        expect(bad.isError).toBe(true)
        expect(t.calls).toHaveLength(1)
    } finally { await caller.close(); await server.close() }
})
it('private capability files fail closed and tokens are reread after rotation', async () => {
    const t = setup()
    chmodSync(t.tokenFile, 0o644)
    await expect(t.client.request('/memory/search?q=test')).rejects.toThrow('private')
    expect(t.calls).toHaveLength(0)
    chmodSync(t.tokenFile, 0o600)
    writeFileSync(t.tokenFile, 'y'.repeat(43))
    await t.client.request('/memory/search?q=test')
    expect(t.calls[0].headers.get('authorization')).toBe(`Bearer ${'y'.repeat(43)}`)
    await expect(t.client.request('//evil.test')).rejects.toThrow('Invalid')
})
it('isolated proxy mode sends no capability and only permits its exact private HTTP endpoint', async () => {
    const before = process.env.HAPI_EVOLVED_PROXY
    process.env.HAPI_EVOLVED_PROXY = '1'
    try {
        let authorization: string | null = null
        const client = new EvolvedClient('a', 'http://runner-proxy:3010', '', (async (_url, options) => {
            authorization = new Headers(options?.headers).get('authorization')
            return Response.json({ ok: true })
        }) as typeof fetch)
        await client.request('/memory/search?q=test')
        expect(authorization).toBe('Bearer evolved-local')
        expect(() => new EvolvedClient('a', 'http://other-host:3010', '')).toThrow('HTTPS')
        expect(() => new EvolvedClient('a', 'http://runner-proxy:9999', '')).toThrow('HTTPS')
        delete process.env.HAPI_EVOLVED_PROXY
        expect(() => new EvolvedClient('a', 'http://runner-proxy:3010', '')).toThrow('HTTPS')
    } finally { if (before === undefined) delete process.env.HAPI_EVOLVED_PROXY; else process.env.HAPI_EVOLVED_PROXY = before }
})
