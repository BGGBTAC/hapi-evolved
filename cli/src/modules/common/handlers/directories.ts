import { logger } from '@/ui/logger'
import { lstat, readdir, type FileHandle } from 'fs/promises'
import { basename, join } from 'path'
import type { DirectoryEntry, ListDirectoryResponse, StatFilesResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { resolveContainedPath, validatePath } from '../pathSecurity'
import { descriptorPath, directoryChildPath, openContainedDirectory, openContainedParent, openDirectoryChild } from '../anchoredPaths'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ListDirectoryRequest {
    path: string
}

interface GetDirectoryTreeRequest {
    path: string
    maxDepth: number
}

interface StatFilesRequest {
    paths: string[]
}

interface TreeNode {
    name: string
    path: string
    type: 'file' | 'directory'
    size?: number
    modified?: number
    children?: TreeNode[]
}

interface GetDirectoryTreeResponse {
    success: boolean
    tree?: TreeNode
    error?: string
}

export function registerDirectoryHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>(RPC_METHODS.ListDirectory, async (data) => {
        logger.debug('List directory request:', data.path)

        const targetPath = data.path || '.'

        const validation = await resolveContainedPath(targetPath, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error)
        }

        try {
            const realDirectory = validation.realPath
            const directory = await openContainedDirectory(realDirectory, workingDirectory)
            try {
                const entries = await readdir(process.platform === 'linux' ? descriptorPath(directory) : realDirectory, { withFileTypes: true })

                const directoryEntries: DirectoryEntry[] = await Promise.all(
                    entries.map(async (entry) => {
                        const fullPath = join(realDirectory, entry.name)
                        let type: 'file' | 'directory' | 'other' = 'other'
                        let size: number | undefined
                        let modified: number | undefined

                        try {
                            const stats = await lstat(directoryChildPath(directory, entry.name, fullPath))
                            if (stats.isDirectory()) type = 'directory'
                            else if (stats.isFile()) type = 'file'
                            if (!stats.isSymbolicLink()) {
                                size = stats.size
                                modified = stats.mtime.getTime()
                            }
                        } catch (error) {
                            logger.debug(`Failed to stat ${fullPath}:`, error)
                        }

                        return {
                            name: entry.name,
                            type,
                            size,
                            modified
                        }
                    })
                )

                directoryEntries.sort((a, b) => {
                    if (a.type === 'directory' && b.type !== 'directory') return -1
                    if (a.type !== 'directory' && b.type === 'directory') return 1
                    return a.name.localeCompare(b.name)
                })

                return { success: true, entries: directoryEntries }
            } finally {
                await directory.close()
            }
        } catch (error) {
            logger.debug('Failed to list directory:', error)
            return rpcError(getErrorMessage(error, 'Failed to list directory'))
        }
    })

    rpcHandlerManager.registerHandler<StatFilesRequest, StatFilesResponse>(RPC_METHODS.StatFiles, async (data) => {
        if (!Array.isArray(data.paths) || data.paths.length > 500) {
            return rpcError('Invalid file paths')
        }

        for (const path of data.paths) {
            const validation = validatePath(path, workingDirectory)
            if (!validation.valid) {
                return rpcError(validation.error ?? 'Invalid file path')
            }
        }

        const entries = await Promise.all(data.paths.map(async (path) => {
            try {
                // A symlink escaping the working directory is reported like a missing file.
                const contained = await resolveContainedPath(path, workingDirectory)
                if (!contained.valid) {
                    return { path }
                }
                const parent = await openContainedParent(contained.realPath, workingDirectory)
                const stats = await parent.stat().finally(() => parent.close())
                return {
                    path,
                    size: stats.size,
                    modified: stats.mtime.getTime()
                }
            } catch (error) {
                logger.debug(`Failed to stat ${path}:`, error)
                return { path }
            }
        }))

        return { success: true, entries }
    })

    rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>(RPC_METHODS.GetDirectoryTree, async (data) => {
        logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth)

        const targetPath = data.path || '.'

        const validation = await resolveContainedPath(targetPath, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error)
        }

        const resolvedRoot = validation.path

        // Keep lexical display paths, but resolve every child through a held
        // directory descriptor so an exchanged ancestor cannot redirect I/O.
        async function buildTree(fsPath: string, path: string, name: string, currentDepth: number, parent?: FileHandle): Promise<TreeNode | null> {
            let directory: FileHandle | undefined
            try {
                let stats
                if (parent) {
                    stats = await lstat(directoryChildPath(parent, name, fsPath))
                    if (stats.isSymbolicLink()) return null
                    if (stats.isDirectory()) {
                        directory = await openDirectoryChild(parent, name, fsPath)
                        stats = await directory.stat()
                    }
                } else {
                    const target = await openContainedParent(fsPath, workingDirectory)
                    try {
                        stats = await target.stat()
                        if (stats.isSymbolicLink()) return null
                        if (stats.isDirectory()) {
                            directory = await openContainedDirectory(fsPath, workingDirectory)
                            stats = await directory.stat()
                        }
                    } finally {
                        await target.close()
                    }
                }

                const node: TreeNode = {
                    name,
                    path,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.getTime()
                }

                if (directory && currentDepth < data.maxDepth) {
                    const entries = await readdir(process.platform === 'linux' ? descriptorPath(directory) : fsPath, { withFileTypes: true })
                    const children: TreeNode[] = []

                    await Promise.all(
                        entries.map(async (entry) => {
                            if (entry.isSymbolicLink()) {
                                logger.debug(`Skipping symlink: ${join(path, entry.name)}`)
                                return
                            }

                            const childNode = await buildTree(join(fsPath, entry.name), join(path, entry.name), entry.name, currentDepth + 1, directory)
                            if (childNode) {
                                children.push(childNode)
                            }
                        })
                    )

                    children.sort((a, b) => {
                        if (a.type === 'directory' && b.type !== 'directory') return -1
                        if (a.type !== 'directory' && b.type === 'directory') return 1
                        return a.name.localeCompare(b.name)
                    })

                    node.children = children
                }

                return node
            } catch (error) {
                logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error))
                return null
            } finally {
                await directory?.close()
            }
        }

        try {
            if (data.maxDepth < 0) {
                return rpcError('maxDepth must be non-negative')
            }

            const baseName = resolvedRoot === '/' ? '/' : basename(resolvedRoot) || resolvedRoot
            const tree = await buildTree(validation.realPath, resolvedRoot, baseName, 0)

            if (!tree) {
                return rpcError('Failed to access the specified path')
            }

            return { success: true, tree }
        } catch (error) {
            logger.debug('Failed to get directory tree:', error)
            return rpcError(getErrorMessage(error, 'Failed to get directory tree'))
        }
    })
}
