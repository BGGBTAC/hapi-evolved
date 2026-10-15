import { describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { signControl, verifyControl, validControlRequest, type ControlRequest } from '../../hub/src/evolved/runnerControlProtocol'

function request():ControlRequest{const projectId=randomUUID();return{action:'prepare',projectId,userId:randomUUID(),sessionHash:'a'.repeat(64),profile:'restricted',rootPath:`/managed-workspaces/${projectId}`,leaseId:randomUUID()}}
describe('narrow signed runner control protocol',()=>{
    test('accepts valid signed envelopes once and only in their direction',()=>{
        const key=randomBytes(32),r=request(),seen=new Map<string,number>(),envelope=signControl(key,r,'operator',100000)
        expect(verifyControl(key,envelope,'operator',seen,100001)).toEqual(r)
        expect(()=>verifyControl(key,envelope,'operator',seen,100002)).toThrow()
        expect(()=>verifyControl(key,envelope,'hub',new Map(),100001)).toThrow()
        expect(()=>verifyControl(randomBytes(32),envelope,'operator',new Map(),100001)).toThrow()
    })
    test('rejects stale, future and modified envelopes',()=>{
        const key=randomBytes(32),envelope=signControl(key,request(),'operator',100000)
        expect(()=>verifyControl(key,envelope,'operator',new Map(),130001)).toThrow()
        expect(()=>verifyControl(key,envelope,'operator',new Map(),90000)).toThrow()
        expect(()=>verifyControl(key,{...envelope,payload:envelope.payload+'x'},'operator',new Map(),100001)).toThrow()
    })
    test('rejects arbitrary paths, images, commands, traversal and unknown fields',()=>{
        const r=request();expect(validControlRequest(r)).toBe(true)
        for(const rootPath of ['/','/runner','/etc','/workspaces/../hub','/workspaces/a/b',`/managed-workspaces/${randomUUID()}`,'/workspaces/a\nEVIL=x'])expect(validControlRequest({...r,rootPath})).toBe(false)
        for(const extra of [{command:'sh'},{image:'evil'},{container:'hub'},{args:['--privileged']},{rootPath:'/var/lib/hapi-evolved/hub'}])expect(validControlRequest({...r,...extra})).toBe(false)
        expect(validControlRequest({...r,rootPath:'/workspaces/example.repo'})).toBe(true)
    })
    test('requires provider and opaque operation id for challenge operations',()=>{
        const r=request()
        expect(validControlRequest({...r,action:'code'})).toBe(false)
        expect(validControlRequest({...r,action:'code',provider:'claude',operationId:randomUUID(),code:'abc#def'})).toBe(true)
        expect(validControlRequest({...r,action:'code',provider:'claude',operationId:randomUUID(),code:'abc\ndef'})).toBe(false)
        expect(validControlRequest({...r,action:'status',leaseToken:'a'.repeat(43)})).toBe(false)
    })
    test('model refresh is a provider-bound metadata action without challenge or command fields',()=>{
        const r=request()
        expect(validControlRequest({...r,action:'models',provider:'codex',refresh:true})).toBe(true)
        for(const value of [{...r,action:'models'},{...r,action:'models',provider:'codex',refresh:'yes'},{...r,action:'status',refresh:true},{...r,action:'models',provider:'codex',operationId:randomUUID()},{...r,action:'models',provider:'codex',code:'private'},{...r,action:'models',provider:'codex',leaseToken:'a'.repeat(43)}])expect(validControlRequest(value)).toBe(false)
    })
})
