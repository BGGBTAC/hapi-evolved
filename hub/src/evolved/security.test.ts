import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { EvolvedStore, hashToken } from './store'
import { createEvolvedRoutes } from './api'
import { authenticateEvolvedRequest, authenticateEvolvedSessionHash, SESSION_COOKIE } from './security'
import { exchangeRunnerLease } from './runner'
import type { VaultClient } from './vault'

const directories: string[] = [], stores: EvolvedStore[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })
function setup(vault?: VaultClient, allowedWorkspaceRoots: string[] = []) {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-security-')); directories.push(directory)
    const bootstrapFile = join(directory, 'bootstrap.token'), store = new EvolvedStore(join(directory, 'state.db'), { bootstrapFile }); stores.push(store)
    const origin = 'https://evolved.example.test', jar = new Map<string, string>()
    const app = new Hono().route('/api/evolved', createEvolvedRoutes({ store, origin, allowedWorkspaceRoots, vault: vault ?? { request: async () => ({ secrets: [] }) } }))
    const call = async (path: string, body?: unknown, options: { method?: string; origin?: string; bearer?: string } = {}) => {
        const headers: Record<string, string> = { 'content-type': 'application/json', origin: options.origin ?? origin }
        if (options.bearer) headers.authorization = `Bearer ${options.bearer}`
        else headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
        const result = await app.request(`${origin}/api/evolved${path}`, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        for (const item of result.headers.getSetCookie()) { const pair = item.split(';')[0], pos = pair.indexOf('='); jar.set(pair.slice(0, pos), pair.slice(pos + 1)) }
        return result
    }
    return { directory, bootstrapFile, store, origin, jar, call, app }
}
// Minimal CBOR encoder for synthetic authenticators; production verification is the real WebAuthn library.
function cbor(value: unknown): Buffer {
    const head = (major: number, n: number): Buffer => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255])
    if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
    if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]) }
    if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
    const entries: Array<[unknown, unknown]> = value instanceof Map ? [...value] : Object.entries(value as object)
    return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])])
}
function authenticator() {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), credentialId = randomBytes(32)
    const publicKey = keys.publicKey.export({ format: 'jwk' })
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(publicKey.x!, 'base64url')], [-3, Buffer.from(publicKey.y!, 'base64url')]]))
    return { credentialId, privateKey: keys.privateKey, cose }
}
function registration(auth: ReturnType<typeof authenticator>, challenge: string, origin: string) {
    const rpHash = createHash('sha256').update(new URL(origin).hostname).digest()
    const data = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, auth.credentialId.length]), auth.credentialId, auth.cose])
    return { id: auth.credentialId.toString('base64url'), rawId: auth.credentialId.toString('base64url'), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })).toString('base64url'), attestationObject: cbor({ fmt: 'none', attStmt: {}, authData: data }).toString('base64url'), transports: ['internal'] } }
}
function assertion(auth: { credentialId: Buffer; privateKey: KeyObject }, challenge: string, origin: string, counter = 1) {
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false })), count = Buffer.alloc(4); count.writeUInt32BE(counter)
    const data = Buffer.concat([createHash('sha256').update(new URL(origin).hostname).digest(), Buffer.from([5]), count])
    return { id: auth.credentialId.toString('base64url'), rawId: auth.credentialId.toString('base64url'), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'), signature: sign('sha256', Buffer.concat([data, createHash('sha256').update(client).digest()]), auth.privateKey).toString('base64url') } }
}
async function enroll(s: ReturnType<typeof setup>) {
    const token = readFileSync(s.bootstrapFile, 'utf8')
    expect((await s.call('/auth/bootstrap', { token, displayName: 'Ada' })).status).toBe(200)
    const options = await (await s.call('/auth/registration/options', {})).json() as { challengeId: string; options: { challenge: string } }
    const auth = authenticator()
    const result = await s.call('/auth/registration/verify', { challengeId: options.challengeId, response: registration(auth, options.options.challenge, s.origin) })
    const body = await result.json() as { principal: { user: { id: string } }; recoveryCodes: string[] }
    expect(result.status).toBe(200)
    return { auth, userId: body.principal.user.id, codes: body.recoveryCodes }
}

describe('Evolved authentication and authorization', () => {
    test('creating a personal team does not grant access to host workspaces or other projects', async () => {
        const s = setup(undefined, [tmpdir()]), { userId } = await enroll(s), victimTeam = s.store.createTeam(userId, 'Private team')
        const privateWorkspace = join(s.directory, 'private-workspace'); mkdirSync(privateWorkspace)
        s.store.createProject(userId, victimTeam.id, 'Private workspace', privateWorkspace)
        const member = randomUUID()
        s.store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(member, 'Viewer', Date.now())
        const own = s.store.createTeam(member, 'Own team')
        s.jar.set(SESSION_COOKIE, s.store.createSession(member))
        expect((await s.call('/projects', { teamId: own.id, name: 'Stolen workspace', rootPath: s.directory })).status).toBe(403)
        expect((await s.call('/projects', { teamId: own.id, name: 'All workspaces', root: tmpdir() })).status).toBe(403)
        expect(() => s.store.createProject(member, own.id, 'Direct attempt', s.directory)).toThrow('installation administrator')
        expect((await s.call('/projects', { teamId: own.id, name: 'Memory only' })).status).toBe(201)
    })
    test('authentication rate limits separate transport peers and ignore spoofed forwarded headers', async () => {
        const s = setup()
        const options = (address: string, forwarded = '') => s.app.request(`${s.origin}/api/evolved/auth/login/options`, { method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json', 'x-forwarded-for': forwarded }, body: '{}' }, { server: { requestIP: () => ({ address }) } })
        for (let index = 0; index < 20; index++) expect((await options('192.0.2.1')).status).toBe(200)
        expect((await options('192.0.2.1', '198.51.100.1')).status).toBe(429)
        expect((await options('192.0.2.2')).status).toBe(200)
    })
    test('pending enrollment resumes from the cookie and an operator can replace a consumed bootstrap file', async () => {
        const s = setup(), original = readFileSync(s.bootstrapFile, 'utf8')
        expect((await s.call('/auth/bootstrap', { token: original, displayName: 'Ada' })).status).toBe(200)
        const status = await (await s.call('/auth/status')).json() as { enrollment: { displayName: string; expiresAt: number }; initialized: boolean }
        expect(status.enrollment.displayName).toBe('Ada')
        expect(status.enrollment.expiresAt).toBeGreaterThan(Date.now())
        expect(status.initialized).toBe(false)
        s.store.db.prepare('UPDATE evolved_enrollments SET expires_at=?').run(Date.now() - 1)
        expect(await (await s.call('/auth/status')).json()).not.toHaveProperty('enrollment')
        rmSync(s.bootstrapFile)
        const reopened = new EvolvedStore(join(s.directory, 'state.db'), { bootstrapFile: s.bootstrapFile }); stores.push(reopened)
        const replacement = readFileSync(s.bootstrapFile, 'utf8')
        expect(replacement).not.toBe(original)
        expect((await s.call('/auth/bootstrap', { token: original, displayName: 'Old' })).status).toBe(401)
        expect((await s.call('/auth/bootstrap', { token: replacement, displayName: 'Ada' })).status).toBe(200)
    })
    test('bootstrap is private, one-use, and registration verifies an actual synthetic authenticator', async () => {
        const s = setup()
        expect(statSync(s.bootstrapFile).mode & 0o777).toBe(0o600)
        expect((await s.call('/auth/bootstrap', { token: 'guessed', displayName: 'Attacker' })).status).toBe(401)
        const { userId, codes } = await enroll(s)
        expect(codes).toHaveLength(10)
        expect((await s.call('/auth/bootstrap', { token: readFileSync(s.bootstrapFile, 'utf8'), displayName: 'Attacker' })).status).toBe(401)
        const token = s.jar.get(SESSION_COOKIE)!
        expect(s.store.db.prepare('SELECT token_hash FROM evolved_sessions').get()).toEqual({ token_hash: hashToken(token) })
        expect(await authenticateEvolvedSessionHash(hashToken(token), s.store)).toMatchObject({ user: { id: userId } })
        expect((await s.call('/teams', { name: 'Forbidden' }, { origin: 'https://evil.test' })).status).toBe(403)
    })
    test('signed passkey login, challenge replay rejection, logout invalidates derived session hashes', async () => {
        const s = setup(), { auth } = await enroll(s)
        await s.call('/auth/logout', {})
        const options = await (await s.call('/auth/login/options', {})).json() as { challengeId: string; options: { challenge: string } }
        const body = { challengeId: options.challengeId, response: assertion(auth, options.options.challenge, s.origin) }
        expect((await s.call('/auth/login/verify', body)).status).toBe(200)
        const token = s.jar.get(SESSION_COOKIE)!
        expect((await s.call('/auth/login/verify', body)).status).toBe(401)
        await s.call('/auth/logout', {})
        expect(await authenticateEvolvedSessionHash(hashToken(token), s.store)).toBeNull()
    })
    test('recovery is single-use, revokes sessions, and cannot write secrets without a new passkey', async () => {
        const s = setup(), { userId, codes } = await enroll(s)
        const old = s.jar.get(SESSION_COOKIE)!, team = s.store.createTeam(userId, 'Team'), project = s.store.createProject(userId, team.id, 'Project')
        expect((await s.call('/auth/recovery', { displayName: 'Ada', code: codes[0] })).status).toBe(200)
        expect(s.store.session(old)).toBeNull()
        expect((await s.call('/auth/recovery', { displayName: 'Ada', code: codes[0] })).status).toBe(401)
        expect((await s.call(`/projects/${project.id}/secrets`, { name: 'test', value: 'synthetic' })).status).toBe(403)
        const stored = JSON.stringify(s.store.db.prepare('SELECT * FROM evolved_recovery_codes').all())
        expect(stored).not.toContain(codes[0])
    })
    test('project roles, scoped capabilities, removal and profile changes are enforced immediately', async () => {
        const s = setup(), { userId } = await enroll(s)
        const outsider = randomUUID()
        s.store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(outsider, 'Grace', Date.now())
        const team = s.store.createTeam(userId, 'Team'), project = s.store.createProject(userId, team.id, 'Project')
        expect(() => s.store.requireProject(outsider, project.id)).toThrow()
        s.store.setMember(userId, team.id, outsider, 'viewer')
        expect(() => s.store.requireProject(outsider, project.id, 'member')).toThrow()
        expect(() => s.store.setMember(outsider, team.id, outsider, 'admin')).toThrow()
        const cap = s.store.issueCapability(userId, project.id, ['memory:read'], [], 300)
        const request = new Request(s.origin, { headers: { authorization: `Bearer ${cap.token}` } })
        expect((await authenticateEvolvedRequest(request, s.store))?.accessibleProjects).toHaveLength(1)
        expect((await s.call('/teams', { name: 'Escalate' }, { bearer: cap.token })).status).toBe(403)
        s.store.setProfile(userId, project.id, 'workspace')
        expect(await authenticateEvolvedRequest(request, s.store)).toBeNull()
        s.store.setMember(userId, team.id, outsider, null)
        expect(s.store.listProjects(outsider)).toHaveLength(0)
        expect(() => s.store.setMember(userId, team.id, userId, 'viewer')).toThrow()
    })
    test('challenge binding is browser-specific and rejects forged WebAuthn responses', async () => {
        const s = setup(); await enroll(s)
        const options = await (await s.call('/auth/login/options', {})).json() as { challengeId: string }
        expect((await s.call('/auth/login/verify', { challengeId: options.challengeId, response: { id: 'fake' } })).status).toBe(401)
        expect((await s.call('/auth/login/verify', { challengeId: options.challengeId, response: { id: 'fake' } })).status).toBe(401)
    })
    test('runner leases refresh short capabilities but cannot outlive revocation, absolute expiry or issuer rights', async () => {
        const s = setup(), { userId } = await enroll(s), team = s.store.createTeam(userId, 'Runner team'), project = s.store.createProject(userId, team.id, 'Runner project')
        const response = await s.call(`/projects/${project.id}/runner-leases`, { name: 'Local runner', scopes: ['runner:connect'], expiresInSeconds: 3600 })
        expect(response.status).toBe(201)
        const lease = await response.json() as { id: string; token: string; expiresAt: number }
        expect((await s.call(`/projects/${project.id}/capabilities`, { scopes: ['runner:connect', 'git:read'] })).status).toBe(400)
        for (let index = 0; index < 8; index++) expect((await s.call('/runner/authority', undefined, { bearer: lease.token })).status).toBe(200)
        expect(await (await s.call('/runner/authority', undefined, { bearer: lease.token })).json()).toEqual({ projectId: project.id, profile: project.profile, rootPath: project.rootPath, expiresAt: lease.expiresAt })
        const mint = await s.call('/runner/token', {}, { bearer: lease.token })
        expect(mint.status).toBe(200)
        const cap = await mint.json() as { token: string; expiresAt: number; namespace: string }
        expect(cap.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000)
        expect(cap.expiresAt).toBeLessThanOrEqual(lease.expiresAt)
        expect(cap.namespace).toBe(project.namespace)
        expect(s.store.capability(cap.token)).not.toBeNull()
        expect((await s.call('/runner/authority', undefined, { bearer: cap.token })).status).toBe(401)
        expect((await s.call('/runner/token', {}, { bearer: cap.token })).status).toBe(401)
        expect(JSON.stringify(await (await s.call(`/projects/${project.id}/runner-leases`)).json())).not.toContain(lease.token)
        expect((await s.call(`/projects/${project.id}/runner-leases/${lease.id}`, undefined, { method: 'DELETE' })).status).toBe(200)
        expect(s.store.capability(cap.token)).toBeNull()
        expect((await s.call('/runner/authority', undefined, { bearer: lease.token })).status).toBe(401)
        expect(() => exchangeRunnerLease(s.store, lease.token)).toThrow()
        const second = await (await s.call(`/projects/${project.id}/runner-leases`, { name: 'Expiring', expiresInSeconds: 60 })).json() as { id: string; token: string }
        const secondCap = exchangeRunnerLease(s.store, second.token)
        s.store.db.prepare('UPDATE evolved_runner_leases SET expires_at=? WHERE id=?').run(Date.now() - 1, second.id)
        expect(s.store.capability(secondCap.token)).toBeNull()
        expect(() => exchangeRunnerLease(s.store, second.token)).toThrow()
        const third = await (await s.call(`/projects/${project.id}/runner-leases`, { name: 'Downgraded' })).json() as { token: string }
        const thirdCap = exchangeRunnerLease(s.store, third.token), admin = randomUUID()
        s.store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(admin, 'Other admin', Date.now())
        s.store.setMember(userId, team.id, admin, 'admin')
        s.store.setMember(userId, team.id, userId, 'member')
        expect(s.store.capability(thirdCap.token)).toBeNull()
        expect((await s.call('/runner/authority', undefined, { bearer: third.token })).status).toBe(401)
        expect(() => exchangeRunnerLease(s.store, third.token)).toThrow('revoked')
    })
    test('repeating the current profile preserves live runner authority but still requires an administrator', async () => {
        const s = setup(), { userId } = await enroll(s), team = s.store.createTeam(userId, 'Idempotent profile'), project = s.store.createProject(userId, team.id, 'Project')
        const profilePath = `/projects/${project.id}/profile`
        expect((await s.call(profilePath, { profile: 'workspace' }, { method: 'PUT' })).status).toBe(200)
        const issued = await s.call(`/projects/${project.id}/runner-leases`, { name: 'Created after profile change', expiresInSeconds: 3600 })
        expect(issued.status).toBe(201)
        const lease = await issued.json() as { id: string; token: string }
        const exchanged = await s.call('/runner/token', {}, { bearer: lease.token })
        expect(exchanged.status).toBe(200)
        const cap = await exchanged.json() as { id: string; token: string }
        const auditCount = () => (s.store.db.prepare("SELECT COUNT(*) AS count FROM evolved_audit WHERE project_id=? AND action='profile.changed'").get(project.id) as { count: number }).count
        const assertLive = async () => {
            expect((await s.call('/runner/authority', undefined, { bearer: lease.token })).status).toBe(200)
            expect(s.store.capability(cap.token)?.capability?.scopes).toContain('git:write')
            expect(s.store.db.prepare('SELECT revoked_at FROM evolved_runner_leases WHERE id=?').get(lease.id)).toEqual({ revoked_at: null })
            expect(s.store.db.prepare('SELECT revoked_at FROM evolved_capabilities WHERE id=?').get(cap.id)).toEqual({ revoked_at: null })
        }
        await assertLive()
        expect(auditCount()).toBe(1)
        for (let attempt = 0; attempt < 2; attempt++) {
            const repeated = await s.call(profilePath, { profile: 'workspace' }, { method: 'PUT' })
            expect(repeated.status).toBe(200)
            expect(await repeated.json()).toMatchObject({ project: { id: project.id, profile: 'workspace' } })
            await assertLive()
            expect(auditCount()).toBe(1)
        }
        const other = randomUUID(), adminSession = s.jar.get(SESSION_COOKIE)!
        s.store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(other, 'Other account', Date.now())
        for (const role of [null, 'viewer', 'member'] as const) {
            if (role) s.store.setMember(userId, team.id, other, role)
            s.jar.set(SESSION_COOKIE, s.store.createSession(other))
            const denied = await s.call(profilePath, { profile: 'workspace' }, { method: 'PUT' })
            expect(denied.status).toBe(403)
            expect(await denied.json()).toMatchObject({ code: 'forbidden' })
            await assertLive()
            expect(auditCount()).toBe(1)
        }
        s.jar.set(SESSION_COOKIE, adminSession)
        expect((await s.call(profilePath, { profile: 'restricted' }, { method: 'PUT' })).status).toBe(200)
        expect(auditCount()).toBe(2)
        expect((await s.call('/runner/authority', undefined, { bearer: lease.token })).status).toBe(401)
        expect(s.store.capability(cap.token)).toBeNull()
    })
    test('restoring the same profile or membership never resurrects an old runner lease', async () => {
        const s = setup(), { userId } = await enroll(s), team = s.store.createTeam(userId, 'Permanent revocation'), project = s.store.createProject(userId, team.id, 'Project')
        const other = randomUUID(); s.store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(other, 'Replacement admin', Date.now())
        s.store.setMember(userId, team.id, other, 'admin')
        const issue = async () => {
            s.jar.set(SESSION_COOKIE, s.store.createSession(userId))
            const response = await s.call(`/projects/${project.id}/runner-leases`, { name: 'Must not resurrect', scopes: ['runner:connect'], expiresInSeconds: 3600 })
            expect(response.status).toBe(201)
            return (await response.json() as { token: string }).token
        }
        const dead = async (token: string) => {
            expect((await s.call('/runner/authority', undefined, { bearer: token })).status).toBe(401)
            expect(() => exchangeRunnerLease(s.store, token)).toThrow('revoked')
        }
        s.store.setProfile(userId, project.id, 'workspace')
        const profileLease = await issue(), profileCap = exchangeRunnerLease(s.store, profileLease)
        s.store.setProfile(userId, project.id, 'restricted'); s.store.setProfile(userId, project.id, 'workspace')
        await dead(profileLease); expect(s.store.capability(profileCap.token)).toBeNull()
        const membershipLease = await issue()
        s.store.setMember(other, team.id, userId, null); s.store.setMember(other, team.id, userId, 'admin')
        await dead(membershipLease)
        const roleLease = await issue()
        s.jar.set(SESSION_COOKIE, s.store.createSession(other))
        expect((await s.call(`/projects/${project.id}/members`, { userId, role: 'viewer' }, { method: 'PUT' })).status).toBe(200)
        expect((await s.call(`/projects/${project.id}/members`, { userId, role: 'admin' }, { method: 'PUT' })).status).toBe(200)
        await dead(roleLease)
        const resetLease = await issue()
        expect((await s.call(`/projects/${project.id}/members/${userId}`, undefined, { method: 'DELETE' })).status).toBe(200)
        expect(s.store.requireProject(userId, project.id).role).toBe('admin')
        await dead(resetLease)
    })
    test('removed team membership cannot resurrect an old project-administrator override on rejoin', async () => {
        const s = setup(), { userId } = await enroll(s), team = s.store.createTeam(userId, 'Membership team'), project = s.store.createProject(userId, team.id, 'Project')
        const member = randomUUID()
        s.store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(member, 'Member', Date.now())
        s.store.setMember(userId, team.id, member, 'viewer')
        expect((await s.call(`/projects/${project.id}/members`, { userId: member, role: 'admin' }, { method: 'PUT' })).status).toBe(200)
        expect(s.store.requireProject(member, project.id).role).toBe('admin')
        s.store.setMember(userId, team.id, member, null)
        s.store.setMember(userId, team.id, member, 'viewer')
        expect(s.store.requireProject(member, project.id).role).toBe('viewer')
        // Retain a project administrator even when reset would fall back to a lower team role.
        await s.call(`/projects/${project.id}/members`, { userId: member, role: 'admin' }, { method: 'PUT' })
        await s.call(`/projects/${project.id}/members`, { userId, role: 'viewer' }, { method: 'PUT' })
        const cookie = s.store.createSession(member); s.jar.set(SESSION_COOKIE, cookie)
        expect((await s.call(`/projects/${project.id}/members/${member}`, undefined, { method: 'DELETE' })).status).toBe(409)
        expect(s.store.requireProject(member, project.id).role).toBe('admin')
        expect(() => s.store.setMember(userId, team.id, member, null)).toThrow('administrator')
    })
    test('a session revoked during vault metadata lookup cannot authorize the subsequent secret write', async () => {
        let revoke = () => {}; const operations: string[] = []
        const s = setup({ request: async input => { operations.push(input.operation); revoke(); return { secrets: [{ id: 'synthetic-secret', name: 'Service' }] } } })
        const { userId } = await enroll(s), team = s.store.createTeam(userId, 'Vault team'), project = s.store.createProject(userId, team.id, 'Project')
        revoke = () => s.store.revokeSession(s.jar.get(SESSION_COOKIE)!)
        const response = await s.call(`/projects/${project.id}/secrets/synthetic-secret`, { value: 'synthetic-only' }, { method: 'PUT' })
        expect(response.status).toBe(403)
        expect(operations).toEqual(['list'])
    })
    test('passkey replacement supports recovery and prevents removing the last authenticator', async () => {
        const s = setup(), first = await enroll(s)
        const id = first.auth.credentialId.toString('base64url')
        expect((await s.call(`/auth/passkeys/${id}`, undefined, { method: 'DELETE' })).status).toBe(409)
        await s.call('/auth/recovery', { displayName: 'Ada', code: first.codes[0] })
        const options = await (await s.call('/auth/registration/options', {})).json() as { challengeId: string; options: { challenge: string } }
        const replacement = authenticator()
        expect((await s.call('/auth/registration/verify', { challengeId: options.challengeId, response: registration(replacement, options.options.challenge, s.origin) })).status).toBe(200)
        expect((await s.call(`/auth/passkeys/${id}`, undefined, { method: 'DELETE' })).status).toBe(200)
        expect(s.store.passkey(id)).toBeNull()
        expect(s.store.passkeys(first.userId)).toHaveLength(1)
    })
})
