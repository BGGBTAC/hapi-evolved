import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, rmdirSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { EvolvedError } from './store'

export function containsWorkspace(parent: string, child: string): boolean {
    const rel = relative(parent, child)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
export function workspacesOverlap(first: string, second: string): boolean {
    return containsWorkspace(first, second) || containsWorkspace(second, first)
}
/** Detect direct bind aliases too. Nested mounts are rejected separately before attaching a workspace. */
export function workspaceBindingsOverlap(first: string, second: string): boolean {
    if (workspacesOverlap(first, second)) return true
    const identity = (path: string) => { try { const st = lstatSync(path); return st.isDirectory() ? `${st.dev}:${st.ino}` : null } catch { return null } }
    const ancestorHas = (path: string, target: string | null) => {
        if (!target) return false
        for (let current = path; ; current = dirname(current)) {
            if (identity(current) === target) return true
            if (dirname(current) === current) return false
        }
    }
    return ancestorHas(first, identity(second)) || ancestorHas(second, identity(first))
}
export function hasNestedWorkspaceMount(path: string, mountInfo: string): boolean {
    return mountInfo.split('\n').some(line => {
        // mountinfo escapes spaces, tabs, newlines and backslashes in the mount point.
        const point = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)))
        return !!point && point !== path && containsWorkspace(path, point)
    })
}
function workspaceMountInfo(): string {
    if (process.platform !== 'linux') return ''
    try {
        const value = readFileSync('/proc/self/mountinfo', 'utf8')
        if (value.length > 4 * 1024 * 1024) throw new Error('Mount table too large')
        return value
    } catch { throw new EvolvedError('workspace_mounts_unavailable', 'Workspace mount isolation could not be checked.', 503) }
}
export function assertWorkspaceMountIsolation(path: string): void {
    if (hasNestedWorkspaceMount(path, workspaceMountInfo())) throw new EvolvedError('workspace_nested_mount', 'A project directory must not contain nested filesystem mounts.', 403)
}
export function assertManagedWorkspaceSeparation(managedRoot: string, dataDir: string, databaseFile: string, bootstrapFile: string, credentialFiles: string[]): void {
    const canonicalLocation = (path: string) => {
        let current = resolve(path)
        const suffix: string[] = []
        for (;;) {
            try { return join(realpathSync(current), ...suffix) } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error
                suffix.unshift(basename(current)); current = dirname(current)
            }
        }
    }
    const root = canonicalLocation(managedRoot), state = canonicalLocation(dataDir)
    const dedicatedChild = ['project-workspaces', 'managed-workspaces'].includes(relative(state, root))
    // The dedicated default child is intentional. Other state directories are not project roots.
    if (workspaceBindingsOverlap(root, state) && !dedicatedChild) throw new EvolvedError('workspace_state_overlap', 'Managed workspace root must be outside operator state, or its dedicated project-workspaces/managed-workspaces directory.', 500)
    for (const file of [databaseFile, bootstrapFile, ...credentialFiles]) {
        if (containsWorkspace(root, canonicalLocation(file))) throw new EvolvedError('workspace_state_overlap', 'Managed workspace root must not contain operator credentials or databases.', 500)
    }
    for (const file of credentialFiles) {
        const parent = dirname(canonicalLocation(file))
        if (parent !== state && workspaceBindingsOverlap(root, parent)) throw new EvolvedError('workspace_state_overlap', 'Managed workspace root must be separate from credential directories.', 500)
    }
}
export function existingWorkspace(path: string): string {
    if (!isAbsolute(path) || path.includes('\0') || path.split(sep).some(part => part === '.' || part === '..')) {
        throw new EvolvedError('invalid_workspace', 'Workspace must be an absolute directory without traversal.')
    }
    try {
        const actual = realpathSync(path)
        if (actual !== resolve(path) || !lstatSync(path).isDirectory()) throw new Error('Not a canonical directory')
        return actual
    } catch { throw new EvolvedError('invalid_workspace', 'Workspace must be an existing directory without symbolic links.') }
}
export function canonicalWorkspace(path: string, allowedRoots: string[]): string {
    if (!path) return ''
    const actual = existingWorkspace(path)
    const allowed = allowedRoots.some(root => {
        try {
            const parent = existingWorkspace(root)
            return containsWorkspace(parent, actual) && !relative(parent, actual).split(sep).some(hiddenFolder)
        } catch { return false }
    })
    if (!allowed) throw new EvolvedError('workspace_forbidden', 'Workspace is outside configured workspace roots or inside a protected directory.', 403)
    return actual
}

/** Only this private parent is writable by the hub; runners receive a single child mount. */
export function openManagedWorkspaceRoot(path: string): { path: string; fd: number; info: Stats } {
    if (!isAbsolute(path) || path.split(sep).some(part => part === '.' || part === '..')) throw new EvolvedError('invalid_workspace_root', 'Managed workspace root must be absolute without traversal.', 500)
    let current = parse(path).root
    for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part)
        try { mkdirSync(current, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        // Validate each parent before creating anything below it.
        existingWorkspace(current)
    }
    const actual = existingWorkspace(path)
    assertWorkspaceMountIsolation(actual)
    const fd = openSync(actual, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const info = fstatSync(fd)
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
        closeSync(fd)
        throw new EvolvedError('insecure_workspace_root', 'Managed workspace root must be private and owned by the hub service.', 500)
    }
    return { path: actual, fd, info }
}
function sameDirectory(path: string, info: Stats): boolean {
    try { const now = lstatSync(path); return now.isDirectory() && now.dev === info.dev && now.ino === info.ino } catch { return false }
}
export function allocateWorkspace(root: ReturnType<typeof openManagedWorkspaceRoot>, projectId: string): { path: string; rollback: () => void } {
    if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new EvolvedError('invalid_project_id', 'Invalid project identifier.', 500)
    if (!sameDirectory(root.path, root.info)) throw new EvolvedError('workspace_changed', 'Managed workspace root changed.', 409)
    const path = join(root.path, projectId)
    const anchored = process.platform === 'linux' ? `/proc/self/fd/${root.fd}/${projectId}` : path
    // No recursive mkdir: even an empty pre-existing directory belongs to someone else.
    mkdirSync(anchored, { mode: 0o700 })
    const info = lstatSync(anchored)
    const rollback = () => {
        // Never remove substituted paths or contents, including after a failed DB transaction.
        if (!sameDirectory(root.path, root.info) || !sameDirectory(anchored, info)) return
        try { rmdirSync(anchored) } catch { /* Nonempty or changed: retain it for operator inspection. */ }
    }
    if (!sameDirectory(root.path, root.info) || !info.isDirectory() || existingWorkspace(path) !== path) {
        rollback(); throw new EvolvedError('workspace_changed', 'Workspace changed during creation.', 409)
    }
    return { path, rollback }
}

type Folder = { path: string; name: string; selectable: boolean }
const hiddenFolder = (name: string) => name.startsWith('.') || ['credentials', 'secrets', 'node_modules'].includes(name.toLowerCase())
export function browseWorkspaces(input: { roots: string[]; managedRoot: string; boundPaths: string[]; path?: string; limit: number; offset: number }): { roots: Folder[]; path: string | null; directories: Folder[]; hasMore: boolean; nextOffset?: number } {
    const { managedRoot, boundPaths } = input
    const mounts = workspaceMountInfo()
    const bound = (path: string) => boundPaths.some(other => containsWorkspace(other, path)) || containsWorkspace(managedRoot, path)
    const folder = (path: string): Folder => ({ path, name: basename(path) || path, selectable: !hasNestedWorkspaceMount(path, mounts) && !boundPaths.some(other => workspaceBindingsOverlap(other, path)) && !workspaceBindingsOverlap(managedRoot, path) })
    const roots = [...new Set(input.roots.flatMap(root => { try { return [existingWorkspace(root)] } catch { return [] } }))].filter(root => !bound(root)).map(folder)
    if (!input.path) return { roots, path: null, directories: [], hasMore: false }
    const path = canonicalWorkspace(input.path, roots.map(root => root.path))
    if (bound(path)) throw new EvolvedError('workspace_conflict', 'This directory is already assigned or managed automatically.', 409)
    const allowedParent = roots.find(root => containsWorkspace(root.path, path))!
    if (relative(allowedParent.path, path).split(sep).some(hiddenFolder)) throw new EvolvedError('workspace_forbidden', 'This directory cannot be browsed.', 403)
    const directory = opendirSync(path), directories: Folder[] = []
    try {
        let scanned = 0
        while (scanned < input.offset) { if (!directory.readSync()) return { roots, path, directories, hasMore: false }; scanned++ }
        for (let n = 0; n < input.limit; n++) {
            const entry = directory.readSync()
            if (!entry) return { roots, path, directories, hasMore: false }
            scanned++
            if (!entry.isDirectory() || entry.isSymbolicLink() || hiddenFolder(entry.name)) continue
            const child = join(path, entry.name)
            try { if (existingWorkspace(child) === child && !bound(child)) directories.push(folder(child)) } catch { /* Concurrent change: omit. */ }
        }
        const hasMore = scanned < 10_000 && directory.readSync() !== null
        return { roots, path, directories, hasMore, ...(hasMore ? { nextOffset: scanned } : {}) }
    } finally { directory.closeSync() }
}
