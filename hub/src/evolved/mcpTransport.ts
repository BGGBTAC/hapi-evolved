import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, ListToolsResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { EvolvedError } from './store'
import { canonicalMcpJson, MCP_MAX_ARGUMENT_BYTES, MCP_MAX_RESPONSE_BYTES, normalizeMcpTools, validateMcpCredential, validateMcpEndpoint, type McpCredential, type McpTool } from './mcpVault'

export type McpRemoteConfig = { endpoint: string; credential: McpCredential }
export type McpRevalidate = () => Promise<void>
export interface RemoteMcpClient {
    discover(config: McpRemoteConfig, revalidate: McpRevalidate): Promise<McpTool[]>
    call(config: McpRemoteConfig, toolName: string, args: Record<string, unknown>, expectedFingerprint: string, revalidate: McpRevalidate): Promise<CallToolResult>
}
export const MCP_TIMEOUT_MS = 30_000
type Address = { address: string; family: number }
type Network = { lookup?: (host: string) => Promise<Address[]>; request?: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest }
export function isPublicMcpAddress(value: string): boolean {
    if (!ipaddr.isValid(value)) return false
    const address = ipaddr.parse(value)
    if (address.kind() === 'ipv6') {
        const v6 = address as ipaddr.IPv6
        if (v6.isIPv4MappedAddress() || v6.match(ipaddr.parse('64:ff9b::'), 96) || v6.match(ipaddr.parse('64:ff9b:1::'), 48) || v6.match(ipaddr.parse('::'), 96)) return false
    }
    return address.range() === 'unicast'
}
function fail(code: string, message: string, status = 502): EvolvedError { return new EvolvedError(code, message, status) }
function checkEcho(value: unknown, credential: McpCredential): void {
    if (!credential.token) return
    const visit = (item: unknown): boolean => {
        if (typeof item === 'string') return item.includes(credential.token!)
        if (Array.isArray(item)) return item.some(visit)
        if (item && typeof item === 'object') return Object.entries(item).some(([key, child]) => key.includes(credential.token!) || visit(child))
        return false
    }
    // Inspect decoded values, not their JSON serialization: quotes and backslashes
    // in an otherwise valid header credential are escaped by JSON.stringify.
    if (visit(value)) throw fail('mcp_credential_echo', 'The MCP response contained credential data and was withheld.')
}
async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let abort!: () => void
    const stopped = new Promise<never>((_, reject) => { abort = () => reject(fail('mcp_timeout', 'MCP request was cancelled or timed out.', 504)); signal.addEventListener('abort', abort, { once: true }) })
    try { return await Promise.race([task, stopped]) } finally { signal.removeEventListener('abort', abort) }
}
function requireDirectNetwork(): void {
    // Bun 1.3.14 node:https inherits proxy environment even with agent:false;
    // its fetch also ignores the newer proxy:false override. Do not send MCP
    // credentials through an unvalidated proxy. NO_PROXY is intentionally ignored.
    if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(name => Boolean(process.env[name]))) {
        throw fail('mcp_proxy_unsupported', 'Project MCP requires a direct connection; proxy environment settings are unsupported.', 503)
    }
}
/** Fixed socket construction, shared with a real TLS runtime regression. Callers
 * must validate the address first; the production fetch does so immediately above. */
export function pinnedMcpRequestOptions(endpoint: URL, pinned: Address, headers: Record<string, string>, signal: AbortSignal): RequestOptions {
    requireDirectNetwork()
    const host = endpoint.hostname.replace(/^\[|\]$/g, '')
    return {
        protocol: 'https:', hostname: host, port: 443, path: endpoint.pathname, method: 'POST', headers,
        agent: false, rejectUnauthorized: true, servername: isIP(host) ? undefined : host, signal,
        maxHeaderSize: 16 * 1024,
        lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
            if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }])
            else callback(null, pinned.address, pinned.family)
        }) as RequestOptions['lookup'],
    }
}
/** Every real request resolves once, checks all addresses, then pins the socket lookup.
 * TLS continues to verify the original hostname; no agent/global proxy is inherited. */
export function createPinnedMcpFetch(config: McpRemoteConfig, revalidate: McpRevalidate, operationSignal: AbortSignal, network: Network = {}, onCallDispatched: () => void = () => {}): typeof fetch {
    const endpoint = new URL(validateMcpEndpoint(config.endpoint)), credential = validateMcpCredential(config.credential)
    const lookup = network.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true }))
    const request = network.request ?? httpsRequest
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.href !== endpoint.href) throw fail('mcp_endpoint_denied', 'MCP requests must use the configured endpoint.', 403)
        const signal = init?.signal ? AbortSignal.any([operationSignal, init.signal]) : operationSignal
        signal.throwIfAborted()
        requireDirectNetwork()
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        // The optional standalone notification stream is deliberately unsupported.
        // POST SSE remains supported; no reconnect/resumption/background requests.
        if (method === 'GET') return new Response(null, { status: 405 })
        if (method !== 'POST') throw fail('mcp_method_denied', 'Unsupported MCP HTTP method.', 403)
        let body: string | undefined, isToolCall = false
        if (method === 'POST') {
            if (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > MCP_MAX_ARGUMENT_BYTES + 8192) throw fail('mcp_payload_too_large', 'MCP request is too large.', 413)
            body = init.body
            let message: Record<string, unknown>
            try { message = JSON.parse(body) } catch { throw fail('mcp_invalid_payload', 'Invalid MCP request.', 400) }
            if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || (typeof message.method !== 'string' || !['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'tools/call'].includes(message.method))) throw fail('mcp_method_denied', 'Unsupported MCP protocol operation.', 403)
            isToolCall = message.method === 'tools/call'
        }
        const headers: Record<string, string> = { accept: 'application/json, text/event-stream', 'accept-encoding': 'identity', 'user-agent': 'HAPI-eVolved-MCP/0.1.0' }
        const incoming = new Headers(init?.headers)
        for (const name of ['mcp-session-id', 'mcp-protocol-version']) {
            const value = incoming.get(name)
            if (value !== null) {
                if (value.length > 256 || !/^[\x21-\x7e]+$/.test(value)) throw fail('mcp_invalid_response', 'Invalid MCP transport metadata.')
                headers[name] = value
            }
        }
        if (method === 'POST') headers['content-type'] = 'application/json'
        if (credential.mode === 'bearer') headers.authorization = `Bearer ${credential.token}`
        if (credential.mode === 'header') headers[credential.headerName!] = credential.token!
        await abortable(revalidate(), signal)
        const host = endpoint.hostname.replace(/^\[|\]$/g, '')
        let addresses: Address[]
        try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(lookup(host), signal) }
        catch (error) { if (error instanceof EvolvedError) throw error; throw fail('mcp_unreachable', 'MCP hostname could not be resolved.', 503) }
        if (!addresses.length || addresses.length > 32 || addresses.some(value => !isPublicMcpAddress(value.address) || isIP(value.address) !== value.family)) throw fail('mcp_endpoint_denied', 'MCP endpoints must resolve exclusively to public IP addresses.', 403)
        // An ACL/configuration change while DNS was in flight must prevent sending.
        await abortable(revalidate(), signal); signal.throwIfAborted()
        const pinned = addresses[0]
        return await new Promise<Response>((resolve, reject) => {
            let req: ClientRequest
            const options = pinnedMcpRequestOptions(endpoint, pinned, headers, signal)
            try {
                req = request(options, response => {
                    const status = response.statusCode ?? 502
                    if (status >= 300 && status < 400 || response.headers['content-encoding']) {
                        response.destroy(); reject(fail('mcp_endpoint_denied', 'MCP redirects and encoded responses are not allowed.', 502)); return
                    }
                    if (Number(response.headers['content-length'] ?? 0) > MCP_MAX_RESPONSE_BYTES) {
                        response.destroy(); reject(fail('mcp_response_too_large', 'MCP response exceeds its size limit.')); return
                    }
                    const outputHeaders = new Headers()
                    for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
                        const value = response.headers[name]
                        if (typeof value === 'string' && value.length <= 256) outputHeaders.set(name, value)
                    }
                    if ([202, 204, 205, 304].includes(status)) { response.destroy(); resolve(new Response(null, { status, headers: outputHeaders })); return }
                    // The SDK resolves an SSE request on its first response event.
                    // Buffer the complete bounded HTTP body first so trailing events,
                    // errors, and credential echoes cannot bypass validation. A server
                    // leaving its POST stream open is bounded by the operation deadline.
                    let total = 0, tail = Buffer.alloc(0), done = false
                    const chunks: Buffer[] = [], secret = credential.token ? Buffer.from(credential.token) : null
                    const error = (value: Error) => { if (done) return; done = true; reject(value); response.destroy() }
                    response.on('data', (chunk: Buffer) => {
                        if (done) return
                        total += chunk.length
                        if (total > MCP_MAX_RESPONSE_BYTES) { error(fail('mcp_response_too_large', 'MCP response exceeds its size limit.')); return }
                        if (secret) {
                            const scan = Buffer.concat([tail, chunk])
                            if (scan.includes(secret)) { error(fail('mcp_credential_echo', 'The MCP response contained credential data and was withheld.')); return }
                            tail = Buffer.from(scan.subarray(Math.max(0, scan.length - secret.length + 1)))
                        }
                        chunks.push(chunk)
                    })
                    response.on('end', () => {
                        if (done) return
                        done = true
                        resolve(new Response(Buffer.concat(chunks, total), { status, headers: outputHeaders }))
                    })
                    response.on('error', () => error(fail(signal.aborted ? 'mcp_timeout' : 'mcp_unreachable', 'MCP response was interrupted or timed out.', signal.aborted ? 504 : 503)))
                    response.on('aborted', () => error(fail('mcp_unreachable', 'MCP response was interrupted.', 503)))

                })
                req.on('error', () => reject(fail(signal.aborted ? 'mcp_timeout' : 'mcp_unreachable', 'MCP connection failed or timed out.', signal.aborted ? 504 : 503)))
                // Conservative dispatch boundary: end() may transmit bytes before
                // reporting an error; never present subsequent failure as retryable.
                if (isToolCall) onCallDispatched()
                req.end(body)
            } catch { reject(fail('mcp_unreachable', 'MCP connection could not be established.', 503)) }
        })
    }) as typeof fetch
}

type Options = Network & { timeoutMs?: number; fetchFactory?: (config: McpRemoteConfig, revalidate: McpRevalidate, signal: AbortSignal, onCallDispatched: () => void) => typeof fetch }
export function createRemoteMcpClient(options: Options = {}): RemoteMcpClient {
    const execute = async <T>(config: McpRemoteConfig, revalidate: McpRevalidate, action: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> => {
        config = { endpoint: validateMcpEndpoint(config.endpoint), credential: validateMcpCredential(config.credential) }
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? MCP_TIMEOUT_MS, MCP_TIMEOUT_MS))
        let callDispatched = false
        const dispatched = () => { callDispatched = true }
        const fetcher = options.fetchFactory?.(config, revalidate, controller.signal, dispatched) ?? createPinnedMcpFetch(config, revalidate, controller.signal, options, dispatched)
        const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), { fetch: fetcher, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })
        const client = new Client({ name: 'hapi-evolved-project-mcp', version: '0.1.0' }, { capabilities: {} })
        try {
            await abortable(revalidate(), controller.signal)
            await abortable(client.connect(transport), controller.signal)
            const result = await abortable(action(client, controller.signal), controller.signal)
            await abortable(revalidate(), controller.signal)
            checkEcho(result, config.credential)
            return result
        } catch (error) {
            if (callDispatched) throw fail('mcp_outcome_unknown', 'The MCP action may have executed. Its outcome could not be confirmed; do not repeat the action automatically.', 502)
            if (error instanceof EvolvedError) throw error
            if (controller.signal.aborted) throw fail('mcp_timeout', 'MCP request timed out. A tool action may already have completed.', 504)
            if (error && typeof error === 'object' && 'code' in error && [401, 403].includes(Number(error.code))) throw fail('mcp_auth_required', 'MCP authentication was rejected.', 502)
            throw fail('mcp_remote_failed', 'MCP request failed. A tool action may already have completed.', 502)
        } finally {
            clearTimeout(timer); controller.abort()
            // Closing is local only: no post-revocation DELETE or automatic retry.
            await client.close().catch(() => {}); await transport.close().catch(() => {})
        }
    }
    const list = async (client: Client, signal: AbortSignal): Promise<McpTool[]> => {
        const tools: unknown[] = []; let cursor: string | undefined
        const seen = new Set<string>()
        for (let page = 0; page < 10; page++) {
            // Low-level SDK request avoids compiling untrusted remote outputSchema.
            const result = await client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, ListToolsResultSchema, { signal, timeout: MCP_TIMEOUT_MS })
            tools.push(...result.tools)
            const normalized = normalizeMcpTools(tools)
            if (!result.nextCursor) return normalized
            if (result.nextCursor.length > 1024 || seen.has(result.nextCursor)) throw fail('mcp_invalid_catalog', 'MCP pagination is invalid.')
            cursor = result.nextCursor; seen.add(cursor)
        }
        throw fail('mcp_invalid_catalog', 'MCP catalog has too many pages.')
    }
    return {
        discover: (config, revalidate) => execute(config, revalidate, (client, signal) => list(client, signal)),
        call: (config, name, args, fingerprint, revalidate) => execute(config, revalidate, async (client, signal) => {
            canonicalMcpJson(args, MCP_MAX_ARGUMENT_BYTES)
            const tool = (await list(client, signal)).find(value => value.name === name)
            if (!tool || tool.fingerprint !== fingerprint) throw fail('mcp_catalog_changed', 'MCP tool definition changed. Rediscover and approve it before calling.', 409)
            const result = await client.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, { signal, timeout: MCP_TIMEOUT_MS })
            const projected: CallToolResult = { content: result.content, ...(result.isError !== undefined ? { isError: result.isError } : {}), ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
            canonicalMcpJson(projected, MCP_MAX_RESPONSE_BYTES)
            return projected
        }),
    }
}
