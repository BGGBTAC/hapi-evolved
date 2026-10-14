import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON, type AuthenticatorTransport } from '@simplewebauthn/server'
import { setCookie, deleteCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { EvolvedError, EvolvedStore, hashToken, randomToken, type EvolvedPrincipal } from './store'

export const SESSION_COOKIE = '__Host-hapi-evolved'
const ENROLLMENT_COOKIE = '__Host-hapi-evolved-enrollment'
const CHALLENGE_COOKIE = '__Host-hapi-evolved-challenge'
export type EvolvedEnv = { Variables: { principal: EvolvedPrincipal } }
export function cookieToken(req: Request, name = SESSION_COOKIE): string | null {
    const matches = (req.headers.get('cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`))
    if (matches.length !== 1) return null
    const token = matches[0].slice(name.length + 1)
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}
export async function authenticateEvolvedRequest(req: Request, store: EvolvedStore): Promise<EvolvedPrincipal | null> {
    const authorization = req.headers.get('authorization')
    if (authorization) {
        if (!authorization.startsWith('Bearer ')) return null
        const token = authorization.slice(7)
        return /^[A-Za-z0-9_-]{43}$/.test(token) ? store.capability(token) : null
    }
    const token = cookieToken(req)
    return token ? store.session(token) : null
}
export async function authenticateEvolvedSessionHash(hash: string, store: EvolvedStore): Promise<EvolvedPrincipal | null> {
    return /^[a-f0-9]{64}$/.test(hash) ? store.getSessionByHash(hash) : null
}
export function requireScope(principal: EvolvedPrincipal, scope: string, projectId?: string): void {
    if (principal.capability && (!principal.capability.scopes.includes(scope) || (projectId && principal.capability.projectId !== projectId))) throw new EvolvedError('scope_denied', 'Capability does not permit this operation.', 403)
}
export function requireHuman(principal: EvolvedPrincipal): void {
    if (principal.capability) throw new EvolvedError('human_required', 'This operation requires a human session.', 403)
}
export function requireFreshPasskey(c: Context, store: EvolvedStore, principal: EvolvedPrincipal): void {
    requireHuman(principal)
    const token = cookieToken(c.req.raw)
    if (!token || !store.isFreshPasskey(token)) throw new EvolvedError('step_up_required', 'Sign in with a passkey again before this operation.', 403)
}
function writeCookie(c: Context, name: string, token: string, seconds: number): void {
    setCookie(c, name, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: seconds })
}
const nameSchema = z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N} _@.+-]+$/u)
const tokenSchema = z.string().min(1).max(2048)
const verificationSchema = z.object({ challengeId: tokenSchema, response: z.record(z.string(), z.unknown()) }).strict()
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
    const result = schema.safeParse(await c.req.json().catch(() => null))
    if (!result.success) throw new EvolvedError('invalid_body', 'Invalid request body.')
    return result.data
}
export function assertOrigin(req: Request, origin: string): void {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.get('origin') !== origin) throw new EvolvedError('origin_denied', 'Request origin is not allowed.', 403)
}
export function createAuthRoutes(config: { store: EvolvedStore; origin: string; rpName?: string }): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>(), { store, origin } = config
    const rpID = new URL(origin).hostname
    const limited = new Map<string, { count: number; expires: number }>()
    function rateLimit(c: Context, operation: string): void {
        const now = store.now()
        // Only the transport's peer address is trusted. Forwarded headers can be
        // supplied by clients and must not create arbitrary rate-limit identities.
        const transport = (c.env as { server?: { requestIP?: (request: Request) => { address: string } | null } } | undefined)?.server
        const address = transport?.requestIP?.(c.req.raw)?.address ?? 'unavailable'
        const key = `${address}:${operation}`
        for (const [k, v] of limited) if (v.expires <= now) limited.delete(k)
        // Global ceiling bounds memory and unauthenticated CPU even behind a shared private proxy.
        const global = limited.get('*') ?? { count: 0, expires: now + 60_000 }
        if (++global.count > 1200) throw new EvolvedError('rate_limited', 'Too many authentication attempts. Try again shortly.', 429)
        limited.set('*', global)
        const entry = limited.get(key) ?? { count: 0, expires: now + 60_000 }
        if (++entry.count > 20) throw new EvolvedError('rate_limited', 'Too many authentication attempts. Try again shortly.', 429)
        limited.set(key, entry)
    }
    app.get('/status', async c => {
        const token = cookieToken(c.req.raw, ENROLLMENT_COOKIE)
        const enrollment = token ? store.enrollment(token) : null
        return c.json({ enabled: true, initialized: store.initialized(), authenticated: !!await authenticateEvolvedRequest(c.req.raw, store),
            ...(enrollment ? { enrollment: { displayName: enrollment.display_name, expiresAt: enrollment.expires_at } } : {}) })
    })
    app.post('/bootstrap', async c => {
        rateLimit(c, 'enrollment')
        const body = await parseBody(c, z.object({ token: tokenSchema, displayName: nameSchema }).strict())
        const token = store.exchangeEnrollment(body.token, body.displayName)
        writeCookie(c, ENROLLMENT_COOKIE, token, 600)
        return c.json({ ok: true })
    })
    app.post('/registration/options', async c => {
        rateLimit(c, 'registration-options')
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (principal) {
            requireHuman(principal)
            if (!store.canEnrollPasskey(cookieToken(c.req.raw) ?? '')) throw new EvolvedError('step_up_required', 'Sign in again before adding a passkey.', 403)
        }
        const token = cookieToken(c.req.raw, ENROLLMENT_COOKIE)
        const enrollment = token ? store.enrollment(token) : null
        const userId = principal?.user.id ?? enrollment?.user_id
        const name = principal?.user.displayName ?? enrollment?.display_name
        if (!userId || !name) throw new EvolvedError('enrollment_required', 'An invitation or authenticated account is required.', 401)
        const options = await generateRegistrationOptions({ rpName: config.rpName ?? 'HAPI Evolved', rpID, userID: new TextEncoder().encode(userId), userName: name, attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: store.passkeys(userId).map(k => ({ id: k.id, transports: JSON.parse(k.transports) as AuthenticatorTransport[] })) })
        const binding = randomToken()
        const challengeId = store.saveChallenge(options.challenge, 'registration', binding, userId, principal ? null : hashToken(token!))
        writeCookie(c, CHALLENGE_COOKIE, binding, 300)
        return c.json({ challengeId, options })
    })
    app.post('/registration/verify', async c => {
        rateLimit(c, 'registration-verify')
        const body = await parseBody(c, verificationSchema)
        const challenge = store.consumeChallenge(body.challengeId, 'registration', cookieToken(c.req.raw, CHALLENGE_COOKIE) ?? '')
        if (!challenge.user_id) throw new EvolvedError('invalid_challenge', 'Invalid registration challenge.', 401)
        if (!challenge.enrollment_hash) {
            const principal = await authenticateEvolvedRequest(c.req.raw, store)
            if (!principal || principal.capability || principal.user.id !== challenge.user_id) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        } else if (hashToken(cookieToken(c.req.raw, ENROLLMENT_COOKIE) ?? '') !== challenge.enrollment_hash) throw new EvolvedError('unauthorized', 'Enrollment credential mismatch.', 401)
        let result
        try { result = await verifyRegistrationResponse({ response: body.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }) }
        catch { throw new EvolvedError('invalid_passkey', 'Passkey registration could not be verified.', 401) }
        if (!result.verified || !result.registrationInfo) throw new EvolvedError('invalid_passkey', 'Passkey registration could not be verified.', 401)
        if (!challenge.enrollment_hash) {
            const principal = await authenticateEvolvedRequest(c.req.raw, store)
            if (!principal || principal.capability || principal.user.id !== challenge.user_id || !store.canEnrollPasskey(cookieToken(c.req.raw) ?? '')) throw new EvolvedError('step_up_required', 'Sign in again before adding a passkey.', 403)
        }
        const registered = store.finishRegistration({ userId: challenge.user_id, enrollmentHash: challenge.enrollment_hash, credential: result.registrationInfo.credential })
        const old = cookieToken(c.req.raw); if (old) store.revokeSession(old)
        writeCookie(c, SESSION_COOKIE, store.createSession(registered.userId), 12 * 3600)
        deleteCookie(c, ENROLLMENT_COOKIE, { secure: true, path: '/' })
        deleteCookie(c, CHALLENGE_COOKIE, { secure: true, path: '/' })
        return c.json({ principal: store.getPrincipal(registered.userId), ...(registered.recoveryCodes ? { recoveryCodes: registered.recoveryCodes } : {}) })
    })
    app.post('/login/options', async c => {
        rateLimit(c, 'login-options')
        await parseBody(c, z.object({ displayName: nameSchema.optional() }).strict())
        // Discoverable credentials avoid leaking whether a supplied account name exists.
        const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' })
        const binding = randomToken()
        const challengeId = store.saveChallenge(options.challenge, 'login', binding, null, null)
        writeCookie(c, CHALLENGE_COOKIE, binding, 300)
        return c.json({ challengeId, options })
    })
    app.post('/login/verify', async c => {
        rateLimit(c, 'login-verify')
        const body = await parseBody(c, verificationSchema)
        const challenge = store.consumeChallenge(body.challengeId, 'login', cookieToken(c.req.raw, CHALLENGE_COOKIE) ?? '')
        const response = body.response as unknown as AuthenticationResponseJSON
        const key = typeof response.id === 'string' ? store.passkey(response.id) : null
        if (!key) throw new EvolvedError('invalid_passkey', 'Passkey authentication failed.', 401)
        let result
        try { result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) as AuthenticatorTransport[] }, requireUserVerification: true }) }
        catch { throw new EvolvedError('invalid_passkey', 'Passkey authentication failed.', 401) }
        if (!result.verified) throw new EvolvedError('invalid_passkey', 'Passkey authentication failed.', 401)
        const updated = store.db.prepare('UPDATE evolved_passkeys SET counter=? WHERE id=? AND counter=?').run(result.authenticationInfo.newCounter, key.id, key.counter)
        if (updated.changes !== 1) throw new EvolvedError('concurrent_authentication', 'Please sign in again.', 409)
        const old = cookieToken(c.req.raw); if (old) store.revokeSession(old)
        writeCookie(c, SESSION_COOKIE, store.createSession(key.user_id), 12 * 3600)
        deleteCookie(c, CHALLENGE_COOKIE, { secure: true, path: '/' })
        store.audit(key.user_id, null, 'auth.passkey')
        return c.json({ principal: store.getPrincipal(key.user_id) })
    })
    app.post('/recovery', async c => {
        rateLimit(c, 'recovery')
        const body = await parseBody(c, z.object({ displayName: nameSchema, code: tokenSchema }).strict())
        const user = store.recover(body.displayName, body.code)
        writeCookie(c, SESSION_COOKIE, store.createSession(user.id, 'recovery'), 12 * 3600)
        return c.json({ principal: store.getPrincipal(user.id) })
    })
    app.post('/recovery-codes', async c => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireFreshPasskey(c, store, principal)
        return c.json({ recoveryCodes: store.rotateRecoveryCodes(principal.user.id) })
    })
    app.get('/passkeys', async c => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal)
        const passkeys = store.db.prepare('SELECT id,created_at AS createdAt FROM evolved_passkeys WHERE user_id=? ORDER BY created_at').all(principal.user.id)
        return c.json({ passkeys })
    })
    app.delete('/passkeys/:id', async c => {
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireFreshPasskey(c, store, principal)
        store.db.transaction(() => {
            const keys = store.passkeys(principal.user.id)
            if (!keys.some(k => k.id === c.req.param('id'))) throw new EvolvedError('not_found', 'Passkey not found.', 404)
            if (keys.length < 2) throw new EvolvedError('last_passkey', 'Add a replacement passkey before deleting your last passkey.', 409)
            store.db.prepare('DELETE FROM evolved_passkeys WHERE id=? AND user_id=?').run(c.req.param('id'), principal.user.id)
            // A lost passkey may already have created sessions. Keep only this freshly verified session.
            store.db.prepare('DELETE FROM evolved_sessions WHERE user_id=? AND token_hash<>?').run(principal.user.id, hashToken(cookieToken(c.req.raw)!))
            store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE user_id=?').run(store.now(), principal.user.id)
            store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=? WHERE user_id=?').run(store.now(), principal.user.id)
            store.audit(principal.user.id, null, 'passkey.deleted', c.req.param('id'))
        })()
        return c.json({ ok: true })
    })
    app.post('/logout', c => {
        const token = cookieToken(c.req.raw); if (token) store.revokeSession(token)
        deleteCookie(c, SESSION_COOKIE, { secure: true, path: '/' })
        return c.json({ ok: true })
    })
    return app
}
