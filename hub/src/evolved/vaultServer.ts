import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync } from 'node:fs'
import { EvolvedVault, verifyVaultEnvelope, type ResourceAction } from './vault'
import { EvolvedError } from './store'
import { boundedGitResponse, GIT_TIMEOUT_MS, readGitBody, parseGitCredentialRequest } from './githubProtocol'

export function createVaultServer(options: { vault: EvolvedVault; hubPublicKey: string }): Hono {
    const app = new Hono()
    let activeGit = 0
    app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
    app.onError((error, c) => error instanceof EvolvedError ? c.json({ code: error.code, error: error.message }, error.status as 400) : c.json({ code: 'vault_error', error: 'Vault request failed.' }, 500))
    app.get('/health', c => c.json({ ok: true }))
    app.post('/v1/github/git', async c => {
        const header = c.req.header('x-evolved-request') ?? ''
        if (!/^[A-Za-z0-9_-]{1,8192}$/.test(header)) throw new EvolvedError('invalid_capability', 'Invalid Git capability.', 401)
        const envelope = Buffer.from(header, 'base64url').toString('utf8')
        const request = verifyVaultEnvelope(envelope, c.req.header('x-evolved-signature') ?? '', options.hubPublicKey, options.vault)
        if (request.operation !== 'githubGit') throw new EvolvedError('operation_denied', 'Git capability required.', 403)
        if (activeGit >= 2) throw new EvolvedError('github_busy', 'Vault Git transfer capacity reached.', 429)
        activeGit++
        const controller = new AbortController(), abort = () => controller.abort()
        c.req.raw.signal.addEventListener('abort', abort, { once: true })
        if (c.req.raw.signal.aborted) abort()
        const timeout = setTimeout(abort, GIT_TIMEOUT_MS)
        const admissionDeadline = setTimeout(abort, Math.max(1, request.expiresAt - Date.now()))
        let finished = false, admitted = false
        const finish = () => {
            if (finished) return
            finished = true; activeGit--; clearTimeout(timeout); clearTimeout(admissionDeadline)
            c.req.raw.signal.removeEventListener('abort', abort)
        }
        try {
            const body = await readGitBody(new Request(c.req.raw, { signal: controller.signal }))
            if (request.expiresAt <= Date.now()) throw new EvolvedError('invalid_capability', 'Git capability expired during upload.', 401)
            controller.signal.throwIfAborted(); clearTimeout(admissionDeadline)
            admitted = true
            return boundedGitResponse(await options.vault.git(parseGitCredentialRequest(request), body, controller.signal), controller, finish)
        } catch (error) {
            controller.abort(); finish()
            if (!admitted && request.expiresAt <= Date.now()) throw new EvolvedError('invalid_capability', 'Git capability expired during upload.', 401)
            throw error
        }
    })
    app.use('*', bodyLimit({ maxSize: 100_000 }))
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
    Bun.serve({ hostname: process.env.EVOLVED_VAULT_HOST ?? '127.0.0.1', port: Number(process.env.EVOLVED_VAULT_PORT ?? '3212'), maxRequestBodySize: 64 * 1024 * 1024, fetch: app.fetch })
}
