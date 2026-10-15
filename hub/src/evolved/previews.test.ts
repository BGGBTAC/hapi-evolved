import { afterEach, describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { EvolvedStore } from './store'
import { createPreviewRoutes } from './previews'
import { SESSION_COOKIE } from './security'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'evolved-previews-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = new EvolvedStore(':memory:'); cleanups.push(() => store.close())
    const userId = randomUUID(), outsider = randomUUID()
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,1,?)').run(userId, 'Admin', Date.now())
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(outsider, 'Other', Date.now())
    const team = store.createTeam(userId, 'Team'), root = join(dir, 'project'), output = join(root, 'dist')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'index.html'), '<!doctype html><script>window.preview=true</script><h1>Synthetic preview</h1>')
    writeFileSync(join(output, 'app.js'), 'window.loaded=true')
    writeFileSync(join(output, '.env'), 'SYNTHETIC_SECRET=never-serve')
    const project = store.createProject(userId, team.id, 'Project', root), origin = 'https://evolved.example.test'
    // Match the Hub's outer browser API middleware; static grants must remove its credential header.
    const app = new Hono().use('/api/*', cors({ origin, credentials: true })).route('/api/evolved', createPreviewRoutes({ store, origin }))
    const token = store.createSession(userId)
    const call = (path: string, body?: unknown, options: { method?: string; token?: string | null; origin?: string } = {}) => app.request(path.startsWith('https:') ? path : `${origin}/api/evolved${path}`, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { origin: options.origin ?? origin, 'content-type': 'application/json', ...(options.token === null ? {} : { cookie: `${SESSION_COOKIE}=${options.token ?? token}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const register = async () => {
        const response = await call(`/projects/${project.id}/previews`, { name: 'Build', directory: output })
        expect(response.status).toBe(201)
        return (await response.json() as { preview: { id: string; openPath: string } }).preview
    }
    return { dir, root, output, store, project, team, userId, outsider, origin, token, call, register }
}
describe('private static previews and explicit shares', () => {
    test('private open needs a session, then creates a bounded static-only ticket with an opaque sandbox', async () => {
        const f = fixture(), preview = await f.register()
        expect((await f.call(`/previews/${preview.id}/`, undefined, { token: null })).status).toBe(401)
        const opened = await f.call(`/previews/${preview.id}/`)
        expect(opened.status).toBe(303)
        const ticket = opened.headers.get('location')!
        const page = await f.call(ticket, undefined, { token: null })
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('Synthetic preview')
        expect(page.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
        expect(page.headers.get('content-security-policy')).not.toContain('allow-same-origin')
        expect(page.headers.get('content-security-policy')).toContain("form-action 'none'")
        expect(page.headers.get('access-control-allow-credentials')).toBeNull()
        expect(page.headers.get('set-cookie')).toBeNull()
        expect(page.headers.get('cache-control')).toContain('no-store')
        expect((await f.call(`${ticket}app.js`, undefined, { token: null })).status).toBe(200)
    })
    test('sensitive files, traversal, outside symlinks, hardlinks and oversized files cannot be served', async () => {
        const f = fixture(), preview = await f.register()
        const ticket = (await f.call(`/previews/${preview.id}/`)).headers.get('location')!
        const outside = join(f.dir, 'outside.txt'); writeFileSync(outside, 'private-other-project')
        symlinkSync(outside, join(f.output, 'linked.txt')); linkSync(outside, join(f.output, 'hardlinked.txt'))
        writeFileSync(join(f.output, 'huge.txt'), Buffer.alloc(16 * 1024 * 1024 + 1))
        for (const path of ['.env', '%2eenv', 'linked.txt', 'hardlinked.txt', 'huge.txt', '%2e%2e%2foutside.txt', 'secrets.json', 'app.js.map']) {
            expect((await f.call(`${ticket}${path}`, undefined, { token: null })).status).not.toBe(200)
        }
        expect((await f.call(`/projects/${f.project.id}/previews`, { name: 'Outside', directory: f.dir })).status).toBe(400)
    })
    test('shared links expire, revoke, are stored only as hashes, and stop after issuer access is removed', async () => {
        const f = fixture(), preview = await f.register(), path = `/projects/${f.project.id}/previews/${preview.id}/shares`
        const share = await (await f.call(path, { expiresInSeconds: 600 })).json() as { id: string; url: string }
        expect((await f.call(share.url, undefined, { token: null })).status).toBe(200)
        const token = share.url.split('/').at(-2)!
        expect(JSON.stringify(f.store.db.prepare('SELECT * FROM evolved_preview_grants').all())).not.toContain(token)
        expect((await f.call(`${path}/${share.id}`, undefined, { method: 'DELETE' })).status).toBe(200)
        expect((await f.call(share.url, undefined, { token: null })).status).toBe(404)
        const expiring = await (await f.call(path, {})).json() as { id: string; url: string }
        f.store.db.prepare('UPDATE evolved_preview_grants SET expires_at=? WHERE id=?').run(Date.now() - 1, expiring.id)
        expect((await f.call(expiring.url, undefined, { token: null })).status).toBe(404)
        const revokedByAcl = await (await f.call(path, {})).json() as { url: string }
        f.store.setMember(f.userId, f.team.id, f.outsider, 'admin')
        f.store.setMember(f.userId, f.team.id, f.userId, null)
        expect((await f.call(revokedByAcl.url, undefined, { token: null })).status).toBe(403)
    })
    test('viewers cannot create shares and cross-origin registration is rejected', async () => {
        const f = fixture(), preview = await f.register()
        f.store.setMember(f.userId, f.team.id, f.outsider, 'viewer')
        const outsiderToken = f.store.createSession(f.outsider)
        expect((await f.call(`/projects/${f.project.id}/previews/${preview.id}/shares`, {}, { token: outsiderToken })).status).toBe(403)
        expect((await f.call(`/projects/${f.project.id}/previews`, { name: 'No', directory: f.output }, { origin: 'https://evil.test' })).status).toBe(403)
    })
})
