import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getEvolvedOperatingContext } from '@/evolved/operatingContext';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from '../shared/launch';
import { record } from '../shared/gateway';
import { buildThreadStartParams } from './appServerConfig';

function hasMcpOperatingInstructions(request: Record<string, unknown> | undefined): boolean {
    if (!request) return false;
    const context = getEvolvedOperatingContext();
    const tools = Array.isArray(request.tools) ? request.tools.map(record) : [];
    // Codex presents MCP initialize.instructions as the namespace description
    // on every model request, independently of its persisted developer prompt.
    return Boolean(context) && tools.some(tool => tool.type === 'namespace' && tool.name === 'mcp__hapi'
        && typeof tool.description === 'string' && tool.description.includes(context));
}

// Uses the installed engine with isolated history and a localhost-only model.
// No provider account or paid model request is needed.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('native Evolved context after an update', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('refreshes legacy threads and isolated children through MCP instructions after cold resume and native compaction', async () => {
        const directory = await mkdtemp('/tmp/hapi-context-resume-');
        const codexHome = join(directory, 'codex');
        const cwd = join(directory, 'work');
        const requests: Record<string, unknown>[] = [];
        const mcpServers = new Set<McpServer>();
        const mcpHttp = createServer(async (request, response) => {
            const server = new McpServer({ name: 'hapi-context-test', version: '1' }, { instructions: getEvolvedOperatingContext() });
            server.registerTool('evolved_context', { description: 'Read the platform operating rules.', inputSchema: {} }, async () => ({
                content: [{ type: 'text', text: getEvolvedOperatingContext() }]
            }));
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
                requests.push(body);
                const inputs = Array.isArray(body.input) ? body.input.map(record) : [];
                const lastUser = [...inputs].reverse().find(input => input.role === 'user');
                const spawnChild = JSON.stringify(lastUser)?.includes('SPAWN_LEGACY_CHILD')
                    && !inputs.some(input => input.type === 'function_call_output');
                const id = randomUUID();
                const item = spawnChild
                    ? { type: 'function_call', call_id: `spawn_${id}`, namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: JSON.stringify({
                        message: 'LEGACY_ISOLATED_CHILD_CHECK', fork_context: false
                    }) }
                    : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'MOCK CONTEXT RESPONSE' }] };
                const events = [
                    { type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
                ];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        const clients: CodexAppServerClient[] = [];
        try {
            await Promise.all([mkdir(codexHome), mkdir(cwd)]);
            await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
            const port = (model.address() as { port: number }).port;
            await writeFile(join(codexHome, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\nfeatures.multi_agent = true\n[model_providers.mock]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
            vi.stubEnv('CODEX_HOME', codexHome);
            vi.stubEnv('HOME', directory);
            vi.stubEnv('HAPI_EVOLVED_PROXY', '');
            vi.stubEnv('HAPI_EVOLVED_CAPABILITY_FILE', '');
            const connect = async () => {
                const client = new CodexAppServerClient({ cwd });
                clients.push(client);
                const completed: unknown[] = [];
                const compactions: unknown[] = [];
                const errors: unknown[] = [];
                client.setServerRequestHandler(() => {});
                client.setNotificationHandler((method, params) => {
                    if (method === 'turn/completed') completed.push(params);
                    if (method === 'thread/compacted') compactions.push(params);
                    if (method === 'item/completed' && record(record(params).item).type === 'contextCompaction') compactions.push(params);
                    if (method === 'error') errors.push(params);
                });
                await initializeSharedClient(client);
                return { client, completed, compactions, errors };
            };
            const old = await connect();
            const started = await old.client.startThread({ cwd, developerInstructions: 'LEGACY THREAD WITHOUT PLATFORM CONTEXT',
                sandbox: 'read-only', approvalPolicy: 'never' });
            await old.client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'BEFORE UPDATE' }] });
            await vi.waitFor(() => expect(old.completed).toHaveLength(1), { timeout: 15_000 });
            expect(JSON.stringify(requests[0]).includes('HAPI-eVolved operating context')).toBe(false);
            await old.client.disconnect();

            vi.stubEnv('HAPI_EVOLVED_PROXY', '1');
            await new Promise<void>(resolve => mcpHttp.listen(0, '127.0.0.1', resolve));
            const mcpPort = (mcpHttp.address() as { port: number }).port;
            const current = await connect();
            const params = buildThreadStartParams({ cwd, mode: { permissionMode: 'read-only', collaborationMode: 'default' },
                mcpServers: { hapi: { url: `http://127.0.0.1:${mcpPort}` } } });
            await current.client.resumeThread({ threadId: started.thread.id, ...params });
            await current.client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'AFTER UPDATE' }] });
            await vi.waitFor(() => expect(current.completed).toHaveLength(1), { timeout: 15_000 });
            const request = requests.find(value => JSON.stringify(value.input).includes('AFTER UPDATE'));
            expect(hasMcpOperatingInstructions(request)).toBe(true);

            const completedBeforeCompaction = current.completed.length;
            await current.client.request('thread/compact/start', { threadId: started.thread.id });
            await vi.waitFor(() => expect(current.compactions.length, JSON.stringify(current.errors)).toBeGreaterThan(0), { timeout: 15_000 });
            await vi.waitFor(() => expect(current.completed.length).toBeGreaterThan(completedBeforeCompaction), { timeout: 15_000 });
            expect(record(record(current.completed.at(-1)).turn).status).toBe('completed');
            expect(current.errors).toEqual([]);
            const compactedTurn = record(await current.client.request('turn/start', {
                threadId: started.thread.id, input: [{ type: 'text', text: 'AFTER COMPACTION' }]
            }));
            await vi.waitFor(() => expect(current.completed.some(value => record(record(value).turn).id === record(compactedTurn.turn).id))
                .toBe(true), { timeout: 15_000 });
            expect(hasMcpOperatingInstructions(requests.find(value => JSON.stringify(value.input).includes('AFTER COMPACTION')))).toBe(true);

            const parentTurn = record(await current.client.request('turn/start', {
                threadId: started.thread.id, input: [{ type: 'text', text: 'SPAWN_LEGACY_CHILD' }]
            }));
            await vi.waitFor(() => expect(current.completed.some(value => record(record(value).turn).id === record(parentTurn.turn).id))
                .toBe(true), { timeout: 15_000 });
            const childRequest = () => requests.find(value => {
                const inputs = Array.isArray(value.input) ? value.input.map(record) : [];
                const user = [...inputs].reverse().find(input => input.role === 'user');
                return JSON.stringify(user)?.includes('LEGACY_ISOLATED_CHILD_CHECK');
            });
            await vi.waitFor(() => expect(hasMcpOperatingInstructions(childRequest())).toBe(true), { timeout: 15_000 });
            expect(current.errors).toEqual([]);
        } finally {
            await Promise.all(clients.map(client => client.disconnect()));
            await Promise.all([...mcpServers].map(server => server.close()));
            mcpHttp.closeAllConnections();
            await new Promise<void>(resolve => mcpHttp.close(() => resolve()));
            await new Promise<void>(resolve => model.close(() => resolve()));
            await rm(directory, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 45_000);
});
