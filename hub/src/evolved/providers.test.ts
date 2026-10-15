import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { createProviderRoutes, type ProviderControl } from './providers'
import { EvolvedError, EvolvedStore, hashToken } from './store'
import { createEvolvedRequestGuard, SESSION_COOKIE } from './security'
import { signControl, type ControlRequest } from './runnerControlProtocol'

const stores:EvolvedStore[]=[]
afterEach(()=>{for(const store of stores.splice(0))store.close()})
function setup(){
    let now=Date.now()
    const store=new EvolvedStore(':memory:',{now:()=>now});stores.push(store)
    const users={admin:randomUUID(),other:randomUUID(),viewer:randomUUID()}
    for(const [name,id]of Object.entries(users))store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(id,name,now)
    const team=store.createTeam(users.admin,'Team'),project=store.createProject(users.admin,team.id,'Project')
    store.db.prepare('UPDATE evolved_projects SET root_path=? WHERE id=?').run(`/managed-workspaces/${project.id}`,project.id)
    project.rootPath=`/managed-workspaces/${project.id}`
    store.setMember(users.admin,team.id,users.other,'admin');store.setMember(users.admin,team.id,users.viewer,'viewer')
    const sessions=Object.fromEntries(Object.entries(users).map(([name,id])=>[name,store.createSession(id)]))
    const calls:ControlRequest[]=[],key=randomBytes(32),origin='https://evolved.example.test',path=`/projects/${project.id}/providers`
    let hook:((r:ControlRequest)=>void|Promise<void>)|undefined
    const control:ProviderControl={async request(r){calls.push(r);await hook?.(r)
        if(r.action==='prepare')return{ok:true}
        if(r.action==='status'||r.action==='logout')return{providers:['codex','claude'].map(provider=>({provider,status:'disconnected',method:null,checkedAt:now}))}
        return{operation:{id:r.operationId??randomUUID(),provider:r.provider,state:'waiting',flow:r.provider==='codex'?'device':'code',expiresAt:now+900000}}
    }}
    const app=new Hono()
    app.onError((error,c)=>error instanceof EvolvedError?c.json({code:error.code},error.status as 400):c.json({code:'internal'},500))
    app.use('*',createEvolvedRequestGuard(origin));app.route('/api/evolved',createProviderRoutes(store,{control,key}))
    const call=(url:string,body?:unknown,options:{method?:string;user?:string;cookie?:boolean;origin?:string;bearer?:string}={})=>app.request(`${origin}/api/evolved${url}`,{method:options.method??(body===undefined?'GET':'POST'),headers:{origin:options.origin??origin,'Content-Type':'application/json',...(options.cookie===false?{}:{cookie:`${SESSION_COOKIE}=${sessions[options.user??'admin']}`}),...(options.bearer?{authorization:`Bearer ${options.bearer}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const start=()=>call(`${path}/codex/login`,{})
    const authority=async(r:ControlRequest)=>{
        const signed=signControl(key,{...r,action:'authority',provider:undefined,leaseToken:undefined},'hub',now)
        return app.request(`${origin}/api/evolved/runner-control/authority`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Runner-Control'},body:JSON.stringify(signed)})
    }
    return{store,users,project,team,sessions,path,key,calls,call,start,authority,setHook:(fn:typeof hook)=>{hook=fn},advance:(ms:number)=>{now+=ms}}
}
describe('browser provider login boundary',()=>{
    test('status is human/admin-only and never provisions on GET',async()=>{
        const t=setup()
        expect((await t.call(t.path,undefined,{cookie:false})).status).toBe(401)
        expect((await t.call(t.path,undefined,{user:'viewer'})).status).toBe(403)
        const capability=t.store.issueCapability(t.users.admin,t.project.id,['runner:connect'],[],300)
        expect((await t.call(t.path,undefined,{cookie:false,bearer:capability.token})).status).toBe(403)
        const response=await t.call(t.path)
        expect(response.status).toBe(200);expect(await response.json()).toMatchObject({runner:{status:'unconfigured'}})
        expect(t.calls).toHaveLength(0)
        expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_runner_leases').get()).toEqual({n:0})
    })
    test('fresh passkey and same origin required before provisioning',async()=>{
        const t=setup()
        expect((await t.call(`${t.path}/codex/login`,{},{origin:'https://attacker.test'})).status).toBe(403)
        t.advance(301000)
        expect((await t.start()).status).toBe(403);expect(t.calls).toHaveLength(0)
    })
    test('creates one dedicated permanent lease and reuses it without changing manual leases',async()=>{
        const t=setup(),manual=randomUUID()
        t.store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(manual,'Manual',hashToken('manual'),t.users.admin,t.project.id,'["runner:connect"]','[]','restricted',Date.now(),Date.now()+3600000)
        const first=await t.start();expect(first.status).toBe(200)
        expect(t.calls.map(r=>r.action)).toEqual(['prepare','start'])
        const lease=t.calls[0]!.leaseId,raw=t.calls[0]!.leaseToken
        expect(raw).toHaveLength(43)
        expect(JSON.stringify(await first.json())).not.toContain(raw!)
        expect(t.calls[1]!.leaseToken).toBeUndefined()
        expect(t.store.db.query('SELECT expires_at,revoked_at FROM evolved_runner_leases WHERE id=?').get(lease)).toEqual({expires_at:null,revoked_at:null})
        const row=t.store.db.query('SELECT scopes FROM evolved_runner_leases WHERE id=?').get(lease) as {scopes:string}
        expect(JSON.parse(row.scopes)).not.toContain('git:write')
        expect((await t.start()).status).toBe(200)
        expect(t.calls[2]!.leaseToken).toBeUndefined();expect(t.calls[2]!.leaseId).toBe(lease)
        expect(t.store.db.query('SELECT revoked_at FROM evolved_runner_leases WHERE id=?').get(manual)).toEqual({revoked_at:null})
        expect((await t.call(t.path)).status).toBe(200)
    })
    test('continuation authority rejects session logout, role downgrade and profile change',async()=>{
        const t=setup();expect((await t.start()).status).toBe(200)
        const request=t.calls[1]!
        expect(await(await t.authority(request)).json()).toEqual({authorized:true})
        t.store.db.prepare('DELETE FROM evolved_sessions WHERE token_hash=?').run(request.sessionHash)
        expect(await(await t.authority(request)).json()).toEqual({authorized:false})
        t.sessions.admin=t.store.createSession(t.users.admin)
        request.sessionHash=hashToken(t.sessions.admin)
        expect(await(await t.authority(request)).json()).toEqual({authorized:true})
        t.store.setMember(t.users.admin,t.team.id,t.users.other,'viewer')
        expect(await(await t.authority({...request,userId:t.users.other,sessionHash:hashToken(t.sessions.other!)})).json()).toEqual({authorized:false})
        t.store.setProfile(t.users.admin,t.project.id,'workspace')
        expect(await(await t.authority(request)).json()).toEqual({authorized:false})
    })
    test('revoked managed lease cannot continue but explicit reconnect issues a fresh scoped lease',async()=>{
        const t=setup();await t.start();const old=t.calls[0]!.leaseId
        t.store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=? WHERE id=?').run(Date.now(),old)
        expect(await(await t.authority(t.calls[1]!)).json()).toEqual({authorized:false})
        expect((await t.start()).status).toBe(200)
        expect(t.calls[2]!.leaseId).not.toBe(old)
    })
    test('revalidates authority after asynchronous provisioning before exposing a challenge',async()=>{
        const t=setup();t.setHook(r=>{if(r.action==='prepare')t.store.db.prepare('DELETE FROM evolved_sessions WHERE token_hash=?').run(r.sessionHash)})
        const response=await t.start();expect(response.status).toBe(403)
        expect(t.calls).toHaveLength(1)
    })
    test('missing operator files can be reconstructed by reconnecting without losing the account home',async()=>{
        const t=setup();await t.start();const old=t.calls[0]!.leaseId
        t.setHook(r=>{if(r.action==='prepare'&&!r.leaseToken)throw new EvolvedError('runner_config_missing','missing',409)})
        expect((await t.start()).status).toBe(409)
        expect(t.store.db.query('SELECT ready FROM evolved_managed_runners WHERE project_id=?').get(t.project.id)).toEqual({ready:0})
        expect((await t.start()).status).toBe(200)
        const repaired=t.calls.find(r=>r.action==='prepare'&&r.leaseId!==old)
        expect(repaired?.leaseToken).toHaveLength(43)
    })
    test('code completion uses the original live session after the five-minute step-up window',async()=>{
        const t=setup();await t.start();t.advance(360000)
        const response=await t.call(`${t.path}/claude/login/${randomUUID()}/code`,{code:'code#state'})
        expect(response.status).toBe(200)
        expect(t.calls.at(-1)?.sessionHash).toBe(hashToken(t.sessions.admin!))
        const audit=JSON.stringify(t.store.db.query('SELECT * FROM evolved_audit').all())
        expect(audit).not.toContain('code#state')
    })
    test('authority signature rejects browser cookies, replay and wrong purpose',async()=>{
        const t=setup();await t.start();const request={...t.calls[1]!,action:'authority' as const,provider:undefined}
        const envelope=signControl(t.key,request,'hub')
        const a=await t.call('/runner-control/authority',envelope)
        expect(a.status).toBe(403)
        expect((await t.call('/runner-control/authority',signControl(t.key,request,'operator'),{cookie:false})).status).toBe(403)
        const first=await t.call('/runner-control/authority',envelope,{cookie:false})
        expect(first.status).toBe(200)
        expect((await t.call('/runner-control/authority',envelope,{cookie:false})).status).toBe(403)
    })
})
