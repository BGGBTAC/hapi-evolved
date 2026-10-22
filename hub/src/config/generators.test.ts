import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOrCreateJsonFile } from './generators'

const codec = {
    readValue: (raw: string) => (JSON.parse(raw) as { value: string }).value,
    writeValue: (value: string) => JSON.stringify({ value }),
}

describe('getOrCreateJsonFile', () => {
    let dir: string | null = null

    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true })
        dir = null
    })

    it('keeps a file another starter created after the existence check', async () => {
        dir = mkdtempSync(join(tmpdir(), 'hapi-generators-test-'))
        const filePath = join(dir, 'secret.json')

        const result = await getOrCreateJsonFile({
            filePath,
            ...codec,
            generate: () => {
                // A concurrent hub publishes its secret between existsSync and the write.
                writeFileSync(filePath, JSON.stringify({ value: 'first' }), { mode: 0o600 })
                return 'second'
            },
        })

        expect(result).toEqual({ value: 'first', created: false })
        expect(codec.readValue(readFileSync(filePath, 'utf8'))).toBe('first')
        expect(readdirSync(dir)).toEqual(['secret.json'])
    })

    it('converges concurrent creators on the persisted value', async () => {
        dir = mkdtempSync(join(tmpdir(), 'hapi-generators-test-'))
        const filePath = join(dir, 'nested', 'secret.json')
        let counter = 0

        const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateJsonFile({
            filePath,
            ...codec,
            generate: () => `value-${counter++}`,
        })))

        const persisted = codec.readValue(readFileSync(filePath, 'utf8'))
        expect(results.every((result) => result.value === persisted)).toBe(true)
        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(readdirSync(join(dir, 'nested'))).toEqual(['secret.json'])
        if (process.platform !== 'win32') {
            expect(statSync(filePath).mode & 0o777).toBe(0o600)
        }
    })
})
