import { describe, it, expect } from 'vitest'
import { HistoryPageCache } from './history-page-cache'
import type { MessagesResponse } from '@/types/api'
const page = (epoch = 1): MessagesResponse => ({ messages: [], page: { direction: 'before', limit: 200, reset: false, nextAfterSeq: null, nextAfterAt: null, epoch, hasMore: true, nextBeforeAt: 1, nextBeforeSeq: 1, snapshotHeadAt: 5, snapshotHeadSeq: 5 } }) as MessagesResponse

describe('history page cache boundaries', () => {
    it('binds pages to API identity, session, epoch and cursor, with bounded LRU eviction', () => {
        const cache = new HistoryPageCache(2); const owner = {}; const response = page()
        cache.put(owner, 'a', 1, 10, 10, response)
        expect(cache.get(owner, 'a', 1, 10, 10)).toBe(response)
        expect(cache.get({}, 'a', 1, 10, 10)).toBeUndefined()
        expect(cache.get(owner, 'b', 1, 10, 10)).toBeUndefined()
        expect(cache.get(owner, 'a', 2, 10, 10)).toBeUndefined()
        cache.put(owner, 'a', 1, 9, 9, page()); cache.get(owner, 'a', 1, 10, 10)
        cache.put(owner, 'a', 1, 8, 8, page())
        expect(cache.get(owner, 'a', 1, 9, 9)).toBeUndefined()
        cache.clear('a'); expect(cache.get(owner, 'a', 1, 10, 10)).toBeUndefined()
        cache.put(owner, 'a', 1, 1, 1, response); cache.clear()
        expect(cache.get(owner, 'a', 1, 1, 1)).toBeUndefined()
    })
    it('does not cache unknown/changed epochs or oversized responses', () => {
        const cache = new HistoryPageCache(2, 8); const owner = {}
        cache.put(owner, 'a', null, 1, 1, page()); cache.put(owner, 'a', 1, 1, 1, page(2)); cache.put(owner, 'a', 1, 1, 1, page())
        expect(cache.get(owner, 'a', 1, 1, 1)).toBeUndefined()
    })
})
