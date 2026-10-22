import { logger } from '@/ui/logger'
import { constants } from 'fs'
import { open, type FileHandle } from 'fs/promises'
import { createHash } from 'crypto'
import type { FileReadResponse, GeneratedImageResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { resolveContainedPath } from '../pathSecurity'
import { openContainedParent } from '../anchoredPaths'
import { getGeneratedImage } from '../generatedImages'
import { getErrorMessage, rpcError } from '../rpcResponses'

// Refuse a changed final component and never block on FIFOs/devices. On Linux,
// openContainedParent also holds every ancestor against a concurrent swap.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

async function requireRegularFile(handle: FileHandle) {
    const stats = await handle.stat()
    if (!stats.isFile()) {
        throw new Error('Not a regular file')
    }
    return stats
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
    let offset = 0
    while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset)
        offset += bytesWritten
    }
}

interface ReadFileRequest {
    path: string
}

type ReadFileResponse = FileReadResponse

interface ReadGeneratedImageRequest {
    id: string
}

type ReadGeneratedImageResponse = GeneratedImageResponse

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

interface WriteFileResponse {
    success: boolean
    hash?: string
    error?: string
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.ReadFile, async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = await resolveContainedPath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error)
        }

        try {
            const parent = await openContainedParent(validation.realPath, workingDirectory)
            try {
                // Read metadata and content from one handle so both describe the same file.
                const handle = await open(parent.path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
                try {
                    const stats = await requireRegularFile(handle)
                    const buffer = await handle.readFile()
                    return {
                        success: true,
                        content: buffer.toString('base64'),
                        size: stats.size,
                        modified: stats.mtime.getTime()
                    }
                } finally {
                    await handle.close()
                }
            } finally {
                await parent.close()
            }
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedImageRequest, ReadGeneratedImageResponse>(RPC_METHODS.ReadGeneratedImage, async (data) => {
        logger.debug('Read generated image request:', data.id)

        const image = getGeneratedImage(data.id)
        if (!image) {
            return rpcError('Generated image not found')
        }

        try {
            return {
                success: true,
                content: image.content.toString('base64'),
                mimeType: image.mimeType,
                fileName: image.fileName
            }
        } catch (error) {
            logger.debug('Failed to read generated image:', error)
            return rpcError(getErrorMessage(error, 'Failed to read generated image'))
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>(RPC_METHODS.WriteFile, async (data) => {
        logger.debug('Write file request:', data.path)

        const validation = await resolveContainedPath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error)
        }
        const buffer = Buffer.from(data.content, 'base64')

        try {
            const parent = await openContainedParent(validation.realPath, workingDirectory)
            try {
                if (data.expectedHash === null || data.expectedHash === undefined) {
                    let handle: FileHandle
                    try {
                        // O_EXCL never follows a symlink and fails if anything appeared meanwhile.
                        handle = await open(parent.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o666)
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                            return rpcError('File already exists but was expected to be new')
                        }
                        throw error
                    }
                    try {
                        await writeAll(handle, buffer)
                    } finally {
                        await handle.close()
                    }
                } else {
                    let handle: FileHandle
                    try {
                        handle = await open(parent.path, constants.O_RDWR | NOFOLLOW | NONBLOCK)
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                            return rpcError('File does not exist but hash was provided')
                        }
                        throw error
                    }
                    try {
                        // Hash check and overwrite use the same handle, i.e. the same file.
                        await requireRegularFile(handle)
                        const existingHash = createHash('sha256').update(await handle.readFile()).digest('hex')
                        if (existingHash !== data.expectedHash) {
                            return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                        }
                        await handle.truncate(0)
                        await writeAll(handle, buffer)
                    } finally {
                        await handle.close()
                    }
                }

                const hash = createHash('sha256').update(buffer).digest('hex')

                return { success: true, hash }
            } finally {
                await parent.close()
            }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
