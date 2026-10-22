import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Pause at the validation/I/O boundary and exchange a project subdirectory.
const swap = vi.hoisted(() => ({ run: async () => {} }))
vi.mock('../pathSecurity', async () => ({
    validatePath: () => ({ valid: true }),
    resolveContainedPath: async (path: string, workingDirectory: string) => {
        const realPath = join(workingDirectory, path)
        await swap.run()
        return { valid: true, path: realPath, realPath }
    }
}))

import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'
import { registerDirectoryHandlers } from './directories'

describe.skipIf(process.platform !== 'linux')('file and directory RPCs after an ancestor swap', () => {
    let base: string
    let project: string
    let outside: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'hapi-ancestor-rpc-'))
        project = join(base, 'project')
        outside = join(base, 'outside')
        await mkdir(join(project, 'safe'), { recursive: true })
        await mkdir(outside)
        await writeFile(join(project, 'safe', 'file.txt'), 'inside')
        await writeFile(join(outside, 'file.txt'), 'outside')
        let done = false
        swap.run = async () => {
            if (done) return
            done = true
            await rename(join(project, 'safe'), join(project, 'safe-original'))
            await symlink(outside, join(project, 'safe'))
        }
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, project)
        registerDirectoryHandlers(rpc, project)
    })

    afterEach(async () => { await rm(base, { recursive: true, force: true }) })

    async function call(method: string, params: unknown): Promise<Record<string, unknown>> {
        return JSON.parse(await rpc.handleRequest({ method: `session-test:${method}`, params: JSON.stringify(params) }))
    }

    it('does not read through the swapped parent', async () => {
        const response = await call('readFile', { path: 'safe/file.txt' })
        expect(response.success).toBe(false)
        expect(JSON.stringify(response)).not.toContain('outside')
        expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('outside')
    })

    it('does not create a new file through the swapped parent', async () => {
        const response = await call('writeFile', { path: 'safe/new.txt', content: Buffer.from('new').toString('base64') })
        expect(response.success).toBe(false)
        await expect(readFile(join(outside, 'new.txt'))).rejects.toThrow()
    })

    it('does not list, stat or tree the swapped outside directory', async () => {
        expect((await call('listDirectory', { path: 'safe' })).success).toBe(false)
        expect((await call('statFiles', { paths: ['safe/file.txt'] })).entries).toEqual([{ path: 'safe/file.txt' }])
        expect((await call('getDirectoryTree', { path: 'safe', maxDepth: 1 })).success).toBe(false)
    })
})
