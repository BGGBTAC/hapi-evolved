import { afterEach, expect, test } from 'bun:test'
import { EvolvedStore } from './store'
import { consumePeerRate, ensurePeerTables } from './peers'
import { PeerCompletionReporter } from './peerReports'
import { Store } from '../store'
import { SyncEngine } from '../sync/syncEngine'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { SyncEvent } from '@hapi/protocol/types'

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })
async function setup() {
    const store = new EvolvedStore(':memory:'), messages = new Store(':memory:')
    store.db.prepare('INSERT INTO evolved_users VALUES(?,?,?,?)').run('alice', 'Alice', 1, Date.now())
    const team = store.createTeam('alice', 'Team'), project = store.createProject('alice', team.id, 'P')
    const engine = new SyncEngine(messages, { of: () => ({ to: () => ({ emit() {} }), adapter: { rooms: new Map() } }) } as never, new RpcRegistry(), { broadcast() {} } as never)
    cleanups.push(() => { engine.stop(); messages.close(); store.close() })
    const parent = engine.getOrCreateSession('parent', { path: '/tmp', host: 'local', flavor: 'claude' }, null, project.namespace)
    const child = engine.getOrCreateSession('child', { path: '/tmp', host: 'local', flavor: 'codex' }, null, project.namespace)
    const grant = store.issueCapability('alice', project.id, ['peers:send'], [], 600)
    ensurePeerTables(store)
    store.db.prepare('INSERT INTO evolved_peer_policy VALUES(?,1)').run(project.id)
    store.db.prepare('INSERT INTO evolved_peer_children VALUES(?,?,?,?,1,?,?,?,?,NULL)').run(project.id, child.id, parent.id, Date.now(), 'spawn-1', 'alice', project.profile, grant.id)
    await engine.sendMessage(child.id, { text: 'Initial remit', localId: 'peer-spawn:spawn-1', trustedPeer: { projectId: project.id, claimedSenderSessionId: parent.id, recipientSessionId: child.id, deliveryId: 'spawn-1' } })
    messages.messages.markMessagesInvoked(child.id, ['peer-spawn:spawn-1'], Date.now())
    const reporter = new PeerCompletionReporter(store, engine)
    const event = (turnId: string): SyncEvent => ({ type: 'message-received', sessionId: child.id, message: { id: `done-${turnId}`, seq: 100, localId: `codex:thread:${turnId}:hapi-turn-completed`, createdAt: Date.now(), content: { role: 'agent', content: { type: 'codex', data: { type: 'hapi-turn-completed', turnId, status: 'completed', finalText: 'Tests passed.' } } } } })
    return { store, messages, engine, parent, child, project, grant, reporter, event }
}
function permanentLease(t: Awaited<ReturnType<typeof setup>>) {
    t.store.db.prepare('INSERT INTO evolved_runner_leases VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)').run('permanent-lease', 'Permanent runner', 'synthetic-unused-lease-hash', 'alice', t.project.id, '["peers:send"]', '[]', t.project.profile, Date.now())
    t.store.db.prepare("UPDATE evolved_peer_children SET lease_id='permanent-lease' WHERE child_id=?").run(t.child.id)
    // Auto-report authority follows the outer lease, not an expired exchanged capability.
    t.store.db.prepare('UPDATE evolved_capabilities SET expires_at=0 WHERE id=?').run(t.grant.id)
}
test('permanent runner authority permits completion reports while standalone capabilities still expire', async () => {
    const t = await setup()
    t.store.db.prepare('UPDATE evolved_capabilities SET expires_at=0 WHERE id=?').run(t.grant.id)
    await t.reporter.handle(t.event('expired-capability'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
    permanentLease(t)
    await t.reporter.handle(t.event('permanent-runner'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(1)
})
test.each(['revoked', 'missing scope', 'profile mismatch'] as const)('permanent completion report authority rejects %s', async reason => {
    const t = await setup(); permanentLease(t)
    if (reason === 'revoked') t.store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=?').run(Date.now())
    if (reason === 'missing scope') t.store.db.exec("UPDATE evolved_runner_leases SET scopes='[\"peers:read\"]'")
    if (reason === 'profile mismatch') t.store.db.exec("UPDATE evolved_runner_leases SET profile='workspace'")
    await t.reporter.handle(t.event('blocked-permanent-runner'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
})
test('permanent lease revocation during prompt lookup prevents report dispatch', async () => {
    const t = await setup(); permanentLease(t)
    const lookup = t.engine.getLatestUserMessage.bind(t.engine)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    t.engine.getLatestUserMessage = async sessionId => { await gate; return lookup(sessionId) }
    const handling = t.reporter.handle(t.event('permanent-revoked-during-lookup'))
    t.store.db.prepare('UPDATE evolved_runner_leases SET revoked_at=?').run(Date.now())
    release()
    await handling
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
    expect(t.store.db.query('SELECT COUNT(*) AS n FROM evolved_peer_reports').get()).toEqual({ n: 0 })
})
test('completion reports resolve only the hub-owned parent and deduplicate across reporter restarts', async () => {
    const t = await setup()
    await t.reporter.handle(t.event('turn-1'))
    await new PeerCompletionReporter(t.store, t.engine).handle(t.event('turn-1'))
    await t.reporter.handle(t.event('forged-new-turn-same-prompt'))
    const received = t.messages.messages.getMessages(t.parent.id, 10)
    expect(received).toHaveLength(1)
    expect(JSON.stringify(received[0]!.content)).toContain('Tests passed.')
    expect(JSON.stringify(received[0]!.content)).toContain('"trust":"project-runner"')
    expect(JSON.stringify(received[0]!.content)).not.toContain('"trust":"session"')
})
test('ordinary peer turns cannot auto-report back and revoked approvals stop reports', async () => {
    const t = await setup()
    await t.engine.sendMessage(t.child.id, { text: 'Peer reply', localId: 'peer:reply', trustedPeer: { projectId: t.project.id, claimedSenderSessionId: t.parent.id, recipientSessionId: t.child.id, deliveryId: 'reply' } })
    t.messages.messages.markMessagesInvoked(t.child.id, ['peer:reply'], Date.now())
    await t.reporter.handle(t.event('turn-2'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
    t.messages.messages.addMessage(t.child.id, { role: 'user', content: { type: 'text', text: 'Human next turn' } })
    t.store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE id=?').run(Date.now(), t.grant.id)
    await t.reporter.handle(t.event('turn-3'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
})
test('unregistered children cannot choose their own callback recipient', async () => {
    const t = await setup()
    t.store.db.prepare('DELETE FROM evolved_peer_children WHERE child_id=?').run(t.child.id)
    await t.reporter.handle(t.event('turn-1'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
})


test('a queued unconsumed human prompt cannot authorize reporting a peer turn', async () => {
    const t = await setup()
    await t.engine.sendMessage(t.child.id, { text: 'Peer turn', localId: 'peer:followup', trustedPeer: { projectId: t.project.id, claimedSenderSessionId: t.parent.id, recipientSessionId: t.child.id, deliveryId: 'followup' } })
    t.messages.messages.markMessagesInvoked(t.child.id, ['peer:followup'], Date.now())
    await t.engine.sendMessage(t.child.id, { text: 'Queued new request', localId: 'not-consumed' })
    await t.reporter.handle(t.event('turn-with-unknown-cause'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
})

test('rate-limited reports remain durably visible and cannot replay after restart', async () => {
    const t = await setup()
    for (let count = 0; count < 30; count++) consumePeerRate(t.store, t.project.id, 'report', 30)
    await t.reporter.handle(t.event('turn-limited'))
    expect(t.store.db.prepare('SELECT state FROM evolved_peer_reports WHERE child_id=? AND turn_id=?').get(t.child.id, 'turn-limited'))
        .toEqual({ state: 'rate_limited' })
    t.store.db.exec('DELETE FROM evolved_peer_rates')
    await new PeerCompletionReporter(t.store, t.engine).handle(t.event('turn-limited'))
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
})

test('revocation while the upgrade lookup yields prevents report dispatch', async () => {
    const t = await setup()
    const lookup = t.engine.getLatestUserMessage.bind(t.engine)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    t.engine.getLatestUserMessage = async sessionId => { await gate; return lookup(sessionId) }
    const handling = t.reporter.handle(t.event('turn-revoked-during-lookup'))
    t.store.db.prepare('UPDATE evolved_capabilities SET revoked_at=? WHERE id=?').run(Date.now(), t.grant.id)
    release()
    await handling
    expect(t.messages.messages.getMessages(t.parent.id, 10)).toHaveLength(0)
    expect(t.store.db.prepare('SELECT COUNT(*) AS n FROM evolved_peer_reports').get()).toEqual({ n: 0 })
})
