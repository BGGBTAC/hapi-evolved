import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalClaudeActivity } from './localClaudeActivity'

afterEach(() => vi.useRealTimers())
describe('local Claude hook activity', () => {
    it('tracks a main-session turn, renews expiry, and stops on Stop', () => {
        vi.useFakeTimers()
        const session = { sessionId: 'main', mode: 'local', onThinkingChange: vi.fn() }
        const activity = new LocalClaudeActivity(() => session, 1000)
        activity.onHook('main', { hook_event_name: 'UserPromptSubmit' })
        expect(session.onThinkingChange).toHaveBeenLastCalledWith(true)
        vi.advanceTimersByTime(900)
        activity.onHook('main', { hook_event_name: 'PreToolUse' })
        vi.advanceTimersByTime(900)
        expect(session.onThinkingChange).toHaveBeenLastCalledWith(true)
        activity.onHook('main', { hook_event_name: 'Stop' })
        expect(session.onThinkingChange).toHaveBeenLastCalledWith(false)
        activity.stop()
    })
    it('bounds interrupted activity without changing remote or foreign sessions', () => {
        vi.useFakeTimers()
        const session = { sessionId: 'main', mode: 'local', onThinkingChange: vi.fn() }
        const activity = new LocalClaudeActivity(() => session, 1000)
        activity.onHook('other', { hook_event_name: 'PreToolUse' })
        activity.onHook('main', { hook_event_name: 'PreToolUse', agent_id: 'child' })
        expect(session.onThinkingChange).not.toHaveBeenCalled()
        activity.onHook('main', { hook_event_name: 'PreToolUse' })
        vi.advanceTimersByTime(1000)
        expect(session.onThinkingChange).toHaveBeenLastCalledWith(false)
        activity.onHook('main', { hook_event_name: 'PreToolUse' })
        session.mode = 'remote'
        vi.advanceTimersByTime(1000)
        activity.onHook('main', { hook_event_name: 'Stop' })
        expect(session.onThinkingChange).toHaveBeenLastCalledWith(true)
        activity.stop()
    })
})
