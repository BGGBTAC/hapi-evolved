import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { isSessionBlocked, matchesSessionStatus, sessionActivityAt } from './sessionActivity'
const session = { updatedAt: 900, lastMessageAt: 100, lastAssistantMessageAt: 80, active: true, thinking: false, backgroundTaskCount: 0 } as SessionSummary
describe('session activity and temporary status filters', () => {
    it('ignores metadata heartbeat time and sorts assistant replies independently', () => {
        expect(sessionActivityAt(session)).toBe(100)
        expect(sessionActivityAt({ ...session, lastMessageAt: null })).toBe(900)
        expect(sessionActivityAt({ ...session, lastMessageAt: undefined })).toBe(900)
        expect(sessionActivityAt(session, 'response')).toBe(80)
        expect(sessionActivityAt({ ...session, lastAssistantMessageAt: undefined }, 'response')).toBe(0)
    })
    it('distinguishes active from working and only treats explicit blocked summaries as blocked', () => {
        expect(matchesSessionStatus(session, 'active')).toBe(true)
        expect(matchesSessionStatus(session, 'working')).toBe(false)
        expect(matchesSessionStatus({ ...session, backgroundTaskCount: 1 }, 'working')).toBe(true)
        expect(isSessionBlocked({ ...session, pendingRequestsCount: 4 })).toBe(false)
        expect(isSessionBlocked({ ...session, notifyStatus: 'blocked' })).toBe(true)
        expect(isSessionBlocked({ ...session, notifyStatus: 'blocked', thinking: true })).toBe(false)
    })
})
