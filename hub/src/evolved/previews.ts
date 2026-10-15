import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EvolvedError, EvolvedStore, hashToken, randomToken } from './store'
import { assertOrigin, authenticateEvolvedRequest, parseBody, requireFreshPasskey, requireHuman } from './security'

type PreviewRow = { id: string; project_id: string; name: string; directory: string; created_by: string; created_at: number }
type GrantRow = { id: string; preview_id: string; user_id: string; kind: 'view' | 'share'; expires_at: number; revoked_at: number | null; bytes_served: number }
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_GRANT_BYTES = 128 * 1024 * 1024
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }
function isWithin(parent: string, path: string): boolean { const rel = relative(parent, path); return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) }
function safePath(path: string): boolean {
    const parts = path.replace(/\\/g, '/').split('/')
    return !path.includes('\0') && !path.includes('\\') && !parts.some(p => p.startsWith('.') || p === 'node_modules' || /^(?:secrets?|credentials?|passwords?|tokens?|id_rsa|id_ed25519)(?:\.|$)/i.test(p) || /\.(?:pem|key|p12|pfx|sqlite|db|map)$/i.test(p))
}
function publicPreview(row: PreviewRow) { return { id: row.id, name: row.name, projectId: row.project_id, directory: row.directory, createdAt: row.created_at, openPath: `/api/evolved/previews/${row.id}/` } }

/** Mount before the authenticated fallback router: the two scoped asset routes authenticate their own opaque grants. */
export function createPreviewRoutes(config: { store: EvolvedStore; origin: string }): Hono {
    const { store } = config, app = new Hono()
    store.db.exec(`
        CREATE TABLE IF NOT EXISTS evolved_previews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES evolved_projects(id) ON DELETE CASCADE,name TEXT NOT NULL,directory TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS evolved_preview_grants(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,preview_id TEXT NOT NULL REFERENCES evolved_previews(id) ON DELETE CASCADE,user_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('view','share')),expires_at INTEGER NOT NULL,revoked_at INTEGER,bytes_served INTEGER NOT NULL DEFAULT 0);
    `)
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ error: error.message, code: error.code }, error.status as 400) : c.json({ error: 'Preview request failed.', code: 'preview_error' }, 500))
    const human = async (c: Context) => {
        assertOrigin(c.req.raw, config.origin)
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal)
        c.header('Cache-Control', 'no-store')
        return principal
    }
    const preview = (id: string): PreviewRow => {
        const row = store.db.prepare('SELECT * FROM evolved_previews WHERE id=?').get(id) as PreviewRow | null
        if (!row) throw new EvolvedError('not_found', 'Preview not found.', 404)
        return row
    }
    const grant = (row: PreviewRow, userId: string, kind: 'view' | 'share', ttl: number) => {
        store.db.prepare('DELETE FROM evolved_preview_grants WHERE expires_at<=?').run(store.now())
        const id = randomUUID(), token = randomToken(), expiresAt = store.now() + ttl * 1000
        store.db.prepare('INSERT INTO evolved_preview_grants VALUES(?,?,?,?,?,?,NULL,0)').run(id, hashToken(token), row.id, userId, kind, expiresAt)
        return { id, token, expiresAt, url: `${config.origin}/api/evolved/preview-${kind}/${token}/` }
    }
    app.get('/projects/:id/previews', async c => {
        const principal = await human(c); store.requireProject(principal.user.id, c.req.param('id'))
        const rows = store.db.prepare('SELECT * FROM evolved_previews WHERE project_id=? ORDER BY created_at DESC').all(c.req.param('id')) as PreviewRow[]
        return c.json({ previews: rows.map(publicPreview) })
    })
    app.post('/projects/:id/previews', bodyLimit({ maxSize: 16_384 }), async c => {
        const principal = await human(c); requireFreshPasskey(c, store, principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(120), directory: z.string().min(1).max(4096) }).strict())
        let directory: string
        try {
            if (!project.rootPath || !isAbsolute(body.directory)) throw new Error()
            directory = realpathSync(body.directory)
            if (!isWithin(realpathSync(project.rootPath), directory) || !statSync(directory).isDirectory() || !safePath(relative(project.rootPath, directory))) throw new Error()
        } catch { throw new EvolvedError('invalid_preview_directory', 'Preview must be a directory inside the configured project workspace.') }
        const id = randomUUID()
        store.db.prepare('INSERT INTO evolved_previews VALUES(?,?,?,?,?,?)').run(id, project.id, body.name, directory, principal.user.id, store.now())
        store.audit(principal.user.id, project.id, 'preview.created', id)
        return c.json({ preview: publicPreview(preview(id)) }, 201)
    })
    app.delete('/projects/:id/previews/:previewId', async c => {
        const principal = await human(c); requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        store.db.prepare('DELETE FROM evolved_previews WHERE id=? AND project_id=?').run(c.req.param('previewId'), c.req.param('id'))
        store.audit(principal.user.id, c.req.param('id'), 'preview.deleted', c.req.param('previewId'))
        return c.json({ ok: true })
    })
    app.get('/projects/:id/previews/:previewId/shares', async c => {
        const principal = await human(c); store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const row = preview(c.req.param('previewId'))
        if (row.project_id !== c.req.param('id')) throw new EvolvedError('not_found', 'Preview not found.', 404)
        return c.json({ shares: store.db.prepare("SELECT id,expires_at AS expiresAt,revoked_at AS revokedAt FROM evolved_preview_grants WHERE preview_id=? AND kind='share' ORDER BY expires_at DESC").all(row.id) })
    })
    app.post('/projects/:id/previews/:previewId/shares', bodyLimit({ maxSize: 16_384 }), async c => {
        const principal = await human(c); requireFreshPasskey(c, store, principal)
        store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const row = preview(c.req.param('previewId'))
        if (row.project_id !== c.req.param('id')) throw new EvolvedError('not_found', 'Preview not found.', 404)
        const body = await parseBody(c, z.object({ expiresInSeconds: z.number().int().min(60).max(86400).default(3600) }).strict())
        const created = grant(row, principal.user.id, 'share', body.expiresInSeconds)
        store.audit(principal.user.id, row.project_id, 'preview.shared', created.id)
        return c.json({ id: created.id, url: created.url, expiresAt: created.expiresAt }, 201)
    })
    app.delete('/projects/:id/previews/:previewId/shares/:shareId', async c => {
        const principal = await human(c); store.requireProject(principal.user.id, c.req.param('id'), 'admin')
        const row = preview(c.req.param('previewId'))
        if (row.project_id !== c.req.param('id')) throw new EvolvedError('not_found', 'Preview not found.', 404)
        store.db.prepare('UPDATE evolved_preview_grants SET revoked_at=? WHERE id=? AND preview_id=?').run(store.now(), c.req.param('shareId'), row.id)
        store.audit(principal.user.id, row.project_id, 'preview.share_revoked', c.req.param('shareId'))
        return c.json({ ok: true })
    })
    app.get('/previews/:previewId/', async c => {
        const principal = await human(c), row = preview(c.req.param('previewId'))
        store.requireProject(principal.user.id, row.project_id)
        return c.redirect(grant(row, principal.user.id, 'view', 600).url, 303)
    })
    async function serve(c: Context, kind: 'view' | 'share'): Promise<Response> {
        const token = c.req.param('token')
        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new EvolvedError('not_found', 'Preview unavailable.', 404)
        const access = store.db.prepare('SELECT * FROM evolved_preview_grants WHERE token_hash=? AND kind=? AND revoked_at IS NULL AND expires_at>?').get(hashToken(token), kind, store.now()) as GrantRow | null
        if (!access) throw new EvolvedError('not_found', 'Preview unavailable.', 404)
        const row = preview(access.preview_id), project = store.requireProject(access.user_id, row.project_id, kind === 'share' ? 'admin' : 'viewer')
        const prefix = `/preview-${kind}/${token}/`, pathname = new URL(c.req.url).pathname, start = pathname.indexOf(prefix)
        let requested: string
        try { requested = decodeURIComponent(pathname.slice(start + prefix.length)) } catch { throw new EvolvedError('invalid_path', 'Invalid preview path.') }
        if (!requested || requested.endsWith('/')) requested += 'index.html'
        if (start < 0 || !safePath(requested) || isAbsolute(requested) || !mime[extname(requested).toLowerCase()]) throw new EvolvedError('not_found', 'Preview file unavailable.', 404)
        let fd: number | undefined
        try {
            const root = realpathSync(row.directory), workspace = realpathSync(project.rootPath), candidate = resolve(root, requested)
            if (root !== row.directory || !isWithin(workspace, root) || !isWithin(root, candidate)) throw new Error()
            const canonical = realpathSync(candidate)
            if (!isWithin(root, canonical) || !safePath(relative(root, canonical))) throw new Error()
            fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
            const info = fstatSync(fd), openedPath = realpathSync(`/proc/self/fd/${fd}`)
            // Validate the opened object too: checking only a pathname leaves a rename/symlink race.
            if (!info.isFile() || info.nlink !== 1 || !isWithin(root, openedPath) || !safePath(relative(root, openedPath)) || info.size > MAX_FILE_BYTES) throw new Error()
            const buffer = Buffer.alloc(info.size + 1)
            let length = 0
            while (length < buffer.length) {
                const count = readSync(fd, buffer, length, buffer.length - length, null)
                if (!count) break
                length += count
            }
            if (length > info.size) throw new Error()
            const bytes = buffer.subarray(0, length)
            const reserved = store.db.prepare('UPDATE evolved_preview_grants SET bytes_served=bytes_served+? WHERE id=? AND bytes_served+?<=? AND revoked_at IS NULL AND expires_at>?').run(bytes.length, access.id, bytes.length, MAX_GRANT_BYTES, store.now())
            if (reserved.changes !== 1) throw new EvolvedError('preview_budget', 'Preview transfer limit reached.', 429)
            const base = `${config.origin}/api/evolved/preview-${kind}/${token}/`
            c.header('Content-Type', mime[extname(requested).toLowerCase()])
            c.header('Cache-Control', 'private, no-store')
            c.header('X-Content-Type-Options', 'nosniff')
            c.header('Referrer-Policy', 'no-referrer')
            c.header('Access-Control-Allow-Origin', '*') // Only the narrowly scoped static grant; never credentialed CORS.
            c.header('Access-Control-Allow-Credentials', undefined)
            c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(), publickey-credentials-create=()')
            c.header('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src data: blob: ${base}; font-src ${base}; media-src ${base}; connect-src ${base}; worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.origin}`)
            return c.body(new Uint8Array(bytes))
        } catch (error) {
            if (error instanceof EvolvedError) throw error
            throw new EvolvedError('not_found', 'Preview file unavailable.', 404)
        } finally { if (fd !== undefined) closeSync(fd) }
    }
    app.get('/preview-view/:token/*', c => serve(c, 'view'))
    app.get('/preview-share/:token/*', c => serve(c, 'share'))
    return app
}
