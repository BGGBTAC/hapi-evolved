import { describe, expect, it, vi } from 'vitest';
import { SessionReboundDuringStop, SessionStopGuards } from './sessionStopGuard';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe('session stop registration guard', () => {
    it('recognizes a late report from the detached generation only while its stop is pending', async () => {
        const guards = new SessionStopGuards();
        const ack = deferred();
        const stop = guards.during('root', guard => guard.run(() => ack.promise), 'generation-one');
        expect(guards.isStoppingGeneration('root', 'generation-one')).toBe(true);
        expect(guards.isStoppingGeneration('root', 'generation-two')).toBe(false);
        expect(guards.isStoppingGeneration('root', undefined)).toBe(false);
        ack.resolve(); await stop;
        expect(guards.isStoppingGeneration('root', 'generation-one')).toBe(false);
    });

    it('prevents detach and cache cleanup when the same root registers before stop ACK', async () => {
        const guards = new SessionStopGuards();
        const ack = deferred();
        const detach = vi.fn();
        const release = vi.fn();
        const stopped = guards.during('root', async guard => {
            await guard.run(() => ack.promise);
            detach();
            release();
        });
        guards.registered('root');
        ack.resolve();
        await expect(stopped).rejects.toBeInstanceOf(SessionReboundDuringStop);
        expect(detach).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });

    it('does not start another orphan kill after re-registration during a sweep', async () => {
        const guards = new SessionStopGuards();
        const firstKill = deferred();
        const secondKill = vi.fn(async () => true);
        const stopped = guards.during('root', async guard => {
            try { await guard.run(() => firstKill.promise); } catch { /* sweep catches failed kills */ }
            await guard.run(secondKill);
        });
        guards.registered('root');
        firstKill.resolve();
        await expect(stopped).rejects.toBeInstanceOf(SessionReboundDuringStop);
        expect(secondKill).not.toHaveBeenCalled();
    });

    it('invalidates concurrent stops only for the registered root, without poisoning later stops', async () => {
        const guards = new SessionStopGuards();
        const ack = deferred();
        const stop = (id: string) => guards.during(id, guard => guard.run(() => ack.promise));
        const first = stop('root');
        const second = stop('root');
        const sibling = stop('sibling');
        guards.registered('root');
        ack.resolve();
        await expect(first).rejects.toBeInstanceOf(SessionReboundDuringStop);
        await expect(second).rejects.toBeInstanceOf(SessionReboundDuringStop);
        await expect(sibling).resolves.toBeUndefined();
        await expect(guards.during('root', guard => guard.run(async () => 'stopped'))).resolves.toBe('stopped');
    });
});
