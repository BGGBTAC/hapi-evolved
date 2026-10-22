import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Session } from '@hapi/protocol/types'
import { createConfiguration } from '../../configuration'
import { CursorLegacyMigrator, workspaceHashFromPath } from '../../cursor/cursorLegacyMigrator'
import { buildSyntheticLegacyStore } from '../../cursor/fixtures/buildSyntheticLegacyStore'
import { createProjectAuthMiddleware, createSessionTokenRoutes } from '../../evolved/bridge'
import { EvolvedStore } from '../../evolved/store'
import { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createCliRoutes } from './cli'
import { createSessionsRoutes } from './sessions'

// Legacy Cursor migration rewrites hub-host files named by session metadata and
// spawns `agent`. Only the hub owner may run it; the agent lookup home is never
// the client-reported metadata.homeDir. Uses synthetic stores and a mock probe.

const okRpc = { ok: true, result: {} }
const originalHapiHome = process.env.HAPI_HOME
let configHome = ''
let dir = ''
const stores: EvolvedStore[] = []

beforeAll(async () => {
    configHome = mkdtempSync(join(tmpdir(), 'hapi-migration-auth-config-'))
    process.env.HAPI_HOME = configHome
    const config = await createConfiguration()
    config._setCliApiToken('owner-token', 'env', false)
})
afterAll(() => {
    if (originalHapiHome === undefined) delete process.env.HAPI_HOME
    else process.env.HAPI_HOME = originalHapiHome
    rmSync(configHome, { recursive: true, force: true })
})
afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
})

function fixture(namespace: string) {
    dir = mkdtempSync(join(tmpdir(), 'hapi-migration-auth-'))
    const projectRoot = join(dir, 'project'), operatorHome = join(dir, 'operator'), reportedHome = join(dir, 'metadata-home'), probeTemp = join(dir, 'probe-tmp')
    for (const path of [projectRoot, operatorHome, reportedHome, probeTemp]) mkdirSync(path)
    const cursorSessionId = 'fixture-cursor'
    const source = join(reportedHome, '.cursor', 'chats', workspaceHashFromPath(projectRoot), cursorSessionId, 'store.db')
    buildSyntheticLegacyStore({ path: source })
    const session = {
        id: 'fixture-session', namespace, active: false,
        metadata: { flavor: 'cursor', path: projectRoot, homeDir: reportedHome, host: 'fixture-host', cursorSessionId }
    } as unknown as Session
    const calls = { access: 0, migrate: 0, updates: 0, lookupHomes: [] as string[] }
    const migrator = new CursorLegacyMigrator({}, {
        homeDir: () => operatorHome,
        hostName: () => 'fixture-host',
        tmpDir: () => probeTemp,
        getHapiMessageCount: () => 0,
        archiveSession: async () => {},
        acquireAcpActiveLock: () => ({ release() {} }),
        awaitLockRelease: async () => true,
        checkpointLegacyStore: () => {},
        updateSessionAfterMigrate: () => { calls.updates++; return { ok: true } },
        createProbe: (_env, lookupHome) => {
            calls.lookupHomes.push(lookupHome)
            return {
                start() {}, async stop() {},
                async initialize() { return okRpc },
                async loadSession() { return { response: okRpc, notificationCount: 0, notificationKinds: {}, durationMs: 0 } },
                async prompt() { return { response: okRpc, durationMs: 0 } }
            } as never
        }
    })
    const engine = {
        resolveSessionAccess: (_id: string, ns: string) => {
            calls.access++
            return ns === namespace ? { ok: true, session, sessionId: session.id } : { ok: false, reason: 'access-denied' }
        },
        migrateLegacyCursorSession: async (_id: string, _ns: string, request: unknown) => {
            calls.migrate++
            return migrator.migrateOne(session, request as never)
        }
    }
    const target = (home: string) => join(home, '.cursor', 'acp-sessions', cursorSessionId, 'store.db')
    const noSideEffects = () => {
        expect(calls).toEqual({ access: 0, migrate: 0, updates: 0, lookupHomes: [] })
        expect(existsSync(target(reportedHome))).toBe(false)
        expect(existsSync(target(operatorHome))).toBe(false)
        expect(existsSync(source)).toBe(true)
    }
    return { projectRoot, operatorHome, reportedHome, source, session, calls, engine, target, noSideEffects }
}

const post = (token: string, extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
    body: JSON.stringify({ keepSource: true })
})

describe('legacy Cursor migration authorization', () => {
    it('denies an Evolved runner capability with 403 before any side effect', async () => {
        const store = new EvolvedStore(':memory:'); stores.push(store)
        store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('fixture-user', 'fixture-user', 1, Date.now())
        const team = store.createTeam('fixture-user', 'Fixture')
        dir = ''
        const projectDir = mkdtempSync(join(tmpdir(), 'hapi-migration-project-'))
        try {
            const project = store.createProject('fixture-user', team.id, 'Project', projectDir)
            const f = fixture(project.namespace)
            const grant = store.issueCapability('fixture-user', project.id, ['runner:connect'], [], 600)
            const app = new Hono()
            app.route('/cli', createCliRoutes(() => f.engine as never, store))
            const response = await app.request('/cli/sessions/fixture-session/migrate-to-acp', post(grant.token))
            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: 'Legacy Cursor migration is only available to the hub owner' })
            f.noSideEffects()
        } finally { rmSync(projectDir, { recursive: true, force: true }) }
    })

    it('denies a non-owner CLI namespace token with 403 before any side effect', async () => {
        const f = fixture('alice')
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => f.engine as never))
        const response = await app.request('/cli/sessions/fixture-session/migrate-to-acp', post('owner-token:alice'))
        expect(response.status).toBe(403)
        f.noSideEffects()
    })

    it('keeps owner migration of metadata.homeDir data while looking up the agent only under the operator home', async () => {
        const f = fixture('default')
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => f.engine as never))
        const response = await app.request('/cli/sessions/fixture-session/migrate-to-acp', post('owner-token'))
        expect(response.status).toBe(200)
        expect((await response.json() as { ok: boolean }).ok).toBe(true)
        expect(f.calls.migrate).toBe(1)
        expect(f.calls.updates).toBe(1)
        expect(f.calls.lookupHomes).toEqual([f.operatorHome])
        expect(existsSync(f.target(f.reportedHome))).toBe(true)
        expect(existsSync(f.source)).toBe(true)
    })

    it('denies the Evolved project web route at the project boundary', async () => {
        const store = new EvolvedStore(':memory:'); stores.push(store)
        store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('alice', 'alice', 1, Date.now())
        const projectDir = mkdtempSync(join(tmpdir(), 'hapi-migration-project-'))
        try {
            const project = store.createProject('alice', store.createTeam('alice', 'Alpha').id, 'A', projectDir)
            const f = fixture(project.namespace)
            const secret = new Uint8Array(32).fill(7), origin = 'https://evolved.test'
            const app = new Hono<WebAppEnv>()
            app.route('/api/evolved', createSessionTokenRoutes(store, secret, origin))
            app.use('/api/*', createProjectAuthMiddleware(store, secret, origin))
            app.route('/api', createSessionsRoutes(() => f.engine as never))
            const minted = await app.request(`/api/evolved/session-token?projectId=${project.id}`, { headers: { cookie: `__Host-hapi-evolved=${store.createSession('alice')}` } })
            const { token } = await minted.json() as { token: string }
            const response = await app.request('/api/sessions/fixture-session/migrate-to-acp', post(token, { origin }))
            expect(response.status).toBe(403)
            f.noSideEffects()
        } finally { rmSync(projectDir, { recursive: true, force: true }) }
    })

    it('denies a non-owner namespace on the web route itself, and admits the owner', async () => {
        const denied = fixture('evolved-project')
        const app = (namespace: string, engine: unknown) => {
            const web = new Hono<WebAppEnv>()
            web.use('*', async (c, next) => { c.set('namespace', namespace); await next() })
            web.route('/api', createSessionsRoutes(() => engine as never))
            return web
        }
        const response = await app('evolved-project', denied.engine).request('/api/sessions/fixture-session/migrate-to-acp', post('unused'))
        expect(response.status).toBe(403)
        denied.noSideEffects()
        rmSync(dir, { recursive: true, force: true })

        const owner = fixture('default')
        const ok = await app('default', owner.engine).request('/api/sessions/fixture-session/migrate-to-acp', post('unused'))
        expect(ok.status).toBe(200)
        expect(owner.calls.lookupHomes).toEqual([owner.operatorHome])
    })

    it('refuses engine-level and auto-migration entrypoints for non-owner namespaces', async () => {
        const f = fixture('evolved-project')
        const untouched = {
            get sessionCache(): never { throw new Error('session cache must not be consulted') },
            buildMigratorForRequest(): never { throw new Error('migrator must not be built') },
            setCursorMigrationStateInProgress(): never { throw new Error('banner must not be set') }
        }
        const outcome = await SyncEngine.prototype.migrateLegacyCursorSession.call(untouched as never, f.session.id, 'evolved-project', {})
        expect(outcome).toMatchObject({ ok: false, reason: 'internal_error' })
        const autoMigrate = (SyncEngine.prototype as unknown as { maybeAutoMigrateLegacyCursorSession(session: Session, namespace: string): Promise<Session> }).maybeAutoMigrateLegacyCursorSession
        expect(await autoMigrate.call(untouched, f.session, 'evolved-project')).toBe(f.session)
        expect(await autoMigrate.call(untouched, f.session, 'default')).toBe(f.session)
        f.noSideEffects()
    })
})
