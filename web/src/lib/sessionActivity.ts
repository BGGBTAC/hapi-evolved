import type { SessionSummary } from '@/types/api'
export type SessionActivitySort = 'message' | 'response'
export type SessionStatusFilter = 'all' | 'active' | 'working' | 'blocked'
export function sessionActivityAt(session: SessionSummary, sort: SessionActivitySort = 'message'): number {
    return sort === 'response'
        ? session.lastAssistantMessageAt ?? 0
        : session.lastMessageAt ?? session.updatedAt
}
export function matchesSessionStatus(session: SessionSummary, filter: SessionStatusFilter): boolean {
    if (filter === 'all') return true
    if (filter === 'blocked') return isSessionBlocked(session)
    if (filter === 'active') return session.active
    return session.active && (session.thinking || (session.backgroundTaskCount ?? 0) > 0)
}

export function isSessionBlocked(session: SessionSummary): boolean { return session.notifyStatus === 'blocked' && !session.thinking }
