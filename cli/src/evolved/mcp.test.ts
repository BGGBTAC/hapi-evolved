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
