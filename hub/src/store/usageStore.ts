import type { Database } from 'bun:sqlite'

import {
    getUsageEvents,
    getUsageEventsPage,
    getUsageIndexedModels,
    getUsageScanStates,
    recordUsageScan,
    transferUsageSession,
    type PagedUsageEvent,
    type UsageEvent,
    type UsageEventCursor,
    type UsageScanState
} from './usage'

export class UsageStore {
    constructor(private readonly db: Database) {
        // Keyset pages must not repeatedly sort the entire usage history.
        // SQLite includes rowid as the final key of this non-unique index.
        db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_created_seq ON usage_events(created_at, source_seq)')
    }

    withReadSnapshot<T>(read: () => T): T {
        return this.db.transaction(read)()
    }

    recordScan(
        sessionId: string,
        messageEpoch: number,
        lastSeq: number,
        events: UsageEvent[],
        replaceEvents: boolean
    ): void {
        recordUsageScan(this.db, sessionId, messageEpoch, lastSeq, events, replaceEvents)
    }

    getEvents(sessionIds: string[]): UsageEvent[] {
        return getUsageEvents(this.db, sessionIds)
    }

    getIndexedModels(sessionId: string): Map<string, string> {
        return getUsageIndexedModels(this.db, sessionId)
    }

    getEventsPage(
        sessionIds: string[],
        cursor: UsageEventCursor | null,
        limit: number
    ): PagedUsageEvent[] {
        return getUsageEventsPage(this.db, sessionIds, cursor, limit)
    }

    getScanStates(sessionIds: string[]): Map<string, UsageScanState> {
        return getUsageScanStates(this.db, sessionIds)
    }

    transferSession(fromSessionId: string, toSessionId: string): void {
        transferUsageSession(this.db, fromSessionId, toSessionId)
    }
}
