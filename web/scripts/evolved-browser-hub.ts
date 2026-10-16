import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EvolvedVault, createVaultSigningKey } from '../../hub/src/evolved/vault.ts'
import { createVaultServer } from '../../hub/src/evolved/vaultServer.ts'
import { startHub } from '../../hub/src/startHub.ts'
const tmp = process.env.EVOLVED_TEST_STATE!
if (!tmp || !/^\/tmp\/hapi-evolved-ui-[A-Za-z0-9-]+$/.test(tmp)) throw new Error('Synthetic test state required')
if (process.env.EVOLVED_TEST_PLUGINS === '1') {
    // Only this isolated test entrypoint replaces external GitHub responses.
    // Product runtime and its PluginService always retain the ordinary fetcher.
    const originalFetch = globalThis.fetch
    const repository = 'synthetic-owner/browser-plugin'
    const manifest = (updated: boolean) => ({ schemaVersion: 1, id: 'browser-plugin', name: 'Browser Plugin', version: updated ? '1.1.0' : '1.0.0', description: 'Isolierte Browser-Test-Erweiterung',
        agents: [{ id: 'reviewer', name: 'Browser plugin reviewer', description: 'Prüft synthetische Änderungen.', instructions: 'Prüfe die Aufgabe. <img src="https://invalid.example/plugin-pixel">', providerPreference: 'either', skills: ['checklist'] }],
        skills: [{ id: 'checklist', name: 'Browser checklist', description: 'Synthetische Prüfschritte', instructions: 'Prüfe Quellen und Ergebnisse.' }],
        themes: [{ id: 'midnight', name: 'Browser midnight', mode: 'dark', colors: { background: '#101827', surface: '#182238', text: '#F9FAFB', muted: '#D1D5DB', accent: '#99CCFF', accentText: '#101827', border: '#7B8BA5' } }],
    })
    globalThis.fetch = (async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (url.href === `https://api.github.com/repos/${repository}`) return Response.json({ id: 4242, private: false, full_name: repository })
        if (url.href === `https://api.github.com/repos/${repository}/commits/HEAD`) return new Response('a'.repeat(40))
        if (url.href === `https://api.github.com/repos/${repository}/commits/updated`) return new Response('b'.repeat(40))
        for (const updated of [false, true]) if (url.href === `https://raw.githubusercontent.com/${repository}/${(updated ? 'b' : 'a').repeat(40)}/hapi-evolved.plugin.json`) return Response.json(manifest(updated))
        if (['api.github.com', 'raw.githubusercontent.com'].includes(url.hostname)) return new Response('Unknown synthetic plugin fixture', { status: 404 })
        return originalFetch(input, init)
    }) as typeof fetch
}
const hubPort = process.env.EVOLVED_TEST_HUB_PORT!
const vaultPort = process.env.EVOLVED_TEST_VAULT_PORT!
const origin = `http://localhost:${hubPort}`
const workspace = join(tmp, 'workspace')
mkdirSync(join(workspace, 'dist'), { recursive: true })
writeFileSync(join(workspace, 'dist/index.html'), `<!doctype html><html><body><h1>Evolved sandbox probe</h1><pre id="result">pending</pre><script>
(async()=>{const result={};
try{localStorage.setItem('probe','unsafe');result.localStorage='allowed'}catch{result.localStorage='blocked'}
try{document.cookie='preview_probe=unsafe';result.cookie='allowed'}catch{result.cookie='blocked'}
try{void parent.document.body;result.parentDocument=parent===self?'self':'allowed'}catch{result.parentDocument='blocked'}
try{await fetch('/api/evolved/me',{credentials:'include'});result.apiFetch='allowed'}catch{result.apiFetch='blocked'}
try{const response=await fetch('./asset.txt');result.staticAsset=response.ok?await response.text():'failed'}catch{result.staticAsset='blocked'}
document.getElementById('result').textContent=JSON.stringify(result)})();
</script></body></html>` )
writeFileSync(join(workspace, 'dist/asset.txt'), 'sandbox-asset-ok')
const signingKeyFile=join(tmp,'hub-signing.pem')
const {publicKey}=createVaultSigningKey(signingKeyFile)
// Only the external provider is synthetic; browser -> Hub -> signed Vault -> broker is real.
const githubFetcher = (async (input, init) => {
    const url = String(input)
    if (new Headers(init?.headers).get('authorization') !== 'Bearer github_pat_synthetic_browser_credential_only') return new Response('denied', { status: 401 })
    if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'synthetic-github-account' })
    if (url === 'https://api.github.com/repos/synthetic-owner/browser-repo') return Response.json({ id: 123, full_name: 'synthetic-owner/browser-repo' })
    if (process.env.EVOLVED_TEST_WORKFLOW === '1' && url === 'https://api.github.com/repos/synthetic/workflow') return Response.json({ id: 101, full_name: 'synthetic/workflow' })
    return new Response('Synthetic fixture endpoint unavailable', { status: 404 })
}) as typeof fetch
const vault=new EvolvedVault({dbPath:join(tmp,'vault.db'),masterKeyFile:join(tmp,'master.key'),githubFetcher})
const vaultServer=Bun.serve({hostname:'127.0.0.1',port:Number(vaultPort),fetch:createVaultServer({vault,hubPublicKey:publicKey}).fetch})
Object.assign(process.env,{HAPI_HOME:tmp,DB_PATH:join(tmp,'hapi.db'),HAPI_EVOLVED_ENABLED:'1',HAPI_LISTEN_HOST:'127.0.0.1',HAPI_LISTEN_PORT:hubPort,HAPI_PUBLIC_URL:origin,EVOLVED_ORIGIN:origin,EVOLVED_CODE_ROOTS:JSON.stringify([workspace]),EVOLVED_MANAGED_WORKSPACE_ROOT:join(tmp,'managed-workspaces'),EVOLVED_DB_PATH:join(tmp,'evolved.db'),EVOLVED_BOOTSTRAP_FILE:join(tmp,'bootstrap.token'),EVOLVED_VAULT_URL:`http://127.0.0.1:${vaultPort}`,EVOLVED_VAULT_SIGNING_KEY_FILE:signingKeyFile,CLI_API_TOKEN:randomBytes(32).toString('base64url'),HAPI_IOS_PUSH:'off',HAPI_ANDROID_PUSH:'off',TELEGRAM_BOT_TOKEN:'',SERVERCHAN_SENDKEY:'',EVOLVED_MEMORY_URL:'',EVOLVED_CODEGRAPH_URL:'',EVOLVED_SERVICE_TOKEN_FILE:''})
const sideKey = join(tmp, 'side-provider.key')
writeFileSync(sideKey, 'synthetic-side-provider-key', { mode: 0o600 })
let sideRequests = 0
const sideProvider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer synthetic-side-provider-key') return new Response('denied', { status: 403 })
    const body = await request.json()
    writeFileSync(join(tmp, 'side-request.json'), JSON.stringify({ count: ++sideRequests, body }), { mode: 0o600 })
    return Response.json({ choices: [{ message: { content: 'SYNTHETIC_SIDE_REPLY: separate text-only answer' } }], usage: { total_tokens: 42 } })
} })
Object.assign(process.env, { EVOLVED_SIDECHANNEL_ADAPTER: 'openai-chat-completions-v1', EVOLVED_SIDECHANNEL_URL: `http://127.0.0.1:${sideProvider.port}/completions`, EVOLVED_SIDECHANNEL_ALLOW_LOOPBACK_HTTP: '1', EVOLVED_SIDECHANNEL_MODEL: 'synthetic-side-model', EVOLVED_SIDECHANNEL_DAILY_TOKENS: '40000', EVOLVED_SIDECHANNEL_KEY_FILE: sideKey })
// Optional real local Codegraph fixture: all state and credentials are synthetic.
let codegraphProcess: ReturnType<typeof spawn> | undefined
let codegraphServiceToken: { file: string; value: string } | undefined
process.on('exit', () => codegraphProcess?.kill('SIGTERM'))
if (process.env.EVOLVED_TEST_CODEGRAPH === '1') {
    const codegraphNode = new URL('../../services/codegraph/node_modules/@colbymchenry/codegraph-linux-x64/node', import.meta.url).pathname
    try { accessSync(codegraphNode, constants.X_OK) }
    catch { throw new Error('The real Codegraph browser fixture requires the installed Linux x64 bundle: run npm ci --prefix services/codegraph --ignore-scripts') }
    const token = randomBytes(32).toString('hex')
    const tokenFile = join(tmp, 'codegraph-service.key')
    writeFileSync(tokenFile, token, { mode: 0o600 })
    codegraphServiceToken = { file: tokenFile, value: token }
    const port = process.env.EVOLVED_TEST_CODEGRAPH_PORT!
    mkdirSync(join(tmp, 'managed-workspaces'), { recursive: true, mode: 0o700 })
    codegraphProcess = spawn(codegraphNode, ['--liftoff-only', new URL('../../services/codegraph/server.mjs', import.meta.url).pathname], {
        env: { ...process.env, EVOLVED_SERVICE_TOKEN_FILE: '', EVOLVED_SERVICE_TOKEN: token, EVOLVED_CODEGRAPH_HOST: '127.0.0.1', EVOLVED_CODEGRAPH_PORT: port, EVOLVED_CODEGRAPH_STATE_DIR: join(tmp, 'codegraph'), EVOLVED_CODE_ROOTS: JSON.stringify([workspace, join(tmp, 'managed-workspaces')]) }, stdio: 'ignore',
    })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
        if (codegraphProcess.exitCode !== null) throw new Error('Synthetic Codegraph exited')
        try { if ((await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } })).ok) { ready = true; break } } catch { /* starting */ }
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!ready) { codegraphProcess.kill('SIGTERM'); throw new Error('Synthetic Codegraph did not start') }
    Object.assign(process.env, { EVOLVED_CODEGRAPH_URL: `http://127.0.0.1:${port}`, EVOLVED_SERVICE_TOKEN_FILE: tokenFile })
}
// Opt-in Memory fixture: real Browser/Hub/Vault paths; only the internal Python
// service is synthetic. No provider inference or external model endpoint exists.
let memoryServer: ReturnType<typeof Bun.serve> | undefined
if (process.env.EVOLVED_TEST_MEMORY === '1') {
    const tokenFile = codegraphServiceToken?.file ?? join(tmp, 'memory-service.key')
    const token = codegraphServiceToken?.value ?? randomBytes(32).toString('hex')
    if (!codegraphServiceToken) writeFileSync(tokenFile, token, { mode: 0o600 })
    const observed = { catalogRequests: 0, configurationChecks: 0, inferenceRequests: 0, keyLabels: [] as string[], bindings: [] as { projectId: string; embeddingModel: string; embeddingDimensions: number }[] }
    const observe = () => writeFileSync(join(tmp, 'memory-observed.json'), JSON.stringify(observed), { mode: 0o600 })
    const keyLabel = (key: unknown) => key === 'synthetic-memory-browser-initial-key' ? 'initial'
        : key === 'synthetic-memory-browser-reconnected-key' ? 'reconnected' : null
    observe()
    memoryServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'Denied' }, { status: 401 })
        const path = new URL(request.url).pathname
        if (path === '/health' && request.method === 'GET') return Response.json({ error: 'Operator provider is unconfigured' }, { status: 503 })
        if (path === '/ingest' || path === '/search') {
            observed.inferenceRequests++; observe()
            return Response.json({ error: 'Inference is forbidden in this synthetic fixture' }, { status: 503 })
        }
        if (request.method !== 'POST') return Response.json({ error: 'Unknown fixture request' }, { status: 404 })
        const body = await request.json() as { apiKey?: unknown; providerConfig?: { apiKey?: unknown; provider?: unknown; embeddingDimensions?: unknown }; projectId?: unknown; embeddingModel?: unknown; embeddingDimensions?: unknown }
        if (path === '/configuration/binding') {
            // This fixture has no graph and rejects inference. Accept only the
            // explicit projects and embeddings created by this browser scenario.
            const projects = JSON.parse(readFileSync(join(tmp, 'memory-projects.json'), 'utf8')) as string[]
            if (!body || Object.keys(body).sort().join(',') !== 'embeddingDimensions,embeddingModel,projectId'
                || typeof body.projectId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(body.projectId) || !projects.includes(body.projectId)
                || typeof body.embeddingModel !== 'string' || !['text-embedding-3-small', 'text-embedding-3-large'].includes(body.embeddingModel)
                || body.embeddingDimensions !== 1536) return Response.json({ error: 'Invalid synthetic binding' }, { status: 400 })
            observed.bindings.push({ projectId: body.projectId, embeddingModel: body.embeddingModel, embeddingDimensions: body.embeddingDimensions }); observe()
            return Response.json({ bound: true })
        }
        const label = keyLabel(path === '/configuration/models' ? body.apiKey : body.providerConfig?.apiKey)
        if (!label) return Response.json({ error: 'Only synthetic fixture credentials are accepted' }, { status: 401 })
        if (!observed.keyLabels.includes(label)) observed.keyLabels.push(label)
        if (path === '/configuration/models') {
            observed.catalogRequests++; observe()
            // The browser test controls this synthetic catalog, including a new
            // model ID absent from UI defaults, to exercise dynamic selection.
            const models = JSON.parse(readFileSync(join(tmp, 'memory-catalog.json'), 'utf8')) as string[]
            return Response.json({ models })
        }
        if (path === '/configuration/check' && body.providerConfig?.provider === 'openai' && body.providerConfig.embeddingDimensions === 1536) {
            observed.configurationChecks++; observe()
            return Response.json({ ok: true, backend: 'synthetic-browser-check' })
        }
        return Response.json({ error: 'Invalid fixture configuration' }, { status: 400 })
    } })
    Object.assign(process.env, { EVOLVED_MEMORY_URL: `http://127.0.0.1:${memoryServer.port}`, EVOLVED_SERVICE_TOKEN_FILE: tokenFile })
}
const hub=await startHub({args:['--no-relay']})
const stopWorkflow = process.env.EVOLVED_TEST_WORKFLOW === '1' ? (await import('./evolved-workflow-fixture.ts')).startWorkflowFixture(tmp, origin) : undefined
const stop=async()=>{stopWorkflow?.();codegraphProcess?.kill('SIGTERM');await hub.stop();vaultServer.stop(true);sideProvider.stop(true);memoryServer?.stop(true);vault.close();process.exit(0)}
process.on('SIGINT',stop);process.on('SIGTERM',stop)
console.log('Synthetic Evolved browser fixture ready')
