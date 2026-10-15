import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { validWorkspaceIdentity, workspaceIdentity } from './workspaceAnchor'
import { pinnedWorkspaceMatches } from '../runner-proxy/supervisor'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
test('pinned workspace identity detects replacement and rejects symlink sources',()=>{
    const root=mkdtempSync('/tmp/evolved-anchor-test-');dirs.push(root)
    mkdirSync(`${root}/project`)
    const expected=workspaceIdentity(`${root}/project`)
    expect(validWorkspaceIdentity(expected)).toBe(true)
    expect(pinnedWorkspaceMatches(`${root}/project`,expected.device,expected.inode)).toBe(true)
    renameSync(`${root}/project`,`${root}/original`);mkdirSync(`${root}/project`)
    expect(pinnedWorkspaceMatches(`${root}/project`,expected.device,expected.inode)).toBe(false)
    expect(pinnedWorkspaceMatches(`${root}/original`,expected.device,expected.inode)).toBe(true)
    symlinkSync(`${root}/original`,`${root}/link`)
    expect(()=>workspaceIdentity(`${root}/link`)).toThrow()
})
test('partial, malformed and unsafe numeric workspace identities fail closed',()=>{
    for(const value of [null,{}, {device:'1',inode:'0'},{device:'1e3',inode:'2'},{device:1,inode:2},{device:'1',inode:'-2'}])expect(validWorkspaceIdentity(value)).toBe(false)
    expect(pinnedWorkspaceMatches('/unread','1',undefined)).toBe(false)
    expect(pinnedWorkspaceMatches('/unread',undefined,undefined)).toBe(true)
})
