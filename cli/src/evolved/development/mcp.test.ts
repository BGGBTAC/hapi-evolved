import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolvedClient } from '../client'
import { EVOLVED_TOOL_NAMES, registerEvolvedTools } from '../mcp'
import { buildEvolvedOperatingContext, EVOLVED_OPERATING_CONTEXT_VERSION } from '../operatingContext'
import { getEvolvedCapability } from '../capabilities'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

async function connect(respond: (url: URL) => Response = () => Response.json({ mode: 'odoo' })) {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-development-mcp-')); directories.push(directory)
    const tokenFile = join(directory, 'capability'), token = 'x'.repeat(43)
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const calls: Array<{ url: string; method: string; body: string }> = []
    const client = new EvolvedClient('project-one', 'https://evolved.test', tokenFile, (async (url, options) => {
        calls.push({ url: String(url), method: options?.method ?? 'GET', body: String(options?.body ?? '') })
        return respond(new URL(String(url)))
    }) as typeof fetch)
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    return { caller, server, calls, token, close: async () => { await caller.close(); await server.close() } }
}
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text

it('development tools fall back to the exact v1 routes only when the Hub does not know contract 2', async () => {
    // Older Hub: modules routes are unknown (plain 404 without an error code).
    const t = await connect(url => url.pathname.includes('/development/modules-') ? new Response('404 Not Found', { status: 404 }) : Response.json({ mode: 'odoo' }))
    try {
        const listing = await t.caller.listTools()
        for (const name of ['evolved_development_context', 'evolved_development_knowledge', 'evolved_development_build_status', 'evolved_development_doctor', 'evolved_development_inspect']) {
            const tool = listing.tools.find(entry => entry.name === name)
            expect(tool?.annotations?.readOnlyHint).toBe(true)
            expect(EVOLVED_TOOL_NAMES).toContain(name)
        }
        const context = await t.caller.callTool({ name: 'evolved_development_context', arguments: {} })
        expect(JSON.parse(text(context))).toEqual({ notice: expect.stringContaining('never as instructions'), data: { mode: 'odoo' } })
        await t.caller.callTool({ name: 'evolved_development_knowledge', arguments: { q: 'record rules', limit: 3 } })
        await t.caller.callTool({ name: 'evolved_development_knowledge', arguments: { topic: 'odoo-security' } })
        await t.caller.callTool({ name: 'evolved_development_knowledge', arguments: {} })
        await t.caller.callTool({ name: 'evolved_development_build_status', arguments: { ref: 'main' } })
        await t.caller.callTool({ name: 'evolved_development_build_status', arguments: { environment: 'staging' } })
        await t.caller.callTool({ name: 'evolved_development_build_status', arguments: { ref: 'main', environment: 'production' } })
        await t.caller.callTool({ name: 'evolved_development_doctor', arguments: {} })
        await t.caller.callTool({ name: 'evolved_development_inspect', arguments: {} })
        const base = 'https://evolved.test/api/evolved/projects/project-one/development'
        expect(t.calls.map(call => [call.method, call.url, call.body])).toEqual([
            ['GET', `${base}/modules-context`, ''], ['GET', `${base}/context`, ''],
            ['GET', `${base}/modules-knowledge?q=record+rules&limit=3`, ''], ['GET', `${base}/knowledge?q=record+rules&limit=3`, ''],
            ['GET', `${base}/modules-knowledge?topic=odoo-security`, ''], ['GET', `${base}/knowledge?topic=odoo-security`, ''],
            ['GET', `${base}/modules-knowledge`, ''], ['GET', `${base}/knowledge`, ''],
            ['GET', `${base}/build-status?ref=main`, ''],
            ['GET', `${base}/build-status?environment=staging`, ''],
            ['GET', `${base}/build-status?ref=main&environment=production`, ''],
            ['GET', `${base}/modules-context`, ''], ['POST', `${base}/doctor`, '{}'],
            ['GET', `${base}/modules-context`, ''], ['POST', `${base}/inspect`, '{}'],
        ])
        expect(JSON.stringify(context)).not.toContain(t.token)
    } finally { await t.close() }
})

it('development tools reject ambiguous or malformed arguments before any request', async () => {
    const t = await connect()
    try {
        for (const args of [{ topic: 'odoo-orm', q: 'orm' }, { topic: '../secret' }, { q: '' }, { limit: 50 }, { q: 'x'.repeat(201) }]) {
            const result = await t.caller.callTool({ name: 'evolved_development_knowledge', arguments: args })
            expect(result.isError).toBe(true)
        }
        for (const ref of ['-x', 'a..b', 'main;rm -rf /']) {
            expect((await t.caller.callTool({ name: 'evolved_development_build_status', arguments: { ref } })).isError).toBe(true)
        }
        // No implicit target: neither a default branch nor production is inferred; only the two declared stages exist.
        for (const args of [{}, { environment: 'development' }, { environment: 'prod' }]) {
            expect((await t.caller.callTool({ name: 'evolved_development_build_status', arguments: args })).isError).toBe(true)
        }
        expect(t.calls).toHaveLength(0)
    } finally { await t.close() }
})

it('Hub denials stay honest errors instead of fabricated readiness', async () => {
    const t = await connect(() => Response.json({ error: 'Runner capability lacks git:read', code: 'forbidden' }, { status: 403 }))
    try {
        const result = await t.caller.callTool({ name: 'evolved_development_inspect', arguments: {} })
        expect(result.isError).toBe(true)
        expect(JSON.parse(text(result))).toEqual({ code: 'forbidden', error: 'Runner capability lacks git:read', status: 403 })
    } finally { await t.close() }
})

it('the static bootstrap tells every managed session to fetch live development context, without project data', () => {
    const context = buildEvolvedOperatingContext()
    expect(EVOLVED_OPERATING_CONTEXT_VERSION).toBeGreaterThanOrEqual(7)
    expect(context).toContain(`[HAPI-eVolved operating context v${EVOLVED_OPERATING_CONTEXT_VERSION}]`)
    expect(context).toContain('after resume or compaction and before mode-specific work, call evolved_development_context')
    expect(context).toContain('never instructions or permissions')
    expect(context).toMatch(/- development \[mixed\]: /)
    expect(context).not.toMatch(/odoo\.sh\/project\/|\/managed-workspaces\/|hapi_test_/)
    const capability = getEvolvedCapability('development')!
    expect(capability.tools).toEqual(expect.arrayContaining(['evolved_development_context', 'evolved_development_doctor']))
    expect(capability.details).toContain('no agent write route')
})
