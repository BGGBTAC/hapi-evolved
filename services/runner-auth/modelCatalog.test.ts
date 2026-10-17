import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { NativeAuthController } from './controller'
import { normalizeModels } from './modelCatalog'
import { parseRequest, serveRequests } from './worker'

const fixtures: { home: string; controller: NativeAuthController }[] = []
afterEach(async () => {
    for (const item of fixtures.splice(0)) { await item.controller.close(); rmSync(item.home, { recursive: true, force: true }) }
})
async function fixture(mode = 'normal') {
    const home = mkdtempSync(join(tmpdir(), 'evolved-model-catalog-'))
    mkdirSync(join(home, 'bin'), { mode: 0o700 })
    writeFileSync(join(home, 'mode'), mode)
    const script = `#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
const provider=basename(process.argv[1]),home=process.env.HOME,args=process.argv.slice(2),mode=readFileSync(join(home,'mode'),'utf8');
appendFileSync(join(home,'calls'),JSON.stringify({provider,args})+'\\n');
const marker=join(home,provider+'.session');
if(args.includes('status')) {
 if(mode==='status-hang'){setInterval(()=>{},1000);await new Promise(()=>{});}
 const method=existsSync(marker)?readFileSync(marker,'utf8'):'none';
 if(provider==='claude')console.log(JSON.stringify({loggedIn:method!=='none',authMethod:method==='none'?'none':method==='api-key'?'api_key':'claude.ai'}));
 else console.error(method==='none'?'Not logged in':method==='api-key'?'Logged in using an API key - secret':'Logged in using ChatGPT');
 process.exit(method==='none'?1:0);
}
if(args.includes('logout')){if(existsSync(marker))unlinkSync(marker);process.exit(0)}
writeFileSync(join(home,provider+'.pid'),String(process.pid));
if(mode==='auth-rotation')writeFileSync(join(home,provider,provider==='codex'?'auth.json':'.credentials.json'),JSON.stringify({syntheticAccount:'changed-during-discovery'}));
appendFileSync(join(home,'cache-presence'),String(existsSync(join(home,'codex','models_cache.json')))+'\\n');
let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
 buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const raw=buffer.slice(0,i);buffer=buffer.slice(i+1);const req=JSON.parse(raw);appendFileSync(join(home,'requests'),JSON.stringify(req)+'\\n');
 if(mode==='hang')continue;
 if(mode==='overflow'){console.log('secret'.repeat(50000));continue;}
 if(mode==='invalid'){console.log('invalid private diagnostic');continue;}
 if(req.method==='initialized')continue;
 let message;
 if(provider==='claude') message={type:'control_response',response:{subtype:'success',request_id:req.request_id,response:{account:{email:'secret-account'},commands:[{name:'private-command'}],models:[{value:'future-model',resolvedModel:'future-provider-id',displayName:'Future model',supportedEffortLevels:['low','high']}]}}};
 else if(req.method==='initialize') message={id:req.id,result:{userAgent:'native-test'}};
 else message={id:req.id,result:{data:[{id:req.params.cursor?'second':'first',model:req.params.cursor?'model-b':'model-a',displayName:req.params.cursor?'Model B':'Model A',isDefault:!req.params.cursor,supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:mode==='loop'?'repeat':req.params.cursor?null:'next'}};
 if(mode==='large-dto'&&provider==='claude')message.response.response.models=Array.from({length:100},(_,i)=>({value:'model-'+i+'-'+ 'x'.repeat(88),resolvedModel:'resolved-'+i+'-'+ 'x'.repeat(85),displayName:'L'.repeat(80),supportedEffortLevels:Array.from({length:8},(_,j)=>'e'+ 'x'.repeat(30)+j)}));
 if(mode==='server-request'&&provider==='codex'&&req.method==='model/list')console.log(JSON.stringify({id:req.id,method:'server/needs-input',params:{},result:{data:[{model:'wrong-server-request',displayName:'Wrong'}],nextCursor:null}}));
 console.error('private-diagnostic-secret');const text=JSON.stringify(message)+'\\n';process.stdout.write(text.slice(0,12));setTimeout(()=>process.stdout.write(text.slice(12)),5);
 }});setInterval(()=>{},1000);
`
    for (const provider of ['codex', 'claude']) { writeFileSync(join(home, 'bin', provider), script, { mode: 0o700 }); writeFileSync(join(home, `${provider}.session`), 'subscription') }
    const controller = new NativeAuthController({ home, codexPath: join(home, 'bin', 'codex'), claudePath: join(home, 'bin', 'claude'), catalogTimeoutMs: 250 })
    fixtures.push({ home, controller }); await controller.initialize()
    return { home, controller, calls: () => readFileSync(join(home, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

test('Codex discovers paginated native models without inference, and only approved metadata reaches callers', async () => {
    const f = await fixture(), result = await f.controller.models('codex')
    expect(result).toMatchObject({ provider: 'codex', status: 'ready', method: 'subscription', source: 'native-cli' })
    expect(result.models.map(model => model.id)).toEqual(['model-a', 'model-b'])
    expect(result.models[0]).toMatchObject({ isDefault: true, reasoningEfforts: ['medium'] })
    expect(JSON.stringify(result)).not.toContain('secret')
    const requests = readFileSync(join(f.home, 'requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list'])
    expect(f.calls().filter(call => call.args.includes('app-server'))[0].args).toEqual(['-c', 'cli_auth_credentials_store="file"', '-c', 'mcp_servers={}', 'app-server'])
    expect(() => process.kill(Number(readFileSync(join(f.home, 'codex.pid'), 'utf8')), 0)).toThrow()
})

test('Claude initialization discovers dynamic aliases safely, ignoring stderr, account data and commands', async () => {
    const f = await fixture(), result = await f.controller.models('claude')
    expect(result.models).toEqual([{ id: 'future-model', resolvedModel: 'future-provider-id', label: 'Future model', isDefault: false, reasoningEfforts: ['low', 'high'] }])
    expect(JSON.stringify(result)).not.toMatch(/secret|private-command/)
    const call = f.calls().find(call => call.args.includes('--print'))
    for (const flag of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '--tools']) expect(call.args).toContain(flag)
    expect(readFileSync(join(f.home, 'requests'), 'utf8').trim()).toBe(JSON.stringify({ type: 'control_request', request_id: 'hapi-model-catalog', request: { subtype: 'initialize' } }))
})

test('Codex server-initiated requests cannot spoof model responses through colliding request IDs', async () => {
    const f = await fixture('server-request'), result = await f.controller.models('codex')
    expect(result.status).toBe('ready')
    expect(result.models.map(model => model.id)).toEqual(['model-a', 'model-b'])
    expect(JSON.stringify(result)).not.toContain('wrong-server-request')
})

test('model status checks stop after the narrower three-second budget without launching discovery', async () => {
    const f = await fixture('status-hang'), started = Date.now()
    expect(await f.controller.models('claude')).toMatchObject({ status: 'unavailable', models: [] })
    expect(Date.now() - started).toBeLessThan(4_500)
    expect(f.calls().some(call => call.args.includes('--print'))).toBe(false)
})

test('disconnected providers cannot return their bundled catalog, and API keys are labeled distinctly', async () => {
    const f = await fixture()
    rmSync(join(f.home, 'claude.session'))
    expect(await f.controller.models('claude')).toMatchObject({ status: 'disconnected', method: null, models: [] })
    expect(f.calls().some(call => call.args.includes('--print'))).toBe(false)
    writeFileSync(join(f.home, 'codex.session'), 'api-key')
    expect(await f.controller.models('codex')).toMatchObject({ status: 'ready', method: 'api-key' })
})

test('cache reuses only the same auth context, returns copies, and explicit refresh preserves native CLI cache', async () => {
    const f = await fixture()
    const first = await f.controller.models('codex'); first.models.length = 0
    expect((await f.controller.models('codex')).models).toHaveLength(2)
    expect(f.calls().filter(call => call.args.includes('app-server'))).toHaveLength(1)
    writeFileSync(join(f.home, 'codex', 'auth.json'), '{"synthetic":"account-changed"}')
    await f.controller.models('codex')
    expect(f.calls().filter(call => call.args.includes('app-server'))).toHaveLength(2)
    writeFileSync(join(f.home, 'codex', 'models_cache.json'), '{}', { mode: 0o600 })
    await f.controller.models('codex', true)
    expect(readFileSync(join(f.home, 'codex', 'models_cache.json'), 'utf8')).toBe('{}')
    expect(readFileSync(join(f.home, 'cache-presence'), 'utf8').trim().split('\n')).toEqual(['false', 'false', 'true'])
    expect(f.calls().filter(call => call.args.includes('app-server'))).toHaveLength(3)
    await f.controller.logout('codex')
    expect((await f.controller.models('codex')).models).toEqual([])
})

test('invalid protocol, cursor cycles, overflow and deadlines return no silent fallback and kill native probes', async () => {
    for (const mode of ['invalid', 'loop', 'overflow', 'hang']) {
        const f = await fixture(mode), result = await f.controller.models('codex')
        expect(result).toMatchObject({ status: 'unavailable', models: [] })
        expect(JSON.stringify(result)).not.toContain('secret')
        expect(() => process.kill(Number(readFileSync(join(f.home, 'codex.pid'), 'utf8')), 0)).toThrow()
    }
})

test('valid model fields cannot exceed the aggregate Hub metadata budget', async () => {
    const f = await fixture('large-dto'), result = await f.controller.models('claude')
    expect(result).toMatchObject({ status: 'unavailable', models: [] })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(30_000)
    expect(() => process.kill(Number(readFileSync(join(f.home, 'claude.pid'), 'utf8')), 0)).toThrow()
})

test('external credential rotation during discovery cannot cache the previous catalog for the new account', async () => {
    const f = await fixture('auth-rotation')
    expect(await f.controller.models('codex')).toMatchObject({ status: 'unavailable', models: [] })
    writeFileSync(join(f.home, 'mode'), 'normal')
    expect(await f.controller.models('codex')).toMatchObject({ status: 'ready' })
    expect(await f.controller.models('codex')).toMatchObject({ status: 'ready' })
    expect(f.calls().filter(call => call.args.includes('app-server'))).toHaveLength(2)
})

test('service close cancels discovery without publishing a post-close catalog', async () => {
    const f = await fixture('hang'), pending = f.controller.models('claude')
    for (let i = 0; i < 100 && !existsSync(join(f.home, 'claude.pid')); i++) await new Promise(resolve => setTimeout(resolve, 5))
    await f.controller.close()
    expect(await pending).toMatchObject({ status: 'unavailable', models: [] })
    await expect(f.controller.models('claude')).rejects.toMatchObject({ code: 'closed' })
})

test('IPC EOF and missing authorization heartbeat terminate in-flight model discovery', async () => {
    for (const eof of [true, false]) {
        const f = await fixture('hang'), source = new PassThrough(), sink = new PassThrough()
        const service = serveRequests(f.controller, source, sink, eof ? 1000 : 150)
        source.write(`${JSON.stringify({ requestId: 'models', action: 'models', provider: 'claude' })}\n`)
        for (let i = 0; i < 100 && !existsSync(join(f.home, 'claude.pid')); i++) await new Promise(resolve => setTimeout(resolve, 5))
        if (eof) source.end()
        await service.closed
        expect(() => process.kill(Number(readFileSync(join(f.home, 'claude.pid'), 'utf8')), 0)).toThrow()
        await expect(f.controller.models('claude')).rejects.toMatchObject({ code: 'closed' })
    }
})

test('catalog schema rejects unsafe identifiers, control text, oversized arrays and duplicate IDs', () => {
    for (const models of [
        [{ value: 'bad\nmodel', displayName: 'Model' }],
        [{ value: 'ok', displayName: '\u202Ehidden' }],
        [{ value: 'ok', displayName: '\u3164' }],
        [{ value: 'same' }, { value: 'same' }],
        Array.from({ length: 201 }, (_, index) => ({ value: `model-${index}` })),
        [{ value: 'ok', supportedEffortLevels: ['anything\nunsafe'] }],
    ]) expect(() => normalizeModels('claude', models)).toThrow()
    expect(parseRequest({ requestId: 'models', action: 'models', provider: 'claude', refresh: true })).toMatchObject({ refresh: true })
    for (const fields of [{ refresh: 'true' }, { executable: '/bin/sh' }, { code: 'not-for-models' }]) expect(() => parseRequest({ requestId: 'models', action: 'models', provider: 'claude', ...fields })).toThrow()
})

test('catalog retains bounded descriptions and explicit native capacities without guessing missing windows', () => {
    expect(normalizeModels('codex', [{ model: 'gpt-6-astra', displayName: 'Astra', description: 'Native description', contextWindow: 900_000 }]))
        .toEqual([{ id: 'gpt-6-astra', label: 'Astra', isDefault: false, description: 'Native description', contextWindow: 900_000 }])
    expect(normalizeModels('claude', [{ value: 'opus', resolvedModel: 'claude-opus-5-5' }])[0].contextWindow).toBeUndefined()
    for (const contextWindow of [-1, 0, 1.5, Infinity, '1000000']) {
        expect(normalizeModels('claude', [{ value: 'opus', contextWindow }])[0].contextWindow).toBeUndefined()
    }
    for (const description of ['secret\ncontrol', '\u202Ehidden', 'x'.repeat(501)]) {
        expect(normalizeModels('claude', [{ value: 'opus', description }])[0].description).toBeUndefined()
    }
})
