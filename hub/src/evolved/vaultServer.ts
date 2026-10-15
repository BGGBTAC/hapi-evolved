import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync } from 'node:fs'
import { EvolvedVault, verifyVaultEnvelope, type ResourceAction } from './vault'
import { EvolvedError } from './store'

export function createVaultServer(options: { vault: EvolvedVault; hubPublicKey: string }): Hono {
    const app = new Hono()
    app.use('*', bodyLimit({ maxSize: 100_000 }))
    app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code, error: error.message }, error.status as 400) : c.json({ code: 'vault_error', error: 'Vault request failed.' }, 500))
    app.get('/health', c => c.json({ ok: true }))
    app.post('/v1/request', async c => {
        const body = await c.req.text()
        const request = verifyVaultEnvelope(body, c.req.header('x-evolved-signature') ?? '', options.hubPublicKey, options.vault)
        return c.json(await options.vault.request(request))
    })
    return app
}
if (import.meta.main) {
    const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
    const vault = new EvolvedVault({ dbPath: required('EVOLVED_VAULT_DB_PATH'), masterKeyFile: required('EVOLVED_VAULT_MASTER_KEY_FILE'), actions: process.env.EVOLVED_VAULT_ACTIONS_FILE ? JSON.parse(readFileSync(process.env.EVOLVED_VAULT_ACTIONS_FILE, 'utf8')) as ResourceAction[] : [] })
    const app = createVaultServer({ vault, hubPublicKey: readFileSync(required('EVOLVED_VAULT_PUBLIC_KEY_FILE'), 'utf8') })
    Bun.serve({ hostname: process.env.EVOLVED_VAULT_HOST ?? '127.0.0.1', port: Number(process.env.EVOLVED_VAULT_PORT ?? '3212'), fetch: app.fetch })
}
