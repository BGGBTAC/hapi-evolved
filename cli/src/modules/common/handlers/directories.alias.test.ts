import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerDirectoryHandlers } from './directories'

type TreeNode = { name: string; path: string; type: string; size?: number; children?: TreeNode[] }

describe.skipIf(process.platform === 'win32')('directory RPC handlers through in-root symlink aliases', () => {
    let base: string
    let project: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        // One private root holding the project and an outside sibling.
        base = await mkdtemp(join(tmpdir(), 'hapi-dir-alias-'))
        project = join(base, 'project')
        await mkdir(join(project, 'src'), { recursive: true })
        await writeFile(join(project, 'src', 'index.ts'), 'export {}\n')
        await mkdir(join(base, 'outside'))
        await writeFile(join(base, 'outside', 'secret.txt'), 'secret')
        await symlink(join(project, 'src'), join(project, 'alias'), 'dir')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerDirectoryHandlers(rpc, project)
    })

    afterEach(async () => {
        await rm(base, { recursive: true, force: true })
    })

    async function call<T>(method: string, params: unknown): Promise<T> {
        return JSON.parse(await rpc.handleRequest({ method: `session-test:${method}`, params: JSON.stringify(params) })) as T
    }

    it('lists, stats and trees the real directory while keeping lexical alias paths', async () => {
        const listed = await call<{ success: boolean; entries?: Array<{ name: string; type: string; size?: number }> }>('listDirectory', { path: 'alias' })
        expect(listed.success).toBe(true)
        expect(listed.entries).toEqual([expect.objectContaining({ name: 'index.ts', type: 'file', size: 10 })])

        const stats = await call<{ entries?: Array<{ path: string; size?: number }> }>('statFiles', { paths: ['alias/index.ts'] })
        expect(stats.entries).toEqual([expect.objectContaining({ path: 'alias/index.ts', size: 10 })])

        const tree = await call<{ success: boolean; tree?: TreeNode }>('getDirectoryTree', { path: 'alias', maxDepth: 1 })
        expect(tree.success).toBe(true)
        expect(tree.tree).toMatchObject({ name: 'alias', path: join(project, 'alias'), type: 'directory' })
        expect(tree.tree?.children).toEqual([expect.objectContaining({ name: 'index.ts', path: join(project, 'alias', 'index.ts'), size: 10 })])
    })

    it('still refuses an alias that leaves the project', async () => {
        await symlink(join(base, 'outside'), join(project, 'escape'), 'dir')

        const listed = await call<{ success: boolean }>('listDirectory', { path: 'escape' })
        const stats = await call<{ entries?: Array<{ path: string; size?: number }> }>('statFiles', { paths: ['escape/secret.txt'] })

        expect(listed.success).toBe(false)
        expect(stats.entries).toEqual([{ path: 'escape/secret.txt' }])
    })
})
