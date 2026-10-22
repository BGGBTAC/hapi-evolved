import { afterEach, expect, test } from 'bun:test'
import { AuthWorker, ControlError, ProjectOperations, RunnerOperator, nativeWorkerError, type WorkerHandle, type WorkerJob } from './operator'
import type { ControlRequest } from '../../hub/src/evolved/runnerControlProtocol'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const request:ControlRequest={action:'start',projectId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',sessionHash:'a'.repeat(64),leaseId:'33333333-3333-4333-8333-333333333333',profile:'restricted',rootPath:'/managed-workspaces/11111111-1111-4111-8111-111111111111',provider:'codex'}
const operationId='44444444-4444-4444-8444-444444444444'
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return{promise,resolve}}
const operators:RunnerOperator[]=[]
const temporary:string[]=[]
afterEach(()=>{for(const operator of operators.splice(0))operator.close();for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true})})
class FakeWorker implements WorkerHandle {
    closed=false;lastActivity=Date.now();jobs=new Map<string,WorkerJob>();calls:string[]=[]
    startGate:Promise<void>|undefined
    constructor(readonly owner:ControlRequest){}
    async request(action:string,fields:Record<string,unknown>={}){
        this.calls.push(action)
        if(action==='start'){
            await this.startGate
            this.jobs.set(operationId,{provider:'codex',state:'waiting',expiresAt:Date.now()+900000})
            return{operation:{id:operationId,provider:'codex',state:'waiting'}}
        }
        if(action==='get'){
            const job=this.jobs.get(String(fields.operationId))!
            job.state='connected'
            return{operation:{id:fields.operationId,...job}}
        }
        return{providers:[]}
    }
    busy(){return[...this.jobs.values()].some(job=>job.state==='waiting'&&job.expiresAt>Date.now())}
    pendingCount(){return 0}
    close(){this.closed=true}
}
/** Exercise the real request/heartbeat logic, with trusted host IO replaced only in the test instance. */
function harness(){
    const operator=Object.create(RunnerOperator.prototype) as RunnerOperator
    const workers=new Map<string,WorkerHandle>(),created:FakeWorker[]=[],dockerCalls:string[][]=[]
    const state={authorized:true,inspectGate:undefined as Promise<void>|undefined,startGate:undefined as Promise<void>|undefined}
    const tmp=mkdtempSync('/tmp/evolved-control-test-');temporary.push(tmp);writeFileSync(`${tmp}/runner.env`,'')
    const paths={directory:'/private/runner',workspace:'/private/workspace',home:'/private/home',lease:'/private/lease',env:`${tmp}/runner.env`,metadata:'/private/metadata',container:`hapi-evolved-runner-${request.projectId}-runner-1`}
    const mutable=operator as unknown as Record<string,unknown>
    Object.assign(mutable,{
        config:{uid:1001,gid:1001,source:'/immutable/source'},workers,operations:new ProjectOperations(),preparing:new Set(),checking:false,closed:false,
        authority:async()=>state.authorized,
        paths:()=>paths,metadata:()=>({leaseId:request.leaseId,profile:request.profile,rootPath:request.rootPath,workspaceIdentity:{device:'1',inode:'2'}}),
        anchor:async()=>({path:paths.workspace,identity:{device:'1',inode:'2'},restored:false}),
        docker:async(args:string[])=>{dockerCalls.push(args);await state.inspectGate;return JSON.stringify({Config:{Labels:{'com.docker.compose.project':`hapi-evolved-runner-${request.projectId}`,'com.docker.compose.service':'runner'}},State:{Running:true,StartedAt:'boot-1'},RestartCount:0,Mounts:[{Destination:'/runner',Source:paths.home},{Destination:request.rootPath,Source:paths.workspace,RW:false}]})},
        createWorker:(owner:ControlRequest)=>{const worker=new FakeWorker(owner);worker.startGate=state.startGate;created.push(worker);return worker},
        pause:async()=>{},
    })
    operators.push(operator)
    return{operator,workers,created,state,dockerCalls,mutable,heartbeat:()=> (operator as unknown as {heartbeat():Promise<void>}).heartbeat()}
}
async function tick(){await new Promise(resolve=>setTimeout(resolve,0))}

test('project queue bounds pending work, serializes one project and lets unrelated projects progress',async()=>{
    const queue=new ProjectOperations(),gate=deferred(),seen:number[]=[]
    const first=queue.run('one',async()=>{await gate.promise;seen.push(1)})
    const rest=[2,3,4].map(n=>queue.run('one',async()=>{seen.push(n)}))
    await expect(queue.run('one',async()=>{})).rejects.toMatchObject({code:'runner_busy',status:429})
    expect(await queue.run('two',async()=>42)).toBe(42)
    expect(seen).toEqual([])
    gate.resolve();await Promise.all([first,...rest]);expect(seen).toEqual([1,2,3,4])
    queue.close();await expect(queue.run('one',async()=>{})).rejects.toMatchObject({code:'runner_unavailable'})
})

test('parallel requests create one worker and foreign owner cannot enter the pending-start acknowledgement gap',async()=>{
    const h=harness(),inspect=deferred(),start=deferred()
    h.state.inspectGate=inspect.promise;h.state.startGate=start.promise
    const first=h.operator.request({...request})
    const status=h.operator.request({...request,action:'status',provider:undefined})
    const foreign=h.operator.request({...request,userId:'55555555-5555-4555-8555-555555555555',sessionHash:'b'.repeat(64)}).catch(error=>error)
    await tick();expect(h.dockerCalls).toHaveLength(1)
    inspect.resolve();await tick();expect(h.created).toHaveLength(1)
    expect(h.created[0]!.calls).toEqual(['start'])
    start.resolve();await first;await status
    expect(await foreign).toMatchObject({code:'login_busy',status:409})
    expect(h.created).toHaveLength(1)
    expect(h.created[0]!.closed).toBe(false)
    await expect(h.operator.request({...request,action:'get',operationId,userId:'55555555-5555-4555-8555-555555555555'})).rejects.toMatchObject({code:'operation_not_found',status:404})
})

test('authority is rechecked after Docker inspect and no worker starts after revocation or operator shutdown',async()=>{
    for(const shutdown of [false,true]){
        const h=harness(),gate=deferred();h.state.inspectGate=gate.promise
        const pending=h.operator.request({...request}).catch(error=>error)
        await tick()
        if(shutdown)h.operator.close();else h.state.authorized=false
        gate.resolve()
        expect(await pending).toMatchObject({code:'authority_lost',status:403})
        expect(h.created).toHaveLength(0)
    }
})

test('queued requests recheck authority rather than reusing authorization from enqueue time',async()=>{
    const h=harness(),start=deferred();h.state.startGate=start.promise
    const first=h.operator.request({...request}).catch(error=>error)
    const next=h.operator.request({...request,action:'logout'}).catch(error=>error)
    await tick();h.state.authorized=false;start.resolve()
    expect(await first).toMatchObject({code:'authority_lost'})
    expect(await next).toMatchObject({code:'authority_lost'})
    expect(h.created[0]!.calls).toEqual(['start'])
    expect(h.created[0]!.closed).toBe(true)
})

test('idle workers expire after sixty seconds and heartbeat refreshes completed native jobs',async()=>{
    const h=harness(),worker=new FakeWorker(request)
    worker.jobs.set(operationId,{provider:'codex',state:'waiting',expiresAt:Date.now()+10000})
    worker.lastActivity=Date.now()-60001;h.workers.set(request.projectId,worker)
    await h.heartbeat()
    expect(worker.calls).toEqual(['heartbeat','get'])
    expect(worker.busy()).toBe(false)
    await h.heartbeat()
    expect(worker.closed).toBe(true)
    expect(h.workers.size).toBe(0)
})

test('stale heartbeat cannot remove a newer worker for the same project',async()=>{
    const h=harness(),old=new FakeWorker(request),next=new FakeWorker(request),gate=deferred<boolean>()
    h.workers.set(request.projectId,old);h.mutable.authority=()=>gate.promise
    const beat=h.heartbeat();await tick();h.workers.set(request.projectId,next);gate.resolve(false);await beat
    expect(old.closed).toBe(true);expect(next.closed).toBe(false)
    expect(h.workers.get(request.projectId)).toBe(next)
})

test('prepare requires three consecutive probes of the same running boot',async()=>{
    const h=harness(),probes=[{running:true,boot:'one',restart:0},{running:false,boot:'one',restart:0},{running:true,boot:'two',restart:1},{running:true,boot:'two',restart:1},{running:true,boot:'two',restart:1}]
    let count=0
    h.mutable.docker=async(args:string[],timeout:number)=>{
        expect(timeout).toBeGreaterThan(0);expect(timeout).toBeLessThanOrEqual(60000)
        if(args[0]==='compose')return''
        const probe=probes[count++]!
        return JSON.stringify({State:{Running:probe.running,StartedAt:probe.boot},RestartCount:probe.restart})
    }
    expect(await h.operator.request({...request,action:'prepare',provider:undefined})).toEqual({ok:true})
    expect(count).toBe(5)
})

test('native errors retain actionable status without reflecting arbitrary messages',()=>{
    for(const code of ['invalid_code','invalid_state','logout_failed'])expect(nativeWorkerError(code)).toMatchObject({code,status:400})
    expect(nativeWorkerError('not_found')).toMatchObject({code:'operation_not_found',status:404})
    expect(nativeWorkerError('login_busy')).toMatchObject({code:'login_busy',status:409})
    expect(nativeWorkerError('private native diagnostic')).toMatchObject({code:'native_auth_failed',status:400})
})

test('a foreign administrator model query preserves the current login owner and process',async()=>{
    const h=harness()
    await h.operator.request(request)
    const worker=h.created[0]!
    expect(worker.busy()).toBe(true)
    await h.operator.request({...request,action:'models',provider:'codex',refresh:true,userId:'55555555-5555-4555-8555-555555555555',sessionHash:'b'.repeat(64)})
    expect(h.created).toHaveLength(1);expect(worker.closed).toBe(false)
    expect(worker.owner.userId).toBe(request.userId)
    expect(worker.jobs.get(operationId)?.state).toBe('waiting')
    expect(worker.calls).toEqual(['start','models'])
})

test('revoking a foreign metadata reader cannot terminate the original owner login',async()=>{
    for(const action of ['status','models'] as const){
        const h=harness();await h.operator.request(request)
        const worker=h.created[0]!,foreign={...request,action,userId:'55555555-5555-4555-8555-555555555555',sessionHash:'b'.repeat(64)}
        let checks=0
        h.mutable.authority=async(r:ControlRequest)=>r.userId===request.userId||++checks===1
        await expect(h.operator.request(foreign)).rejects.toMatchObject({code:'authority_lost',status:403})
        expect(worker.closed).toBe(false)
        expect(h.workers.get(request.projectId)).toBe(worker)
        expect(worker.jobs.get(operationId)?.state).toBe('waiting')
        expect(await h.operator.request({...request,action:'get',operationId})).toMatchObject({operation:{state:'connected'}})
    }
})

test('late metadata replies keep bounded IPC slots and do not kill a login or its heartbeat',async()=>{
    class DelayedWorker extends AuthWorker {
        protected override launch(){
            return spawn(process.execPath,['-e',`
                const readline=require('node:readline');
                readline.createInterface({input:process.stdin}).on('line',line=>{
                    const r=JSON.parse(line);
                    const result=r.action==='start'?{operation:{id:'${operationId}',provider:'codex',state:'waiting',expiresAt:Date.now()+900000}}:{ok:true};
                    setTimeout(()=>process.stdout.write(JSON.stringify({requestId:r.requestId,result})+'\\n'),['status','models'].includes(r.action)?180:0);
                });
            `],{stdio:['pipe','pipe','pipe']})
        }
    }
    const worker=new DelayedWorker(request,'unused',1001,1001)
    try {
        await worker.request('start')
        const pending=Array.from({length:15},(_,index)=>worker.request(index%2?'status':'models',{},true,5).catch(error=>error))
        expect((await Promise.all(pending)).every(error=>error instanceof ControlError&&error.code==='native_auth_timeout')).toBe(true)
        expect(worker.pendingCount()).toBe(15)
        expect(worker.closed).toBe(false);expect(worker.busy()).toBe(true)
        await expect(worker.request('models')).rejects.toMatchObject({code:'runner_busy'})
        expect(await worker.request('heartbeat',{},false)).toEqual({ok:true})
        expect(worker.pendingCount()).toBe(15)
        const h=harness();h.workers.set(request.projectId,worker)
        await h.heartbeat()
        expect(worker.closed).toBe(false)
        expect(h.workers.get(request.projectId)).toBe(worker)
        const deadline=Date.now()+2000
        while(worker.pendingCount()&&Date.now()<deadline)await tick()
        expect(worker.pendingCount()).toBe(0)
        expect(worker.closed).toBe(false);expect(worker.busy()).toBe(true)
        expect(await worker.request('status')).toEqual({ok:true})
    } finally { worker.close() }
})

test('restore cycles eventually consider projects after the first thirty-two',async()=>{
    const h=harness(),root=mkdtempSync('/tmp/evolved-control-rotation-');temporary.push(root)
    mkdirSync(`${root}/runners`)
    for(let n=1;n<=40;n++)mkdirSync(`${root}/runners/${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`)
    const seen:string[]=[]
    h.mutable.config={state:root};h.mutable.restoreCursor=0
    h.mutable.metadata=(request:ControlRequest)=>{seen.push(request.projectId);return null}
    const restore=()=> (h.operator as unknown as {restoreManagedRunners():Promise<void>}).restoreManagedRunners()
    await restore();expect(new Set(seen).size).toBe(32)
    await restore();expect(new Set(seen).size).toBe(40)
})

test('a changed project root fails with an actionable identity error before touching the runner',async()=>{
    const h=harness()
    await expect(h.operator.request({...request,action:'prepare',rootPath:'/workspaces/replaced',provider:undefined})).rejects.toMatchObject({code:'workspace_identity_changed',status:409})
    expect(h.dockerCalls).toHaveLength(0)
    expect(h.created).toHaveLength(0)
})

function browserHarness(image=true){
    const h=harness(),files:string[]=[],metadata:unknown[]=[]
    Object.assign(h.mutable,{
        browserImage:async()=>image,
        writeBrowserFiles:()=>{files.push('write')},removeBrowserFiles:()=>{files.push('remove')},
        writeMetadata:(_p:unknown,value:unknown)=>{metadata.push(value)},
        paths:()=>({directory:'/private/runner',workspace:'/private/workspace',home:'/private/home',lease:'/private/lease',env:'/private/runner.env',metadata:'/private/metadata',container:`hapi-evolved-runner-${request.projectId}-runner-1`,browserKey:'/private/browser.key',browserEnv:'/private/browser.env'}),
    })
    return {...h,files,metadata}
}
const browserRequest=(browser:boolean):ControlRequest=>({...request,action:'browser',provider:undefined,browser})

test('browser enable starts only the three profile services of this stack with a fresh key and --pull never',async()=>{
    const h=browserHarness()
    expect(await h.operator.request(browserRequest(true))).toEqual({ok:true})
    expect(h.files).toEqual(['write'])
    const up=h.dockerCalls.at(-1)!
    expect(up).toEqual(['compose','--env-file','/private/runner.env','--env-file','/private/browser.env','-f','/immutable/source/deploy/evolved/runner.compose.yml','--profile','browser','up','-d','--no-build','--pull','never','--force-recreate','browser-gateway','browser','browser-egress'])
    expect(h.metadata.at(-1)).toMatchObject({browser:true,leaseId:request.leaseId})
    expect(h.created).toHaveLength(0)
})

test('browser disable explicitly removes profile services and key; missing image fails clearly without docker up',async()=>{
    const h=browserHarness()
    expect(await h.operator.request(browserRequest(false))).toEqual({ok:true})
    expect(h.dockerCalls.at(-1)!.slice(-6)).toEqual(['rm','--stop','--force','browser-gateway','browser','browser-egress'])
    expect(h.dockerCalls.at(-1)).toContain('--profile')
    expect(h.files).toEqual(['remove'])
    expect(h.metadata.at(-1)).toMatchObject({browser:false})
    const missing=browserHarness(false)
    await expect(missing.operator.request(browserRequest(true))).rejects.toMatchObject({code:'browser_image_missing',status:409})
    expect(missing.dockerCalls.filter(args=>args.includes('up'))).toHaveLength(0)
    expect(missing.files).toEqual([])
})

test('browser authority lost after start tears the sidecar down; status reports exact container states',async()=>{
    const h=browserHarness();let calls=0
    Object.assign(h.mutable,{authority:async()=>++calls===1})
    await expect(h.operator.request(browserRequest(true))).rejects.toMatchObject({code:'authority_lost'})
    expect(h.dockerCalls.at(-1)!.slice(-6)).toEqual(['rm','--stop','--force','browser-gateway','browser','browser-egress'])
    const s=browserHarness()
    Object.assign(s.mutable,{docker:async(args:string[])=>{s.dockerCalls.push(args);if(args[0]==='inspect'&&args.at(-1)!.endsWith('-browser-1'))return 'exited';if(args[0]==='inspect')return 'running';throw new Error('no')}})
    expect(await s.operator.request({...request,action:'browser-status',provider:undefined})).toEqual({image:true,containers:{'browser-gateway':'running',browser:'exited','browser-egress':'running'}})
})

test('restore converges a failed disable with the trusted Hub configuration and never starts a browser itself',async()=>{
    const h=browserHarness(),converge=(metadata:Record<string,unknown>,enabled:unknown)=>(h.operator as unknown as {convergeBrowser(p:unknown,m:unknown,e:unknown):Promise<boolean>}).convergeBrowser((h.mutable.paths as ()=>unknown)(),metadata,enabled)
    const metadata={leaseId:request.leaseId,rootPath:request.rootPath,profile:request.profile}
    expect(await converge({...metadata,browser:true},false)).toBe(false)
    expect(h.dockerCalls.at(-1)!.slice(-6)).toEqual(['rm','--stop','--force','browser-gateway','browser','browser-egress'])
    expect(h.metadata.at(-1)).toMatchObject({browser:false}); expect(h.files).toEqual(['remove'])
    const calls=h.dockerCalls.length
    expect(await converge({...metadata,browser:true},true)).toBe(true)
    expect(await converge({...metadata,browser:true},undefined)).toBe(true) // older Hub: unchanged
    expect(await converge({...metadata},true)).toBe(false) // never enables on its own
    expect(h.dockerCalls.length).toBe(calls)
})
