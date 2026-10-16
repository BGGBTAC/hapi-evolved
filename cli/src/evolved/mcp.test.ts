import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolvedClient } from './client'
import { registerEvolvedTools } from './mcp'
import { buildEvolvedOperatingContext, EVOLVED_OPERATING_CONTEXT_VERSION } from './operatingContext'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function setup(respond: () => Response | Promise<Response> = () => Response.json({ results: [{ id: 'symbol' }] })) {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-mcp-')); directories.push(directory)
    const tokenFile = join(directory, 'capability'), token = 'x'.repeat(43)
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = []
    const client = new EvolvedClient('project-one', 'https://evolved.test', tokenFile, (async (url, options) => {
        calls.push({ url: String(url), method: options?.method ?? 'GET', headers: new Headers(options?.headers), body: String(options?.body ?? '') })
        return respond()
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
it('any Evolved MCP agent can reload the canonical operating context without a remote request or live-state claim', async () => {
    const t = setup(() => { throw new Error('Context must not access a backend') })
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const listing = await caller.listTools()
        expect(listing.tools.find(tool => tool.name === 'evolved_context')?.annotations?.readOnlyHint).toBe(true)
        const result = await caller.callTool({ name: 'evolved_context', arguments: {} })
        expect(result.isError).not.toBe(true)
        expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ version: EVOLVED_OPERATING_CONTEXT_VERSION, instructions: buildEvolvedOperatingContext() })
        expect(t.calls).toHaveLength(0)
        expect(JSON.stringify(result)).not.toContain(t.token)
        expect(JSON.stringify(result)).not.toContain(t.tokenFile)
    } finally { await caller.close(); await server.close() }
})
it('standalone MCP sends the operating instructions on every new connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-mcp-stdio-')); directories.push(directory)
    const moduleUrl = new URL('./mcp.ts', import.meta.url).href
    for (let connection = 0; connection < 2; connection += 1) {
        const transport = new StdioClientTransport({
            command: process.env.HAPI_BUN_EXEC ?? 'bun',
            args: ['-e', `const { startEvolvedMcp } = await import(${JSON.stringify(moduleUrl)}); await startEvolvedMcp()`],
            env: { HAPI_HOME: directory, HAPI_EVOLVED_PROXY: '1', EVOLVED_PROJECT_ID: 'project-one', HAPI_EVOLVED_URL: 'http://runner-proxy:3010', HAPI_SESSION_ID: '' },
            stderr: 'pipe',
        })
        const caller = new Client({ name: 'standalone-test', version: '1' })
        try {
            await caller.connect(transport)
            expect(caller.getInstructions()).toBe(buildEvolvedOperatingContext())
            expect((await caller.listTools()).tools.map(tool => tool.name)).toContain('evolved_context')
            const result = await caller.callTool({ name: 'evolved_context', arguments: {} })
            expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ version: EVOLVED_OPERATING_CONTEXT_VERSION, instructions: buildEvolvedOperatingContext() })
        } finally { await caller.close(); await transport.close() }
    }
}, 15_000)
it('repository discovery needs no resource execution, returns exact granted identities and optionally inspects the workspace', async () => {
    const catalog = { connected: true, rootPath: '/work/project-one', canSync: true, canPush: false, runner: { status: 'ready' }, repositories: [{ id: '42', owner: 'granted-owner', name: 'project', fullName: 'granted-owner/project', cloneUrl: 'https://github.com/granted-owner/project.git', path: '/work/project-one/repositories/granted-owner/project', permission: 'read', local: { state: 'unknown', branch: null, dirty: null } }] }
    const t = setup(() => Response.json(catalog)), server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const listing = await caller.listTools()
        expect(listing.tools.map(tool => tool.name)).toContain('evolved_repositories')
        expect(listing.tools.find(tool => tool.name === 'evolved_resources')?.description).toContain('evolved_repositories')
        const result = await caller.callTool({ name: 'evolved_repositories', arguments: {} })
        expect(result.isError).not.toBe(true)
        expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(catalog)
        expect(t.calls[0].url).toBe('https://evolved.test/api/evolved/projects/project-one/repositories?workspace=0')
        await caller.callTool({ name: 'evolved_repositories', arguments: { workspace: true } })
        expect(t.calls[1].url.endsWith('/repositories?workspace=1')).toBe(true)
        expect(JSON.stringify(result)).not.toContain(t.token)
    } finally { await caller.close(); await server.close() }
})
it('repository MCP starts once, returns a generated request ID and polls an existing job without replaying the mutation', async () => {
    const jobId = '768237a3-3378-4384-aaaf-eed31ae931e9'
    let state = 'running'
    const t = setup(() => Response.json({ job: { id: jobId, repositoryId: '42', action: 'clone', state } }, { status: 202 }))
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const started = await caller.callTool({ name: 'evolved_repository_sync', arguments: { action: 'clone', repositoryId: '42' } })
        const payload = JSON.parse((started.content as Array<{ text: string }>)[0].text)
        expect(payload.job.state).toBe('running')
        expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(t.calls[0].method).toBe('POST')
        expect(t.calls[0].url.endsWith('/projects/project-one/repositories/42/sync')).toBe(true)
        expect(JSON.parse(t.calls[0].body)).toEqual({ action: 'clone', requestId: payload.requestId })
        state = 'succeeded'
        const checked = await caller.callTool({ name: 'evolved_repository_sync', arguments: { action: 'status', jobId } })
        expect(JSON.parse((checked.content as Array<{ text: string }>)[0].text).job.state).toBe('succeeded')
        expect(t.calls[1].method).toBe('GET')
        expect(t.calls[1].url.endsWith(`/repository-jobs/${jobId}`)).toBe(true)
        expect(t.calls).toHaveLength(2)
        for (const args of [{ action: 'pull' }, { action: 'status' }, { action: 'push', repositoryId: '42' }, { action: 'clone', repositoryId: '../42' }, { action: 'clone', repositoryId: '42', jobId }, { action: 'status', jobId, requestId: jobId }]) {
            expect((await caller.callTool({ name: 'evolved_repository_sync', arguments: args })).isError).toBe(true)
        }
        expect(t.calls).toHaveLength(2)
    } finally { await caller.close(); await server.close() }
})
it('an uncertain sync preserves its generated ID, returns stable backend errors and never automatically retries', async () => {
    let response: 'lost' | 'denied' | 'success' = 'lost'
    const t = setup(() => {
        if (response === 'lost') throw new Error('Connection lost')
        if (response === 'denied') return Response.json({ code: 'profile_denied', error: 'Project is read-only' }, { status: 403 })
        return Response.json({ job: { id: '768237a3-3378-4384-aaaf-eed31ae931e9', state: 'running' } })
    })
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const failed = await caller.callTool({ name: 'evolved_repository_sync', arguments: { action: 'pull', repositoryId: '42' } })
        expect(failed.isError).toBe(true)
        const failure = JSON.parse((failed.content as Array<{ text: string }>)[0].text)
        expect(failure.requestId).toBe(JSON.parse(t.calls[0].body).requestId)
        expect(t.calls).toHaveLength(1)
        response = 'denied'
        const denied = await caller.callTool({ name: 'evolved_repository_sync', arguments: { action: 'pull', repositoryId: '42', requestId: failure.requestId } })
        expect(JSON.parse((denied.content as Array<{ text: string }>)[0].text)).toMatchObject({ requestId: failure.requestId, code: 'profile_denied', status: 403 })
        response = 'success'
        const retried = await caller.callTool({ name: 'evolved_repository_sync', arguments: { action: 'pull', repositoryId: '42', requestId: failure.requestId } })
        expect(retried.isError).not.toBe(true)
        expect(t.calls.map(call => JSON.parse(call.body).requestId)).toEqual([failure.requestId, failure.requestId, failure.requestId])
        expect(JSON.stringify([failed, denied, retried])).not.toContain(t.token)
    } finally { await caller.close(); await server.close() }
})
it('hybrid graph failure gives an explicit ledger retry without hiding the failure or blocking independent persistent proposals', async () => {
    let request = 0
    const ledger = { mode: 'ledger', backendAvailable: false, results: [{ id: 'known-project', title: 'gbtac20 odoo', status: 'proposed' }] }
    const proposal = { item: { id: 'new-memory', status: 'proposed' } }
    const t = setup(() => {
        request += 1
        if (request === 1) return Response.json({ error: 'Memory graph service unavailable', backendAvailable: false, internalToken: 'must-not-be-forwarded' }, { status: 503 })
        return request === 2 ? Response.json(ledger) : Response.json(proposal, { status: 201 })
    })
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const failed = await caller.callTool({ name: 'evolved_memory_search', arguments: { q: 'gbtac20 odoo', mode: 'hybrid' } })
        expect(failed.isError).toBe(true)
        const failure = JSON.parse((failed.content as Array<{ text: string }>)[0].text)
        expect(failure).toMatchObject({
            code: 'memory_graph_unavailable', error: 'Memory graph service unavailable', status: 503,
            mode: 'hybrid', backendAvailable: false,
            retry: { tool: 'evolved_memory_search', arguments: { q: 'gbtac20 odoo', mode: 'ledger' } },
        })
        expect(failure.guidance).toContain('No ledger search has been attempted')
        expect(failure.guidance).toContain('evolved_memory_propose')
        expect(failure).not.toHaveProperty('results')
        expect(JSON.stringify(failed)).not.toContain('must-not-be-forwarded')
        expect(t.calls).toHaveLength(1)
        expect(new URL(t.calls[0].url).searchParams.get('mode')).toBe('hybrid')

        const retried = await caller.callTool({ name: failure.retry.tool, arguments: failure.retry.arguments })
        expect(retried.isError).not.toBe(true)
        expect(JSON.parse((retried.content as Array<{ text: string }>)[0].text)).toEqual(ledger)
        expect(new URL(t.calls[1].url).searchParams.get('projectId')).toBe('project-one')
        expect(new URL(t.calls[1].url).searchParams.get('mode')).toBe('ledger')

        const saved = await caller.callTool({ name: 'evolved_memory_propose', arguments: { title: 'Project location', body: 'Source: example/repo:README.md. Checkout location was confirmed.' } })
        expect(saved.isError).not.toBe(true)
        expect(JSON.parse((saved.content as Array<{ text: string }>)[0].text)).toEqual(proposal)
        expect(t.calls).toHaveLength(3)
        expect(t.calls[2].method).toBe('POST')
        expect(t.calls[2].url).toBe('https://evolved.test/api/evolved/projects/project-one/memory')
        expect(JSON.stringify([failed, retried, saved])).not.toContain(t.token)
    } finally { await caller.close(); await server.close() }
})
it.each([
    { mode: 'hybrid', status: 503, body: { error: 'Gateway unavailable' } },
    { mode: 'hybrid', status: 503, body: { error: 'Unavailable', backendAvailable: 'false' } },
    { mode: 'hybrid', status: 503, body: { error: 'Unavailable', backendAvailable: true } },
    { mode: 'hybrid', status: 403, body: { error: 'Read permission denied', code: 'scope_denied', backendAvailable: false } },
    { mode: 'ledger', status: 503, body: { error: 'Hub unavailable', backendAvailable: false } },
])('does not misdiagnose other memory errors as an optional graph outage: $mode / $status / $body.error', async ({ mode, status, body }) => {
    const t = setup(() => Response.json({ ...body, internalToken: 'must-not-be-forwarded' }, { status }))
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const failed = await caller.callTool({ name: 'evolved_memory_search', arguments: { q: 'project', mode } })
        expect(failed.isError).toBe(true)
        const failure = JSON.parse((failed.content as Array<{ text: string }>)[0].text)
        expect(failure).toEqual({ error: body.error, status, ...('code' in body ? { code: body.code } : {}) })
        expect(failure).not.toHaveProperty('retry')
        expect(JSON.stringify(failed)).not.toContain('must-not-be-forwarded')
        expect(t.calls).toHaveLength(1)
    } finally { await caller.close(); await server.close() }
})
it('memory search defaults to the project ledger and passes the literal query without broadening its scope', async () => {
    const t = setup(() => Response.json({ results: [], mode: 'ledger', backendAvailable: false }))
    const server = new McpServer({ name: 'test', version: '1' }), caller = new Client({ name: 'test', version: '1' })
    registerEvolvedTools(server, t.client)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await caller.connect(b)
    try {
        const query = 'gbtac20 odoo %_'
        const result = await caller.callTool({ name: 'evolved_memory_search', arguments: { q: query } })
        expect(result.isError).not.toBe(true)
        expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ results: [], mode: 'ledger', backendAvailable: false })
        expect([...new URL(t.calls[0].url).searchParams]).toEqual([['q', query], ['mode', 'ledger'], ['projectId', 'project-one']])
        const listing = await caller.listTools()
        expect(listing.tools.find(tool => tool.name === 'evolved_memory_search')?.description).toContain('full literal query as a substring')
        expect(listing.tools.find(tool => tool.name === 'evolved_memory_propose')?.description).toContain('independently of the optional graph service')
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
