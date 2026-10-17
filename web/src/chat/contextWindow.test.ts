import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import type { DecryptedMessage } from '@/types/api'

function message(data: unknown, seq: number, type = 'output') {
    return normalizeDecryptedMessage({ id: `message-${seq}`, seq, localId: null, createdAt: seq,
        content: { role: 'agent', content: { type, data } } } as DecryptedMessage)!
}
const assistant = (seq: number, model = 'claude-opus-5-5', window?: number) => message({ type: 'assistant',
    message: { model, content: [{ type: 'text', text: 'Working' }], usage: { input_tokens: 10_000, output_tokens: 100, cache_read_input_tokens: 40_000, context_window: window } } }, seq)
const result = (seq: number, models: Record<string, { contextWindow: unknown }>, isSidechain = false, contextModel?: string) => message({
    type: 'system', subtype: 'turn_duration', isSidechain,
    resultSummary: { modelUsage: models, contextModel, usage: { input_tokens: 8_000_000, output_tokens: 100_000 } } }, seq)

describe('provider-reported session context', () => {
    it('shows the first Opus result limit immediately without replacing occupancy with cumulative billing', () => {
        const reduced = reduceChatBlocks([assistant(1, 'claude-opus-5-5', 200_000), result(2, {
            'claude-opus-5-5': { contextWindow: 1_000_000 }, 'claude-haiku-4-5': { contextWindow: 200_000 }
        })], null)
        expect(reduced.latestUsage).toMatchObject({ contextSize: 50_000, contextWindow: 1_000_000 })
    })

    it('matches a unique runtime 1m variant to its bare assistant model', () => {
        const reduced = reduceChatBlocks([assistant(1), result(2, { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } })], null)
        expect(reduced.latestUsage?.contextWindow).toBe(1_000_000)
    })

    it('uses the resolved parent variant when a same-model child has a smaller limit', () => {
        const windows = { 'claude-opus-5-5': { contextWindow: 200_000 }, 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } }
        expect(reduceChatBlocks([assistant(1), result(2, windows, false, 'claude-opus-5-5[1m]')], null).latestUsage?.contextWindow).toBe(1_000_000)
        expect(reduceChatBlocks([assistant(1), result(2, windows)], null).latestUsage?.contextWindow).toBeNull()
    })

    it.each([['claude-opus-5-5[1m]', 'claude-opus-5-5'], ['claude-opus-5-5', 'claude-opus-5-5[1m]']])(
        'accepts an unambiguous resolved variant %s reported as %s at completion', (resolved, reported) => {
            expect(reduceChatBlocks([assistant(1), result(2, { [reported]: { contextWindow: 1_000_000 } }, false, resolved)], null).latestUsage?.contextWindow).toBe(1_000_000)
        }
    )

    it('does not apply child, unrelated, or older model limits to the latest parent usage', () => {
        for (const messages of [
            [assistant(1), result(2, { 'claude-opus-5-5': { contextWindow: 200_000 } }, true)],
            [assistant(1), result(2, { 'claude-haiku-4-5': { contextWindow: 200_000 } })],
            [assistant(1), result(2, { 'claude-opus-5-5': { contextWindow: 1_000_000 } }), assistant(3, 'claude-haiku-4-5')],
        ]) expect(reduceChatBlocks(messages, null).latestUsage?.contextWindow).toBeNull()
    })

    it.each([0, -1, 1.5, NaN, Infinity, '1000000'])('ignores invalid result context limits: %s', contextWindow => {
        expect(reduceChatBlocks([assistant(1), result(2, { 'claude-opus-5-5': { contextWindow } })], null).latestUsage?.contextWindow).toBeNull()
    })

    it('uses Astra’s actual session limit and last input count without double-counting cached input', () => {
        const current = message({ type: 'token_count', model: 'gpt-6-astra', info: {
            last: { inputTokens: 90_000, cachedInputTokens: 80_000, outputTokens: 200 },
            total: { inputTokens: 9_000_000, outputTokens: 2_000 }, modelContextWindow: 900_000
        } }, 1, 'codex')
        expect(reduceChatBlocks([current], null).latestUsage).toMatchObject({ contextSize: 90_000, contextWindow: 900_000 })
    })

    it('does not interpret total-only Codex billing as current context after compaction', () => {
        const totalOnly = message({ type: 'token_count', model: 'gpt-6-astra', info: {
            total: { inputTokens: 9_000_000, outputTokens: 2_000 }, modelContextWindow: 900_000
        } }, 1, 'codex')
        expect(totalOnly).toBeNull()
    })
})
