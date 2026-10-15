import { describe, expect, it, vi } from 'vitest';
import { restoreControlSubscriptions } from './controlSubscriptions';

describe('control subscriptions', () => {
    it('continues past one rejected rollout without starving its sibling', async () => {
        const unavailable = vi.fn();
        const request = vi.fn().mockRejectedValueOnce(new Error('missing source rollout')).mockResolvedValue({});
        await restoreControlSubscriptions({ request, isInitialized: () => true }, ['empty', 'live'], unavailable);
        expect(request).toHaveBeenCalledTimes(2);
        expect(unavailable).toHaveBeenCalledExactlyOnceWith('empty', expect.any(Error));
    });
    it('propagates a second transport loss so the outer reconnect loop retries without erasing settings', async () => {
        let initialized = true;
        const unavailable = vi.fn();
        const request = vi.fn(async () => { initialized = false; throw new Error('disconnected'); });
        await expect(restoreControlSubscriptions({ request, isInitialized: () => initialized }, ['one', 'two'], unavailable)).rejects.toThrow('disconnected');
        expect(request).toHaveBeenCalledOnce();
        expect(unavailable).not.toHaveBeenCalled();
    });
});
