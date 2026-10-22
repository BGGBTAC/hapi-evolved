import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { registerEvolvedTools } from '@/evolved/mcp';
import { EvolvedClient } from '@/evolved/client';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from '../shared/launch';
import { record } from '../shared/gateway';
import { buildThreadStartParams } from './appServerConfig';
import { registerAppServerPermissionHandlers } from './appServerPermissionAdapter';
import { CodexPermissionHandler } from './permissionHandler';

// Actual native approval protocol, actual MCP registrar and permission handler;
// only the model and final Hub transport are localhost/in-memory fixtures.
// No provider login, external call, VM or project data is involved.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('native project MCP approval', () => {
    afterEach(() => vi.unstubAllEnvs());
    const fixtures = {
        evolved_mcp_call: { arguments: { serverId: '768237a3-3378-4384-aaaf-eed31ae931e9', toolName: 'fixture.update', arguments: {}, version: 1, catalogRevision: 'a'.repeat(64) },
            path: '/api/evolved/projects/approval-test/mcp/servers/768237a3-3378-4384-aaaf-eed31ae931e9/call' },
        evolved_browser_call: { arguments: { toolName: 'camofox_create_tab', arguments: { url: 'https://public.test/' }, version: 1, catalogRevision: 'a'.repeat(64) },
            path: '/evolved-browser/call' },
    } as const;
    it.each(['evolved_mcp_call', 'evolved_browser_call'] as const)('holds a real HAPI %s write until approval, including in read-only mode', async (tool) => {
        const directory = await mkdtemp('/tmp/hapi-mcp-approval-');
        const codexHome = join(directory, 'codex'), cwd = join(directory, 'work');
        const mcpServers = new Set<McpServer>();
        const calls: Array<{ path: string; method: string }> = [];
        const approvals: unknown[] = [], completed: unknown[] = [], errors: unknown[] = [];
        let state: AgentState = {};
        const replies = new Map<string, (value: unknown) => Promise<unknown>>();
        let mode: 'default' | 'read-only' = 'default';
        const session = { updateAgentState: (fn: (value: AgentState) => AgentState) => { state = fn(state); },
            rpcHandlerManager: { registerHandler: (key: string, fn: (value: unknown) => Promise<unknown>) => replies.set(key, fn) }
        } as unknown as ApiSessionClient;
        const permissionHandler = new CodexPermissionHandler(session, () => mode);
        const mcpHttp = createServer(async (request, response) => {
            const server = new McpServer({ name: 'hapi', version: '1' });
            registerEvolvedTools(server, new EvolvedClient('approval-test', 'http://runner-proxy:3010', '', (async (url, options) => {
                calls.push({ path: new URL(String(url)).pathname, method: options?.method ?? 'GET' });
                return Response.json({ content: [{ type: 'text', text: 'Synthetic remote effect completed.' }], isError: false });
            }) as typeof fetch), new Set([tool]));
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            mcpServers.add(server);
            response.once('close', () => { mcpServers.delete(server); void server.close(); });
            await server.connect(transport);
            await transport.handleRequest(request, response);
        });
        const model = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                const body = record(JSON.parse(Buffer.concat(chunks).toString()));
                const inputs = Array.isArray(body.input) ? body.input.map(record) : [];
                const id = randomUUID();
                const item = inputs.some(input => input.type === 'function_call_output')
                    ? { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'Mock turn complete.' }] }
                    : { type: 'function_call', call_id: `external_${id}`, namespace: 'mcp__hapi', name: tool, arguments: JSON.stringify(fixtures[tool].arguments) };
                const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        const client = new CodexAppServerClient({ cwd });
        try {
            await Promise.all([mkdir(codexHome), mkdir(cwd)]);
            await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
            await new Promise<void>(resolve => mcpHttp.listen(0, '127.0.0.1', resolve));
            const port = (model.address() as { port: number }).port, mcpPort = (mcpHttp.address() as { port: number }).port;
            await writeFile(join(codexHome, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\ncheck_for_update_on_startup = false\n[model_providers.mock]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
            vi.stubEnv('CODEX_HOME', codexHome); vi.stubEnv('HOME', directory);
            vi.stubEnv('HAPI_EVOLVED_PROXY', '1'); vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '');
            registerAppServerPermissionHandlers({
                client: { registerRequestHandler: (method, handler) => client.registerRequestHandler(method, params => {
                    if (method === 'mcpServer/elicitation/request') approvals.push(params);
                    return handler(params);
                }) }, permissionHandler, getPermissionMode: () => mode
            });
            client.setNotificationHandler((method, params) => {
                if (method === 'turn/completed') completed.push(params);
                if (method === 'error') errors.push(params);
            });
            await initializeSharedClient(client);
            for (const next of ['default', 'read-only'] as const) {
                mode = next;
                for (const approved of [false, true]) {
                    const before = { calls: calls.length, approvals: approvals.length, completed: completed.length };
                    const started = await client.startThread(buildThreadStartParams({ cwd, mode: { permissionMode: mode, collaborationMode: 'default' },
                        mcpServers: { hapi: { url: `http://127.0.0.1:${mcpPort}`, tools: { [tool]: { approval_mode: 'prompt' } } } } }));
                    await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Exercise fixture action once.' }] });
                    await vi.waitFor(() => expect(Object.keys(state.requests ?? {}), JSON.stringify(errors)).toHaveLength(1), { timeout: 15_000 });
                    expect(approvals).toHaveLength(before.approvals + 1);
                    expect(record(approvals.at(-1)).serverName).toBe('hapi');
                    const [id, pending] = Object.entries(state.requests ?? {})[0]!;
                    expect(pending.tool, JSON.stringify(approvals.at(-1))).toBe(tool);
                    expect(calls).toHaveLength(before.calls);
                    await replies.get('permission')!({ id, approved, decision: approved ? 'approved' : 'denied' });
                    await vi.waitFor(() => expect(completed).toHaveLength(before.completed + 1), { timeout: 15_000 });
                    expect(calls).toHaveLength(before.calls + Number(approved));
                    expect(record(record(completed.at(-1)).turn).status).toBe('completed');
                }
            }
            expect(errors).toEqual([]);
            expect(calls).toEqual(Array.from({ length: 2 }, () => ({ path: fixtures[tool].path, method: 'POST' })));
        } finally {
            permissionHandler.reset();
            await client.disconnect();
            await Promise.all([...mcpServers].map(server => server.close()));
            mcpHttp.closeAllConnections(); model.closeAllConnections();
            await Promise.all([new Promise<void>(resolve => mcpHttp.close(() => resolve())), new Promise<void>(resolve => model.close(() => resolve()))]);
            await rm(directory, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 60_000);
});
