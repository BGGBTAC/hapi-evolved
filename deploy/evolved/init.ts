import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const SOURCE_ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
export const STATE_DIRECTORIES = ['hub', 'vault', 'memory', 'codegraph', 'neo4j', 'neo4j-logs', 'workspaces', 'managed-workspaces', 'credentials', 'credentials/hub', 'credentials/vault', 'credentials/memory', 'credentials/codegraph', 'credentials/neo4j'] as const
export const CREDENTIAL_FILES = ['hub/vault-signing.pem', 'hub/service.token', 'hub/runner-control.key', 'vault/hub-public.pem', 'vault/master.key', 'vault/actions.json', 'memory/service.token', 'memory/neo4j.password', 'memory/provider.key', 'codegraph/service.token', 'neo4j/auth'] as const

function inside(path: string, parent: string): boolean {
    const part = relative(parent, path)
    return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

/**
 * State is an explicit local operator CLI argument, not remote request data.
 * This unprivileged initializer intentionally allows operator-selected locations
 * outside HOME; it does not grant filesystem access beyond the invoking UID.
 * Check the actual source root, irrespective of the caller's current directory.
 */
export function checkStatePath(directory: string): void {
    if (!isAbsolute(directory) || resolve(directory) !== directory || !/^\/[A-Za-z0-9_./-]+$/.test(directory)
        || inside(directory, SOURCE_ROOT) || inside(SOURCE_ROOT, directory)) {
        throw new Error('State requires a separate absolute path outside the source tree, without spaces, links or Compose interpolation.')
    }
    for (let path = directory; ; path = dirname(path)) {
        try {
            const info = lstatSync(path)
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('State ancestors must be real directories, not symbolic links.')
            const trustedOwner = info.uid === 0 || info.uid === process.getuid?.()
            const protectedSharedParent = info.uid === 0 && (info.mode & 0o1000) !== 0
            if (!trustedOwner || ((info.mode & 0o022) !== 0 && !protectedSharedParent)) {
                throw new Error('State ancestors must belong to root or the invoking user and must not be group/world writable, except root-owned sticky directories such as /tmp.')
            }
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (path === dirname(path)) break
    }
}

export function checkPrivateMetadata(path: string, directory: boolean): void {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
        || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600)) {
        throw new Error('State requires service-owned private directories (0700) and regular private files (0600), without links.')
    }
}

export function checkInitializedState(state: string): void {
    checkStatePath(state)
    checkPrivateMetadata(state, true)
    for (const name of STATE_DIRECTORIES) checkPrivateMetadata(join(state, name), true)
    for (const name of CREDENTIAL_FILES) checkPrivateMetadata(join(state, 'credentials', name), false)
    checkPrivateMetadata(join(state, 'compose.env'), false)
}

export function validateOrigin(origin: string, port: number): string {
    let value: URL
    try { value = new URL(origin) } catch { throw new Error('Origin must be an HTTPS origin, or HTTP localhost for a local test.') }
    if (value.origin !== origin || value.username || value.password || value.pathname !== '/' || value.search || value.hash
        || (value.protocol !== 'https:' && !(value.protocol === 'http:' && value.hostname === 'localhost' && Number(value.port || 80) === port))) {
        throw new Error('Origin must be an HTTPS origin, or HTTP localhost matching the local port; no path or credentials.')
    }
    return origin
}

function createPrivateFile(path: string, value: Uint8Array | string): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, value) } finally { closeSync(fd) }
}

function createPrivateDirectory(path: string): void {
    // Never silently adopt a directory created by a competing local process.
    checkStatePath(path)
    mkdirSync(path, { mode: 0o700 })
    checkPrivateMetadata(path, true)
}

export function initializeState(directory: string, options: { origin?: string; port?: number } = {}): { state: string; created: boolean } {
    if (!process.getuid?.() || !process.getgid?.()) throw new Error('Initialize as the unprivileged service user, not root. Host-control setup is a separate operator task.')
    checkStatePath(directory)
    const port = options.port ?? 3006
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Use an unprivileged port between 1024 and 65535.')
    const origin = validateOrigin(options.origin ?? `http://localhost:${port}`, port)
    if (existsSync(directory)) {
        checkPrivateMetadata(directory, true)
        if (readdirSync(directory).length) {
            checkInitializedState(directory)
            // Do not read, recreate or rotate credentials in an existing installation.
            return { state: directory, created: false }
        }
    } else {
        const missing: string[] = []
        for (let path = directory; !existsSync(path); path = dirname(path)) missing.unshift(path)
        for (const path of missing) createPrivateDirectory(path)
    }
    const state = realpathSync(directory)
    if (state !== directory) throw new Error('State directory changed during initialization.')
    checkStatePath(state)
    checkPrivateMetadata(state, true)
    for (const name of STATE_DIRECTORIES) createPrivateDirectory(join(state, name))
    const hubKeys = join(state, 'credentials/hub'), vaultKeys = join(state, 'credentials/vault')
    const pair = generateKeyPairSync('ed25519')
    createPrivateFile(join(hubKeys, 'vault-signing.pem'), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
    createPrivateFile(join(vaultKeys, 'hub-public.pem'), pair.publicKey.export({ format: 'pem', type: 'spki' }))
    const master = randomBytes(32), control = randomBytes(32)
    const serviceToken = Buffer.from(randomBytes(32).toString('base64url'))
    const neoPassword = Buffer.from(randomBytes(32).toString('base64url'))
    try {
        createPrivateFile(join(vaultKeys, 'master.key'), master)
        createPrivateFile(join(hubKeys, 'runner-control.key'), control)
        for (const name of ['hub', 'memory', 'codegraph']) createPrivateFile(join(state, 'credentials', name, 'service.token'), serviceToken)
        createPrivateFile(join(state, 'credentials/memory/neo4j.password'), neoPassword)
        createPrivateFile(join(state, 'credentials/neo4j/auth'), `neo4j/${neoPassword.toString('utf8')}`)
    } finally { master.fill(0); control.fill(0); serviceToken.fill(0); neoPassword.fill(0) }
    // Empty means paused: provisioning activates neither a provider nor a budget.
    createPrivateFile(join(state, 'credentials/memory/provider.key'), '')
    createPrivateFile(join(vaultKeys, 'actions.json'), '[]\n')
    const configuration = `EVOLVED_STATE_DIR=${state}\nEVOLVED_UID=${process.getuid!()}\nEVOLVED_GID=${process.getgid!()}\nEVOLVED_ORIGIN=${origin}\nEVOLVED_LISTEN_PORT=${port}\n`
    writeFileSync(join(state, 'compose.env'), configuration, { flag: 'wx', mode: 0o600 })
    checkInitializedState(state)
    return { state, created: true }
}

if (import.meta.main) {
    try {
        const result = initializeState(resolve(process.argv[2] ?? join(homedir(), '.local/share/hapi-evolved')))
        console.log(`Private state ${result.created ? 'initialized' : 'preserved'}: ${result.state}`)
        console.log(`Configuration: ${join(result.state, 'compose.env')}`)
        console.log('No credentials were printed. Choose the final private HTTPS origin before enrolling a passkey.')
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Initialization failed; existing files were preserved.')
        process.exitCode = 1
    }
}
