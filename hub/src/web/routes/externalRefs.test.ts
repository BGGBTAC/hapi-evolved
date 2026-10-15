import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { parseGithubPrInput } from '@hapi/protocol'
import { Store } from '../../store'
import { SyncEngine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { createExternalRefsRoutes } from './externalRefs'
import { createGithubPrRunnerRoutes } from '../../evolved/githubPr'
import { EvolvedError, EvolvedStore } from '../../evolved/store'
import { githubPrFeature, setGithubPrFeature } from '../../config/githubPrAwareness'
import type { WebAppEnv } from '../middleware/auth'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'pr-refs-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = new Store(':memory:'), evolved = new EvolvedStore(':memory:')
    const io = { of: () => ({ to: () => ({ emit() {} }), adapter: { rooms: new Map() } }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    cleanup.push(() => { engine.stop(); store.close(); evolved.close() })
    evolved.db.prepare('INSERT INTO evolved_users VALUES(?,?,1,?)').run('alice', 'Alice', Date.now())
    const team = evolved.createTeam('alice', 'Team'), project = evolved.createProject('alice', team.id, 'Project')
    const session = engine.getOrCreateSession('source', { path: '/work', host: 'local' }, null, project.namespace)
    const outsider = engine.getOrCreateSession('outside', { path: '/other', host: 'local' }, null, 'outside')
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => { c.set('namespace', c.req.header('x-test-ns') ?? project.namespace); await next() })
    app.route('/api', createExternalRefsRoutes(() => engine, dir))
    const runner = new Hono().route('/api/evolved', createGithubPrRunnerRoutes(evolved, () => engine, dir))
    runner.onError((e, c) => c.json({ error: e.message }, e instanceof EvolvedError ? e.status as 400 : 500))
    const grant = evolved.issueCapability('alice', project.id, ['runner:connect'], [], 600)
    const call = (path: string, method = 'GET', body?: unknown, namespace?: string) => app.request(`/api${path}`, {
        method, headers: { 'content-type': 'application/json', ...(namespace ? { 'x-test-ns': namespace } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const link = (pr: string, sessionId = session.id, token = grant.token) => runner.request('/api/evolved/github-pr/link', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, pr })
    })
    return { dir, store, evolved, engine, project, session, outsider, app, grant, call, link }
}
test('feature defaults off, persists toggle and refuses unauthorized/pinned changes', async () => {
    const t = setup()
    expect(githubPrFeature(t.dir).enabled).toBe(false)
    expect((await t.call('/features', 'PATCH', { githubPrAwareness: true })).status).toBe(403)
    expect((await t.call('/features', 'PATCH', { githubPrAwareness: true }, 'default')).status).toBe(200)
    expect(githubPrFeature(t.dir)).toEqual({ enabled: true, source: 'file' })
    expect(githubPrFeature(t.dir, '0')).toEqual({ enabled: false, source: 'env' })
    expect(() => setGithubPrFeature(t.dir, true, '0')).toThrow()
})
test('canonical human refs are namespace scoped, provenance protected and retained while off', async () => {
    const t = setup(), ref = parseGithubPrInput('owner/repo#42')!
    const path = `/sessions/${t.session.id}/external-refs`
    expect((await t.call(path, 'PUT', { externalRefs: [ref] })).status).toBe(403)
    setGithubPrFeature(t.dir, true)
    expect((await t.call(`/sessions/${t.outsider.id}/external-refs`, 'PUT', { externalRefs: [ref] })).status).toBe(403)
    expect((await t.call(path, 'PUT', { externalRefs: [{ ...ref, url: 'javascript:alert(1)' }] })).status).toBe(400)
    expect((await t.call(path, 'PUT', { externalRefs: [{ ...ref, source: 'agent' }] })).status).toBe(200)
    let row = t.store.sessions.getSession(t.session.id)!
    const original = (row.metadata as any).externalRefs
    expect(original[0].source).toBe('user')
    t.store.sessions.updateSessionMetadata(t.session.id, { ...(row.metadata as object), externalRefs: [] }, row.metadataVersion, t.project.namespace)
    row = t.store.sessions.getSession(t.session.id)!
    expect((row.metadata as any).externalRefs).toEqual(original)
    expect(t.store.sessions.updateSessionMetadata(t.session.id, null, row.metadataVersion, t.project.namespace).result).toBe('error')
    const child = t.store.sessions.getOrCreateSession('new-identity', row.metadata, null, t.project.namespace)
    expect((child.metadata as any).externalRefs).toBeUndefined()
    expect((t.store.sessions.getOrCreateSession('source', {}, null, t.project.namespace).metadata as any).externalRefs).toEqual(original)
    setGithubPrFeature(t.dir, false)
    expect((await t.call(path, 'PUT', { externalRefs: [] })).status).toBe(403)
    expect((await (await t.call(path)).json() as any).externalRefs).toEqual(original)
})
test('runner links require live project authorization and preserve human choices and secondaries', async () => {
    const t = setup()
    expect((await t.link('owner/repo#1')).status).toBe(403)
    setGithubPrFeature(t.dir, true)
    expect((await t.link('owner/repo#1', t.outsider.id)).status).toBe(404)
    expect((await t.link('owner/repo#1')).status).toBe(200)
    expect((t.engine.getSession(t.session.id)?.metadata?.externalRefs?.[0])?.source).toBe('agent')
    const secondary = { ...parseGithubPrInput('owner/second#2')!, role: 'secondary' as const, source: 'user' as const }
    await t.engine.setSessionExternalRefs(t.session.id, t.project.namespace, [parseGithubPrInput('owner/repo#1')!, secondary])
    expect((await t.link('owner/repo#3')).status).toBe(200)
    expect(t.engine.getSession(t.session.id)?.metadata?.externalRefs).toContainEqual(secondary)
    await t.call(`/sessions/${t.session.id}/external-refs`, 'PUT', { externalRefs: [{ ...parseGithubPrInput('human/choice#4')!, source: 'user' }, secondary] })
    expect((await t.link('owner/repo#5')).status).toBe(409)
    expect((await t.link('human/choice#4')).status).toBe(200)
    t.evolved.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE id=?').run(Date.now(), t.grant.id)
    expect((await t.link('human/choice#4')).status).toBe(403)
})
