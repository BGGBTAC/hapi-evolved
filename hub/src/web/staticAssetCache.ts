import type { MiddlewareHandler } from 'hono'

/** Keep update entrypoints revalidatable in both embedded and filesystem builds. */
export const staticAssetCache: MiddlewareHandler = async (c, next) => {
    await next()
    if (!['GET', 'HEAD'].includes(c.req.method) || c.res.status !== 200 || /^\/(api|cli)(\/|$)/.test(c.req.path)) return
    const path = c.req.path
    const html = c.res.headers.get('content-type')?.startsWith('text/html')
    if (html || path === '/sw.js' || path === '/manifest.webmanifest') {
        c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
        c.header('CDN-Cache-Control', 'no-store')
        c.header('Cloudflare-CDN-Cache-Control', 'no-store')
    } else if (/^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(path)) {
        c.header('Cache-Control', 'public, max-age=604800, immutable')
    }
}
