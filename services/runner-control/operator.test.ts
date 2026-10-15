import { afterEach, expect, test } from 'bun:test'
import { ProjectOperations, RunnerOperator, nativeWorkerError, type WorkerHandle, type WorkerJob } from './operator'
import type { ControlRequest } from '../../hub/src/evolved/runnerControlProtocol'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

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
