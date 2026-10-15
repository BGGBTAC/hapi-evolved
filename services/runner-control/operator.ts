import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { signControl, type ControlRequest } from '../../hub/src/evolved/runnerControlProtocol'
import { checkRunnerConfig, parseRunnerEnv } from '../../deploy/evolved/check-runner'
import { assertRootOwnedPath, ensureWorkspaceAnchor, validWorkspaceIdentity, WorkspaceAnchorError, type WorkspaceIdentity } from './workspaceAnchor'

export class ControlError extends Error {
    constructor(readonly code:string, readonly status=503) { super(code) }
}
export type OperatorConfig = { state:string; source:string; uid:number; gid:number; key:Uint8Array; hubUrl:string; backendNetwork?:string }
type Metadata = Pick<ControlRequest,'leaseId'|'rootPath'|'profile'> & {workspaceIdentity?:WorkspaceIdentity}
const sameRunner = (a:Metadata,b:Metadata) => a.leaseId===b.leaseId && a.rootPath===b.rootPath && a.profile===b.profile
const sameOwner = (a:ControlRequest,b:ControlRequest) => a.userId===b.userId && a.sessionHash===b.sessionHash && sameRunner(a,b)
const terminal = (state:unknown) => ['connected','failed','cancelled','expired'].includes(String(state))
function writePrivateAtomic(path:string,contents:string):void {
    const temporary=`${path}.${randomUUID()}.tmp`
    try{writeFileSync(temporary,contents,{flag:'wx',mode:0o600});renameSync(temporary,path)}
    finally{rmSync(temporary,{force:true})}
}

/** Small per-project queues serialize owner changes and native start acknowledgement. */
export class ProjectOperations {
    private projects=new Map<string,{tail:Promise<unknown>;count:number}>()
    private total=0
    private closed=false
    run<T>(projectId:string,work:()=>Promise<T>):Promise<T>{
        if(this.closed)return Promise.reject(new ControlError('runner_unavailable'))
        const entry=this.projects.get(projectId)??{tail:Promise.resolve(),count:0}
        if(entry.count>=4||this.total>=64)return Promise.reject(new ControlError('runner_busy',429))
        entry.count++;this.total++;this.projects.set(projectId,entry)
        const result=entry.tail.catch(()=>undefined).then(()=>{if(this.closed)throw new ControlError('runner_unavailable');return work()})
        entry.tail=result.catch(()=>undefined)
        void result.finally(()=>{entry.count--;this.total--;if(!entry.count&&this.projects.get(projectId)===entry)this.projects.delete(projectId)}).catch(()=>undefined)
        return result
    }
    close(){this.closed=true}
}
export function nativeWorkerError(code:unknown):ControlError {
    if(code==='not_found'||code==='operation_not_found')return new ControlError('operation_not_found',404)
    if(code==='login_busy')return new ControlError('login_busy',409)
    return new ControlError(['invalid_code','invalid_state','code_state_mismatch','logout_failed'].includes(String(code))?String(code):'native_auth_failed',400)
}
export type WorkerJob={provider:string;state:string;expiresAt:number}
export interface WorkerHandle {
    readonly owner:ControlRequest; closed:boolean; readonly jobs:Map<string,WorkerJob>; lastActivity:number
    request(action:string,fields?:Record<string,unknown>,touch?:boolean,timeout?:number):Promise<unknown>
    busy():boolean; pendingCount():number; close():void
}

/** No shell, caller-supplied commands or unbounded output. Docker errors stay local. */
export function runDocker(args:string[],timeout=60_000):Promise<string> {
    return new Promise((resolve,reject)=>{
        const child=spawn('/usr/bin/docker',args,{env:{PATH:'/usr/bin:/bin',HOME:'/root'},stdio:['ignore','pipe','pipe']})
        let output='', size=0, stopped=false
        const stop=()=>{ if(stopped)return;stopped=true;child.kill('SIGKILL');reject(new ControlError('runner_command_failed')) }
        const timer=setTimeout(stop,timeout)
        child.stdout.on('data',(data:Buffer)=>{size+=data.length;if(size>256*1024)stop();else output+=data.toString('utf8')})
        child.stderr.on('data',(data:Buffer)=>{size+=data.length;if(size>256*1024)stop()})
        child.on('error',stop)
        child.on('close',code=>{clearTimeout(timer);if(stopped)return;stopped=true;code===0?resolve(output.trim()):reject(new ControlError('runner_command_failed'))})
    })
}
export class AuthWorker implements WorkerHandle {
    private child:ChildProcessWithoutNullStreams
    private pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
    private input=''
    closed=false
    lastActivity=Date.now()
    private pendingStarts=0
    readonly jobs=new Map<string,WorkerJob>()
    constructor(readonly owner:ControlRequest,container:string,uid:number,gid:number) {
        this.child=this.launch(container,uid,gid)
        this.child.stdout.setEncoding('utf8')
        this.child.stdout.on('data',(chunk:string)=>{
            this.input+=chunk
            if(this.input.length>64*1024){this.close();return}
            for(;;){const end=this.input.indexOf('\n');if(end<0)break
                const line=this.input.slice(0,end);this.input=this.input.slice(end+1)
                try {
                    const reply=JSON.parse(line),pending=this.pending.get(reply.requestId)
                    if(!pending)continue
                    clearTimeout(pending.timer);this.pending.delete(reply.requestId)
                    if(reply.error) pending.reject(nativeWorkerError(reply.error.code))
                    else {
                        if(reply.result?.operation){const op=reply.result.operation
                            if(!['codex','claude'].includes(op.provider)||typeof op.id!=='string'||!Number.isFinite(op.expiresAt)){pending.reject(new ControlError('native_auth_failed'));this.close();return}
                            for(const [id,job] of this.jobs)if(job.provider===op.provider&&id!==op.id)this.jobs.delete(id)
                            this.jobs.set(op.id,{provider:op.provider,state:op.state,expiresAt:op.expiresAt})
                        }
                        pending.resolve(reply.result)
                    }
                } catch {this.close()}
            }
        })
        // Never forward native worker stderr to service logs or HTTP clients.
        this.child.stderr.resume()
        this.child.on('error',()=>this.close());this.child.on('close',()=>this.close());this.child.stdin.on('error',()=>this.close())
    }
    protected launch(container:string,uid:number,gid:number):ChildProcessWithoutNullStreams {
        return spawn('/usr/bin/docker',['exec','-i','--user','0:0','-e','HOME=/runner','-e','USER=runner',container,
            '/usr/bin/setpriv','--reuid',String(uid),'--regid',String(gid),'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','--',
            '/usr/bin/tini','-s','--','/usr/local/bin/bun','/app/services/runner-auth/worker.ts'],
            {env:{PATH:'/usr/bin:/bin',HOME:'/root'},stdio:['pipe','pipe','pipe']})
    }
    request(action:string,fields:Record<string,unknown>={},touch=true,timeout=action==='heartbeat'?2000:18_000):Promise<unknown> {
        if(this.closed)return Promise.reject(new ControlError('runner_unavailable'))
        // Leave one IPC slot for authority heartbeats even while read-only replies
        // arrive late. The native worker also caps all in-flight commands at 16.
        const maintenance=action==='heartbeat'||(!touch&&action==='get')
        if(this.pending.size>=(maintenance?16:15))return Promise.reject(new ControlError('runner_busy',429))
        if(touch&&action!=='heartbeat')this.lastActivity=Date.now()
        if(action==='start')this.pendingStarts++
        const result=new Promise((resolve,reject)=>{
            const id=randomUUID(),timer=setTimeout(()=>{
                reject(new ControlError('native_auth_timeout'))
                // A metadata read must not terminate somebody else's login. Keep
                // its slot occupied until the real reply or worker EOF; otherwise
                // repeated timeouts could overflow the native worker's bound.
                if(!['status','models'].includes(action)){this.pending.delete(id);this.close()}
            },Math.min(timeout,18_000))
            this.pending.set(id,{resolve,reject,timer})
            this.child.stdin.write(`${JSON.stringify({requestId:id,action,...fields})}\n`)
        })
        return result.finally(()=>{if(action==='start')this.pendingStarts--})
    }
    busy(){return this.pendingStarts>0||[...this.jobs.values()].some(job=>!terminal(job.state)&&job.expiresAt>Date.now())}
    pendingCount(){return this.pending.size}
    close(){
        if(this.closed)return
        this.closed=true
        // EOF is handled inside the runner PID namespace, killing native process groups.
        this.child.stdin.end()
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new ControlError('runner_unavailable'))}
        this.pending.clear()
        const timer=setTimeout(()=>this.child.kill('SIGKILL'),3500);timer.unref()
    }
}
export class RunnerOperator {
    private workers=new Map<string,WorkerHandle>()
    private operations=new ProjectOperations()
    private preparing=new Set<string>()
    private timer:ReturnType<typeof setInterval>
    private restoreTimer:ReturnType<typeof setInterval>
    private restoring=false
    private checking=false
    private closed=false
    private restoreCursor=0
    constructor(private config:OperatorConfig) {
        if(realpathSync(config.state)!==config.state || realpathSync(config.source)!==config.source || ![config.uid,config.gid].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('Invalid operator configuration')
        if(config.backendNetwork && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(config.backendNetwork))throw new Error('Invalid operator network configuration')
        assertRootOwnedPath(config.state);assertRootOwnedPath(config.source)
        const hub=new URL(config.hubUrl)
        if(hub.protocol!=='http:'||hub.hostname!=='127.0.0.1'||hub.username||hub.password||hub.pathname!=='/'||hub.search||hub.hash)throw new Error('Operator authority must use the local hub')
        const source=lstatSync(config.source),compose=lstatSync(join(config.source,'deploy/evolved/runner.compose.yml'))
        if(source.uid!==0 || compose.uid!==0 || (source.mode&0o022)!==0 || (compose.mode&0o022)!==0 || !compose.isFile()) throw new Error('Operator source must be root-owned and immutable to the hub')
        const base=join(config.state,'runners')
        mkdirSync(base,{recursive:true,mode:0o700});chownSync(base,0,0);chmodSync(base,0o700)
        this.timer=setInterval(()=>void this.heartbeat(),2000)
        this.restoreTimer=setInterval(()=>void this.restoreManagedRunners(),30_000)
        void this.restoreManagedRunners()
    }
    async authority(request:ControlRequest,timeout=2000):Promise<boolean> {
        if(this.closed)return false
        try {
            const r:ControlRequest={action:'authority',projectId:request.projectId,userId:request.userId,sessionHash:request.sessionHash,profile:request.profile,rootPath:request.rootPath,leaseId:request.leaseId}
            const response=await fetch(`${this.config.hubUrl}/api/evolved/runner-control/authority`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Runner-Control'},body:JSON.stringify(signControl(this.config.key,r,'hub')),redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(timeout,2000)))})
            return response.ok && (await response.json() as {authorized?:boolean}).authorized===true
        }catch{return false}
    }
    private async heartbeat(){
        if(this.checking)return;this.checking=true
        try {await Promise.allSettled([...this.workers.entries()].map(async([id,worker])=>{
            if(worker.closed || (!worker.busy()&&!worker.pendingCount()&&Date.now()-worker.lastActivity>=60_000) || !await this.authority(worker.owner)){this.dropWorker(id,worker);return}
            if(this.workers.get(id)!==worker)return
            try{
                await worker.request('heartbeat',{},false)
                for(const [operationId,job] of worker.jobs)if(!terminal(job.state)&&job.expiresAt>Date.now())await worker.request('get',{operationId,provider:job.provider},false,2000)
            }catch{this.dropWorker(id,worker)}
        }))}finally{this.checking=false}
    }
    private dropWorker(id:string,worker:WorkerHandle){worker.close();if(this.workers.get(id)===worker)this.workers.delete(id)}
    protected docker(args:string[],timeout?:number){return runDocker(args,timeout)}
    protected createWorker(owner:ControlRequest,container:string):WorkerHandle{return new AuthWorker(owner,container,this.config.uid,this.config.gid)}
    protected pause(duration:number){return new Promise<void>(resolve=>setTimeout(resolve,duration))}
    protected async anchor(r:ControlRequest,expected?:WorkspaceIdentity){
        try{return await ensureWorkspaceAnchor(this.config.state,r.projectId,r.rootPath,expected)}
        catch(error){if(error instanceof WorkspaceAnchorError)throw new ControlError(error.code,409);throw error}
    }
    private paths(r:ControlRequest){
        const directory=join(this.config.state,'runners',r.projectId)
        const workspace=join(directory,'workspace')
        return {directory,workspace,home:join(directory,'home'),lease:join(directory,'lease'),env:join(directory,'runner.env'),metadata:join(directory,'operator.json'),container:`hapi-evolved-runner-${r.projectId}-runner-1`}
    }
    private metadata(r:ControlRequest):Metadata|null {
        const paths=this.paths(r)
        try {
            const info=lstatSync(paths.metadata)
            if(!info.isFile()||info.uid!==0||(info.mode&0o077)!==0||info.nlink!==1||info.size>4096)return null
            return JSON.parse(readFileSync(paths.metadata,'utf8')) as Metadata
        }catch{return null}
    }
    private configurationMatches(r:ControlRequest,metadata:Metadata):boolean {
        try{
            const p=this.paths(r),info=lstatSync(p.env)
            if(!info.isFile()||info.uid!==0||(info.mode&0o077)!==0||info.nlink!==1||info.size>8192)return false
            const env=parseRunnerEnv(readFileSync(p.env,'utf8'));checkRunnerConfig(env)
            return env.EVOLVED_PROJECT_ID===r.projectId&&env.EVOLVED_RUNNER_PROFILE===metadata.profile
                &&env.EVOLVED_RUNNER_WORKSPACE===p.workspace&&env.EVOLVED_RUNNER_HOME===p.home&&env.EVOLVED_RUNNER_LEASE_FILE===p.lease
                &&env.EVOLVED_RUNNER_RESTART_POLICY==='no'&&env.EVOLVED_RUNNER_WORKSPACE_DEVICE===metadata.workspaceIdentity?.device
                &&env.EVOLVED_RUNNER_WORKSPACE_INODE===metadata.workspaceIdentity?.inode
        }catch{return false}
    }
    /** Docker auto-restart is disabled for managed runners. After a reboot only
     * this lease-checked path restores the pinned mount before starting them. */
    private async restoreManagedRunners(){
        if(this.closed||this.restoring)return
        this.restoring=true
        try{
            const ids=readdirSync(join(this.config.state,'runners')).filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)).sort()
            const start=this.restoreCursor%Math.max(ids.length,1),count=Math.min(32,ids.length)
            const batch=Array.from({length:count},(_,index)=>ids[(start+index)%ids.length]!)
            this.restoreCursor=(start+count)%Math.max(ids.length,1)
            for(const projectId of batch){
                if(this.closed)break
                try{await this.operations.run(projectId,async()=>{
                    const metadata=this.metadata({projectId} as ControlRequest)
                    if(!metadata||!validWorkspaceIdentity(metadata.workspaceIdentity)||!['restricted','workspace','extended'].includes(metadata.profile)
                        ||!/^\/(?:managed-workspaces|workspaces)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metadata.rootPath))return
                    const r={...metadata,projectId} as ControlRequest,p=this.paths(r),leaseInfo=lstatSync(p.lease)
                    if(!this.configurationMatches(r,metadata))return
                    if(!leaseInfo.isFile()||leaseInfo.nlink!==1||leaseInfo.uid!==this.config.uid||(leaseInfo.mode&0o077)!==0||leaseInfo.size>128)return
                    const token=readFileSync(p.lease,'utf8').trim()
                    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return
                    const response=await fetch(`${this.config.hubUrl}/api/evolved/runner/authority`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(2000)})
                    if(!response.ok||this.closed)return
                    const authority=await response.json() as {projectId?:string;profile?:string;rootPath?:string;expiresAt?:number|null}
                    if(authority.projectId!==projectId||authority.profile!==metadata.profile||authority.rootPath!==metadata.rootPath
                        ||!(authority.expiresAt===null||typeof authority.expiresAt==='number'&&authority.expiresAt>Date.now()))return
                    const anchor=await this.anchor(r,metadata.workspaceIdentity)
                    if(this.closed)return
                    const running=await this.docker(['inspect','--format','{{.State.Running}}',p.container],3000).catch(()=>'false')
                    if(this.closed||running==='true'&&!anchor.restored)return
                    const args=['compose','--env-file',p.env,'-f',join(this.config.source,'deploy/evolved/runner.compose.yml'),'up','-d','--no-build','--pull','never']
                    if(anchor.restored)args.push('--force-recreate')
                    await this.docker(args,60_000)
                })}catch{/* Missing/revoked configuration stays stopped; explicit connect can repair it. */}
            }
        }finally{this.restoring=false}
    }
    private async prepare(r:ControlRequest){
        if(this.preparing.has(r.projectId))throw new ControlError('login_busy',409)
        this.preparing.add(r.projectId)
        const deadline=Date.now()+75_000
        const remaining=()=>{const time=deadline-Date.now();if(time<=0||this.closed)throw new ControlError('runner_start_failed');return time}
        try {
            const p=this.paths(r),previous=this.metadata(r)
            // Root changes are not a public project operation. Do not silently
            // replace an existing trusted inode during external maintenance.
            if(previous&&previous.rootPath!==r.rootPath)throw new ControlError('workspace_identity_changed',409)
            if(!r.leaseToken && (!previous||!sameRunner(previous,r))) throw new ControlError('runner_config_missing')
            let restored=false
            if(r.leaseToken){
                this.workers.get(r.projectId)?.close();this.workers.delete(r.projectId)
                mkdirSync(p.directory,{recursive:true,mode:0o700})
                const parent=lstatSync(p.directory)
                if(!parent.isDirectory()||parent.uid!==0||(parent.mode&0o077)!==0||realpathSync(p.directory)!==p.directory)throw new ControlError('invalid_runner_directory')
                if(!existsSync(p.home)){mkdirSync(p.home,{mode:0o700});chownSync(p.home,this.config.uid,this.config.gid)}
                const home=lstatSync(p.home)
                if(!home.isDirectory()||realpathSync(p.home)!==p.home||home.uid!==this.config.uid||(home.mode&0o777)!==0o700)throw new ControlError('invalid_runner_home')
                const temp=join(p.directory,`lease-${randomUUID()}.tmp`)
                writeFileSync(temp,r.leaseToken,{flag:'wx',mode:0o600});chownSync(temp,this.config.uid,this.config.gid);renameSync(temp,p.lease)
                const anchor=await this.anchor(r,previous?.workspaceIdentity);restored=anchor.restored
                const prefix=r.rootPath.startsWith('/managed-workspaces/')?'/managed-workspaces':'/workspaces'
                const values={EVOLVED_UID:this.config.uid,EVOLVED_GID:this.config.gid,EVOLVED_PROJECT_ID:r.projectId,EVOLVED_PROJECT_DIRECTORY:r.rootPath.slice(prefix.length+1),EVOLVED_RUNNER_PROFILE:r.profile,EVOLVED_WORKSPACE_MODE:r.profile==='restricted'?'ro':'rw',EVOLVED_RUNNER_WORKSPACE:anchor.path,EVOLVED_RUNNER_HOME:p.home,EVOLVED_RUNNER_LEASE_FILE:p.lease,EVOLVED_WORKSPACE_PREFIX:prefix,EVOLVED_BACKEND_NETWORK:this.config.backendNetwork??'hapi-evolved_backend',EVOLVED_RUNNER_RESTART_POLICY:'no',EVOLVED_RUNNER_WORKSPACE_DEVICE:anchor.identity.device,EVOLVED_RUNNER_WORKSPACE_INODE:anchor.identity.inode}
                const content=Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n'
                checkRunnerConfig(parseRunnerEnv(content))
                writePrivateAtomic(p.env,content)
                writePrivateAtomic(p.metadata,JSON.stringify({leaseId:r.leaseId,rootPath:r.rootPath,profile:r.profile,workspaceIdentity:anchor.identity}))
            }else{
                if(!existsSync(p.env)||!validWorkspaceIdentity(previous?.workspaceIdentity))throw new ControlError('runner_config_missing')
                restored=(await this.anchor(r,previous.workspaceIdentity)).restored
            }
            if(!await this.authority(r,remaining()))throw new ControlError('authority_lost',403)
            const args=['compose','--env-file',p.env,'-f',join(this.config.source,'deploy/evolved/runner.compose.yml'),'up','-d','--no-build','--pull','never']
            if(r.leaseToken||restored)args.push('--force-recreate')
            await this.docker(args,Math.min(60_000,remaining()))
            let stable=0,previousBoot=''
            for(let i=0;i<20;i++){
                if(!await this.authority(r,remaining()))throw new ControlError('authority_lost',403)
                const raw=await this.docker(['inspect','--format','{{json .}}',p.container],Math.min(3000,remaining())).catch(()=>'null')
                let probe:{State?:{Running?:boolean;StartedAt?:string};RestartCount?:number}|null=null
                try{probe=JSON.parse(raw)}catch{/* Retry a transient missing/restarting container. */}
                const boot=probe?.State?.Running&&typeof probe.State.StartedAt==='string'&&Number.isSafeInteger(probe.RestartCount)?`${probe.State.StartedAt}:${probe.RestartCount}`:''
                stable=boot?(boot===previousBoot?stable+1:1):0;previousBoot=boot
                if(stable>=3){remaining();if(!await this.authority(r,remaining()))throw new ControlError('authority_lost',403);return {ok:true}}
                await this.pause(Math.min(500,remaining()))
            }
            throw new ControlError('runner_start_failed')
        }finally{this.preparing.delete(r.projectId)}
    }
    async request(r:ControlRequest):Promise<unknown>{
        return this.operations.run(r.projectId,()=>this.requestAuthorized(r))
    }
    private async requestAuthorized(r:ControlRequest):Promise<unknown>{
        if(this.closed)throw new ControlError('runner_unavailable')
        if(!await this.authority(r))throw new ControlError('authority_lost',403)
        if(r.action==='prepare')return this.prepare(r)
        const metadata=this.metadata(r)
        if(!metadata||!sameRunner(metadata,r))throw new ControlError('runner_config_missing')
        let worker=this.workers.get(r.projectId)
        if(worker?.closed){this.workers.delete(r.projectId);worker=undefined}
        if(['get','code','cancel'].includes(r.action)){
            if(!worker||!sameOwner(worker.owner,r)||worker.jobs.get(r.operationId!)?.provider!==r.provider)throw new ControlError('operation_not_found',404)
        }else if(worker&&!sameOwner(worker.owner,r)&&!['status','models'].includes(r.action)){
            if(worker.busy())throw new ControlError('login_busy',409)
            worker.close();this.workers.delete(r.projectId);worker=undefined
        }
        if(!worker){
            if(this.workers.size>=16)throw new ControlError('runner_limit',429)
            const p=this.paths(r)
            const raw=await this.docker(['inspect','--format','{{json .}}',p.container],3000)
            const container=JSON.parse(raw)
            if(container.Config?.Labels?.['com.docker.compose.project']!==`hapi-evolved-runner-${r.projectId}` || container.Config?.Labels?.['com.docker.compose.service']!=='runner' || !container.State?.Running)throw new ControlError('runner_unavailable')
            for(const [source,destination] of [[p.home,'/runner'],[p.workspace,r.rootPath]]){
                const mount=container.Mounts?.find((m:{Destination:string})=>m.Destination===destination)
                if(!mount||mount.Source!==source||(destination===r.rootPath&&r.profile==='restricted'&&mount.RW))throw new ControlError('invalid_runner_mount')
            }
            // Authorization can change while Docker inspect is in flight. The
            // project queue prevents another request from inserting a competing worker.
            if(this.closed||!await this.authority(r))throw new ControlError('authority_lost',403)
            if(this.workers.size>=16)throw new ControlError('runner_limit',429)
            worker=this.createWorker({...r,code:undefined,leaseToken:undefined},p.container)
            this.workers.set(r.projectId,worker)
        }
        const fields:Record<string,unknown>={}
        if(r.provider)fields.provider=r.provider
        if(r.operationId)fields.operationId=r.operationId
        if(r.code)fields.code=r.code
        if(r.action==='models'&&r.refresh!==undefined)fields.refresh=r.refresh
        const result=await worker.request(r.action,fields)
        if(!await this.authority(r)){
            if(sameOwner(worker.owner,r))this.dropWorker(r.projectId,worker)
            throw new ControlError('authority_lost',403)
        }
        return result
    }
    close(){this.closed=true;this.operations.close();clearInterval(this.timer);clearInterval(this.restoreTimer);for(const worker of this.workers.values())worker.close();this.workers.clear()}
}
