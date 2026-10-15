/** Opt-in integration check on the test VM. Uses only newly created synthetic accounts.
 * Run as root from a root-owned release directory after building the local images.
 * No human provider account is signed in and no model request is sent.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, chownSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { RunnerOperator, runDocker } from '../../services/runner-control/operator'
import { verifyControl } from '../../hub/src/evolved/runnerControlProtocol'
import { ensureWorkspaceAnchor, removeTestWorkspaceAnchor, workspaceIdentity } from '../../services/runner-control/workspaceAnchor'

if(process.getuid?.()!==0)throw new Error('Run this isolated deployment check as root')
const source=realpathSync(resolve(import.meta.dir,'../..')),suffix=randomUUID(),state=`/var/lib/hapi-evolved-browser-check-${suffix}`
const network=`evolved-browser-check-${suffix}`,frontend=`evolved-browser-check-front-${suffix}`,hubName=`evolved-browser-check-hub-${suffix}`,uid=1001,gid=1001
const listener=createServer();await new Promise<void>(done=>listener.listen(0,'127.0.0.1',done));const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()))
const origin=`http://localhost:${port}`,base=`http://127.0.0.1:${port}`,socket=join(state,'control/control.sock')
let operator:RunnerOperator|undefined,server:ReturnType<typeof Bun.serve>|undefined,projectId:string|undefined
const delay=(ms:number)=>new Promise(done=>setTimeout(done,ms))
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message)}
mkdirSync(state,{mode:0o700});chownSync(state,uid,gid)
try{
    await runDocker(['run','--rm','--network','none','--user',`${uid}:${gid}`,'--mount',`type=bind,src=${state},dst=${state}`,'--entrypoint','bun','hapi-evolved:0.1.0','deploy/evolved/init.ts',state])
    // Match the production trust boundary: the hub can write its mounted
    // subdirectories, but cannot rename the root operator's runners directory.
    chownSync(state,0,0);chmodSync(state,0o700)
    mkdirSync(join(state,'control'),{mode:0o755});chmodSync(join(state,'control'),0o755)
    const key=readFileSync(join(state,'credentials/hub/runner-control.key')),seen=new Map<string,number>()
    operator=new RunnerOperator({state,source,uid,gid,key,hubUrl:base,backendNetwork:network})
    server=Bun.serve({unix:socket,maxRequestBodySize:20_000,async fetch(req,s){
        s.timeout(req,120)
        try{return Response.json(await operator!.request(verifyControl(key,await req.json(),'operator',seen)))}
        catch(error){return Response.json({code:(error as {code?:string}).code??'failed'},{status:(error as {status?:number}).status??503})}
    }})
    chownSync(socket,0,gid);chmodSync(socket,0o660)
    await runDocker(['network','create','--internal',network])
    await runDocker(['network','create',frontend])
    const env={HAPI_HOME:'/data',HAPI_EVOLVED_ENABLED:'1',HAPI_LISTEN_HOST:'0.0.0.0',HAPI_LISTEN_PORT:'3006',HAPI_PUBLIC_URL:origin,HAPI_IOS_PUSH:'off',HAPI_ANDROID_PUSH:'off',EVOLVED_ORIGIN:origin,EVOLVED_CODE_ROOTS:'["/workspaces"]',EVOLVED_MANAGED_WORKSPACE_ROOT:'/managed-workspaces',EVOLVED_VAULT_URL:'http://unused-vault:3212',EVOLVED_VAULT_SIGNING_KEY_FILE:'/credentials/vault-signing.pem',EVOLVED_RUNNER_CONTROL_KEY_FILE:'/credentials/runner-control.key',EVOLVED_RUNNER_CONTROL_SOCKET:'/runner-control/control.sock'}
    const args=['create','--name',hubName,'--network',network,'--network-alias','hub','--user',`${uid}:${gid}`,'--read-only','--tmpfs','/tmp:rw,nosuid,size=128m','--cap-drop','ALL','--security-opt','no-new-privileges:true','-p',`127.0.0.1:${port}:3006`]
    for(const [name,value] of Object.entries(env))args.push('-e',`${name}=${value}`)
    for(const [host,target,mode] of [['hub','/data','rw'],['workspaces','/workspaces','ro'],['managed-workspaces','/managed-workspaces','rw'],['credentials/hub','/credentials','ro'],['control','/runner-control','ro']])args.push('--mount',`type=bind,src=${join(state,host!)},dst=${target}${mode==='ro'?',readonly':''}`)
    args.push('hapi-evolved:0.1.0');await runDocker(args)
    await runDocker(['network','connect',frontend,hubName])
    await runDocker(['start',hubName])
    let healthy=false
    for(let i=0;i<80;i++){try{healthy=(await fetch(`${base}/health`)).ok}catch{}if(healthy)break;await delay(250)}
    assert(healthy,'Synthetic hub did not start')
    // This isolated database has no human users or credentials.
    const seeded=JSON.parse(await runDocker(['exec',hubName,'bun','-e',`import {EvolvedStore} from '/app/hub/src/evolved/store.ts';const s=new EvolvedStore('/data/evolved.db',{managedWorkspaceRoot:'/managed-workspaces'});const id=crypto.randomUUID();s.db.prepare('INSERT INTO evolved_users VALUES(?,?,1,?)').run(id,'Synthetic login acceptance',Date.now());const team=s.createTeam(id,'Synthetic team');const project=s.createProject(id,team.id,'Synthetic login project');console.log(JSON.stringify({token:s.createSession(id),otherToken:s.createSession(id),projectId:project.id}));s.close()`])) as {token:string;otherToken:string;projectId:string}
    projectId=seeded.projectId
    const call=async(path:string,method='GET',body?:unknown,token=seeded.token)=>{
        const response=await fetch(`${base}/api/evolved${path}`,{method,headers:{origin,'Content-Type':'application/json',cookie:`__Host-hapi-evolved=${token}`},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90_000)})
        return{status:response.status,body:await response.json() as Record<string,any>}
    }
    const path=`/projects/${projectId}/providers`,challenges:string[]=[]
    assert((await call(path)).body.runner?.status==='unconfigured','GET must not provision a runner')
    const initialCatalog=await call(`${path}/codex/models`)
    assert(initialCatalog.status===200&&initialCatalog.body.models?.length===0,'An unconfigured project must expose an empty model snapshot')
    assert((await call(path)).body.runner?.status==='unconfigured','Model snapshot GET must not provision a runner')
    for(const provider of ['codex','claude']){
        let result=await call(`${path}/${provider}/login`,'POST',{})
        if(result.status!==200){
            const observed=await runDocker(['inspect','--format','{{json .State}}',`hapi-evolved-runner-${projectId}-runner-1`]).catch(()=>'null')
            console.error(JSON.stringify({phase:`${provider}-start`,runnerState:JSON.parse(observed)}))
        }
        assert(result.status===200,`Native ${provider} start failed (${result.status}: ${result.body.code??'unknown'})`)
        const id=result.body.operation?.id
        for(let i=0;i<120 && result.body.operation?.state==='starting';i++){await delay(500);result=await call(`${path}/${provider}/login/${id}`)}
        assert(result.body.operation?.state==='waiting',`Native ${provider} did not produce a usable challenge`)
        const url=new URL(result.body.operation.verificationUrl)
        assert(url.origin===(provider==='codex'?'https://auth.openai.com':'https://claude.com'),'Unexpected native login destination')
        if(provider==='codex')assert(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/.test(result.body.operation.userCode),'Codex device code missing')
        challenges.push(provider)
        const foreign=await call(`${path}/${provider}/login/${id}`,'GET',undefined,seeded.otherToken)
        assert(foreign.status===404,'Another HAPI session could inspect the private challenge')
        const resumed=await call(`${path}/${provider}/login`,'POST',{})
        assert(resumed.body.operation?.id===id,'Reload/reconnect did not resume the same native login')
        if(provider==='codex'){
            const cancelled=await call(`${path}/${provider}/login/${id}`,'DELETE')
            assert(cancelled.body.operation?.state==='cancelled','Native login cancellation failed')
            const catalog=await call(`${path}/codex/models/refresh`,'POST',{})
            assert(catalog.status===200&&catalog.body.status==='disconnected'&&catalog.body.models?.length===0,'An anonymous account must not receive a fabricated authorized model list')
            assert(catalog.body.catalogOrigin==='native-reported'&&catalog.body.entitlementVerified===false,'Model catalog provenance must remain explicit')
            const container=`hapi-evolved-runner-${projectId}-runner-1`
            const inspected=JSON.parse(await runDocker(['inspect',container]))[0]
            assert(inspected.HostConfig.RestartPolicy.Name==='no','Managed runner must wait for lease-checked restoration')
            assert(inspected.Mounts.some((mount:{Destination:string;RW:boolean})=>mount.Destination===`/managed-workspaces/${projectId}`&&!mount.RW),'Restricted workspace must be mounted read-only')
            const original=join(state,'managed-workspaces',projectId!),saved=`${original}.synthetic-saved`
            const pinned=join(state,'runners',projectId!,'workspace'),identity=workspaceIdentity(pinned)
            renameSync(original,saved)
            try{
                mkdirSync(original,{mode:0o700});chownSync(original,uid,gid)
                let rejected=false
                try{await ensureWorkspaceAnchor(state,projectId!,`/managed-workspaces/${projectId}`,identity)}catch{rejected=true}
                assert(rejected,'A replacement project directory must not inherit an existing authorization')
                rmSync(original,{recursive:true})
                symlinkSync('/etc',original)
                rejected=false
                try{await ensureWorkspaceAnchor(state,projectId!,`/managed-workspaces/${projectId}`,identity)}catch{rejected=true}
                assert(rejected,'A swapped project symlink must be rejected')
                assert(JSON.stringify(workspaceIdentity(pinned))===JSON.stringify(identity),'Pinned workspace changed after source path replacement')
                unlinkSync(original)
            }finally{
                rmSync(original,{recursive:true,force:true});renameSync(saved,original)
            }
            operator.close();await delay(4000)
            await runDocker(['stop',container])
            operator=new RunnerOperator({state,source,uid,gid,key,hubUrl:base,backendNetwork:network})
            let restored=false,stable=0
            for(let i=0;i<60;i++){
                const running=(await runDocker(['inspect','--format','{{.State.Running}}',container]))==='true'
                stable=running?stable+1:0;restored=stable>=4
                if(restored)break
                await delay(500)
            }
            assert(restored,'Operator restart did not restore the permanent authorized project runner')
        }else{
            const busyCatalog=await call(`${path}/claude/models/refresh`,'POST',{})
            assert(busyCatalog.status===200&&busyCatalog.body.status==='unavailable','Model discovery must not interrupt an active provider login')
            assert((await call(`${path}/claude/login/${id}`)).body.operation?.state==='waiting','Active Claude challenge was interrupted by model discovery')
            const invalid=await call(`${path}/${provider}/login/${id}/code`,'POST',{code:'synthetic-invalid-code#incorrect-state'})
            assert(invalid.status===400,'Claude must reject a mismatched callback state')
            await runDocker(['exec',hubName,'bun','-e',`import {Database} from 'bun:sqlite';const db=new Database('/data/evolved.db');db.exec('DELETE FROM evolved_sessions');db.close()`])
            await delay(6500)
            const processes=await runDocker(['exec',`hapi-evolved-runner-${projectId}-runner-1`,'ps','-eo','args'])
            assert(!processes.split('\n').some(line=>line.includes('/app/services/runner-auth/worker.ts')||/codex.*login.*--device-auth|claude.*auth login/.test(line)),'Native login survived loss of its HAPI session')
        }
    }
    const credentials=await runDocker(['exec',`hapi-evolved-runner-${projectId}-runner-1`,'/usr/bin/setpriv','--reuid',String(uid),'--regid',String(gid),'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','--','/usr/local/bin/bun','-e',`import{existsSync}from'node:fs';console.log(JSON.stringify({codex:existsSync('/runner/codex/auth.json'),claude:existsSync('/runner/claude/.credentials.json')}))`])
    assert(!JSON.parse(credentials).codex&&!JSON.parse(credentials).claude,'Anonymous check unexpectedly stored provider credentials')
    console.log(JSON.stringify({passed:true,checks:['automatic managed runner provisioning','read-only project mount','native worker privilege drop','Codex device challenge','Claude code challenge','same-session resume','foreign-session isolation','native cancellation','model snapshot does not provision','anonymous catalog and active-login discovery isolation','directory replacement and symlink swap rejection','permanent runner restoration after operator restart','callback state rejection','session revocation kills native processes','no provider account or model request'],providers:challenges},null,2))
}finally{
    operator?.close();await server?.stop(true);await delay(4000)
    let cleaned=true
    if(projectId){
        const env=join(state,'runners',projectId,'runner.env')
        try{await runDocker(['compose','--env-file',env,'-f',join(source,'deploy/evolved/runner.compose.yml'),'down','--remove-orphans'])}catch{cleaned=false;console.error('Synthetic runner cleanup requires inspection')}
        try{await removeTestWorkspaceAnchor(join(state,'runners',projectId,'workspace'))}catch{cleaned=false;console.error('Synthetic workspace anchor cleanup requires inspection')}
    }
    await runDocker(['rm','-f',hubName]).catch(()=>{})
    await runDocker(['network','rm',network]).catch(()=>{})
    await runDocker(['network','rm',frontend]).catch(()=>{})
    // Only the unique synthetic directory created above; never installation state.
    if(cleaned&&state===`/var/lib/hapi-evolved-browser-check-${suffix}`)rmSync(state,{recursive:true,force:true})
    if(!cleaned)throw new Error(`Synthetic state retained for cleanup: ${state}`)
}
