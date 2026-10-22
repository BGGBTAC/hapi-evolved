import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { EvolvedError, EvolvedStore, hashToken, randomToken, type EvolvedProject } from './store'
import { authenticateEvolvedRequest, cookieToken, parseBody, requireFreshPasskey, requireHuman, type EvolvedEnv } from './security'
import { signControl, verifyControl, type ControlRequest } from './runnerControlProtocol'
import { providerModelCatalogSchema, unavailableModelCatalog, type ProviderModelCatalog } from './providerModels'
import { standardRunnerScopes } from './runnerScopes'

const provider = z.enum(['codex', 'claude'])
function parseProvider(value:string):'codex'|'claude' {
    const parsed=provider.safeParse(value)
    if(!parsed.success)throw new EvolvedError('invalid_provider','Unbekannter Anbieter.',400)
    return parsed.data
}
const summary = z.object({ provider, status: z.enum(['connected','disconnected','unavailable']), method: z.enum(['subscription','api-key']).nullable(), checkedAt: z.number().nullable() }).strict()
const operation = z.object({ id:z.string().max(128), provider, state:z.enum(['starting','waiting','connected','failed','cancelled','expired']), flow:z.enum(['device','code']).nullable(), verificationUrl:z.string().max(4096).optional(), userCode:z.string().max(128).optional(), expiresAt:z.number().optional(), message:z.string().max(300).optional() }).strict()
const operationReply = z.object({ operation }).strict()
const summaryReply = z.object({ providers:z.array(summary).length(2) }).strict()
type Managed = { lease_id:string; ready:number }
export type ProviderControl = { request(request:ControlRequest):Promise<unknown> }
export class UnixProviderControl implements ProviderControl {
    constructor(private socket:string, private key:Uint8Array) {}
    async request(request:ControlRequest):Promise<unknown> {
        let response:Response
        try { response = await fetch('http://runner-control/control', { unix:this.socket, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(signControl(this.key,request,'operator')), signal:AbortSignal.timeout(request.action==='prepare'?90_000:20_000) }) }
        catch { throw new EvolvedError('runner_unavailable','Der Projektdienst ist vorübergehend nicht erreichbar. Bitte erneut versuchen.',503) }
        if (!response.ok) {
            const body = await response.json().catch(()=>null) as {code?:string}|null
            if (body?.code==='login_busy') throw new EvolvedError('login_busy','Für diesen Anbieter läuft bereits eine Anmeldung. Bitte zuerst abschließen oder abbrechen.',409)
            if (body?.code==='operation_not_found') throw new EvolvedError('operation_not_found','Diese Anmeldung ist nicht mehr verfügbar. Bitte erneut verbinden.',404)
            if (body?.code==='runner_config_missing') throw new EvolvedError('runner_config_missing','Die gespeicherte Projektdienst-Konfiguration fehlt. Bitte erneut verbinden; HAPI richtet sie neu ein.',409)
            if (body?.code==='workspace_identity_changed') throw new EvolvedError('workspace_identity_changed','Der Projektordner wurde außerhalb von HAPI ersetzt oder verschoben. Der Projektdienst bleibt gesperrt; bitte den Installationsadministrator den Ordner und Workspace-Anker prüfen lassen.',409)
            if (body?.code==='logout_failed') throw new EvolvedError('logout_failed','Die native Abmeldung konnte nicht bestätigt werden. Bitte den Status aktualisieren und erneut versuchen.',409)
            if (body?.code && ['invalid_code','code_state_mismatch','invalid_state'].includes(body.code)) throw new EvolvedError('invalid_code','Dieser Bestätigungscode passt nicht zur laufenden Anmeldung. Bitte den vollständigen Code aus dem gerade geöffneten Anbieterfenster einfügen.',400)
            throw new EvolvedError('runner_unavailable','Der Projektdienst konnte die Aktion nicht abschließen. Bitte erneut versuchen.',503)
        }
        const text = await response.text()
        if(text.length>32_768) throw new EvolvedError('invalid_runner_reply','Ungültige Antwort des Projektdienstes.',502)
        return JSON.parse(text)
    }
}
export function createProviderRoutes(store:EvolvedStore, options:{control?:ProviderControl;key?:Uint8Array} = {}):Hono<EvolvedEnv> {
    store.db.exec('CREATE TABLE IF NOT EXISTS evolved_managed_runners(project_id TEXT PRIMARY KEY REFERENCES evolved_projects(id) ON DELETE CASCADE,lease_id TEXT NOT NULL REFERENCES evolved_runner_leases(id) ON DELETE CASCADE,ready INTEGER NOT NULL DEFAULT 0)')
    const app = new Hono<EvolvedEnv>(), seen = new Map<string,number>(), preparing = new Set<string>()
    type ModelSnapshot = { catalog?:ProviderModelCatalog; leaseId?:string; profile?:string; rootPath?:string; generation:number; refreshedAt:number; pending?:Promise<ProviderModelCatalog> }
    const modelSnapshots = new Map<string,ModelSnapshot>()
    let modelRefreshes=0
    const modelKey=(projectId:string,chosen:string)=>`${projectId}:${chosen}`
    const invalidateModels=(projectId:string,chosen:string)=>{
        const entry=modelSnapshots.get(modelKey(projectId,chosen))
        if(entry){entry.catalog=undefined;entry.generation++;entry.refreshedAt=0}
    }
    const mapping = (id:string) => store.db.prepare('SELECT lease_id,ready FROM evolved_managed_runners WHERE project_id=?').get(id) as Managed|null
    const validLease = (project:EvolvedProject, leaseId:string):boolean => {
        const row=store.db.prepare('SELECT user_id,profile FROM evolved_runner_leases WHERE id=? AND project_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').get(leaseId,project.id,store.now()) as {user_id:string;profile:string}|null
        if(!row || row.profile!==project.profile) return false
        try { return store.requireProject(row.user_id,project.id,'admin').profile===project.profile } catch { return false }
    }
    const authorized = (r:ControlRequest):boolean => {
        const principal=store.getSessionByHash(r.sessionHash)
        if(!principal || principal.user.id!==r.userId) return false
        try {
            const project=store.requireProject(r.userId,r.projectId,'admin')
            return project.profile===r.profile && project.rootPath===r.rootPath && mapping(project.id)?.lease_id===r.leaseId && validLease(project,r.leaseId)
        } catch { return false }
    }
    app.post('/runner-control/authority', async c => {
        if(!options.key || c.req.header('cookie')) return c.json({authorized:false},403)
        let request:ControlRequest
        try { request=verifyControl(options.key,await c.req.json(),'hub',seen,store.now()) } catch { return c.json({authorized:false},403) }
        return c.json({authorized:request.action==='authority' && authorized(request)})
    })
    // This read-only member route is deliberately registered before the existing
    // administrator middleware. It never starts a native process or provisions.
    app.get('/projects/:id/providers/:provider/models',async c=>{
        const principal=await authenticateEvolvedRequest(c.req.raw,store)
        if(!principal)throw new EvolvedError('unauthorized','Sign in required.',401)
        requireHuman(principal)
        const project=store.requireProject(principal.user.id,c.req.param('id'),'member'),chosen=parseProvider(c.req.param('provider'))
        const entry=modelSnapshots.get(modelKey(project.id,chosen)),managed=mapping(project.id)
        if(!entry?.catalog||!managed?.ready||entry.leaseId!==managed.lease_id||entry.profile!==project.profile||entry.rootPath!==project.rootPath||!validLease(project,managed.lease_id))return c.json(unavailableModelCatalog(chosen))
        return c.json({...entry.catalog,stale:entry.catalog.expiresAt===null||entry.catalog.expiresAt<=store.now()})
    })
    app.use('/projects/:id/providers/*', async(c,next)=>{
        if(!['GET','HEAD'].includes(c.req.method)) await c.req.text()
        const principal=await authenticateEvolvedRequest(c.req.raw,store)
        if(!principal) throw new EvolvedError('unauthorized','Sign in required.',401)
        requireHuman(principal); store.requireProject(principal.user.id,c.req.param('id')!,'admin')
        c.set('principal',principal); await next()
    })
    const control = async(r:ControlRequest) => {
        if(!options.control) throw new EvolvedError('runner_unavailable','Die Browser-Anmeldung ist auf diesem Server noch nicht eingerichtet.',503)
        if(!authorized(r)) throw new EvolvedError('forbidden','Die Berechtigung für diesen Projektdienst wurde geändert.',403)
        const result=await options.control.request(r)
        if(!authorized(r)) throw new EvolvedError('forbidden','Die Berechtigung für diesen Projektdienst wurde geändert.',403)
        return result
    }
    const requestFor = (req:Request, project:EvolvedProject, userId:string, action:ControlRequest['action']):ControlRequest => ({action,projectId:project.id,userId,sessionHash:hashToken(cookieToken(req)??''),profile:project.profile,rootPath:project.rootPath,leaseId:mapping(project.id)?.lease_id??''})
    app.post('/projects/:id/providers/:provider/models/refresh',async c=>{
        const principal=c.get('principal'),project=store.requireProject(principal.user.id,c.req.param('id'),'admin'),chosen=parseProvider(c.req.param('provider'))
        await parseBody(c,z.object({}).strict())
        const managed=mapping(project.id)
        if(!managed?.ready||!validLease(project,managed.lease_id))throw new EvolvedError('runner_unavailable','Für eine Modellabfrage muss bereits ein Projektdienst verbunden sein.',503)
        const key=modelKey(project.id,chosen),request={...requestFor(c.req.raw,project,principal.user.id,'models'),provider:chosen,refresh:true}
        let entry=modelSnapshots.get(key)
        if(!entry){
            if(modelSnapshots.size>=256){const removable=[...modelSnapshots].find(([,value])=>!value.pending);if(removable)modelSnapshots.delete(removable[0]);else throw new EvolvedError('model_catalog_busy','Modellkatalog ist ausgelastet.',429)}
            entry={generation:0,refreshedAt:0};modelSnapshots.set(key,entry)
        }
        if(!entry.pending){
            if(modelRefreshes>=4||entry.refreshedAt&&store.now()-entry.refreshedAt<30_000)throw new EvolvedError('model_catalog_rate_limited','Bitte nach einer Modellabfrage 30 Sekunden bis zur nächsten Abfrage warten.',429)
            entry.refreshedAt=store.now();modelRefreshes++
            const target=entry,generation=entry.generation
            entry.pending=(async()=>{
                const parsed=providerModelCatalogSchema.safeParse(await control(request))
                if(!parsed.success||parsed.data.provider!==chosen||parsed.data.checkedAt!==null&&parsed.data.checkedAt>store.now()+60_000)throw new EvolvedError('invalid_runner_reply','Ungültige Modellkatalog-Antwort des Projektdienstes.',502)
                if(target.generation!==generation)throw new EvolvedError('model_catalog_changed','Die Anmeldung wurde während der Modellabfrage geändert. Bitte erneut abfragen.',409)
                target.catalog=parsed.data;target.leaseId=request.leaseId;target.profile=project.profile;target.rootPath=project.rootPath
                return parsed.data
            })().finally(()=>{target.pending=undefined;modelRefreshes--})
        }
        const result=await entry.pending
        // A concurrent administrator may join the same native refresh. Their
        // own session and current role still govern disclosure of its result.
        if(!authorized(request))throw new EvolvedError('forbidden','Die Berechtigung für diesen Projektdienst wurde geändert.',403)
        return c.json({...result,stale:result.expiresAt===null||result.expiresAt<=store.now()})
    })
    app.get('/projects/:id/providers', async c=>{
        const principal=c.get('principal'),project=store.requireProject(principal.user.id,c.req.param('id'),'admin'), managed=mapping(project.id)
        const unavailable=()=>({providers:['codex','claude'].map(provider=>({provider,status:'unavailable',method:null,checkedAt:null}))})
        if(!managed) return c.json({runner:{status:'unconfigured',managed:false},...unavailable()})
        if(!options.control || !managed.ready || !validLease(project,managed.lease_id)) return c.json({runner:{status:preparing.has(project.id)?'starting':'offline',managed:true},...unavailable()})
        try { const result=summaryReply.parse(await control(requestFor(c.req.raw,project,principal.user.id,'status'))); return c.json({runner:{status:'ready',managed:true},...result}) }
        catch { return c.json({runner:{status:'offline',managed:true},...unavailable()}) }
    })
    app.post('/projects/:id/providers/:provider/login',async c=>{
        const principal=c.get('principal');requireFreshPasskey(c,store,principal)
        await parseBody(c,z.object({}).strict());const chosen=parseProvider(c.req.param('provider'))
        const project=store.requireProject(principal.user.id,c.req.param('id'),'admin')
        if(!options.control) throw new EvolvedError('runner_unavailable','Die Browser-Anmeldung ist auf diesem Server noch nicht eingerichtet.',503)
        if(preparing.has(project.id)) throw new EvolvedError('login_busy','Der Projektdienst wird gerade vorbereitet. Bitte kurz warten.',409)
        invalidateModels(project.id,chosen)
        preparing.add(project.id)
        try {
            let managed=mapping(project.id), token:string|undefined
            if(!managed?.ready || !validLease(project,managed.lease_id)) {
                token=randomToken(); const id=randomUUID()
                store.db.transaction(()=>{
                    if(managed) store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(store.now(),managed.lease_id)
                    const scopes=standardRunnerScopes(project.profile)
                    store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id,'Verwalteter Projektdienst',hashToken(token!),principal.user.id,project.id,JSON.stringify(scopes),'[]',project.profile,store.now(),null)
                    store.db.prepare('INSERT INTO evolved_managed_runners VALUES(?,?,0) ON CONFLICT(project_id) DO UPDATE SET lease_id=excluded.lease_id,ready=0').run(project.id,id)
                    store.audit(principal.user.id,project.id,'runner.managed_created',id)
                })()
                managed={lease_id:id,ready:0}
            }
            const r=requestFor(c.req.raw,project,principal.user.id,'prepare')
            if(token) r.leaseToken=token
            try { await control(r) } catch(error) {
                if(error instanceof EvolvedError && error.code==='runner_config_missing') {
                    // Keep the account home and manual leases; the next explicit
                    // connect creates a fresh managed lease and reconstructs config.
                    store.db.prepare('UPDATE evolved_managed_runners SET ready=0 WHERE project_id=? AND lease_id=?').run(project.id,r.leaseId)
                }
                throw error
            }
            store.db.prepare('UPDATE evolved_managed_runners SET ready=1 WHERE project_id=? AND lease_id=?').run(project.id,r.leaseId)
            requireFreshPasskey(c,store,principal)
            const result=operationReply.parse(await control({...r,leaseToken:undefined,action:'start',provider:chosen}))
            store.audit(principal.user.id,project.id,'provider.login_started',chosen)
            return c.json(result)
        } finally { invalidateModels(project.id,chosen);preparing.delete(project.id) }
    })
    app.get('/projects/:id/providers/:provider/login/:operationId', async c=>{
        const principal=c.get('principal'), project=store.requireProject(principal.user.id,c.req.param('id'),'admin')
        const chosen=parseProvider(c.req.param('provider')),result=operationReply.parse(await control({...requestFor(c.req.raw,project,principal.user.id,'get'),provider:chosen,operationId:c.req.param('operationId')}))
        if(result.operation.state==='connected')invalidateModels(project.id,chosen)
        return c.json(result)
    })
    app.post('/projects/:id/providers/:provider/login/:operationId/code',async c=>{
        // Starting this operation required a fresh passkey. Completing its bounded
        // challenge remains bound to that same live session in the operator;
        // re-authentication here would rotate the session and strand a valid code.
        const principal=c.get('principal')
        const body=await parseBody(c,z.object({code:z.string().trim().min(1).max(4096).regex(/^[A-Za-z0-9_.~+#/-]+$/)}).strict())
        const project=store.requireProject(principal.user.id,c.req.param('id'),'admin')
        const chosen=parseProvider(c.req.param('provider'))
        invalidateModels(project.id,chosen)
        try {
            return c.json(operationReply.parse(await control({...requestFor(c.req.raw,project,principal.user.id,'code'),provider:chosen,operationId:c.req.param('operationId'),code:body.code})))
        } finally { invalidateModels(project.id,chosen) }
    })
    app.delete('/projects/:id/providers/:provider/login/:operationId',async c=>{
        const principal=c.get('principal'),project=store.requireProject(principal.user.id,c.req.param('id'),'admin')
        return c.json(operationReply.parse(await control({...requestFor(c.req.raw,project,principal.user.id,'cancel'),provider:parseProvider(c.req.param('provider')),operationId:c.req.param('operationId')})))
    })
    app.delete('/projects/:id/providers/:provider',async c=>{
        const principal=c.get('principal');requireFreshPasskey(c,store,principal)
        const project=store.requireProject(principal.user.id,c.req.param('id'),'admin'), chosen=parseProvider(c.req.param('provider'))
        invalidateModels(project.id,chosen)
        try {
            const result=summaryReply.parse(await control({...requestFor(c.req.raw,project,principal.user.id,'logout'),provider:chosen}))
            store.audit(principal.user.id,project.id,'provider.logged_out',chosen)
            return c.json(result)
        } finally { invalidateModels(project.id,chosen) }
    })
    return app
}
