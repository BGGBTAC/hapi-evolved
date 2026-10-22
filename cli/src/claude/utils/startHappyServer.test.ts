import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import type { ApiSessionClient } from '@/api/apiSession'
import { startHappyServer, toClaudeAllowedHapiMcpTools } from './startHappyServer'
import { getEvolvedOperatingContext } from '@/evolved/operatingContext'

type ToolResult = {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
}

describe('startHappyServer skill_lookup', () => {
    const originalHome = process.env.HOME
    let sandboxDir: string
    let workingDirectory: string
    let client: Client | null
    let stopServer: (() => void) | null
    let sendAgentMessage: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skill-mcp-'))
        workingDirectory = join(sandboxDir, 'repo')
        process.env.HOME = join(sandboxDir, 'home')
        await mkdir(join(workingDirectory, '.git'), { recursive: true })
        await mkdir(process.env.HOME, { recursive: true })
        client = null
        stopServer = null
    })

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        await rm(sandboxDir, { recursive: true, force: true })
    })

    async function connect(enableSkillLookup = true): Promise<Client> {
        sendAgentMessage = vi.fn()
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, enableSkillLookup
            ? {
                skillLookup: {
                    workingDirectory,
                    flavor: 'opencode'
                }
            }
            : {})
        stopServer = server.stop

        client = new Client(
            { name: 'hapi-skill-lookup-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('returns a discovered SKILL.md body', async () => {
        const skillDir = join(workingDirectory, '.agents', 'skills', 'review')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: review',
            'description: Review changes safely',
            '---',
            '',
            '# Review instructions',
            '',
            'Inspect the diff before editing.'
        ].join('\n'))

        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'review' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Skill: review')
        expect(result.content?.[0]?.text).toContain('Description: Review changes safely')
        expect(result.content?.[0]?.text).toContain('# Review instructions')
    })

    it('returns a tool error for an unknown skill', async () => {
        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'missing' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Skill not found: missing')
    })

    it('does not expose the fallback tool to native-skill sessions', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()
        expect(mcp.getInstructions()).toBeUndefined()

        expect(tools.tools.map((tool) => tool.name)).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'inspect_peer',
            'list_peers',
            'search_peers'
        ])
    })

    it('describes display_image as user output rather than image input', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()
        const displayImage = tools.tools.find((tool) => tool.name === 'display_image')

        expect(displayImage?.description).toContain('human user')
        expect(displayImage?.description).toContain('does not provide image input to the model')
        expect(displayImage?.description).toContain('cannot be used to read, inspect, or analyze image contents')
    })

    it('displays audio through display_media and emits a generated media message', async () => {
        const path = join(sandboxDir, 'sample.wav')
        await writeFile(path, Buffer.from('RIFFxxxxWAVE'))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'sample.wav' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: sample.wav')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'sample.wav',
            mimeType: 'audio/wav',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('preserves the source extension when display_media title omits one', async () => {
        const path = join(sandboxDir, 'plan-a.zip')
        await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'Cursor Plan A Markdown 导出' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: Cursor Plan A Markdown 导出.zip')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'Cursor Plan A Markdown 导出.zip',
            mimeType: 'application/octet-stream',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('does not expose change_title when native ACP titles are enabled', async () => {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, { enableChangeTitle: false })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp

        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const tools = await mcp.listTools()

        expect(server.toolNames).toEqual(['display_image', 'display_video', 'display_media', 'list_peers', 'search_peers', 'ping_peer', 'inspect_peer'])
        expect(tools.tools.map((tool) => tool.name)).toEqual([
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'inspect_peer',
            'list_peers',
            'search_peers'
        ])
    })

})

describe('startHappyServer change_title', () => {
    let stopServer: (() => void) | null
    let client: Client | null

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        client = null
        stopServer = null
    })

    async function connectChangeTitleServer(sessionClient: ApiSessionClient, options?: Parameters<typeof startHappyServer>[1]) {
        const server = await startHappyServer(sessionClient, options)
        stopServer = server.stop
        client = new Client(
            { name: 'hapi-change-title-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('renames via metadata.name so spawn --name sessions update visibly', async () => {
        const updateMetadata = vi.fn()
        const sendClaudeSessionMessage = vi.fn()
        const sessionClient = {
            updateMetadata,
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()
        sendClaudeSessionMessage.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: '  Renamed triage peer  ' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Successfully changed chat title to: "Renamed triage peer"')
        expect(updateMetadata).toHaveBeenCalledTimes(1)
        const handler = updateMetadata.mock.calls[0]?.[0] as (metadata: {
            path: string
            host: string
            name?: string
            summary?: { text: string }
        }) => {
            path: string
            host: string
            name?: string
            summary?: { text: string }
        }
        expect(handler({
            path: '/tmp',
            host: 'localhost',
            name: 'issue-triage-#54',
            summary: { text: 'stale' }
        })).toEqual({
            path: '/tmp',
            host: 'localhost',
            name: 'Renamed triage peer',
            summary: { text: 'stale' }
        })
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled()
    })

    it('returns an error for blank titles instead of claiming success', async () => {
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: '   ' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Failed to change chat title')
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('does not write titles when emitTitleSummary is disabled (Codex child isolation)', async () => {
        const updateMetadata = vi.fn()
        const sendClaudeSessionMessage = vi.fn()
        const sessionClient = {
            updateMetadata,
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient, { emitTitleSummary: false })
        updateMetadata.mockClear()
        sendClaudeSessionMessage.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: 'Child Title' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled()
    })
})
describe('toClaudeAllowedHapiMcpTools', () => {
    it('keeps local-path and peer tools registered but out of Claude --allowedTools', () => {
        expect(toClaudeAllowedHapiMcpTools([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'list_peers',
            'search_peers',
            'ping_peer',
            'inspect_peer',
            'skill_lookup',
            'evolved_mcp_servers',
            'evolved_mcp_tools',
            'evolved_mcp_query',
            'evolved_mcp_call'
        ])).toEqual([
            'mcp__hapi__change_title',
            'mcp__hapi__display_image',
            'mcp__hapi__list_peers',
            'mcp__hapi__search_peers',
            'mcp__hapi__skill_lookup',
            'mcp__hapi__evolved_mcp_servers',
            'mcp__hapi__evolved_mcp_tools',
            'mcp__hapi__evolved_mcp_query'
        ])
        expect(toClaudeAllowedHapiMcpTools(['evolved_browser_status', 'evolved_browser_tools', 'evolved_browser_query', 'evolved_browser_call']))
            .toEqual(['mcp__hapi__evolved_browser_status', 'mcp__hapi__evolved_browser_tools', 'mcp__hapi__evolved_browser_query'])
        expect(toClaudeAllowedHapiMcpTools(['display_video'])).not.toContain('mcp__hapi__display_video')
        expect(toClaudeAllowedHapiMcpTools(['display_media'])).not.toContain('mcp__hapi__display_media')
    })
})


it('mediaOnly exposes exactly display tools and performs no feature discovery', async () => {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    const session = { updateMetadata: vi.fn() } as unknown as ApiSessionClient
    const fetcher = vi.spyOn(globalThis, 'fetch')
    const server = await startHappyServer(session, { mediaOnly: true })
    const discoveryCalls = fetcher.mock.calls.length
    const client = new Client({ name: 'media-test', version: '1' }, { capabilities: {} })
    try {
        expect(discoveryCalls).toBe(0)
        expect(server.toolNames).toEqual(['display_image', 'display_video', 'display_media'])
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        expect(client.getInstructions()).toBeUndefined()
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(server.toolNames)
    } finally { await client.close(); server.stop(); fetcher.mockRestore(); vi.unstubAllEnvs() }
})

it('publishes the same operating context on every scoped MCP connection', async () => {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    vi.stubEnv('EVOLVED_PROJECT_ID', 'context-test')
    vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:1')
    vi.stubEnv('HAPI_PEER_TOOLS', '')
    vi.stubEnv('HAPI_PEER_SCOPES', '')
    // Feature-policy discovery is deliberately offline; context is static and
    // must still be available without a healthy graph, Hub or credential read.
    const policy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const session = { updateMetadata: vi.fn() } as unknown as ApiSessionClient
    let server: Awaited<ReturnType<typeof startHappyServer>> | undefined
    try {
        server = await startHappyServer(session)
        policy.mockRestore()
        for (let attempt = 0; attempt < 2; attempt++) {
            const client = new Client({ name: 'operating-context-test', version: '1' }, { capabilities: {} })
            try {
                await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
                expect(client.getInstructions()).toBe(getEvolvedOperatingContext())
                expect(client.getInstructions()).toContain('evolved_memory_propose')
                expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['evolved_mcp_servers', 'evolved_mcp_tools', 'evolved_mcp_query', 'evolved_mcp_call', 'evolved_browser_status', 'evolved_browser_tools', 'evolved_browser_query', 'evolved_browser_call']))
            } finally { await client.close() }
        }
    } finally {
        server?.stop()
        policy.mockRestore()
        vi.unstubAllEnvs()
    }
})

it('keeps Evolved peer tools in a warm MCP session while the Hub policy changes', async () => {
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
    vi.stubEnv('EVOLVED_PROJECT_ID', 'peer-test')
    vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:1')
    vi.stubEnv('HAPI_PEER_TOOLS', '0')
    vi.stubEnv('HAPI_PEER_SCOPES', '')
    let enabled = false
    const requests: string[] = []
    const realFetch = globalThis.fetch
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.port !== '1') return realFetch(input, init)
        const path = url.pathname
        requests.push(path)
        if (path !== '/api/evolved/peers') return Response.json({ error: 'Unexpected request' }, { status: 404 })
        return enabled
            ? Response.json({ sessions: [] })
            : Response.json({ error: 'Peer operations are disabled' }, { status: 403 })
    })
    const session = { sessionId: 'caller', updateMetadata: vi.fn() } as unknown as ApiSessionClient
    let server: Awaited<ReturnType<typeof startHappyServer>> | undefined
    const client = new Client({ name: 'warm-peer-test', version: '1' }, { capabilities: {} })
    try {
        server = await startHappyServer(session)
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const names = (await client.listTools()).tools.map(tool => tool.name)
        for (const name of ['list_peers', 'search_peers', 'inspect_peer', 'ping_peer', 'spawn_peer', 'archive_peer']) {
            expect(names).toContain(name)
            expect(server.toolNames).toContain(name)
        }
        expect((await client.callTool({ name: 'list_peers', arguments: {} }) as ToolResult).isError).toBe(true)
        enabled = true
        expect((await client.callTool({ name: 'list_peers', arguments: {} }) as ToolResult).isError).toBe(false)
        enabled = false
        expect((await client.callTool({ name: 'list_peers', arguments: {} }) as ToolResult).isError).toBe(true)
        expect(requests.filter(path => path.startsWith('/api/evolved/peers'))).toEqual(Array(3).fill('/api/evolved/peers'))
    } finally {
        await client.close()
        server?.stop()
        fetcher.mockRestore()
        vi.unstubAllEnvs()
    }
})

it('rejects rebound hosts and foreign origins while allowing native and same-origin local MCP clients', async () => {
    const session = { updateMetadata: vi.fn() } as unknown as ApiSessionClient
    const server = await startHappyServer(session, { mediaOnly: true })
    const url = new URL(server.url)
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host-check', version: '1' } } })
    // Native fetch may discard a custom Host header. Send actual wire headers
    // so this regression proves DNS-rebinding protection, not client filtering.
    const probe = (headers: Record<string, string>) => new Promise<{ status: number | undefined; sessionId: string | string[] | undefined }>((resolve, reject) => {
        const request = httpRequest(url, { method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'content-length': Buffer.byteLength(initialize) } }, response => {
            response.resume()
            response.on('end', () => resolve({ status: response.statusCode, sessionId: response.headers['mcp-session-id'] }))
        })
        request.on('error', reject)
        request.setTimeout(3000, () => request.destroy(new Error('Loopback probe timed out')))
        request.end(initialize)
    })
    try {
        const hostileHeaders: Array<Record<string, string>> = [
            { host: 'attacker.example' }, { host: `attacker.example:${url.port}`, origin: 'https://attacker.example' },
            { origin: 'https://attacker.example' }, { origin: 'null' }, { origin: 'http://127.0.0.1:1' },
            { origin: `http://localhost:${url.port}.attacker.example` },
        ]
        for (const headers of hostileHeaders) {
            const response = await probe(headers)
            expect(response.status).toBe(403)
            expect(response.sessionId).toBeUndefined()
        }
        const localHeaders: Array<Record<string, string> | undefined> = [undefined, { origin: url.origin }, { host: `localhost:${url.port}`, origin: `http://localhost:${url.port}` }]
        for (const headers of localHeaders) {
            const caller = new Client({ name: 'native-loopback-test', version: '1' })
            try {
                await caller.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
                expect((await caller.listTools()).tools.map(tool => tool.name)).toEqual(['display_image', 'display_video', 'display_media'])
            } finally { await caller.close() }
        }
    } finally { server.stop() }
})
