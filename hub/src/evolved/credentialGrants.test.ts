import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { EvolvedStore, hashToken } from './store'
import { EvolvedVault, type VaultClient, type VaultRequest } from './vault'
import { createEvolvedRoutes } from './api'
import type { AgentCredentialGrant } from './agentCredentialVault'
import { withCredentialProjectLock } from './credentialGrants'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
const secretValue = 'SYNTHETIC-ODOO-KEY-never-return-in-metadata'
async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'evolved-agent-grants-')), store = new EvolvedStore(':memory:')
    const vault = new EvolvedVault({ dbPath: ':memory:', masterKeyFile: join(dir, 'master') })
    cleanup.push(() => { vault.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
    for (const user of ['admin', 'member', 'viewer']) store.db.prepare('INSERT INTO evolved_users VALUES(?,?,0,?)').run(user, user, store.now())
    const team = store.createTeam('admin', 'Team'), project = store.createProject('admin', team.id, 'Project')
    store.setMember('admin', team.id, 'member', 'member'); store.setMember('admin', team.id, 'viewer', 'viewer')
    store.db.exec('CREATE TABLE evolved_managed_runners(project_id TEXT PRIMARY KEY,lease_id TEXT NOT NULL,ready INTEGER NOT NULL)')
    const leaseId = randomUUID(), leaseToken = 'a'.repeat(43), now = store.now()
    store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(leaseId, 'Project runner', hashToken(leaseToken), 'admin', project.id, '["runner:connect","git:read"]', '[]', project.profile, now, null)
    store.db.prepare('INSERT INTO evolved_managed_runners VALUES(?,?,1)').run(project.id, leaseId)
    const sessions = Object.fromEntries(['admin', 'member', 'viewer'].map(user => [user, store.createSession(user)]))
    const cap = store.issueCapability('admin', project.id, ['runner:connect', 'git:read'], [], 900, leaseId)
    const stored = await vault.request({ userId: 'admin', projectId: project.id, operation: 'set', payload: { name: 'OdooAPIKey', value: secretValue } }) as { secret: { id: string } }
    let hook: (request: VaultRequest) => Promise<void> = async () => {}
    const calls: VaultRequest[] = []
    const client: VaultClient = { request: async request => { calls.push({ ...request, payload: { ...request.payload, value: undefined } }); await hook(request); return vault.request(request) } }
    const origin = 'https://hapi.test', app = new Hono().route('/api/evolved', createEvolvedRoutes({ store, vault: client, origin }))
    const request = (suffix: string, options: { method?: string; body?: unknown; token?: string; user?: string; projectId?: string } = {}) => app.request(`${origin}/api/evolved/projects/${options.projectId ?? project.id}${suffix}`, {
        method: options.method ?? 'GET', headers: { origin, 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : { cookie: `__Host-hapi-evolved=${sessions[options.user ?? 'admin']}` }) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    const input = () => ({ id: randomUUID(), secretId: stored.secret.id, leaseId, envName: 'PROJECT_SECRET_ODOO_API_KEY', acknowledgeProcessAccess: true })
    const grant = async () => { const response = await request('/secret-grants', { method: 'POST', body: input() }); expect(response.status).toBe(201); return (await response.json() as { grant: AgentCredentialGrant }).grant }
    const environment = (headers: Record<string, string> = {}, body: unknown = {}, signal?: AbortSignal) => app.request(`${origin}/api/evolved/runner/environment`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${leaseToken}`, ...headers }, body: JSON.stringify(body), signal })
    return { store, vault, project, leaseId, leaseToken, cap, sessions, request, environment, grant, input, secretId: stored.secret.id, calls, hook: (value: typeof hook) => { hook = value } }
}

describe('explicit project credential delegation', () => {
    test('saving alone grants nothing; explicit consent binds current lease/profile and metadata never returns values', async () => {
        const f = await setup()
        expect((await (await f.request('/secret-grants')).json() as { grants: unknown[] }).grants).toEqual([])
        expect(await (await f.request('/agent-credentials', { token: f.cap.token })).json()).toMatchObject({ variables: [] })
        const grant = await f.grant()
        const metadata = await (await f.request('/agent-credentials', { token: f.cap.token })).json()
        expect(metadata).toMatchObject({ variables: [{ name: 'PROJECT_SECRET_ODOO_API_KEY', version: 1 }] })
        expect(JSON.stringify(metadata)).not.toContain(secretValue)
        expect(JSON.stringify(metadata)).not.toContain(f.secretId)
        expect((await f.request('/secrets', { token: f.cap.token })).status).toBe(403)
        expect((await f.request('/secret-grants', { token: f.cap.token })).status).toBe(403)
        const bundle = await f.vault.request({ userId: 'admin', projectId: f.project.id, operation: 'agentCredentials', payload: { action: 'resolve', leaseId: f.leaseId, profile: f.project.profile } })
        expect(bundle).toMatchObject({ environment: { PROJECT_SECRET_ODOO_API_KEY: secretValue } })
        expect(grant.leaseId).toBe(f.leaseId)
        expect(JSON.stringify(f.vault.db.query('SELECT * FROM audit').all())).not.toContain(secretValue)
        expect(JSON.stringify(f.vault.db.query('SELECT * FROM agent_credential_grants').all())).not.toContain(secretValue)
    })
    test('rejects implicit consent, members, stale lease/profile, foreign secrets and unsafe variable names', async () => {
        const f = await setup()
        for (const user of ['member', 'viewer']) expect((await f.request('/secret-grants', { user, method: 'POST', body: f.input() })).status).toBe(403)
        for (const envName of ['NODE_OPTIONS', 'PYTHONPATH', 'OPENAI_API_KEY', 'PROJECT_SECRET_']) expect((await f.request('/secret-grants', { method: 'POST', body: { ...f.input(), envName } })).status).toBe(400)
        expect((await f.request('/secret-grants', { method: 'POST', body: { ...f.input(), acknowledgeProcessAccess: false } })).status).toBe(400)
        expect((await f.request('/secret-grants', { method: 'POST', body: { ...f.input(), leaseId: randomUUID() } })).status).toBe(409)
        expect((await f.request('/secret-grants', { method: 'POST', body: { ...f.input(), secretId: randomUUID() } })).status).toBe(404)
        const detached = f.store.issueCapability('admin', f.project.id, ['runner:connect'], [], 900)
        expect((await f.request('/agent-credentials', { token: detached.token })).status).toBe(403)
        f.store.setProfile('admin', f.project.id, 'workspace')
        expect((await f.request('/secret-grants', { method: 'POST', body: f.input() })).status).toBe(409)
    })
    test.each(['revoke', 'rotate', 'delete'] as const)('%s revokes the runner before changing the Vault and invalidates existing capability', async operation => {
        const f = await setup(), grant = await f.grant()
        f.hook(async request => {
            if (request.operation === 'set' || request.operation === 'delete' || request.operation === 'agentCredentials' && request.payload.action === 'revoke') expect(f.store.capability(f.cap.token)).toBeNull()
        })
        const response = operation === 'revoke' ? await f.request(`/secret-grants/${grant.id}`, { method: 'DELETE' })
            : await f.request(`/secrets/${f.secretId}`, { method: operation === 'rotate' ? 'PUT' : 'DELETE', ...(operation === 'rotate' ? { body: { value: 'SYNTHETIC-rotated' } } : {}) })
        expect(response.status).toBe(200)
        expect(f.store.capability(f.cap.token)).toBeNull()
        expect((await f.request('/agent-credentials', { token: f.cap.token })).status).toBe(401)
        expect(await (await f.request('/secret-grants')).json()).toMatchObject({ managedRunner: null })
        const replacement = await f.vault.request({ userId: 'admin', projectId: f.project.id, operation: 'agentCredentials', payload: { action: 'resolve', leaseId: randomUUID(), profile: f.project.profile } })
        expect(replacement).toMatchObject({ environment: {} })
    })
    test('stale passkey and revocation during metadata lookup cannot mutate credentials', async () => {
        const f = await setup(); await f.grant()
        f.hook(async request => { if (request.operation === 'agentCredentials' && request.payload.action === 'list') f.store.revokeSession(f.sessions.admin) })
        expect((await f.request(`/secrets/${f.secretId}`, { method: 'DELETE' })).status).toBe(403)
        expect(f.calls.some(request => request.operation === 'delete')).toBe(false)
        expect(f.store.capability(f.cap.token)).not.toBeNull()
    })
    test('duplicate names, NUL and total-size bounds fail without exposing plaintext', async () => {
        const f = await setup(); await f.grant()
        expect((await f.request('/secret-grants', { method: 'POST', body: f.input() })).status).toBe(409)
        for (const value of ['bad\0value', 'x'.repeat(65536)]) {
            const stored = await f.vault.request({ userId: 'admin', projectId: f.project.id, operation: 'set', payload: { name: randomUUID(), value } }) as { secret: { id: string } }
            const response = await f.request('/secret-grants', { method: 'POST', body: { ...f.input(), secretId: stored.secret.id, envName: 'PROJECT_SECRET_OTHER' } })
            expect([400, 409]).toContain(response.status)
            expect(await response.text()).not.toContain(value)
        }
    })
    test('private runner transport returns only explicitly granted values and rejects browsers, capabilities and arbitrary scope input', async () => {
        const f = await setup()
        const empty = await f.environment()
        expect(empty.status).toBe(200); expect(empty.headers.get('cache-control')).toBe('no-store')
        expect(await empty.json()).toMatchObject({ projectId: f.project.id, environment: {} })
        await f.grant()
        expect(await (await f.environment()).json()).toMatchObject({ environment: { PROJECT_SECRET_ODOO_API_KEY: secretValue } })
        const rejectedHeaders: Array<Record<string, string>> = [{ origin: 'https://hapi.test' }, { cookie: `__Host-hapi-evolved=${f.sessions.admin}` }, { authorization: `Bearer ${f.cap.token}` }, { authorization: '' }]
        for (const headers of rejectedHeaders) {
            const response = await f.environment(headers)
            expect([401, 403]).toContain(response.status)
            expect(await response.text()).not.toContain(secretValue)
        }
        expect((await f.environment({}, { projectId: 'other', leaseId: f.leaseId })).status).toBe(400)
    })
    test.each(['not-ready', 'profile', 'scope'] as const)('private runner transport rejects %s authority', async reason => {
        const f = await setup(); await f.grant()
        if (reason === 'not-ready') f.store.db.query('UPDATE evolved_managed_runners SET ready=0').run()
        if (reason === 'profile') f.store.db.query("UPDATE evolved_runner_leases SET profile='workspace'").run()
        if (reason === 'scope') f.store.db.query("UPDATE evolved_runner_leases SET scopes='[]'").run()
        const response = await f.environment()
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain(secretValue)
    })
    test.each(['no-table', 'unmanaged', 'other-project', 'replaced'] as const)('valid %s runner starts without Vault dependency and never receives former grants', async reason => {
        const f = await setup(); await f.grant()
        if (reason === 'no-table') f.store.db.query('DROP TABLE evolved_managed_runners').run()
        if (reason === 'unmanaged') f.store.db.query('DELETE FROM evolved_managed_runners').run()
        if (reason === 'other-project') f.store.db.query('UPDATE evolved_managed_runners SET project_id=?').run(randomUUID())
        if (reason === 'replaced') f.store.db.query('UPDATE evolved_managed_runners SET lease_id=?').run(randomUUID())
        f.hook(async () => { throw new Error('Manual runner must not contact Vault') })
        const response = await f.environment()
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ projectId: f.project.id, environment: {} })
        f.store.db.query('UPDATE evolved_runner_leases SET revoked_at=?').run(f.store.now())
        expect((await f.environment()).status).toBe(401)
    })
    test('private runner transport rechecks revocation after the Vault response', async () => {
        const f = await setup(); await f.grant()
        f.hook(async request => { if (request.operation === 'agentCredentials' && request.payload.action === 'resolve') f.store.db.query('UPDATE evolved_runner_leases SET revoked_at=? WHERE id=?').run(f.store.now(), f.leaseId) })
        const response = await f.environment()
        expect(response.status).toBe(401)
        expect(await response.text()).not.toContain(secretValue)
    })
    test('a concurrently queued grant cannot bypass rotation revocation', async () => {
        const f = await setup(); await f.grant()
        let release!: () => void
        let listed!: () => void
        const pending = new Promise<void>(resolve => { listed = resolve })
        f.hook(async request => {
            if (request.operation === 'agentCredentials' && request.payload.action === 'list') {
                listed(); await new Promise<void>(resolve => { release = resolve })
            }
        })
        const rotating = f.request(`/secrets/${f.secretId}`, { method: 'PUT', body: { name: 'OdooAPIKey', value: 'SYNTHETIC-rotated' } })
        await pending
        const granting = f.request('/secret-grants', { method: 'POST', body: { ...f.input(), envName: 'PROJECT_SECRET_OTHER' } })
        release()
        expect((await rotating).status).toBe(200)
        expect((await granting).status).toBe(409)
    })
    test('a grantor losing their session during the Vault write cannot leave a usable grant on another live authority', async () => {
        const f = await setup()
        f.hook(async request => { if (request.operation === 'agentCredentials' && request.payload.action === 'grant') f.store.revokeSession(f.sessions.admin) })
        const response = await f.request('/secret-grants', { method: 'POST', body: f.input() })
        expect(response.status).toBe(401)
        expect(f.store.capability(f.cap.token)).toBeNull()
        expect((await f.environment()).status).toBe(401)
    })
    test('an unknown grant write invalidates its lease even if the signed Vault request commits late', async () => {
        const f = await setup(), input = f.input()
        f.hook(async request => { if (request.operation === 'agentCredentials' && request.payload.action === 'grant') throw new Error('Synthetic transport timeout') })
        expect((await f.request('/secret-grants', { method: 'POST', body: input })).status).toBe(500)
        await f.vault.request({ userId: 'admin', projectId: f.project.id, operation: 'agentCredentials', payload: { action: 'grant', id: input.id, secretId: input.secretId, leaseId: input.leaseId, envName: input.envName, profile: f.project.profile } })
        expect(f.store.capability(f.cap.token)).toBeNull()
        expect((await f.environment()).status).toBe(401)
    })
    test('project credential serialization bounds the pending queue and releases capacity after failures', async () => {
        const f = await setup()
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const pending = Array.from({ length: 8 }, () => withCredentialProjectLock(f.store, f.project.id, () => gate))
        await expect(withCredentialProjectLock(f.store, f.project.id, async () => {})).rejects.toThrow('gleichzeitige')
        release(); await Promise.all(pending)
        await expect(withCredentialProjectLock(f.store, f.project.id, async () => { throw new Error('synthetic') })).rejects.toThrow('synthetic')
        expect(await withCredentialProjectLock(f.store, f.project.id, async () => 'available')).toBe('available')
    })
    test('parallel private environment reads return busy without a second Vault read', async () => {
        const f = await setup(); await f.grant()
        let release!: () => void, started!: () => void
        const entered = new Promise<void>(resolve => { started = resolve })
        f.hook(async request => {
            if (request.operation === 'agentCredentials' && request.payload.action === 'resolve') {
                started(); await new Promise<void>(resolve => { release = resolve })
            }
        })
        const first = f.environment(); await entered
        expect((await f.environment()).status).toBe(429)
        expect(f.calls.filter(request => request.operation === 'agentCredentials' && request.payload.action === 'resolve')).toHaveLength(1)
        release(); expect((await first).status).toBe(200)
        f.hook(async () => {})
        expect((await f.environment()).status).toBe(200)
    })
    test.each(['queued', 'resolving'] as const)('aborted private environment read while %s never returns credentials', async phase => {
        const f = await setup(); await f.grant()
        const controller = new AbortController()
        let release!: () => void, started!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const entered = new Promise<void>(resolve => { started = resolve })
        let pendingLock: Promise<void> | undefined
        if (phase === 'queued') pendingLock = withCredentialProjectLock(f.store, f.project.id, () => { started(); return gate })
        else f.hook(async request => { if (request.operation === 'agentCredentials' && request.payload.action === 'resolve') { started(); await gate } })
        const request = f.environment({}, {}, controller.signal)
        await entered; controller.abort(); release()
        if (pendingLock) await pendingLock
        const response = await request
        expect(response.status).toBe(500)
        expect(await response.text()).not.toContain(secretValue)
        if (phase === 'queued') expect(f.calls.some(request => request.operation === 'agentCredentials' && request.payload.action === 'resolve')).toBe(false)
    })
})
