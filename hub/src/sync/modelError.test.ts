import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('persistent model error acknowledgement', () => {
    it('checks namespace and observed error version, and never clears a newer failure', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('error', {
                path: '/synthetic', host: 'fixture', flavor: 'cursor',
                lastModelError: { kind: 'transport_closed', message: 'Synthetic failure', at: 100 },
            }, null, 'project-one')
            expect(() => engine.acknowledgeModelError(session.id, 'project-two', 100)).toThrow()
            expect(() => engine.acknowledgeModelError(session.id, 'project-one', 99)).toThrow()
            engine.acknowledgeModelError(session.id, 'project-one', 100)
            expect(engine.getSession(session.id)?.metadata?.lastModelError?.acknowledgedAt).toBeGreaterThan(0)
            const current = store.sessions.getSession(session.id)!
            store.sessions.updateSessionMetadata(session.id, { ...current.metadata!, lastModelError: {
                kind: 'prompt_failed', message: 'A newer failure', at: 200,
            } }, current.metadataVersion, 'project-one')
            // Cache still contains the old error: versioned persistence must
            // reject stale ACK without overwriting the newer failure.
            expect(() => engine.acknowledgeModelError(session.id, 'project-one', 100)).toThrow()
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ lastModelError: { kind: 'prompt_failed', message: 'A newer failure', at: 200 } })
        } finally { engine.stop() }
    })
})
