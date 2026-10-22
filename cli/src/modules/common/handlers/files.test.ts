import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'

async function createTempDir(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `${prefix}-`))
}

describe('file RPC handlers', () => {
    let rootDir: string
    let outsideDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-file-handler')
        outsideDir = await createTempDir('hapi-file-handler-outside')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
        await rm(outsideDir, { recursive: true, force: true })
    })

    async function call(method: string, params: unknown): Promise<{ success: boolean; error?: string; content?: string }> {
        const response = await rpc.handleRequest({ method: `session-test:${method}`, params: JSON.stringify(params) })
        return JSON.parse(response)
    }

    it('returns file metadata alongside content', async () => {
        const filePath = join(rootDir, 'README.md')
        await writeFile(filePath, '# test')
        const expectedStats = await stat(filePath)

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'README.md' })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            content?: string
            size?: number
            modified?: number
        }

        expect(parsed.success).toBe(true)
        expect(parsed.content).toBe(Buffer.from('# test').toString('base64'))
        expect(parsed.size).toBe(expectedStats.size)
        expect(parsed.modified).toBe(expectedStats.mtime.getTime())
    })

    it('writes relative paths inside the working directory, not the process cwd', async () => {
        const name = `hapi-write-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
        const result = await call('writeFile', { path: name, content: Buffer.from('hello').toString('base64') })

        expect(result.success).toBe(true)
        expect(await readFile(join(rootDir, name), 'utf8')).toBe('hello')
        expect(existsSync(join(process.cwd(), name))).toBe(false)
    })

    it('refuses to read a file through a symlink that leaves the working directory', async () => {
        await writeFile(join(outsideDir, 'secret.txt'), 'secret')
        await symlink(join(outsideDir, 'secret.txt'), join(rootDir, 'link.txt'))

        const result = await call('readFile', { path: 'link.txt' })

        expect(result.success).toBe(false)
        expect(result.error).toContain('outside the working directory')
        expect(result.content).toBeUndefined()
    })

    it('still reads symlinks that stay inside the working directory', async () => {
        await writeFile(join(rootDir, 'real.txt'), 'inside')
        await symlink(join(rootDir, 'real.txt'), join(rootDir, 'alias.txt'))

        const result = await call('readFile', { path: 'alias.txt' })

        expect(result.success).toBe(true)
        expect(result.content).toBe(Buffer.from('inside').toString('base64'))
    })

    it('refuses to create a file through a symlinked directory outside the working directory', async () => {
        await symlink(outsideDir, join(rootDir, 'escape'), 'dir')

        const result = await call('writeFile', { path: 'escape/new.txt', content: Buffer.from('x').toString('base64') })

        expect(result.success).toBe(false)
        expect(existsSync(join(outsideDir, 'new.txt'))).toBe(false)
    })

    it('refuses to write through a dangling symlink', async () => {
        await symlink(join(outsideDir, 'created.txt'), join(rootDir, 'dangling.txt'))

        const result = await call('writeFile', { path: 'dangling.txt', content: Buffer.from('x').toString('base64') })

        expect(result.success).toBe(false)
        expect(existsSync(join(outsideDir, 'created.txt'))).toBe(false)
    })

    it('overwrites with the expected hash through one handle and leaves no stale bytes', async () => {
        const original = Buffer.from('a much longer original body')
        await writeFile(join(rootDir, 'edit.txt'), original)
        const sha = (await import('crypto')).createHash('sha256').update(original).digest('hex')

        const mismatch = await call('writeFile', { path: 'edit.txt', content: Buffer.from('x').toString('base64'), expectedHash: '0'.repeat(64) })
        expect(mismatch.success).toBe(false)
        expect(await readFile(join(rootDir, 'edit.txt'), 'utf8')).toBe('a much longer original body')

        const result = await call('writeFile', { path: 'edit.txt', content: Buffer.from('short').toString('base64'), expectedHash: sha })
        expect(result.success).toBe(true)
        expect(await readFile(join(rootDir, 'edit.txt'), 'utf8')).toBe('short')
    })

    it.skipIf(process.platform === 'win32')('rejects FIFOs and directories without blocking', async () => {
        execFileSync('mkfifo', [join(rootDir, 'pipe')])
        await mkdir(join(rootDir, 'dir'))

        for (const path of ['pipe', 'dir']) {
            const result = await call('readFile', { path })
            expect(result.success).toBe(false)
        }
    })
})
