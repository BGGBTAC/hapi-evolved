import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEvolvedOperatingContext } from '@/evolved/operatingContext'
import { EVOLVED_TOOL_NAMES } from '@/evolved/mcp'

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

const harness = vi.hoisted(() => ({
    instructions: undefined as string | undefined,
    tools: new Map<string, ToolHandler>(),
    configs: new Map<string, Record<string, unknown>>(),
    prEnabled: false,
    callTool: vi.fn(async (_request: unknown) => ({
        content: [{ type: 'text', text: 'forwarded' }],
        isError: false
    }))
}))

vi.mock('@/modules/githubPr', () => ({
    githubPrEnabled: async () => harness.prEnabled,
    registerGithubPrTool: (server: { registerTool: (name: string, config: Record<string, unknown>, handler: ToolHandler) => void }) => {
        server.registerTool('link_pr', {}, async () => ({ content: [{ type: 'text', text: 'linked' }] }))
    },
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: class {
        constructor(_info: unknown, options?: { instructions?: string }) {
            harness.instructions = options?.instructions
        }
        registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler): void {
            harness.tools.set(name, handler)
            harness.configs.set(name, config)
        }

        async connect(): Promise<void> {}
    }
}))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: class {}
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
        async connect(): Promise<void> {}

        async callTool(request: unknown): Promise<unknown> {
            return harness.callTool(request)
        }
    }
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: class {
        constructor(_url: URL) {}
    }
}))

import { runHappyMcpStdioBridge } from './happyMcpStdioBridge'

describe('runHappyMcpStdioBridge tool forwarding', () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
    beforeEach(() => {
        harness.instructions = undefined
        harness.tools.clear()
        harness.configs.clear()
        harness.prEnabled = false
        harness.callTool.mockClear()
    })

    it('supplies scoped operating context even when feature-policy discovery is offline', async () => {
        vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
        vi.stubEnv('EVOLVED_PROJECT_ID', 'context-test')
        vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:1')
        vi.stubEnv('HAPI_PEER_TOOLS', '')
        vi.stubEnv('HAPI_PEER_SCOPES', '')
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
        await runHappyMcpStdioBridge(['--url', 'http://127.0.0.1:43006'])
        expect(harness.instructions).toContain(getEvolvedOperatingContext())
        expect(harness.instructions).toContain('live project access unavailable')
        expect(harness.tools.has('evolved_context')).toBe(true)
        for (const name of ['evolved_mcp_servers', 'evolved_mcp_tools', 'evolved_mcp_query', 'evolved_mcp_call']) expect(harness.tools.has(name)).toBe(true)
        expect(harness.configs.get('evolved_mcp_call')?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false })
        for (const name of ['list_peers', 'search_peers', 'inspect_peer', 'ping_peer', 'spawn_peer', 'archive_peer']) expect(harness.tools.has(name)).toBe(true)
    })

    it('adds current project scopes to the MCP connection instructions', async () => {
        vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
        vi.stubEnv('EVOLVED_PROJECT_ID', 'context-test')
        vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:1')
        vi.stubEnv('HAPI_PEER_TOOLS', '')
        vi.stubEnv('HAPI_PEER_SCOPES', '')
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ projectId: 'context-test', profile: 'workspace', scopes: ['runner:connect', 'git:read'] }))
        await runHappyMcpStdioBridge(['--url', 'http://127.0.0.1:43006'])
        expect(harness.instructions).toContain('profile: workspace; runner scopes: runner:connect, git:read')
        expect(harness.instructions).not.toContain('evolved-local')
    })

    it('preserves the Legacy peer exposure switch', async () => {
        vi.stubEnv('HAPI_EVOLVED_PROXY', '')
        vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '')
        vi.stubEnv('HAPI_PEER_TOOLS', '0')
        await runHappyMcpStdioBridge(['--url', 'http://127.0.0.1:43006'])
        for (const name of ['list_peers', 'search_peers', 'inspect_peer', 'ping_peer', 'spawn_peer', 'archive_peer']) expect(harness.tools.has(name)).toBe(false)
    })

    it.each([['--tools', ''], ['--tools='], ['--tools', 'display_image,evolved_context,evolved_mcp_query'], ['--tools=display_image,evolved_context,evolved_mcp_query']])('honors explicit tool selection for native and Evolved tools: %j', async (...selection) => {
        harness.prEnabled = true
        vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
        vi.stubEnv('EVOLVED_PROJECT_ID', 'context-test')
        vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:1')
        vi.stubEnv('HAPI_PEER_TOOLS', '')
        vi.stubEnv('HAPI_PEER_SCOPES', '')
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
        await runHappyMcpStdioBridge(['--url', 'http://127.0.0.1:43006', ...selection])
        const expected = selection.join('').includes('display_image') ? ['display_image', 'evolved_context', 'evolved_mcp_query'] : []
        expect([...harness.tools.keys()].sort()).toEqual(expected.sort())
        expect(harness.tools.has('evolved_mcp_call')).toBe(false)
        expect(harness.tools.has('evolved_resource_execute')).toBe(false)
    })

    it.each([[], ['--tools', 'link_pr']])('retains enabled PR tools with no filter or an explicit selection: %j', async (...selection) => {
        harness.prEnabled = true
        await runHappyMcpStdioBridge(['--url', 'http://127.0.0.1:43006', ...selection])
        expect(harness.tools.has('link_pr')).toBe(true)
    })

    it('retains every Evolved tool when the normal HAPI bridge supplies its complete tool list', async () => {
        vi.stubEnv('HAPI_EVOLVED_PROXY', '1')
        vi.stubEnv('EVOLVED_PROJECT_ID', 'context-test')
        vi.stubEnv('HAPI_EVOLVED_URL', 'http://127.0.0.1:1')
        vi.stubEnv('HAPI_PEER_TOOLS', '')
        vi.stubEnv('HAPI_PEER_SCOPES', '')
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
        await runHappyMcpStdioBridge(['--url', 'http://127.0.0.1:43006', '--tools', ['display_image', ...EVOLVED_TOOL_NAMES].join(',')])
        expect([...harness.tools.keys()].sort()).toEqual(['display_image', ...EVOLVED_TOOL_NAMES].sort())
    })

    it('describes display_image as user output rather than image input', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'display_image'
        ])

        const description = harness.configs.get('display_image')?.description
        expect(harness.instructions).toBeUndefined()
        expect(description).toContain('human user')
        expect(description).toContain('does not provide image input to the model')
        expect(description).toContain('cannot be used to read, inspect, or analyze image contents')
    })

    it('registers and forwards skill_lookup when the HTTP server enables it', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,skill_lookup'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'skill_lookup'
        ])

        const handler = harness.tools.get('skill_lookup')
        expect(handler).toBeDefined()
        await expect(handler?.({ name: 'review' })).resolves.toEqual({
            content: [{ type: 'text', text: 'forwarded' }],
            isError: false
        })
        expect(harness.callTool).toHaveBeenCalledWith({
            name: 'skill_lookup',
            arguments: { name: 'review' }
        })
    })

    it('keeps skill_lookup hidden when the upstream HTTP server does not enable it', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video'
        ])

        expect([...harness.tools.keys()]).toEqual(['change_title', 'display_image', 'display_video'])
    })

    it('forwards display_media arguments unchanged', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'display_media'
        ])

        const handler = harness.tools.get('display_media')
        await expect(handler?.({ path: '/tmp/sample.wav', title: 'sample.wav' })).resolves.toEqual({
            content: [{ type: 'text', text: 'forwarded' }],
            isError: false
        })
        expect(harness.callTool).toHaveBeenCalledWith({
            name: 'display_media',
            arguments: { path: '/tmp/sample.wav', title: 'sample.wav' }
        })
    })

    it('registers ping_peer when included in --tools', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,ping_peer'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer'
        ])
    })

    it('registers inspect_peer when included in --tools', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,ping_peer,inspect_peer'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'inspect_peer'
        ])
    })
    it('registers list_peers when included in --tools', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,list_peers,search_peers,ping_peer,inspect_peer'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'inspect_peer',
            'list_peers',
            'search_peers',
        ])
    })

    it('registers search_peers when included in --tools', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'search_peers'
        ])

        expect([...harness.tools.keys()]).toEqual(['search_peers'])
    })

})
