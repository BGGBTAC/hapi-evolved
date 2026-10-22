import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadTunwg, sha256Hex } from './download-tunwg'

const roots: string[] = []
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('refuses a destination created while the verified download was in flight', async () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'tunwg-creation-race-'))
    roots.push(toolsDir)
    const good = Buffer.from('verified'), unrelated = Buffer.from('preserve')
    const artifact = { fileName: 'tunwg-test', url: 'https://example.invalid/test', size: good.length, sha256: sha256Hex(good), executable: false }
    const destination = join(toolsDir, artifact.fileName)
    await expect(downloadTunwg({
        toolsDir, artifacts: [artifact], log: () => {},
        fetchImpl: async () => {
            writeFileSync(destination, unrelated, { flag: 'wx' })
            return new Response(good)
        },
    })).rejects.toThrow()
    expect(readFileSync(destination)).toEqual(unrelated)
    expect(readdirSync(toolsDir)).toEqual([artifact.fileName])
})
