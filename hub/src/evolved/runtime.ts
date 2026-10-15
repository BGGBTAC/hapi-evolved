import { join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { EvolvedError, EvolvedStore, privateFile } from './store'
import { createEvolvedRoutes } from './api'
import { RemoteVaultClient } from './vault'
import { createSessionTokenRoutes } from './bridge'
import { createCodegraphRoutes, startCodegraphSync, enqueueCodegraphDeletion } from './codegraph'
import { createMemoryRoutes } from './memory'
import { HttpMemoryBackend, MemoryService } from './memoryService'
import { assertOrigin } from './security'
import { createPreviewRoutes } from './previews'

export type EvolvedRuntime = ReturnType<typeof createEvolvedRuntime>
export function createEvolvedRuntime(dataDir: string, secret: Uint8Array) {
    const originValue = process.env.EVOLVED_ORIGIN
    if (!originValue) throw new Error('EVOLVED_ORIGIN is required in Evolved mode')
    const url = new URL(originValue)
    if (url.origin !== originValue || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('EVOLVED_ORIGIN must be an HTTPS origin (localhost HTTP is allowed for development)')
    const origin = url.origin
    const roots: unknown = JSON.parse(process.env.EVOLVED_CODE_ROOTS ?? '[]')
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new Error('EVOLVED_CODE_ROOTS must be a JSON array of absolute directories')
    const store = new EvolvedStore(process.env.EVOLVED_DB_PATH ?? join(dataDir, 'evolved.db'), {
        bootstrapFile: process.env.EVOLVED_BOOTSTRAP_FILE ?? join(dataDir, 'bootstrap.token')
    })
    const vaultUrl = process.env.EVOLVED_VAULT_URL
    const signingKeyFile = process.env.EVOLVED_VAULT_SIGNING_KEY_FILE
    if (!vaultUrl || !signingKeyFile) throw new Error('The isolated vault URL and signing-key file are required')
    const vault = new RemoteVaultClient({ url: vaultUrl, signingKeyFile })
    const serviceToken = process.env.EVOLVED_SERVICE_TOKEN_FILE ? privateFile(process.env.EVOLVED_SERVICE_TOKEN_FILE).toString('utf8').trim() : undefined
    const memory = new MemoryService(store, new HttpMemoryBackend(process.env.EVOLVED_MEMORY_URL, serviceToken))
    const graphOptions = { store, origin, adapterUrl: process.env.EVOLVED_CODEGRAPH_URL, serviceToken }
    const routes = new Hono()
    routes.use('*', bodyLimit({ maxSize: 1024 * 1024 }))
    routes.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('X-Content-Type-Options', 'nosniff')
        // Non-browser capability clients may omit Origin. A browser may never
        // combine its ambient cookie with a bearer token to skip the CSRF gate.
        if (c.req.path.includes('/auth/') || c.req.header('cookie') || !c.req.header('authorization') || c.req.header('origin')) assertOrigin(c.req.raw, origin)
        await next()
    })
    routes.onError((error, c) => error instanceof EvolvedError
        ? c.json({ error: error.message, code: error.code }, error.status as 400)
        : c.json({ error: 'Evolved request failed.' }, 500))
    routes.route('/', createSessionTokenRoutes(store, secret, origin))
    routes.route('/', createPreviewRoutes({ store, origin }))
    routes.route('/', createEvolvedRoutes({ store, vault, origin, allowedWorkspaceRoots: roots as string[],
        onProjectDelete: projectId => { memory.forgetProject(projectId); enqueueCodegraphDeletion(store, projectId) } }))
    routes.route('/', createMemoryRoutes({ store, service: memory, origin }))
    routes.route('/', createCodegraphRoutes(graphOptions))
    const stopMemory = memory.start()
    const stopGraph = startCodegraphSync(graphOptions)
    return { store, origin, routes, memory, close() { stopMemory(); stopGraph(); store.close() } }
}
