import { spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export type WorkspaceIdentity = { device:string; inode:string }
const same=(a:WorkspaceIdentity,b:WorkspaceIdentity)=>a.device===b.device&&a.inode===b.inode
export function validWorkspaceIdentity(value:unknown):value is WorkspaceIdentity {
    const r=value as WorkspaceIdentity|null
    return !!r&&typeof r==='object'&&typeof r.device==='string'&&typeof r.inode==='string'&&/^\d{1,24}$/.test(r.device)&&/^[1-9]\d{0,23}$/.test(r.inode)
}
export function workspaceIdentity(path:string):WorkspaceIdentity {
    const info=lstatSync(path,{bigint:true})
    if(!info.isDirectory())throw new Error('Workspace must be a directory')
    return{device:info.dev.toString(),inode:info.ino.toString()}
}
/** Fixed host-mount helper. Neither command nor flags come from HTTP input. */
function fixedCommand(command:string,args:string[]):Promise<string>{
    return new Promise((resolve,reject)=>{
        const child=spawn(command,args,{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']})
        let output='',size=0,failed=false
        const fail=()=>{if(failed)return;failed=true;child.kill('SIGKILL');reject(new Error('Workspace anchor could not be established'))}
        const timer=setTimeout(fail,8000)
        child.stdout.on('data',(data:Buffer)=>{size+=data.length;if(size>4096)fail();else output+=data.toString('utf8')})
        child.stderr.on('data',(data:Buffer)=>{size+=data.length;if(size>4096)fail()})
        child.on('error',fail);child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0)fail();else resolve(output.trim())})
    })
}
function isHostMount(path:string):boolean {
    return readFileSync('/proc/1/mountinfo','utf8').split('\n').some(line=>line.split(' ')[4]===path)
}
/** Pin the directory inode before crossing into Docker's separately privileged
 * mount resolution. A root-owned ancestor protects the persistent bind anchor.
 * --no-canonicalize is essential: mount must pass the proc-fd path to the kernel,
 * not resolve it back to a replaceable workspace pathname in userspace.
 */
export async function pinWorkspaceInHost(state:string,projectId:string,rootPath:string,expected?:WorkspaceIdentity):Promise<{path:string;identity:WorkspaceIdentity;restored:boolean}> {
    if(process.getuid?.()!==0||readlinkSync('/proc/self/ns/mnt')!==readlinkSync('/proc/1/ns/mnt'))throw new Error('Anchor helper must run in the host mount namespace')
    if(!/^[0-9a-f-]{36}$/.test(projectId)||!/^\/(?:managed-workspaces|workspaces)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rootPath))throw new Error('Invalid project workspace')
    if(rootPath.startsWith('/managed-workspaces/')&&rootPath!==`/managed-workspaces/${projectId}`)throw new Error('Project workspace mismatch')
    const prefix=rootPath.startsWith('/managed-workspaces/')?'managed-workspaces':'workspaces',name=rootPath.split('/')[2]!
    const parent=join(state,'runners',projectId),path=join(parent,'workspace')
    const parentInfo=lstatSync(parent)
    if(!parentInfo.isDirectory()||parentInfo.uid!==0||(parentInfo.mode&0o077)!==0||realpathSync(parent)!==parent)throw new Error('Private root-owned anchor parent required')
    const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW
    const base=openSync(join(state,prefix),flags)
    let fd:number|undefined
    try{
        fd=openSync(`/proc/self/fd/${base}/${name}`,flags)
        const info=fstatSync(fd,{bigint:true}),identity={device:info.dev.toString(),inode:info.ino.toString()}
        if(expected&&(!validWorkspaceIdentity(expected)||!same(expected,identity)))throw new Error('Project directory identity changed')
        const mounted=isHostMount(path)
        if(!mounted){
            mkdirSync(path,{recursive:true,mode:0o700})
            const anchor=lstatSync(path)
            if(!anchor.isDirectory()||anchor.uid!==0||(anchor.mode&0o077)!==0||realpathSync(path)!==path)throw new Error('Unsafe anchor directory')
            await fixedCommand('/usr/bin/mount',['--no-canonicalize','--bind',`/proc/${process.pid}/fd/${fd}`,path])
            await fixedCommand('/usr/bin/mount',['--no-canonicalize','--make-private',path])
        }
        if(!same(workspaceIdentity(path),identity))throw new Error('Workspace anchor points to a different directory')
        return{path,identity,restored:!mounted}
    }finally{if(fd!==undefined)closeSync(fd);closeSync(base)}
}
export async function ensureWorkspaceAnchor(state:string,projectId:string,rootPath:string,expected?:WorkspaceIdentity):Promise<{path:string;identity:WorkspaceIdentity;restored:boolean}> {
    const helper=new URL('./anchor-helper.ts',import.meta.url).pathname
    for(const file of [helper,process.execPath]){
        const info=lstatSync(file)
        if(!info.isFile()||info.uid!==0||(info.mode&0o022)!==0||realpathSync(file)!==file)throw new Error('Root-owned anchor helper and runtime required')
    }
    // setns alone leaves a process's root/cwd referring to its previous namespace.
    // Select the host root too, then open the source FD in that same namespace.
    const raw=await fixedCommand('/usr/bin/nsenter',['--mount=/proc/1/ns/mnt','--root=/proc/1/root','--wd=/','--',process.execPath,helper,state,projectId,rootPath,expected?.device??'',expected?.inode??''])
    const result=JSON.parse(raw) as {path:string;identity:WorkspaceIdentity;restored:boolean}
    if(result.path!==join(state,'runners',projectId,'workspace')||!validWorkspaceIdentity(result.identity)||typeof result.restored!=='boolean')throw new Error('Invalid workspace anchor result')
    return result
}
/** Only used when explicitly tearing down the isolated integration fixture. */
export async function removeTestWorkspaceAnchor(path:string):Promise<void>{
    if(!/^\/var\/lib\/hapi-evolved-browser-check-[0-9a-f-]{36}\/runners\/[0-9a-f-]{36}\/workspace$/.test(path))throw new Error('Only synthetic anchors may be removed by this helper')
    if(isHostMount(path))await fixedCommand('/usr/bin/nsenter',['--mount=/proc/1/ns/mnt','--root=/proc/1/root','--wd=/','--','/usr/bin/umount','--no-canonicalize',path])
}
