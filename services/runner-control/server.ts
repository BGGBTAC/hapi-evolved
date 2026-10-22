import { chmodSync, chownSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { verifyControl } from '../../hub/src/evolved/runnerControlProtocol'
import { ControlError, RunnerOperator } from './operator'

/** The key directory belongs to the unprivileged operator UID. Check the opened
 * inode, not the pathname, so a swapped link cannot redirect this root read. */
export function readOperatorKey(keyFile:string,uid:number):Buffer{
    const fd=openSync(keyFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    try{
        const info=fstatSync(fd)
        if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||![0,uid].includes(info.uid))throw new Error('Private operator key required')
        const key=readFileSync(fd)
        if(key.length!==32)throw new Error('Invalid operator key')
        return key
    }finally{closeSync(fd)}
}

function main(){
    process.umask(0o077)
    if(process.getuid?.()!==0)throw new Error('Host operator requires root')
    const state=process.env.EVOLVED_STATE_DIR??'/var/lib/hapi-evolved',source=process.env.EVOLVED_CONTROL_SOURCE??'/opt/hapi-evolved'
    const uid=Number(process.env.EVOLVED_UID??1001),gid=Number(process.env.EVOLVED_GID??1001)
    const socket=process.env.EVOLVED_CONTROL_SOCKET??'/run/hapi-evolved-control/control.sock'
    const key=readOperatorKey(`${state}/credentials/hub/runner-control.key`,uid)
    const operator=new RunnerOperator({state,source,uid,gid,key,hubUrl:'http://127.0.0.1:3006'}),seen=new Map<string,number>()
    try {const old=lstatSync(socket);if(!old.isSocket()||old.uid!==0)throw new Error('Invalid control socket');unlinkSync(socket)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    const server=Bun.serve({unix:socket,maxRequestBodySize:20_000,async fetch(req,server){
        server.timeout(req,120)
        const headers={'Content-Type':'application/json','Cache-Control':'no-store'}
        if(req.method!=='POST'||new URL(req.url).pathname!=='/control')return new Response('{}',{status:404,headers})
        try{
            let request
            try{request=verifyControl(key,await req.json(),'operator',seen)}catch{return new Response('{"code":"invalid_authorization"}',{status:403,headers})}
            const result=await operator.request(request)
            return Response.json(result,{headers})
        }catch(error){return Response.json({code:error instanceof ControlError?error.code:'control_failed'},{status:error instanceof ControlError?error.status:503,headers})}
    }})
    chownSync(socket,0,gid);chmodSync(socket,0o660)
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{operator.close();void server.stop(true);setTimeout(()=>process.exit(0),4000)})
    console.log('Project runner control socket ready')
}
if(import.meta.main)try{main()}catch{console.error('Project runner control startup refused');process.exit(1)}
