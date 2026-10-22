import { constants } from 'fs'
import { lstat, open, realpath, type FileHandle } from 'fs/promises'
import type { Stats } from 'fs'
import { isAbsolute, relative, sep } from 'path'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const DIRECTORY = constants.O_DIRECTORY ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

export function descriptorPath(handle: FileHandle): string {
    return `/proc/self/fd/${handle.fd}`
}

export function childPath(parent: FileHandle, name: string): string {
    // Linux treats backslash as an ordinary filename character. Only NUL and
    // the actual path separator can change which component this fd addresses.
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        throw new Error('Invalid path component')
    }
    return `${descriptorPath(parent)}/${name}`
}

export interface AnchoredParent {
    path: string
    isRoot: boolean
    stat(): Promise<Stats>
    close(): Promise<void>
}

/**
 * Bind every ancestor to a directory descriptor before using the validated
 * canonical path. O_NOFOLLOW on the leaf alone cannot stop a parent directory
 * being exchanged for a symlink between validation and I/O.
 */
export async function openContainedParent(realPath: string, workingDirectory: string): Promise<AnchoredParent> {
    const root = await realpath(workingDirectory)
    const suffix = relative(root, realPath)
    if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
        throw new Error('Access denied: path is outside the working directory')
    }

    // Node does not expose openat(2). Linux procfs paths keep the opened parent
    // inode as the anchor. Other platforms retain the existing canonical-path
    // behaviour until they have an equivalent native descriptor-relative API.
    if (process.platform !== 'linux') {
        return { path: realPath, isRoot: !suffix, stat: () => lstat(realPath), async close() {} }
    }

    let parent: FileHandle | undefined
    try {
        parent = await open(root, constants.O_RDONLY | DIRECTORY | NOFOLLOW | NONBLOCK)
        if (!(await parent.stat()).isDirectory() || await realpath(descriptorPath(parent)) !== root) {
            throw new Error('Working directory changed during path validation')
        }

        const components = suffix ? suffix.split(sep) : []
        for (const component of components.slice(0, -1)) {
            const next = await open(childPath(parent, component), constants.O_RDONLY | DIRECTORY | NOFOLLOW | NONBLOCK)
            await parent.close()
            parent = next
            if (!(await parent.stat()).isDirectory()) throw new Error('Not a directory')
        }

        const leaf = components.at(-1)
        const path = leaf ? childPath(parent, leaf) : descriptorPath(parent)
        const heldParent = parent
        parent = undefined
        return {
            path,
            isRoot: !leaf,
            stat: () => leaf ? lstat(path) : heldParent.stat(),
            close: () => heldParent.close()
        }
    } finally {
        await parent?.close()
    }
}

/** Open a checked directory inode for descriptor-relative readdir/lstat. */
export async function openContainedDirectory(realPath: string, workingDirectory: string): Promise<FileHandle> {
    const parent = await openContainedParent(realPath, workingDirectory)
    try {
        const directory = await open(parent.path, constants.O_RDONLY | DIRECTORY | (parent.isRoot ? 0 : NOFOLLOW) | NONBLOCK)
        if (!(await directory.stat()).isDirectory()) {
            await directory.close()
            throw new Error('Not a directory')
        }
        return directory
    } finally {
        await parent.close()
    }
}

/** Non-Linux callers use a direct canonical child path; Linux callers use a held fd. */
export function directoryChildPath(parent: FileHandle, name: string, fallbackPath: string): string {
    return process.platform === 'linux' ? childPath(parent, name) : fallbackPath
}

export async function openDirectoryChild(parent: FileHandle, name: string, fallbackPath: string): Promise<FileHandle> {
    return open(directoryChildPath(parent, name, fallbackPath), constants.O_RDONLY | DIRECTORY | NOFOLLOW | NONBLOCK)
}
