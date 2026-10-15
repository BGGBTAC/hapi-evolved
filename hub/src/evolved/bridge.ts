import { Hono, type MiddlewareHandler } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import { dirname, isAbsolute, relative } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import { EvolvedError, EvolvedStore, hashToken, type EvolvedPrincipal, type EvolvedProject } from './store'
import { cookieToken } from './security'
import { existingWorkspace } from './workspaces'
import type { WebAppEnv } from '../web/middleware/auth'
import type { PermissionMode } from '@hapi/protocol'

const AUDIENCE = 'hapi-evolved-web'
export type EvolvedAccess = { principal: EvolvedPrincipal; project: EvolvedProject; userId: number; valid: () => boolean }

/** Stable distinct legacy numeric IDs; an account name is never an identity. */
function legacyUserId(store: EvolvedStore, id: string): number {
    store.db.exec('CREATE TABLE IF NOT EXISTS evolved_web_ids(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL UNIQUE REFERENCES evolved_users(id) ON DELETE CASCADE)')
    store.db.prepare('INSERT OR IGNORE INTO evolved_web_ids(user_id) VALUES(?)').run(id)
    return (store.db.prepare('SELECT id FROM evolved_web_ids WHERE user_id=?').get(id) as { id: number }).id
}

export async function verifyProjectToken(token: string, secret: Uint8Array, store: EvolvedStore, write = false): Promise<EvolvedAccess> {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], audience: AUDIENCE, issuer: 'hapi-evolved' })
    const { esid, pid, sub, exp } = payload
    if (typeof esid !== 'string' || typeof pid !== 'string' || typeof sub !== 'string' || typeof exp !== 'number') throw new EvolvedError('unauthorized', 'Invalid project token.', 401)
    const resolve = () => {
        if (exp * 1000 <= store.now()) throw new EvolvedError('unauthorized', 'Project token expired.', 401)
        const principal = store.getSessionByHash(esid)
        if (!principal || principal.user.id !== sub) throw new EvolvedError('unauthorized', 'Session revoked.', 401)
        const project = store.requireProject(sub, pid, write ? 'member' : 'viewer')
        return { principal, project }
    }
    const { principal, project } = resolve()
    return { principal, project, userId: legacyUserId(store, sub), valid: () => {
        try {
            const live = resolve().project
            return live.profile === project.profile && live.rootPath === project.rootPath && live.namespace === project.namespace
        } catch { return false }
    } }
}

export function authenticateRunner(token: string, store: EvolvedStore): EvolvedAccess | null {
    const principal = store.capability(token)
    const cap = principal?.capability
    if (!principal || !cap || !cap.scopes.includes('runner:connect')) return null
    const project = principal.accessibleProjects.find(p => p.id === cap.projectId && p.role !== 'viewer')
    if (!project) return null
    return { principal, project, userId: legacyUserId(store, principal.user.id), valid: () => !!authenticateRunner(token, store) }
}

export function createSessionTokenRoutes(store: EvolvedStore, secret: Uint8Array, origin: string): Hono {
    const app = new Hono()
    app.get('/session-token', async c => {
        const incomingOrigin = c.req.header('origin')
        if (incomingOrigin && incomingOrigin !== origin) return c.json({ error: 'Origin denied.' }, 403)
        const cookie = cookieToken(c.req.raw)
        const principal = cookie ? store.session(cookie) : null
        if (!principal || !cookie) return c.json({ error: 'Sign in required.' }, 401)
        const projectId = c.req.query('projectId') ?? ''
        try {
            const project = store.requireProject(principal.user.id, projectId)
            const userId = legacyUserId(store, principal.user.id)
            const token = await new SignJWT({ uid: userId, ns: project.namespace, pid: project.id, esid: hashToken(cookie) })
                .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(principal.user.id)
                .setAudience(AUDIENCE).setIssuer('hapi-evolved').setIssuedAt().setExpirationTime('5m').sign(secret)
            c.header('Cache-Control', 'no-store')
            return c.json({ token, expiresIn: 300, user: { id: userId, firstName: principal.user.displayName }, projectId })
        } catch { return c.json({ error: 'Project access denied.' }, 403) }
    })
    return app
}

export function withinProject(project: EvolvedProject, path: string, allowMissing = false): boolean {
    if (!project.rootPath || !isAbsolute(path)) return false
    try {
        let existing = path
        if (allowMissing) {
            // Resolve the nearest existing ancestor; broken/outside links must never
            // become a way to check arbitrary host paths through a runner.
            while (true) {
                try { lstatSync(existing); break } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) throw error
                    existing = dirname(existing)
                }
            }
        }
        const rel = relative(realpathSync(project.rootPath), realpathSync(existing))
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    } catch { return false }
}

export function permissionAllowed(project: EvolvedProject, mode: unknown): boolean {
    if (mode === undefined) return true
    if (project.profile === 'extended') return true
    const allowed = project.profile === 'workspace'
        ? ['default', 'plan', 'read-only', 'acceptEdits', 'auto']
        : ['plan', 'read-only']
    return typeof mode === 'string' && allowed.includes(mode)
}

export function projectPermissionMode(project: EvolvedProject, agent: string | null = 'claude', mode?: PermissionMode): PermissionMode | undefined {
    if (!permissionAllowed(project, mode)) throw new EvolvedError('profile_denied', 'Project profile forbids this permission mode.', 403)
    if (mode !== undefined || project.profile === 'extended') return mode
    return project.profile === 'restricted' ? agent === 'codex' ? 'read-only' : 'plan'
        : agent === 'codex' ? 'default' : 'acceptEdits'
}

/** A fresh browser session starts at its persisted project root, never a client path. */
export function projectSpawnDirectory(project: EvolvedProject, directory: unknown, sessionType?: unknown, worktreeName?: unknown): string {
    let root: string
    try {
        root = existingWorkspace(project.rootPath)
    } catch {
        throw new EvolvedError('project_root_unavailable', 'The saved project directory is unavailable or changed. Ask the installation administrator to check it.', 409)
    }
    if (sessionType === 'worktree' || worktreeName !== undefined) {
        // The inherited runner creates sibling worktrees, outside the single project mount.
        throw new EvolvedError('project_worktree_unavailable', 'New project sessions must use the project directory. Worktree creation is not available in Evolved.', 400)
    }
    if (directory === undefined || (typeof directory === 'string' && directory.trim() === '')) return root
    if (typeof directory !== 'string') throw new EvolvedError('invalid_directory', 'Directory must be a string.', 400)
    let requested: string | undefined
    try { requested = existingWorkspace(directory.trim()) } catch { /* All invalid client paths are denied. */ }
    if (requested !== root) {
        throw new EvolvedError('project_directory_mismatch', 'New sessions must start in the saved project directory.', 403)
    }
    return root
}

export function createProjectAuthMiddleware(store: EvolvedStore, secret: Uint8Array, origin: string): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        const readPost = c.req.method === 'POST' && (path === '/api/visibility' || path === '/api/sessions/content-search')
        const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !readPost
        const bearer = c.req.header('authorization')?.replace(/^Bearer /, '')
        const token = bearer ?? (path === '/api/events' ? c.req.query('token') : undefined)
        if (!token) return c.json({ error: 'Sign in required.' }, 401)
        let access: EvolvedAccess
        try { access = await verifyProjectToken(token, secret, store, write) }
        catch { return c.json({ error: 'Session or project access expired.' }, 401) }
        const headerProject = c.req.header('x-hapi-project-id')
        if (headerProject && headerProject !== access.project.id) return c.json({ error: 'Project scope mismatch.' }, 403)
        if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== origin) return c.json({ error: 'Origin denied.' }, 403)
        // These upstream endpoints expose host-global credentials/files or unsupported agents.
        if (/^\/api\/(auth|bind|storage|hub-settings|voice|codex|claude|cursor|pi)(\/|$)/.test(path)
            || /^\/api\/machines\/[^/]+\/(?:claude|cursor|codex|pi)-(?:sessions|import|discover)/.test(path)) return c.json({ error: 'Endpoint unavailable in Evolved.' }, 403)
        if (write && access.project.profile === 'restricted' && /\/codex\/plan\/implement$/.test(path)) return c.json({ error: 'Read-only projects cannot execute plans.' }, 403)
        if (write && /\/machines\/[^/]+\/(list-directory|paths\/exists)$/.test(path)) {
            const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
            const paths = path.endsWith('/list-directory') ? [body?.path] : body?.paths
            if (!Array.isArray(paths) || !paths.every(value => typeof value === 'string' && withinProject(access.project, value.trim(), true))) return c.json({ error: 'Path is outside this project.' }, 403)
        }
        if (write && /\/(spawn|permission-mode|approve)$/.test(path)) {
            const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
            if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid body.' }, 400)
            if (!permissionAllowed(access.project, body.mode) || !permissionAllowed(access.project, body.permissionMode) || (body.yolo === true && access.project.profile !== 'extended')) return c.json({ error: 'Project profile forbids this permission mode.' }, 403)
            if (path.endsWith('/spawn')) {
                if (body.agent !== undefined && !['claude', 'codex'].includes(String(body.agent))) return c.json({ error: 'v1 supports Claude and Codex.' }, 400)
                if (/^\/api\/machines\/[^/]+\/spawn$/.test(path)) {
                    try { projectSpawnDirectory(access.project, body.directory, body.sessionType, body.worktreeName) }
                    catch (error) {
                        if (error instanceof EvolvedError) return c.json({ error: error.message, code: error.code }, error.status as 400)
                        throw error
                    }
                } else if (typeof body.directory !== 'string' || !withinProject(access.project, body.directory)) {
                    return c.json({ error: 'Directory is outside this project.' }, 403)
                }
            }
        }
        c.set('userId', access.userId)
        c.set('namespace', access.project.namespace)
        c.set('evolvedAccess', access)
        c.set('isAuthorized', access.valid)
        return next()
    }
}
