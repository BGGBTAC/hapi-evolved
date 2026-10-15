import type { Database } from 'bun:sqlite'
import { getLatestUserMessageId, getSessionActivity } from './sessionActivity'

import { hasConversationMessageContent } from '@hapi/protocol/messages'
import { decodeMessageContent } from './contentCodec'
import { assertAttachmentRefsReady } from './messageAttachmentRefs'

import type { StoredMessage } from './types'
import {
    addMessage,
    hasLocalMessage,
    syncNativeQueuedMessage,
    addImportedMessage,
    cancelQueuedMessage,
    deleteLiveReasoningSnapshots,
    deleteQueuedMessageById,
    claimIndeterminateMessage,
    lookupQueuedMessage,
    getMessages,
    getFirstMessages,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getMessagesAfterPosition,
    getNewestMessagePosition,
    getMessageEpoch,
    bumpMessageEpoch,
    getLocalMessageStates,
    getUninvokedLocalMessages,
    updateMessageContent,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    countFutureScheduledBySessionIds,
    countFutureScheduledLocalMessages,
    minFutureScheduledAtBySessionIds,
    countMessages,
    getMaxSeq,
    markMessagesInvoked,
    markMessagesIndeterminate,
    setMessagesDeliveryState,
    markUninvokedImmediateMessages,
    mergeSessionMessages,
    moveUninvokedScheduledMessages,
    moveUninvokedMessages,
    copyMessageToSession as copyStoredMessageToSession,
    copyMessagesToSession as copyStoredMessagesToSession,
    mergeCopiedMessagesToSession as mergeCopiedStoredMessagesToSession,
    getAllMessages,
    getMessagesAfterSeq,
    getMessagesAfterSeqLimit,
    getMessageSeqById,
    getMessageById,
    truncateMessagesFromLocalId,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type LocalMessageState,
    type MessagePosition,
} from './messages'

import { hasPotentiallyIncompleteMessageContent, searchMessageContent, searchMessageContentInSession, type MessageContentSearchMatch, type SessionMessageContentSearchResult } from './messageContentSearch'

export class MessageStore {
    getMessageByLocalId(sessionId: string, localId: string): StoredMessage | null {
        const row = this.db.prepare('SELECT id FROM messages WHERE session_id=? AND local_id=? LIMIT 1').get(sessionId, localId) as { id: string } | undefined
        return row ? this.getMessageById(sessionId, row.id) : null
    }
    latestInvokedLocalId(sessionId: string): string | undefined {
        return (this.db.prepare('SELECT local_id FROM messages WHERE session_id=? AND invoked_at IS NOT NULL AND local_id IS NOT NULL ORDER BY invoked_at DESC,seq DESC LIMIT 1').get(sessionId) as { local_id: string } | undefined)?.local_id
    }
    *iterateUninvokedMessages(sessionId: string): Iterable<StoredMessage> {
        for (const raw of this.db.prepare('SELECT id FROM messages WHERE session_id=? AND invoked_at IS NULL ORDER BY seq').iterate(sessionId)) {
            const message = this.getMessageById(sessionId, (raw as { id: string }).id)
            if (message) yield message
        }
    }
    /** Only attachment-bearing prefix rows; no SQLite reader survives a yield/await. */
    *iterateForkAttachmentMessages(sessionId: string, beforeLocalId?: string, throughLocalId?: string): Iterable<StoredMessage> {
        if (beforeLocalId === undefined && throughLocalId === '') return
        assertAttachmentRefsReady(this.db)
        const boundaryId = beforeLocalId ?? throughLocalId
        const boundary = boundaryId === undefined ? null : this.db.prepare('SELECT COALESCE(invoked_at,created_at) AS at,seq FROM messages WHERE session_id=? AND local_id=? LIMIT 1').get(sessionId, boundaryId) as { at: number; seq: number } | undefined
        if (boundaryId !== undefined && !boundary) throw new Error('Fork boundary message not found')
        const highwater = getMaxSeq(this.db, sessionId)
        const epoch = getMessageEpoch(this.db, sessionId)
        const cutoff = boundary ? `AND (m.invoked_at < ? OR (m.invoked_at = ? AND m.seq ${beforeLocalId !== undefined ? '<' : '<='} ?))` : ''
        let after: { at: number; seq: number } | null = null
        while (true) {
            if (getMessageEpoch(this.db, sessionId) !== epoch) throw new Error('Fork source history changed while preserving attachments; retry required')
            const cursorClause = after ? 'AND (m.invoked_at > ? OR (m.invoked_at = ? AND m.seq > ?))' : ''
            const rows = this.db.prepare(`SELECT m.id,m.invoked_at AS at,m.seq FROM messages m
                WHERE m.session_id=? AND m.invoked_at IS NOT NULL AND m.seq<=? ${cutoff} ${cursorClause}
                AND EXISTS(SELECT 1 FROM message_attachment_refs r WHERE r.message_id=m.id)
                ORDER BY m.invoked_at,m.seq LIMIT 50`)
                .all(sessionId, highwater, ...(boundary ? [boundary.at, boundary.at, boundary.seq] : []), ...(after ? [after.at, after.at, after.seq] : [])) as Array<{ id: string; at: number; seq: number }>
            if (rows.length === 0) return
            for (const row of rows) {
                if (getMessageEpoch(this.db, sessionId) !== epoch) throw new Error('Fork source history changed while preserving attachments; retry required')
                const message = this.getMessageById(sessionId, row.id)
                if (!message) throw new Error('Fork source message disappeared while preserving attachments')
                yield message
            }
            after = rows[rows.length - 1]!
        }
    }
    referencedAttachmentIds(sessionId: string): string[] {
        assertAttachmentRefsReady(this.db)
        return (this.db.prepare('SELECT DISTINCT attachment_id FROM message_attachment_refs WHERE session_id=?').all(sessionId) as Array<{ attachment_id: string }>).map(row => row.attachment_id)
    }
    async getLatestUserMessage(sessionId: string): Promise<StoredMessage | null> {
        const id = await getLatestUserMessageId(this.db, sessionId)
        return id ? this.getMessageById(sessionId, id) : null
    }
    /** Constant-size indexed lookup, including queued references. */
    hasAttachmentReference(sessionId: string, attachmentId: string): boolean {
        assertAttachmentRefsReady(this.db)
        return !!this.db.prepare('SELECT 1 FROM message_attachment_refs WHERE session_id=? AND attachment_id=? LIMIT 1').get(sessionId, attachmentId)
    }
    getConversationActivity(sessionId: string): { lastMessageAt: number | null; lastAssistantMessageAt: number | null; notifyStatus: 'blocked' | null } {
        return getSessionActivity(this.db, sessionId)
    }
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string, scheduledAt?: number | null, createdAt?: number): StoredMessage {
        return addMessage(this.db, sessionId, content, localId, scheduledAt, createdAt)
    }

    hasLocalMessage(sessionId: string, localId: string): boolean {
        return hasLocalMessage(this.db, sessionId, localId)
    }

    syncNativeQueuedMessage(sessionId: string, localId: string, text: string): StoredMessage {
        return syncNativeQueuedMessage(this.db, sessionId, localId, text)
    }

    deleteLiveReasoningSnapshots(sessionId: string, streamId: string, keepMessageId?: string): number {
        return deleteLiveReasoningSnapshots(this.db, sessionId, streamId, keepMessageId)
    }

    addImportedMessage(sessionId: string, content: unknown, localId: string, createdAt: number): { message: StoredMessage; inserted: boolean } {
        return addImportedMessage(this.db, sessionId, content, localId, createdAt)
    }

    copyMessageToSession(
        sessionId: string,
        message: Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>
    ): StoredMessage {
        // 中文注释：重复会话合并时需要保留源消息的时间戳和排队信息，因此走专门的复制入口而不是普通 addMessage。
        return copyStoredMessageToSession(this.db, sessionId, message)
    }

    copyMessagesToSession(
        sessionId: string,
        messages: Array<Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>>
    ): number {
        return copyStoredMessagesToSession(this.db, sessionId, messages)
    }

    mergeCopiedMessagesToSession(
        sessionId: string,
        messages: Array<Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>>
    ): number {
        return mergeCopiedStoredMessagesToSession(this.db, sessionId, messages)
    }

    getAllMessages(sessionId: string): StoredMessage[] {
        return getAllMessages(this.db, sessionId)
    }

    getMessagesAfterSeq(sessionId: string, afterSeq: number): StoredMessage[] {
        return getMessagesAfterSeq(this.db, sessionId, afterSeq)
    }

    getMessagesAfterSeqLimit(sessionId: string, afterSeq: number, limit: number): StoredMessage[] {
        return getMessagesAfterSeqLimit(this.db, sessionId, afterSeq, limit)
    }

    getSeqById(sessionId: string, messageId: string): number | null {
        return getMessageSeqById(this.db, sessionId, messageId)
    }

    getMessageById(sessionId: string, messageId: string): StoredMessage | null {
        return getMessageById(this.db, sessionId, messageId)
    }

    getMessages(sessionId: string, limit: number = 200): StoredMessage[] {
        return getMessages(this.db, sessionId, limit)
    }

    getFirstMessages(sessionId: string, limit: number = 50): StoredMessage[] {
        return getFirstMessages(this.db, sessionId, limit)
    }

    getDeliverableMessagesAfter(sessionId: string, afterSeq: number, now: number, limit: number = 200): StoredMessage[] {
        return getDeliverableMessagesAfter(this.db, sessionId, afterSeq, now, limit)
    }

    getMessagesByPosition(sessionId: string, limit: number, before?: { at: number; seq: number }): StoredMessage[] {
        return getMessagesByPosition(this.db, sessionId, limit, before)
    }

    getMessagesAfterPosition(
        sessionId: string,
        limit: number,
        after: MessagePosition,
        until?: MessagePosition
    ): StoredMessage[] {
        return getMessagesAfterPosition(this.db, sessionId, limit, after, until)
    }

    getNewestMessagePosition(sessionId: string): MessagePosition | null {
        return getNewestMessagePosition(this.db, sessionId)
    }

    getMessageEpoch(sessionId: string): number {
        return getMessageEpoch(this.db, sessionId)
    }

    bumpMessageEpoch(sessionId: string): number {
        return bumpMessageEpoch(this.db, sessionId)
    }

    getLocalMessageStates(sessionId: string, localIds: string[]): LocalMessageState[] {
        return getLocalMessageStates(this.db, sessionId, localIds)
    }

    getUninvokedLocalMessages(sessionId: string, options?: { deliverableOnly?: boolean }): StoredMessage[] {
        return getUninvokedLocalMessages(this.db, sessionId, options)
    }

    updateMessageContent(messageId: string, content: unknown): boolean {
        return updateMessageContent(this.db, messageId, content)
    }

    getMatureScheduledMessages(beforeTime: number): StoredMessage[] {
        return getMatureScheduledMessages(this.db, beforeTime)
    }

    getImmediateQueuedLocalMessages(sessionId: string): StoredMessage[] {
        return getImmediateQueuedLocalMessages(this.db, sessionId)
    }

    countFutureScheduledLocalMessages(sessionId: string, now: number = Date.now()): number {
        return countFutureScheduledLocalMessages(this.db, sessionId, now)
    }

    countFutureScheduledBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return countFutureScheduledBySessionIds(this.db, sessionIds, now)
    }

    minFutureScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return minFutureScheduledAtBySessionIds(this.db, sessionIds, now)
    }

    /**
     * Whether the session has any message that counts as conversation content.
     *
     * The answer is "any row matches", so scan order cannot change the result —
     * but it changes the cost enormously. Newest-first answers in a few rows for
     * a live session, whereas oldest-first must walk the leading bookkeeping
     * first: a session opening with tens of thousands of tool calls made every
     * `refreshSession` decode its entire history (zstd inflate + JSON.parse per
     * row, plus one table page read each), blocking the hub for minutes.
     */
    hasConversationContent(sessionId: string): boolean {
        const query = this.db.prepare<{ content: string | Uint8Array }, [string]>(
            'SELECT content FROM messages WHERE session_id = ? ORDER BY seq DESC'
        )
        try {
            for (const row of query.iterate(sessionId)) {
                if (hasConversationMessageContent(decodeMessageContent(row.content))) return true
            }
            return false
        } finally {
            query.finalize()
        }
    }

    countMessages(sessionId: string): number {
        return countMessages(this.db, sessionId)
    }

    /** Highest message seq in the session; 0 when it has none. */
    getMaxSeq(sessionId: string): number {
        return getMaxSeq(this.db, sessionId)
    }

    searchContent(query: string, namespace: string, limit = 50, sessionIds?: readonly string[]): MessageContentSearchMatch[] {
        return searchMessageContent(this.db, query, namespace, limit, sessionIds)
    }

    searchContentInSession(query: string, namespace: string, sessionId: string, limit = 500): SessionMessageContentSearchResult {
        return searchMessageContentInSession(this.db, query, namespace, sessionId, limit)
    }

    hasPotentiallyIncompleteContent(namespace: string, query: string, sessionIds?: readonly string[]): boolean {
        return hasPotentiallyIncompleteMessageContent(this.db, namespace, query, sessionIds)
    }

    cancelQueuedMessage(sessionId: string, messageId: string): CancelQueuedMessageResult {
        return cancelQueuedMessage(this.db, sessionId, messageId)
    }

    lookupQueuedMessage(sessionId: string, messageId: string): LookupQueuedMessageResult {
        return lookupQueuedMessage(this.db, sessionId, messageId)
    }

    deleteQueuedMessageById(sessionId: string, messageId: string): boolean {
        return deleteQueuedMessageById(this.db, sessionId, messageId)
    }

    claimIndeterminateMessage(sessionId: string, messageId: string): StoredMessage | null {
        return claimIndeterminateMessage(this.db, sessionId, messageId)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): number {
        return markMessagesInvoked(this.db, sessionId, localIds, invokedAt)
    }

    markMessagesIndeterminate(sessionId: string, localIds: string[]): number {
        return markMessagesIndeterminate(this.db, sessionId, localIds)
    }

    setMessagesDeliveryState(sessionId: string, localIds: string[], state: 'queued' | 'dispatching' | 'indeterminate'): number {
        return setMessagesDeliveryState(this.db, sessionId, localIds, state)
    }

    markUninvokedImmediateMessages(sessionId: string, invokedAt: number): string[] {
        return markUninvokedImmediateMessages(this.db, sessionId, invokedAt)
    }

    moveUninvokedScheduledMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedScheduledMessages(this.db, fromSessionId, toSessionId)
    }

    moveUninvokedMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedMessages(this.db, fromSessionId, toSessionId)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    truncateMessagesFromLocalId(
        sessionId: string,
        localId: string,
        replacement: Array<{
            content: unknown
            localId?: string | null
            createdAt?: number
            invokedAt?: number | null
        }> = []
    ): { deleted: number; inserted: number; epoch: number } {
        return truncateMessagesFromLocalId(this.db, sessionId, localId, replacement)
    }
}
