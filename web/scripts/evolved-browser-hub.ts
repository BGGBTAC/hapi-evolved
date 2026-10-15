import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { EvolvedVault, createVaultSigningKey } from '../../hub/src/evolved/vault.ts'
import { createVaultServer } from '../../hub/src/evolved/vaultServer.ts'
import { startHub } from '../../hub/src/startHub.ts'
const tmp = process.env.EVOLVED_TEST_STATE!
if (!tmp || !tmp.startsWith('/tmp/hapi-evolved-ui-')) throw new Error('Synthetic test state required')
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
const hub=await startHub({args:['--no-relay']})
const stop=async()=>{await hub.stop();vaultServer.stop(true);sideProvider.stop(true);vault.close();process.exit(0)}
process.on('SIGINT',stop);process.on('SIGTERM',stop)
console.log('Synthetic Evolved browser fixture ready')
