import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOperatorKey } from './server'

const uid=process.getuid?.()??0
let directory=''
afterEach(()=>{if(directory)rmSync(directory,{recursive:true,force:true});directory=''})
function fixture(){directory=mkdtempSync(join(tmpdir(),'runner-control-key-'));const key=join(directory,'runner-control.key'),value=randomBytes(32);writeFileSync(key,value,{mode:0o600});return{key,value}}

describe('operator key loading',()=>{
    test('reads a private 32-byte key through the opened descriptor',()=>{
        const {key,value}=fixture()
        expect(readOperatorKey(key,uid).equals(value)).toBe(true)
    })
    test('refuses a key path replaced by a symbolic link',()=>{
        const {key}=fixture(),link=join(directory,'link.key')
        symlinkSync(key,link)
        expect(()=>readOperatorKey(link,uid)).toThrow()
    })
    test('refuses hard-linked, permissive and wrong-sized keys',()=>{
        const {key}=fixture()
        linkSync(key,join(directory,'alias.key'))
        expect(()=>readOperatorKey(key,uid)).toThrow('Private operator key required')
        rmSync(join(directory,'alias.key'))
        chmodSync(key,0o640)
        expect(()=>readOperatorKey(key,uid)).toThrow('Private operator key required')
        chmodSync(key,0o600);writeFileSync(key,randomBytes(31))
        expect(()=>readOperatorKey(key,uid)).toThrow('Invalid operator key')
    })
})
