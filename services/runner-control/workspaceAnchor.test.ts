import { afterEach, expect, test } from 'bun:test'
import { constants, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { assertRootOwnedPath, runAnchorCommand, validWorkspaceIdentity, WorkspaceAnchorError } from './workspaceAnchor'

const temporary:string[]=[]
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true})})
function directory(){const path=mkdtempSync('/tmp/evolved-anchor-test-');temporary.push(path);return path}

test('mount command inherits a stable directory FD even after its source path is replaced',async()=>{
    const root=directory(),source=`${root}/project`,other=`${root}/other`
    mkdirSync(source);mkdirSync(other)
    const fd=openSync(source,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try{
        const identity=fstatSync(fd,{bigint:true})
        renameSync(source,`${root}/original`);symlinkSync(other,source)
        const output=await runAnchorCommand(process.execPath,['-e',"const s=require('node:fs').fstatSync(3,{bigint:true});process.stdout.write(JSON.stringify({device:String(s.dev),inode:String(s.ino)}))"],{descriptor:fd,processGroup:true})
        expect(JSON.parse(output)).toEqual({device:String(identity.dev),inode:String(identity.ino)})
    }finally{closeSync(fd)}
})

test('outer timeout kills the helper process group including children that hold no stdio',async()=>{
    const root=directory(),pidFile=`${root}/pid`
    const script="const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],String(p.pid));setInterval(()=>{},1000)"
    await expect(runAnchorCommand(process.execPath,['-e',script,pidFile],{processGroup:true,timeout:300})).rejects.toThrow('Workspace anchor')
    expect(existsSync(pidFile)).toBe(true)
    const pid=Number(readFileSync(pidFile,'utf8'))
    const alive=()=>{try{return !['Z','X'].includes(readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2]!)}catch{return false}}
    for(let attempt=0;attempt<30&&alive();attempt++)await new Promise(resolve=>setTimeout(resolve,20))
    expect(alive()).toBe(false)
})

test('root-owned writable ancestors and malformed inode identities are rejected',()=>{
    expect(()=>assertRootOwnedPath('/tmp')).toThrow('immutable')
    expect(validWorkspaceIdentity({device:'1',inode:'2'})).toBe(true)
    for(const value of [{device:'1',inode:'0'},{device:'../1',inode:'2'},{device:1,inode:'2'},null])expect(validWorkspaceIdentity(value)).toBe(false)
    expect(new WorkspaceAnchorError()).toMatchObject({code:'workspace_identity_changed'})
})
