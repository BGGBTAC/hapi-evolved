/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage
} from '@/claude/sdk'
import type { RawJSONLines } from '@/claude/types'
import type { ClaudePermissionMode } from '@hapi/protocol/types'
import { logger } from '@/lib'

/**
 * SDK message types this converter knows how to turn into a transcript line.
 *
 * Anything outside this set is dropped. Claude Code keeps adding out-of-band
 * SDK events (`tool_progress` heartbeats, stream events, control responses),
 * and they are not conversation content — passing them through would stamp
 * them with transcript base fields (parentUuid/sessionId/userType), which
 * makes them indistinguishable from a real log line downstream. The web
 * normalizer can't match them to any known shape and falls back to rendering
 * the raw envelope as message text, leaking JSON into the chat.
 *
 * The local launcher already enforces the same allowlist via
 * `RawJSONLinesSchema.safeParse` in sessionScanner; this keeps the remote
 * (SDK) path at parity instead of leaving it open by default.
 */
const CONVERTIBLE_SDK_MESSAGE_TYPES = new Set([
    'user',
    'assistant',
    'system',
    'result',
    'tool_result'
])

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
    sessionId: string
    cwd: string
    version?: string
    gitBranch?: string
    parentUuid?: string | null
    // Keep the selected variant separate when the runtime resolves both variants
    // to the same bare id; selection is never proof of context capacity.
    selectedModel?: string | null
}

type PermissionResponse = {
    approved: boolean
    mode?: ClaudePermissionMode
    reason?: string
}

/**
 * Get current git branch for the working directory
 */
function getGitBranch(cwd: string): string | undefined {
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
        return branch || undefined
    } catch {
        return undefined
    }
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
    private lastUuid: string | null = null
    private context: ConversionContext
    private responses?: Map<string, PermissionResponse>
    private sidechainLastUUID = new Map<string, string>();
    // The raw model id from the most recent system/init (the session's authoritative model).
    private resolvedModel: string | null = null
    // The cache key for the current session model's contextWindow. Usually equal to
    // resolvedModel, but for presets whose "[1m]" variant the CLI still reports with the
    // bare id (fable[1m] arrives as "claude-fable-5", same as plain fable) it folds the
    // selectedModel's "[1m]" back in so the two variants don't collide. See
    // computeContextWindowKey.
    private resolvedContextWindowKey: string | null = null
    // Per-model contextWindow cache. Keys are the CLI's model id, except that for a
    // preset whose "[1m]" variant shares the bare id of its plain form (fable) the "[1m]"
    // is folded back into the key (computeContextWindowKey) so a 1M variant and a
    // potentially-smaller plain variant stay on distinct entries. opus[1m]/sonnet[1m]
    // already arrive suffixed from the CLI, so their keys are unchanged. Keying per model
    // — rather than a single sticky number — means a mid-session model switch picks up the
    // new model's own window immediately instead of inheriting the previous model's.
    private modelContextWindows = new Map<string, number>()
    private childModelContextWindows = new Map<string, number>()

    constructor(
        context: Omit<ConversionContext, 'parentUuid'>,
        responses?: Map<string, PermissionResponse>
    ) {
        this.context = {
            ...context,
            gitBranch: context.gitBranch ?? getGitBranch(context.cwd),
            version: context.version ?? process.env.npm_package_version ?? '0.0.0',
            parentUuid: null
        }
        this.responses = responses
    }

    /**
     * Compute the contextWindow cache key for an init model id.
     *
     * The CLI reports opus[1m]/sonnet[1m] with the "[1m]" suffix already on the id, but
     * reports fable[1m] with the same bare id as plain fable ("claude-fable-5"). To keep a
     * 1M variant from colliding with its (possibly-smaller) plain form, we fold the "[1m]"
     * back onto the bare id when the session's selected preset asks for 1M. Ids that
     * already carry the suffix are returned unchanged.
     */
    private computeContextWindowKey(model: string): string {
        if (model.endsWith('[1m]')) {
            return model
        }
        const wants1m = this.context.selectedModel?.endsWith('[1m]') ?? false
        return wants1m ? `${model}[1m]` : model
    }

    /** Update the selected variant without reusing another variant's known limit. */
    updateSelectedModel(model: string | null | undefined): void {
        this.context.selectedModel = model ?? null
    }

    /**
     * Update session ID (for when session changes during resume)
     */
    updateSessionId(sessionId: string): void {
        this.context.sessionId = sessionId
    }

    /**
     * Reset parent chain (useful when starting new conversation)
     */
    resetParentChain(): void {
        this.lastUuid = null
        this.context.parentUuid = null
    }

    /**
     * Convert rate_limit_event to pipe-delimited text matching the ACP path format,
     * or suppress if the status does not need display (e.g. 'allowed').
     * Must not mutate converter state (UUID chain) so dropped events are invisible.
     */
    private convertRateLimitEvent(sdkMessage: SDKMessage): RawJSONLines | null {
        const info = (sdkMessage as any).rate_limit_info
        if (typeof info !== 'object' || info === null) return null

        const { status, resetsAt, utilization, rateLimitType } = info

        if (status === 'allowed') return null
        if (typeof resetsAt !== 'number') return null

        const resetsAtInt = Math.round(resetsAt)
        let text: string

        if (status === 'allowed_warning') {
            const pct = typeof utilization === 'number' ? Math.round(utilization * 100) : 0
            const limitType = typeof rateLimitType === 'string' ? rateLimitType : ''
            text = `Claude AI usage limit warning|${resetsAtInt}|${pct}|${limitType}`
        } else if (status === 'rejected') {
            const limitType = typeof rateLimitType === 'string' ? rateLimitType : ''
            text = `Claude AI usage limit reached|${resetsAtInt}|${limitType}`
        } else {
            return null
        }

        const parentUuid = this.lastUuid
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.lastUuid = uuid

        return {
            parentUuid,
            isSidechain: false,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp,
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text }]
            }
        } as RawJSONLines
    }

    /**
     * Convert SDK message to log format
     */
    convert(sdkMessage: SDKMessage): RawJSONLines | null {
        if (sdkMessage.type === 'rate_limit_event') {
            return this.convertRateLimitEvent(sdkMessage)
        }

        // Bail before allocating a uuid or touching sidechain/parent tracking —
        // an unknown event must not advance the transcript chain it never joins.
        if (!CONVERTIBLE_SDK_MESSAGE_TYPES.has(sdkMessage.type)) {
            logger.debug(`[sdkToLogConverter] dropping unsupported SDK message type: ${sdkMessage.type}`)
            return null
        }

        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        let parentUuid = this.lastUuid;
        let isSidechain = false;
        // Preserved (not just consumed) so the web tracer can group sidechain
        // messages directly by the spawning Agent tool_use id, instead of relying
        // solely on the SDK emitting a prompt-holding sidechain root to exact-match
        // against. Some subagents (e.g. background/task_started) never emit that
        // root, orphaning every child that only carries this id.
        let parentToolUseId: string | undefined;
        if (sdkMessage.parent_tool_use_id) {
            isSidechain = true;
            parentToolUseId = (sdkMessage as any).parent_tool_use_id;
            parentUuid = this.sidechainLastUUID.get((sdkMessage as any).parent_tool_use_id) ?? null;
            if (sdkMessage.type !== 'result') {
                this.sidechainLastUUID.set((sdkMessage as any).parent_tool_use_id!, uuid);
            }
        }
        const baseFields = {
            parentUuid: parentUuid,
            isSidechain: isSidechain,
            parentToolUseId,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp
        }

        let logMessage: RawJSONLines | null = null

        switch (sdkMessage.type) {
            case 'user': {
                const userMsg = sdkMessage as SDKUserMessage
                logMessage = {
                    ...baseFields,
                    type: 'user',
                    message: userMsg.message
                }

                // Claude Code injects its own user-role turns (skill bodies, compact
                // continuation summaries). Over stream-json they are flagged
                // `isSynthetic`, while the on-disk transcript the local launcher reads
                // flags them `isMeta`. Normalize to `isMeta` so both paths hit the same
                // downstream filters — otherwise the injected text reaches the web UI
                // and is rendered as if the human had typed it.
                if (userMsg.isSynthetic === true || userMsg.isMeta === true) {
                    logMessage.isMeta = true
                }

                // Check if this is a tool result and add mode if available
                if (Array.isArray(userMsg.message.content)) {
                    for (const content of userMsg.message.content) {
                        if (content.type === 'tool_result' && content.tool_use_id && this.responses?.has(content.tool_use_id)) {
                            const response = this.responses.get(content.tool_use_id)
                            if (response?.mode) {
                                (logMessage as any).mode = response.mode
                            }
                        }
                    }
                } else if (typeof userMsg.message.content === 'string') {
                    // Simple string content, no tool result
                }
                break
            }

            case 'assistant': {
                const assistantMsg = sdkMessage as SDKAssistantMessage
                const message = assistantMsg.message as Record<string, unknown>
                // Parent usage follows the resolved variant; child messages use their
                // own model and must never inherit the parent's larger context window.
                const contextWindow = assistantMsg.parent_tool_use_id
                    ? (typeof message.model === 'string' ? this.childModelContextWindows.get(message.model) : undefined)
                    : this.resolvedContextWindowKey ? this.modelContextWindows.get(this.resolvedContextWindowKey) : undefined
                if (contextWindow !== undefined && message && typeof message.usage === 'object' && message.usage !== null) {
                    const usage = message.usage as Record<string, unknown>
                    if (usage.context_window === undefined) {
                        usage.context_window = contextWindow
                    }
                }
                logMessage = {
                    ...baseFields,
                    type: 'assistant',
                    message: assistantMsg.message,
                    // Assistant messages often have additional fields
                    requestId: (assistantMsg as any).requestId
                }
                // if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                //     for (const content of assistantMsg.message.content) {
                //         if (content.type === 'tool_use' && content.id) {
                //             this.sidechainLastUUID.set(content.id, uuid);
                //         }
                //     }
                // }
                break
            }

            case 'system': {
                const systemMsg = sdkMessage as SDKSystemMessage

                // System messages with subtype 'init' might update session ID
                if (systemMsg.subtype === 'init' && systemMsg.session_id) {
                    this.updateSessionId(systemMsg.session_id)
                }

                // Preserve confirmed limits per model/selected variant across turns.
                if (systemMsg.subtype === 'init' && typeof systemMsg.model === 'string') {
                    this.resolvedModel = systemMsg.model
                    this.resolvedContextWindowKey = this.computeContextWindowKey(systemMsg.model)
                    // A bare model id or a requested [1m] preset is not a runtime
                    // limit. Await modelUsage instead of publishing a guessed 200k/1M.
                }

                // System messages are typically not sent to logs
                // but we can convert them if needed
                logMessage = {
                    ...baseFields,
                    type: 'system',
                    subtype: systemMsg.subtype,
                    model: systemMsg.model,
                    tools: systemMsg.tools,
                    // Include all other fields
                    ...(systemMsg as any)
                }
                break
            }

            case 'result': {
                // Only the resolved parent's entry updates its selected-variant cache.
                // Child raw IDs live separately: a bare parent and suffixed child must
                // not collide with the parent's folded variant key or depend on order.
                const resultMsg = sdkMessage as SDKResultMessage
                if (resultMsg.modelUsage) {
                    const reported = new Map<string, number>()
                    for (const [model, usage] of Object.entries(resultMsg.modelUsage)) {
                        const cw = usage?.contextWindow
                        if (typeof cw === 'number' && Number.isSafeInteger(cw) && cw > 0) {
                            reported.set(model, cw)
                            this.childModelContextWindows.set(model, cw)
                        }
                    }
                    if (!resultMsg.parent_tool_use_id && this.resolvedModel && this.resolvedContextWindowKey) {
                        const base = this.resolvedModel.replace(/\[1m\]$/i, '')
                        const candidates = [...reported].filter(([model]) => model.replace(/\[1m\]$/i, '') === base)
                        const window = reported.get(this.resolvedModel) ?? (candidates.length === 1 ? candidates[0][1] : undefined)
                        if (window !== undefined) this.modelContextWindows.set(this.resolvedContextWindowKey, window)
                    }
                }
                logMessage = {
                    ...baseFields,
                    type: 'system',
                    subtype: 'turn_duration',
                    durationMs: resultMsg.duration_ms,
                    resultSummary: {
                        contextModel: resultMsg.parent_tool_use_id ? undefined : this.resolvedModel ?? undefined,
                        usage: resultMsg.usage,
                        modelUsage: resultMsg.modelUsage,
                        total_cost_usd: resultMsg.total_cost_usd,
                        num_turns: resultMsg.num_turns,
                        duration_ms: resultMsg.duration_ms
                    }
                }
                break
            }

            // Handle tool use results (often comes as user messages)
            case 'tool_result': {
                const toolMsg = sdkMessage as any
                const baseLogMessage: any = {
                    ...baseFields,
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolMsg.tool_use_id,
                            content: toolMsg.content
                        }]
                    },
                    toolUseResult: toolMsg.content
                }

                // Add mode if available from responses
                if (toolMsg.tool_use_id && this.responses?.has(toolMsg.tool_use_id)) {
                    const response = this.responses.get(toolMsg.tool_use_id)
                    if (response?.mode) {
                        baseLogMessage.mode = response.mode
                    }
                }

                logMessage = baseLogMessage
                break
            }

            default:
                // Unreachable: CONVERTIBLE_SDK_MESSAGE_TYPES gates this switch.
                // Kept as a fail-closed guard so that adding a type to the set
                // without a matching case here drops the message instead of
                // passing an unshaped envelope through to the chat.
                logger.debug(`[sdkToLogConverter] no case for allowlisted type: ${(sdkMessage as any).type}`)
                break
        }

        // Update last UUID for parent tracking
        if (logMessage && logMessage.type !== 'summary' && sdkMessage.type !== 'result') {
            this.lastUuid = uuid
        }

        return logMessage
    }

    /**
     * Convert multiple SDK messages to log format
     */
    convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
        return sdkMessages
            .map(msg => this.convert(msg))
            .filter((msg): msg is RawJSONLines => msg !== null)
    }

    /**
     * Convert a simple string content to a sidechain user message
     * Used for Task tool sub-agent prompts
     */
    convertSidechainUserMessage(toolUseId: string, content: string): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.sidechainLastUUID.set(toolUseId, uuid);
        return {
            parentUuid: null,
            isSidechain: true,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            type: 'user',
            message: {
                role: 'user',
                content: content
            },
            uuid,
            timestamp
        }
    }

    /**
     * Generate an interrupted tool result message
     * Used when a tool call is interrupted by the user
     * @param toolUseId - The ID of the tool that was interrupted
     * @param parentToolUseId - Optional parent tool ID if this is a sidechain tool
     */
    generateInterruptedToolResult(toolUseId: string, parentToolUseId?: string | null): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const errorMessage = "[Request interrupted by user for tool use]"
        
        // Determine if this is a sidechain and get parent UUID
        let isSidechain = false
        let parentUuid: string | null = this.lastUuid
        
        if (parentToolUseId) {
            isSidechain = true
            // Look up the parent tool's UUID
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null
            // Track this tool in the sidechain map
            this.sidechainLastUUID.set(parentToolUseId, uuid)
        }
        
        const logMessage: RawJSONLines = {
            type: 'user',
            isSidechain: isSidechain,
            parentToolUseId: parentToolUseId ?? undefined,
            uuid,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        content: errorMessage,
                        is_error: true,
                        tool_use_id: toolUseId
                    }
                ]
            },
            parentUuid: parentUuid,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            timestamp,
            toolUseResult: `Error: ${errorMessage}`
        } as any
        
        // Update last UUID for tracking
        this.lastUuid = uuid
        
        return logMessage
    }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
    sdkMessage: SDKMessage,
    context: Omit<ConversionContext, 'parentUuid'>,
    responses?: Map<string, PermissionResponse>
): RawJSONLines | null {
    const converter = new SDKToLogConverter(context, responses)
    return converter.convert(sdkMessage)
}
