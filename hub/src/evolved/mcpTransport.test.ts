import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { EvolvedError } from './store'
import { createPinnedMcpFetch, createRemoteMcpClient, isPublicMcpAddress } from './mcpTransport'
import { MCP_MAX_RESPONSE_BYTES, normalizeMcpTools } from './mcpVault'

const config = { endpoint: 'https://public.example.test/mcp', credential: { mode: 'bearer' as const, token: 'SYNTHETIC-only-project-a' } }
const tool = { name: 'lookup', description: 'Documentation', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } }
type Reply = { status?: number; headers?: Record<string, string>; body?: string; chunks?: string[]; pending?: boolean }
function network(respond?: (message: any) => Reply) {
    const calls: Array<{ options: RequestOptions; message: any; address: string }> = []
    let lookups = 0
    return {
        calls, get lookups() { return lookups },
        lookup: async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }] },
        request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
            const req = new EventEmitter() as ClientRequest
            req.destroy = (() => req) as ClientRequest['destroy']
            req.end = ((body?: string) => {
                const message = body ? JSON.parse(body) : undefined
                let address = ''
                ;(options.lookup as Function)('public.example.test', { all: false }, (_error: unknown, ip: string) => { address = ip })
                calls.push({ options, message, address })
                queueMicrotask(() => {
                    const rpc = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: message?.id, result })
                    const response = new PassThrough() as unknown as IncomingMessage
                    let reply = respond?.(message)
                    if (!reply) {
                        if (message?.method === 'initialize') reply = { body: rpc({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } }) }
                        else if (message?.method === 'notifications/initialized') reply = { status: 202 }
                        else if (message?.method === 'tools/list') reply = { body: rpc({ tools: [tool] }) }
                        else if (message?.method === 'tools/call') reply = { body: rpc({ content: [{ type: 'text', text: 'Documentation result' }] }) }
                        else reply = { status: 405 }
                    }
                    response.statusCode = reply.status ?? 200
                    response.headers = { 'content-type': 'application/json', ...reply.headers }
                    callback(response)
                    options.signal?.addEventListener('abort', () => response.destroy(new Error('synthetic cancellation')), { once: true })
                    if (reply.pending) return
                    if (reply.chunks) for (const chunk of reply.chunks) response.push(Buffer.from(chunk))
                    else if (reply.body) response.push(Buffer.from(reply.body))
                    response.push(null)
                })
                return req
            }) as ClientRequest['end']
            return req
        },
    }
}

test('public-only IP classifier rejects all private, loopback, reserved and mapped variants', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.4.3', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:93.184.216.34', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '::127.0.0.1', '::10.0.0.1', '::93.184.216.34']) expect(isPublicMcpAddress(ip)).toBe(false)
    expect(isPublicMcpAddress('93.184.216.34')).toBe(true)
    expect(isPublicMcpAddress('2606:4700:4700::1111')).toBe(true)
})

test('pinned socket preserves TLS host verification, strips caller headers and never re-resolves', async () => {
    const n = network(), signal = new AbortController().signal
    let checks = 0
    const fetcher = createPinnedMcpFetch(config, async () => { checks++ }, signal, n)
    const response = await fetcher(config.endpoint, { method: 'POST', headers: { authorization: 'attacker', cookie: 'private-cookie', host: 'internal', 'x-evil': 'forwarded' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
    await response.text()
    expect(n.lookups).toBe(1); expect(checks).toBe(2)
    const sent = n.calls[0]
    expect(sent.address).toBe('93.184.216.34')
    expect(sent.options.hostname).toBe('public.example.test'); expect(sent.options.servername).toBe('public.example.test'); expect(sent.options.rejectUnauthorized).toBe(true); expect(sent.options.agent).toBe(false)
    expect(sent.options.headers).toMatchObject({ authorization: `Bearer ${config.credential.token}`, 'accept-encoding': 'identity' })
    for (const name of ['cookie', 'host', 'x-evil']) expect((sent.options.headers as Record<string, string>)[name]).toBeUndefined()
    let all: unknown; (sent.options.lookup as Function)('changed.example.test', { all: true }, (_error: unknown, addresses: unknown) => { all = addresses })
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]); expect(n.lookups).toBe(1)
})

test('DNS mixed answers, changed endpoint and revocation during DNS prevent any socket request', async () => {
    const n = network(), init = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
    const mixed = createPinnedMcpFetch(config, async () => {}, new AbortController().signal, { ...n, lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] })
    await expect(mixed(config.endpoint, init)).rejects.toThrow('public IP')
    await expect(mixed('https://internal.example.test/mcp', init)).rejects.toThrow('configured endpoint')
    let release!: () => void, entered!: () => void, revoked = false
    const waiting = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { release = r })
    const delayed = createPinnedMcpFetch(config, async () => { if (revoked) throw new EvolvedError('scope_denied', 'Access revoked.', 403) }, new AbortController().signal, { ...n, lookup: async () => { entered(); await gate; return [{ address: '93.184.216.34', family: 4 }] } })
    const attempt = delayed(config.endpoint, init); await waiting; revoked = true; release()
    await expect(attempt).rejects.toThrow('revoked'); expect(n.calls).toHaveLength(0)
})

test('response bounds, split credential echoes and redirects are rejected without exposing body text', async () => {
    const replies: Reply[] = [
        { status: 302, headers: { location: 'http://127.0.0.1/secret' } },
        { headers: { 'content-encoding': 'gzip' }, body: 'encoded' },
        { body: 'x'.repeat(MCP_MAX_RESPONSE_BYTES + 1) },
        { chunks: ['prefix-SYNTHETIC-only-', 'project-a-suffix'] },
    ]
    for (const reply of replies) {
        const n = network(() => reply), fetcher = createPinnedMcpFetch(config, async () => {}, new AbortController().signal, n)
        let caught: unknown
        try { await (await fetcher(config.endpoint, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text() } catch (error) { caught = error }
        expect(caught).toBeInstanceOf(Error); expect(String(caught)).not.toContain(config.credential.token); expect(n.calls).toHaveLength(1)
    }
})

test('real SDK initialize/list/call over pinned transport is scoped and requires unchanged fresh tool fingerprint', async () => {
    const n = network(); let checks = 0
    const client = createRemoteMcpClient({ ...n, timeoutMs: 2000 }), revalidate = async () => { checks++ }
    const tools = await client.discover(config, revalidate)
    expect(tools).toEqual(normalizeMcpTools([tool])); expect(tools[0].readOnly).toBe(false)
    const result = await client.call(config, 'lookup', { q: 'docs' }, tools[0].fingerprint, revalidate)
    expect(result).toEqual({ content: [{ type: 'text', text: 'Documentation result' }] })
    expect(n.calls.filter(c => c.message?.method === 'tools/call')).toHaveLength(1)
    expect(n.calls.every(c => c.address === '93.184.216.34')).toBe(true)
    expect(checks).toBeGreaterThan(n.calls.length)
    await expect(client.call(config, 'lookup', {}, '0'.repeat(64), revalidate)).rejects.toThrow('definition changed')
    expect(n.calls.filter(c => c.message?.method === 'tools/call')).toHaveLength(1)
})

test('SDK SSE tool response is bounded and late authorization change withholds completed result', async () => {
    let revoked = false
    const n = network(message => {
        if (message?.method !== 'tools/call') return undefined as unknown as Reply
        revoked = true
        return { headers: { 'content-type': 'text/event-stream' }, body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'side effect may have completed' }] } })}\n\n` }
    })
    const client = createRemoteMcpClient({ ...n, timeoutMs: 2000 })
    await expect(client.call(config, 'lookup', {}, normalizeMcpTools([tool])[0].fingerprint, async () => { if (revoked) throw new EvolvedError('scope_denied', 'Access revoked.', 403) })).rejects.toMatchObject({ code: 'mcp_outcome_unknown', status: 502 })
    expect(n.calls.filter(c => c.message?.method === 'tools/call')).toHaveLength(1)
})

test('SDK never performs OAuth discovery or retries calls; HTTP401 and body deadline are bounded', async () => {
    for (const mode of ['unauthorized', 'pending'] as const) {
        const n = network(message => {
            if (message?.method !== 'tools/call') return undefined as unknown as Reply
            return mode === 'unauthorized' ? { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/secret"' }, body: 'remote unsafe details' } : { pending: true }
        })
        const client = createRemoteMcpClient({ ...n, timeoutMs: 100 })
        let caught: unknown
        try { await client.call(config, 'lookup', {}, normalizeMcpTools([tool])[0].fingerprint, async () => {}) } catch (error) { caught = error }
        expect(caught).toBeInstanceOf(EvolvedError)
        expect(caught).toMatchObject({ code: 'mcp_outcome_unknown', status: 502 })
        expect(String(caught)).not.toContain('unsafe details')
        expect(n.calls.filter(c => c.message?.method === 'tools/call')).toHaveLength(1)
        expect(n.calls.every(c => c.options.hostname === 'public.example.test')).toBe(true)
    }
})

test('escaped credential echoes in parsed metadata/results are withheld and projects never share transport headers', async () => {
    for (const phase of ['tools/list', 'tools/call'] as const) {
        const n = network(message => {
            if (message?.method !== phase) return undefined as unknown as Reply
            const result = phase === 'tools/list' ? { tools: [{ ...tool, description: config.credential.token }] } : { content: [{ type: 'text', text: config.credential.token }] }
            return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }).replaceAll('SYNTHETIC', '\\u0053YNTHETIC') }
        })
        const client = createRemoteMcpClient({ ...n, timeoutMs: 2000 })
        await expect(phase === 'tools/list' ? client.discover(config, async () => {}) : client.call(config, 'lookup', {}, normalizeMcpTools([tool])[0].fingerprint, async () => {})).rejects.toMatchObject({ code: phase === 'tools/list' ? 'mcp_credential_echo' : 'mcp_outcome_unknown' })
    }
    const n = network(), client = createRemoteMcpClient({ ...n, timeoutMs: 2000 })
    await client.discover(config, async () => {})
    const split = n.calls.length
    await client.discover({ ...config, credential: { mode: 'header', headerName: 'X-API-Key', token: 'SYNTHETIC-only-project-b' } }, async () => {})
    expect(n.calls.slice(0, split).every(c => (c.options.headers as Record<string, string>).authorization === `Bearer ${config.credential.token}`)).toBe(true)
    expect(n.calls.slice(split).every(c => !(c.options.headers as Record<string, string>).authorization && (c.options.headers as Record<string, string>)['X-API-Key'] === 'SYNTHETIC-only-project-b')).toBe(true)
})

test('a valid SSE result cannot bypass trailing-body limits or credential checks', async () => {
    for (const suffix of ['x'.repeat(MCP_MAX_RESPONSE_BYTES), config.credential.token]) {
        const n = network(message => message?.method !== 'tools/call' ? undefined as unknown as Reply : {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'first result' }] } })}\n\n`, `: ${suffix}\n\n`],
        })
        const client = createRemoteMcpClient({ ...n, timeoutMs: 2000 })
        await expect(client.call(config, 'lookup', {}, normalizeMcpTools([tool])[0].fingerprint, async () => {})).rejects.toBeInstanceOf(EvolvedError)
        expect(n.calls.filter(c => c.message?.method === 'tools/call')).toHaveLength(1)
    }
})

test('server-initiated RPCs cannot trigger extra outbound HTTP requests', async () => {
    const n = network(message => message?.method !== 'tools/call' ? undefined as unknown as Reply : {
        body: JSON.stringify([
            { jsonrpc: '2.0', id: 'remote-ping', method: 'ping' },
            { jsonrpc: '2.0', id: 'remote-other', method: 'roots/list' },
            { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
            { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'result' }] } },
        ]),
    })
    const client = createRemoteMcpClient({ ...n, timeoutMs: 2000 })
    expect(await client.call(config, 'lookup', {}, normalizeMcpTools([tool])[0].fingerprint, async () => {})).toEqual({ content: [{ type: 'text', text: 'result' }] })
    expect(n.calls.map(c => c.message?.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
})

test('credential echoes containing JSON escape characters are withheld in decoded values and object keys', async () => {
    const escaped = { ...config, credential: { mode: 'bearer' as const, token: 'SYNTHETIC-quote"and\\slash' } }
    for (const phase of ['tools/list', 'tools/call', 'structured-key'] as const) {
        const n = network(message => {
            if (message?.method !== (phase === 'tools/list' ? 'tools/list' : 'tools/call')) return undefined as unknown as Reply
            const result = phase === 'tools/list' ? { tools: [{ ...tool, description: escaped.credential.token }] }
                : phase === 'tools/call' ? { content: [{ type: 'text', text: `prefix ${escaped.credential.token}` }] }
                    : { content: [], structuredContent: { [escaped.credential.token]: 'value' } }
            return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) }
        })
        const client = createRemoteMcpClient({ ...n, timeoutMs: 2000 })
        await expect(phase === 'tools/list' ? client.discover(escaped, async () => {}) : client.call(escaped, 'lookup', {}, normalizeMcpTools([tool])[0].fingerprint, async () => {})).rejects.toMatchObject({ code: phase === 'tools/list' ? 'mcp_credential_echo' : 'mcp_outcome_unknown' })
    }
})

test('dispatch marker distinguishes denied-before-send from unknown-after-send even through an injected fetch', async () => {
    for (const when of ['before', 'after'] as const) {
        let sent = false
        const client = createRemoteMcpClient({ timeoutMs: 2000, fetchFactory: (_config, _revalidate, _signal, dispatched) => (async (_url, init) => {
            const message = JSON.parse(init!.body as string)
            const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } })
            if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } })
            if (message.method === 'notifications/initialized') return new Response(null, { status: 204 })
            if (message.method === 'tools/list') return reply({ tools: [tool] })
            if (message.method === 'tools/call') {
                if (when === 'before') throw new EvolvedError('mcp_version_conflict', 'Changed before send.', 409)
                dispatched(); sent = true
                return reply({ content: [{ type: 'text', text: 'completed' }] })
            }
            throw new Error('Unexpected request')
        }) as typeof fetch })
        await expect(client.call(config, 'lookup', {}, normalizeMcpTools([tool])[0].fingerprint, async () => {
            if (sent) throw new EvolvedError('mcp_version_conflict', 'Changed after send.', 409)
        })).rejects.toMatchObject({ code: when === 'before' ? 'mcp_version_conflict' : 'mcp_outcome_unknown', status: when === 'before' ? 409 : 502 })
    }
})
