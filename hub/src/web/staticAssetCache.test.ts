import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { staticAssetCache } from './staticAssetCache'

const root = mkdtempSync(join(tmpdir(), 'hapi-static-update-'))
mkdirSync(join(root, 'assets'))
const files = {
    'index.html': '<!doctype html><title>Update fixture</title>',
    'sw.js': '/* service worker */',
    'manifest.webmanifest': '{"name":"Update fixture"}',
    'assets/index-ABcd1234.js': 'export const version = 2',
    'assets/index-ABcd1234.css': 'body { color: black }',
}
for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
afterAll(() => rmSync(root, { recursive: true, force: true }))

for (const delivery of ['filesystem', 'embedded'] as const) {
    describe(`${delivery} web asset cache headers`, () => {
        const app = new Hono()
        app.use('*', staticAssetCache)
        app.get('/api/example', c => { c.header('Cache-Control', 'private, no-store'); return c.html('private') })
        app.get('/assets/missing-ABcd1234.js', c => c.text('Not found', 404))
        if (delivery === 'filesystem') {
            app.use('*', serveStatic({ root }))
            app.get('*', serveStatic({ root, path: 'index.html' }))
        } else {
            app.get('*', c => {
                const path = c.req.path.slice(1)
                const known = path in files ? path : 'index.html'
                const type = known.endsWith('.js') ? 'text/javascript' : known.endsWith('.css') ? 'text/css' : known.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html'
                return new Response(Bun.file(join(root, known)), { headers: { 'Content-Type': type } })
            })
        }
        for (const path of ['/', '/index.html', '/evolved', '/sessions/example', '/sw.js', '/manifest.webmanifest']) {
            test(`${path} is never retained by HTTP caches`, async () => {
                for (const method of ['GET', 'HEAD']) {
                    const response = await app.request(`http://localhost${path}`, { method })
                    expect(response.status).toBe(200)
                    expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate')
                    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
                    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
                }
            })
        }
        test('only versioned successful JS/CSS assets are immutable', async () => {
            for (const path of ['/assets/index-ABcd1234.js', '/assets/index-ABcd1234.css']) {
                const response = await app.request(`http://localhost${path}`)
                expect(response.headers.get('cache-control')).toBe('public, max-age=604800, immutable')
            }
            const missing = await app.request('http://localhost/assets/missing-ABcd1234.js')
            expect(missing.status).toBe(404)
            expect(missing.headers.get('cache-control')).toBeNull()
        })
        test('does not override private API responses', async () => {
            const response = await app.request('http://localhost/api/example')
            expect(response.headers.get('cache-control')).toBe('private, no-store')
            expect(response.headers.get('cdn-cache-control')).toBeNull()
        })
    })
}
