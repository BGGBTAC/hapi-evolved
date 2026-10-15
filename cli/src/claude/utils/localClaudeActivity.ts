type ActivitySession = {
    sessionId: string | null
    mode: string
    onThinkingChange(thinking: boolean): void
}

/** Local TUI activity comes from hooks; remote activity remains owned by its SDK stream. */
export class LocalClaudeActivity {
    private timer: ReturnType<typeof setTimeout> | undefined
    constructor(private current: () => ActivitySession | null, private timeoutMs = 10 * 60_000) {}

    onHook(sessionId: string, hook: { hook_event_name?: unknown; agent_id?: unknown }): void {
        const session = this.current()
        if (!session || session.mode !== 'local' || session.sessionId !== sessionId || hook.agent_id !== undefined) return
        if (hook.hook_event_name === 'Stop' || hook.hook_event_name === 'SessionEnd') {
            this.stop()
            session.onThinkingChange(false)
        } else if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(String(hook.hook_event_name))) {
            this.stop()
            session.onThinkingChange(true)
            // Escape/crashes may omit Stop. Do not leave a permanently active indicator.
            this.timer = setTimeout(() => {
                if (this.current() === session && session.mode === 'local' && session.sessionId === sessionId) session.onThinkingChange(false)
            }, this.timeoutMs)
            this.timer.unref?.()
        }
    }

    stop(): void { clearTimeout(this.timer); this.timer = undefined }
}
