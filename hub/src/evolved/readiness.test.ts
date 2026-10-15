import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolvedStore } from './store'
import { createReadinessRoutes } from './readiness'
import type { ProjectReadiness } from '@hapi/protocol/evolvedWorkspace'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { SyncEngine } from '../sync/syncEngine'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function setup() {
    const root = mkdtempSync(join(tmpdir(), 'evolved-readiness-')), store = new EvolvedStore(':memory:')
    cleanups.push(() => store.close(), () => rmSync(root, { recursive: true, force: true }))
    for (const id of ['alice', 'bob']) store.db.query('INSERT INTO evolved_users VALUES(?,?,?,?)').run(id, id, 0, Date.now())
    const team = store.createTeam('alice', 'A'), project = store.createProject('alice', team.id, 'A')
    store.db.query("UPDATE evolved_projects SET root_path=?,profile='workspace' WHERE id=?").run(root, project.id)
    const machine = { id: 'machine', active: true, metadata: { workspaceRoots: [root], capabilities: [...CURRENT_MACHINE_CAPABILITIES] } }
    let probeFails = false, revoked = false, online = true, providerReads = 0, graphReads = 0
    const rpcCalls: unknown[] = []
    const engine = {
        getOnlineMachinesByNamespace: () => online ? [machine] : [],
        evolvedRepositories: async (_id: string, request: unknown) => { rpcCalls.push(request); if (probeFails) throw new Error('RPC target missing'); return [] },
        getAgentAvailability: async () => ({ agents: [{ agent: 'claude', available: true }] }),
    } as unknown as Pick<SyncEngine, 'getOnlineMachinesByNamespace' | 'evolvedRepositories' | 'getAgentAvailability'>
    const app = new Hono().route('/api/evolved', createReadinessRoutes({ store, origin: 'https://hapi.test', getEngine: () => engine,
        memoryAvailable: async () => false,
        graphStatus: () => { graphReads++; return { rootPath: root, checkedAt: Date.now(), status: 200, result: { state: 'ready', available: true } } },
        readResource: async (_request, _id, resource) => {
            if (revoked) { store.setMember('alice', team.id, 'bob', 'admin'); store.setMember('bob', team.id, 'alice', null) }
            if (resource === 'providers') { providerReads++; return { status: 200, body: { providers: [{ provider: 'claude', status: 'connected' }, { provider: 'codex', status: 'disconnected' }] } } }
            return { status: 200, body: { connected: true, repositories: [{ local: { state: 'ready' } }] } }
        },
    }))
    const token = store.createSession('alice')
    const request = () => app.request(`https://hapi.test/api/evolved/projects/${project.id}/readiness`, { headers: { cookie: `__Host-hapi-evolved=${token}` } })
    return { store, team, project, request, rpcCalls, setProbeFails: () => { probeFails = true }, revoke: () => { revoked = true }, offline: () => { online = false }, counts: () => ({ providerReads, graphReads }) }
}
describe('project readiness without provisioning', () => {
    test('uses an empty read-only RPC probe and cached graph state; optional graph memory is independent', async () => {
        const f = setup(), response = await f.request(), body = await response.json() as ProjectReadiness
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(f.rpcCalls).toEqual([{ action: 'status', projectId: f.project.id, repositories: [] }])
        expect(body.purposes).toEqual({ plan: 'ok', code: 'ok' })
        expect(body.items.find(item => item.key === 'memory')?.reasonCode).toBe('memory_ledger_ready')
        expect(f.counts()).toEqual({ providerReads: 1, graphReads: 1 })
        const cached = await (await f.request()).json() as ProjectReadiness
        expect(cached.checkedAt).toBe(body.checkedAt)
        expect(f.counts()).toEqual({ providerReads: 1, graphReads: 1 })
        f.store.setMember('alice', f.team.id, 'bob', 'admin'); f.store.setMember('bob', f.team.id, 'alice', null)
        expect((await f.request()).status).toBe(403)
    })
    test('active socket with missing RPC is stale, offline is missing, neither is ready', async () => {
        const f = setup(); f.setProbeFails()
        const body = await (await f.request()).json() as ProjectReadiness
        expect(body.items.find(item => item.key === 'rpc')?.state).toBe('stale')
        expect(body.purposes.plan).toBe('stale')
        f.offline()
        const offline = await (await f.request()).json() as ProjectReadiness
        expect(offline.items.find(item => item.key === 'runner')?.state).toBe('missing')
        expect(offline.purposes.plan).toBe('missing')
    })
    test('viewers can read diagnostics but never cause an admin provider read', async () => {
        const f = setup()
        f.store.setMember('alice', f.team.id, 'bob', 'admin'); f.store.setMember('bob', f.team.id, 'alice', 'viewer')
        const body = await (await f.request()).json() as ProjectReadiness
        expect(body.items.find(item => item.key === 'providers')?.state).toBe('denied')
        expect(body.items.find(item => item.key === 'agents')?.state).toBe('denied')
        expect(f.counts().providerReads).toBe(0)
    })
    test('authority revoked while diagnostics await prevents every partial response', async () => {
        const f = setup(); f.revoke()
        expect((await f.request()).status).toBe(403)
    })
})
