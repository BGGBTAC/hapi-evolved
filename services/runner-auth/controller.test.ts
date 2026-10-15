import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { NativeAuthController, parseChallenge, type Provider, type AuthOperation } from './controller'
import { parseRequest, serveRequests } from './worker'

const state = 's'.repeat(43)
const claudeUrl = `https://claude.com/cai/oauth/authorize?${new URLSearchParams({ code: 'true', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', response_type: 'code', redirect_uri: 'https://platform.claude.com/oauth/code/callback', scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', state })}`
const fixtures: { home: string; controller: NativeAuthController }[] = []
afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
        await fixture.controller.close()
        if (existsSync(join(fixture.home, 'escaped.pid'))) {
            try { process.kill(-Number(readFileSync(join(fixture.home, 'escaped.pid'), 'utf8')), 'SIGKILL') } catch { /* Synthetic helper already exited. */ }
        }
        rmSync(fixture.home, { recursive: true, force: true })
    }
})

async function fixture(mode = 'normal', options: { loginTimeoutMs?: number; commandTimeoutMs?: number } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'evolved-native-auth-test-'))
    const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
const provider = basename(process.argv[1]);
const args = process.argv.slice(2), home = process.env.HOME;
const marker = join(home, provider + '.synthetic-session');
const mode = readFileSync(join(home, 'mode'), 'utf8');
appendFileSync(join(home, 'calls'), JSON.stringify({provider,args,hasApiKey:!!process.env.OPENAI_API_KEY,hasOAuth:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,hasNodeOptions:!!process.env.NODE_OPTIONS,home,cwd:process.cwd()}) + '\\n');
const status = args.includes('status');
if (status) {
 if (mode === 'status-hang' || (mode === 'other-status-hang' && provider === 'claude')) setInterval(() => {}, 1000);
 else if (mode === 'bad-status') { console.log('private-diagnostic-secret'); process.exit(2); }
 else {
 const authenticated = existsSync(marker), method = authenticated ? readFileSync(marker, 'utf8') : 'none';
 if (mode === 'status-warning' && provider === 'claude') console.error('private-diagnostic-secret warning');
 if (provider === 'claude') console.log(JSON.stringify({loggedIn:authenticated,authMethod:authenticated?(method==='api-key'?'api_key':'claude.ai'):'none',accountMetadata:'must-not-reach-browser'}));
 else console.error(authenticated ? (method==='api-key'?'Logged in using an API key - private-diagnostic-secret':'Logged in using ChatGPT') : 'Not logged in');
 process.exit(authenticated?0:1);
 }
} else if (args.includes('logout')) {
 const {unlinkSync} = await import('node:fs'); if (existsSync(marker)) unlinkSync(marker); console.log('Logged out'); process.exit(0);
} else {
 writeFileSync(join(home, provider + '.pid'), String(process.pid));
 if (mode === 'overflow') { console.log('private-diagnostic-secret'.repeat(10000)); setInterval(()=>{},1000); }
 else if (mode === 'exit-failure') { console.error('private-diagnostic-secret'); process.exit(1); }
 else if (mode === 'false-success') process.exit(0);
 else {
 if (mode === 'descendant' || mode === 'orphan') { const child=spawn(process.execPath,['-e',mode==='orphan'?'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)':'setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(join(home,'descendant.pid'),String(child.pid)); if(mode==='descendant')process.on('SIGTERM',()=>{}); }
 if (mode === 'escaped-pipes') { const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr],detached:true}); writeFileSync(join(home,'escaped.pid'),String(child.pid)); }
 if (provider === 'claude') console.log('If the browser did not open, visit: ' + ${JSON.stringify(claudeUrl)} + '\\nPaste code here if prompted >');
 else console.log('\\x1b[1mhttps://auth.openai.com/codex/device\\x1b[0m\\nAB12-C3D4E');
 process.stdin.setEncoding('utf8');
 process.stdin.on('data', input => { if (provider==='claude' && input === ${JSON.stringify(`authorizationCode123#${state}\n`)}) { writeFileSync(marker,'subscription'); console.log('Login successful.'); process.exit(0); } });
 if (mode==='codex-success') setTimeout(()=>{writeFileSync(marker,'subscription');process.exit(0)},100);
 setInterval(()=>{},1000);
 }
}
`
    mkdirSync(join(home, 'bin'), { mode: 0o700 })
    for (const provider of ['codex', 'claude']) writeFileSync(join(home, 'bin', provider), script, { mode: 0o700 })
    writeFileSync(join(home, 'mode'), mode, { mode: 0o600 })
    const controller = new NativeAuthController({ home, codexPath: join(home, 'bin', 'codex'), claudePath: join(home, 'bin', 'claude'), ...options })
    fixtures.push({ home, controller })
    await controller.initialize()
    return { home, controller, calls: () => readFileSync(join(home, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

async function waitFor(controller: NativeAuthController, provider: Provider, id: string, state: AuthOperation['state']): Promise<AuthOperation> {
    for (let i = 0; i < 200; i++) {
        const operation = controller.get(provider, id).operation
        if (operation.state === state) return operation
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Expected ${state}, got ${controller.get(provider, id).operation.state}`)
}

test('parses only pinned provider challenge URLs, device code and matching Claude OAuth parameters', () => {
    expect(parseChallenge('codex', '\x1b[1mhttps://auth.openai.com/codex/device\x1b[0m\nAB12-C3D4E')).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'AB12-C3D4E' })
    expect(parseChallenge('claude', claudeUrl)).toEqual({ url: claudeUrl, state })
    for (const url of [claudeUrl.replace('claude.com', 'claude.com.evil.test'), claudeUrl.replace('claude.com', 'user@claude.com'), claudeUrl.replace('S256', 'plain'), `${claudeUrl}&state=${state}`, claudeUrl.replace('platform.claude.com', 'evil.test'), claudeUrl.replace('user%3Ainference', 'user%3Aadmin')]) {
        expect(parseChallenge('claude', url)).toBeNull()
    }
    for (const url of ['https://auth.openai.com/codex/device?token=private', 'https://auth.openai.com.evil.test/codex/device', 'https://user@auth.openai.com/codex/device']) expect(parseChallenge('codex', `${url}\nAB12-C3D4E`)).toBeNull()
})

test('native Codex device login is verified using status, keeps secrets out of DTOs and uses fixed arguments', async () => {
    const f = await fixture('codex-success')
    const started = await f.controller.start('codex')
    const waiting = await waitFor(f.controller, 'codex', started.operation.id, 'waiting')
    expect(waiting.userCode).toBe('AB12-C3D4E')
    expect(waiting.flow).toBe('device')
    const connected = await waitFor(f.controller, 'codex', started.operation.id, 'connected')
    expect(connected.verificationUrl).toBeUndefined()
    expect(connected.userCode).toBeUndefined()
    expect((await f.controller.status()).providers.find(provider => provider.provider === 'codex')).toMatchObject({ status: 'connected', method: 'subscription' })
    expect(f.calls().filter(call => call.provider === 'codex').map(call => call.args)).toContainEqual(['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'])
    expect(JSON.stringify(await f.controller.status())).not.toContain('accountMetadata')
})

test('Claude accepts only one bounded code for this exact flow and native status confirms persisted login', async () => {
    const f = await fixture()
    const { operation } = await f.controller.start('claude')
    const waiting = await waitFor(f.controller, 'claude', operation.id, 'waiting')
    expect(waiting.verificationUrl).toBe(claudeUrl)
    for (const code of [`authorizationCode123#${'x'.repeat(43)}`, `authorizationCode123#${state}\n`, `bad#${state}`, '${shell}']) {
        await expect(f.controller.code('claude', operation.id, code)).rejects.toMatchObject({ code: 'invalid_code' })
    }
    await expect(f.controller.code('claude', '00000000-0000-0000-0000-000000000000', `authorizationCode123#${state}`)).rejects.toMatchObject({ code: 'not_found' })
    expect((await f.controller.code('claude', operation.id, `authorizationCode123#${state}`)).operation.state).toBe('starting')
    await expect(f.controller.code('claude', operation.id, `authorizationCode123#${state}`)).rejects.toMatchObject({ code: 'invalid_state' })
    await waitFor(f.controller, 'claude', operation.id, 'connected')
    expect(f.calls().some(call => call.args.join(' ') === 'auth login --claudeai')).toBe(true)
})

test('existing subscription or API-key login is preserved and never silently replaced', async () => {
    for (const method of ['subscription', 'api-key']) {
        const f = await fixture()
        writeFileSync(join(f.home, 'codex.synthetic-session'), method)
        expect((await f.controller.start('codex')).operation.state).toBe('connected')
        expect(f.calls().every(call => call.args.includes('status'))).toBe(true)
        expect(JSON.stringify(await f.controller.status())).not.toContain('private-diagnostic-secret')
        expect(readFileSync(join(f.home, 'codex.synthetic-session'), 'utf8')).toBe(method)
    }
})

test('same-provider concurrent starts share one flow while providers remain isolated', async () => {
    const f = await fixture()
    const [first, second, claude] = await Promise.all([f.controller.start('codex'), f.controller.start('codex'), f.controller.start('claude')])
    expect(first.operation.id).toBe(second.operation.id)
    expect(claude.operation.id).not.toBe(first.operation.id)
    expect(() => f.controller.get('claude', first.operation.id)).toThrow('nicht gefunden')
    await waitFor(f.controller, 'codex', first.operation.id, 'waiting')
    expect(f.calls().filter(call => call.provider === 'codex' && call.args.includes('--device-auth'))).toHaveLength(1)
})

test('explicit cancellation terminates the child process group, including descendants and a SIGTERM-resistant parent', async () => {
    const f = await fixture('descendant')
    const { operation } = await f.controller.start('codex')
    await waitFor(f.controller, 'codex', operation.id, 'waiting')
    const pid = Number(readFileSync(join(f.home, 'codex.pid'), 'utf8'))
    const descendant = Number(readFileSync(join(f.home, 'descendant.pid'), 'utf8'))
    const cancelled = await f.controller.cancel('codex', operation.id)
    expect(cancelled.operation.state).toBe('cancelled')
    expect(cancelled.operation.userCode).toBeUndefined()
    expect(() => process.kill(pid, 0)).toThrow()
    // A killed orphan can briefly remain a zombie until PID1 reaps it.
    if (existsSync(`/proc/${descendant}/stat`)) expect(readFileSync(`/proc/${descendant}/stat`, 'utf8').split(' ')[2]).toBe('Z')
})

test('cancellation kills a SIGTERM-resistant descendant even if its parent exits first', async () => {
    const f = await fixture('orphan')
    const { operation } = await f.controller.start('codex')
    await waitFor(f.controller, 'codex', operation.id, 'waiting')
    const descendant = Number(readFileSync(join(f.home, 'descendant.pid'), 'utf8'))
    await new Promise(resolve => setTimeout(resolve, 80))
    await f.controller.cancel('codex', operation.id)
    for (let i = 0; i < 100 && existsSync(`/proc/${descendant}/stat`) && readFileSync(`/proc/${descendant}/stat`, 'utf8').split(' ')[2] !== 'Z'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    if (existsSync(`/proc/${descendant}/stat`)) expect(readFileSync(`/proc/${descendant}/stat`, 'utf8').split(' ')[2]).toBe('Z')
})

test('cancellation is bounded when a setsid helper retains inherited stdout/stderr pipes', async () => {
    const f = await fixture('escaped-pipes')
    const { operation } = await f.controller.start('codex')
    await waitFor(f.controller, 'codex', operation.id, 'waiting')
    const pid = Number(readFileSync(join(f.home, 'codex.pid'), 'utf8'))
    const started = Date.now()
    await f.controller.cancel('codex', operation.id)
    expect(Date.now() - started).toBeLessThan(1_800)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(f.controller.get('codex', operation.id).operation.state).toBe('cancelled')
})

test('Claude JSON status ignores stderr warnings without forwarding those diagnostics', async () => {
    const f = await fixture('status-warning')
    writeFileSync(join(f.home, 'claude.synthetic-session'), 'subscription')
    const result = await f.controller.status()
    expect(result.providers.find(provider => provider.provider === 'claude')).toMatchObject({ status: 'connected', method: 'subscription' })
    expect(JSON.stringify(result)).not.toContain('private-diagnostic-secret')
})

test('expiry removes challenge data, terminates login and permits a fresh flow only after process exit', async () => {
    const f = await fixture('normal', { loginTimeoutMs: 120 })
    const { operation } = await f.controller.start('codex')
    await waitFor(f.controller, 'codex', operation.id, 'waiting')
    const pid = Number(readFileSync(join(f.home, 'codex.pid'), 'utf8'))
    await waitFor(f.controller, 'codex', operation.id, 'expired')
    const next = await f.controller.start('codex')
    expect(next.operation.id).not.toBe(operation.id)
    expect(() => process.kill(pid, 0)).toThrow()
})

test('unknown status, timeout, excessive output and false native success fail closed with sanitized messages', async () => {
    for (const mode of ['bad-status', 'status-hang', 'overflow', 'exit-failure', 'false-success']) {
        const f = await fixture(mode, { commandTimeoutMs: 100 })
        const { operation } = await f.controller.start('codex')
        const failed = await waitFor(f.controller, 'codex', operation.id, 'failed')
        expect(JSON.stringify(failed)).not.toContain('private-diagnostic-secret')
        expect(failed.verificationUrl).toBeUndefined()
        if (mode === 'bad-status' || mode === 'status-hang') expect(f.calls().every(call => call.args.includes('status'))).toBe(true)
    }
})

test('explicit logout cancels pending login and verifies actual native credentials are removed', async () => {
    const f = await fixture()
    const { operation } = await f.controller.start('claude')
    await waitFor(f.controller, 'claude', operation.id, 'waiting')
    writeFileSync(join(f.home, 'claude.synthetic-session'), 'subscription')
    const result = await f.controller.logout('claude')
    expect(result.providers.find(provider => provider.provider === 'claude')?.status).toBe('disconnected')
    expect(f.controller.get('claude', operation.id).operation.state).toBe('cancelled')
    expect(f.calls().some(call => call.args.join(' ') === 'auth logout')).toBe(true)
})

test('logout verifies only its target and does not wait for an unrelated provider status command', async () => {
    const f = await fixture('other-status-hang', { commandTimeoutMs: 1_500 })
    writeFileSync(join(f.home, 'codex.synthetic-session'), 'subscription')
    const started = Date.now()
    const result = await f.controller.logout('codex')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.providers.find(provider => provider.provider === 'codex')?.status).toBe('disconnected')
    expect(f.calls().some(call => call.provider === 'claude')).toBe(false)
})

test('native children receive a minimal environment without ambient provider credentials or execution hooks', async () => {
    const previous = { key: process.env.OPENAI_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, options: process.env.NODE_OPTIONS }
    process.env.OPENAI_API_KEY = 'synthetic-only'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'synthetic-only'
    process.env.NODE_OPTIONS = '--trace-warnings'
    try {
        const f = await fixture()
        await f.controller.status()
        for (const call of f.calls()) expect(call).toMatchObject({ hasApiKey: false, hasOAuth: false, hasNodeOptions: false, cwd: f.home, home: f.home })
    } finally {
        for (const [key, value] of Object.entries({ OPENAI_API_KEY: previous.key, CLAUDE_CODE_OAUTH_TOKEN: previous.oauth, NODE_OPTIONS: previous.options })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value
        }
    }
})

test('private homes reject shared permissions and symlinked provider directories', async () => {
    const f = await fixture()
    chmodSync(f.home, 0o755)
    await expect(f.controller.initialize()).rejects.toThrow('not private')
    chmodSync(f.home, 0o700)
    rmSync(join(f.home, 'codex'), { recursive: true, force: true })
    symlinkSync(join(f.home, 'claude'), join(f.home, 'codex'))
    await expect(f.controller.initialize()).rejects.toThrow('not private')
})

test('closing controller cancels direct CLI children and prohibits further mutations', async () => {
    const f = await fixture()
    const { operation } = await f.controller.start('codex')
    await waitFor(f.controller, 'codex', operation.id, 'waiting')
    const pid = Number(readFileSync(join(f.home, 'codex.pid'), 'utf8'))
    await f.controller.close()
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(f.controller.start('codex')).rejects.toMatchObject({ code: 'closed' })
})

test('JSONL protocol rejects arbitrary commands, paths, unsupported providers and surplus parameters', () => {
    expect(parseRequest({ requestId: 'request-1', action: 'heartbeat' })).toEqual({ requestId: 'request-1', action: 'heartbeat' })
    expect(parseRequest({ requestId: 'request-2', action: 'start', provider: 'codex' })).toMatchObject({ provider: 'codex' })
    for (const request of [null, { requestId: 'id', action: 'exec' }, { requestId: 'id', action: 'start', provider: 'shell' }, { requestId: 'id', action: 'start', provider: 'codex', path: '/tmp/other' }, { requestId: 'id', action: 'status', provider: 'codex' }, { requestId: 'id\n', action: 'heartbeat' }, { requestId: 'id', action: 'cancel', provider: 'codex' }]) {
        expect(() => parseRequest(request)).toThrow()
    }
})

test('IPC EOF cancels the native child before service completion and returns only correlated sanitized DTOs', async () => {
    const f = await fixture(), source = new PassThrough(), sink = new PassThrough()
    const replies: any[] = []
    sink.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) replies.push(JSON.parse(line)) })
    const service = serveRequests(f.controller, source, sink)
    source.write(`${JSON.stringify({ requestId: 'start-1', action: 'start', provider: 'claude' })}\n`)
    for (let i = 0; i < 100 && !replies.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(replies[0].requestId).toBe('start-1')
    await waitFor(f.controller, 'claude', replies[0].result.operation.id, 'waiting')
    const pid = Number(readFileSync(join(f.home, 'claude.pid'), 'utf8'))
    source.end()
    await service.closed
    expect(() => process.kill(pid, 0)).toThrow()
    expect(JSON.stringify(replies)).not.toContain('accountMetadata')
})

test('only explicit heartbeat extends IPC lifetime; ordinary authenticated requests do not', async () => {
    const f = await fixture(), source = new PassThrough(), sink = new PassThrough()
    sink.resume()
    const service = serveRequests(f.controller, source, sink, 80)
    for (let i = 0; i < 3; i++) {
        source.write(`${JSON.stringify({ requestId: `beat-${i}`, action: 'heartbeat' })}\n`)
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    const { operation } = await f.controller.start('codex')
    await waitFor(f.controller, 'codex', operation.id, 'waiting')
    const pid = Number(readFileSync(join(f.home, 'codex.pid'), 'utf8'))
    const interval = setInterval(() => source.write(`${JSON.stringify({ requestId: 'read', action: 'get', provider: 'codex', operationId: operation.id })}\n`), 10)
    await service.closed
    clearInterval(interval)
    expect(() => process.kill(pid, 0)).toThrow()
})

test('IPC rejects oversized input and generic errors never echo malformed payloads or credentials', async () => {
    const f = await fixture(), source = new PassThrough(), sink = new PassThrough()
    let output = ''
    sink.on('data', chunk => { output += chunk.toString() })
    const service = serveRequests(f.controller, source, sink)
    source.write('private-diagnostic-secret{malformed\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(JSON.parse(output).error.code).toBe('native_auth_failed')
    expect(output).not.toContain('private-diagnostic-secret')
    source.write('x'.repeat(8_193))
    await service.closed
    await expect(f.controller.start('codex')).rejects.toMatchObject({ code: 'closed' })
})
