import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Simulate a concurrent same-user writer replacing the validated final path
// component with a symlink between resolveContainedPath() and the open().
const swapped = vi.hoisted(() => ({ realPath: '' }))
vi.mock('../pathSecurity', () => ({
    resolveContainedPath: async (path: string) => ({ valid: true, path, realPath: swapped.realPath })
}))

import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'

describe.skipIf(process.platform === 'win32')('file RPC handlers after a final-component symlink swap', () => {
    let base: string
    let rootDir: string
    let outsideFile: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        // One private root holding the project and an outside sibling; single cleanup.
        base = await mkdtemp(join(tmpdir(), 'hapi-file-swap-'))
        rootDir = join(base, 'project')
        await mkdir(rootDir)
        outsideFile = join(base, 'outside.txt')
        await writeFile(outsideFile, 'outside secret')
        swapped.realPath = join(rootDir, 'swapped.txt')
        await symlink(outsideFile, swapped.realPath)
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(base, { recursive: true, force: true })
    })

    async function call(method: string, params: unknown): Promise<{ success: boolean; content?: string }> {
        return JSON.parse(await rpc.handleRequest({ method: `session-test:${method}`, params: JSON.stringify(params) }))
    }

    it('does not read through the swapped symlink', async () => {
        const result = await call('readFile', { path: 'swapped.txt' })
        expect(result.success).toBe(false)
        expect(result.content).toBeUndefined()
    })

    it('does not overwrite or create through the swapped symlink', async () => {
        const hash = (await import('crypto')).createHash('sha256').update('outside secret').digest('hex')
        const overwrite = await call('writeFile', { path: 'swapped.txt', content: Buffer.from('pwned').toString('base64'), expectedHash: hash })
        const create = await call('writeFile', { path: 'swapped.txt', content: Buffer.from('pwned').toString('base64') })

        expect(overwrite.success).toBe(false)
        expect(create.success).toBe(false)
        expect(await readFile(outsideFile, 'utf8')).toBe('outside secret')
    })
})
