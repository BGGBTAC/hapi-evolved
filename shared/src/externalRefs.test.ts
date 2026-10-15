import { describe, expect, it } from 'bun:test'
import { ExternalRefsSchema, parseGithubPrInput, withoutExternalRefs } from './externalRefs'
describe('explicit PR identity', () => {
    it('accepts manual paste without network or title conventions', () => {
        const short = parseGithubPrInput('BGGBTAC/hapi-evolved#2')
        expect(short?.url).toBe('https://github.com/BGGBTAC/hapi-evolved/pull/2')
        expect(parseGithubPrInput(short!.url)).toEqual(short)
        expect(parseGithubPrInput(short!.url+'/')).toEqual(short)
    })
    it('rejects misleading URL authorities, encoded paths, unsafe integers and duplicate primaries', () => {
        for(const value of ['https://github.com@evil.example/o/r/pull/1','https://u:p@github.com/o/r/pull/1',
            'https://github.com/o/r/pull/1#secret','https://github.com/o/r/pull/1?token=x','https://github.com/o/%2f/pull/1',
            'https://github.com:8080/o/r/pull/1','o/r#9007199254740993','../r#1','o/r#0']) expect(parseGithubPrInput(value)).toBeNull()
        const first=parseGithubPrInput('one/repo#1')!, second=parseGithubPrInput('two/repo#2')!
        expect(ExternalRefsSchema.safeParse([first,second]).success).toBe(false)
        expect(ExternalRefsSchema.safeParse([first,{...first,role:'secondary'}]).success).toBe(false)
        expect(ExternalRefsSchema.safeParse([{...first,url:'https://github.com/other/repo/pull/1'}]).success).toBe(false)
        expect(ExternalRefsSchema.safeParse([]).success).toBe(true)
    })
    it('strips links from a new session without mutating its source', () => {
        const source={path:'/workspace',externalRefs:[parseGithubPrInput('one/repo#1')!]}
        expect(withoutExternalRefs(source)).toEqual({path:'/workspace'})
        expect(source.externalRefs).toHaveLength(1)
    })
})
