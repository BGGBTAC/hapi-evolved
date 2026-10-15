import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';

/** A recovered PID is ownership evidence, not proof of a working Hub connection. */
export async function reconnectRunnerSession(
    options: SpawnSessionOptions,
    result: Extract<SpawnSessionResult, { type: 'success' }>
): Promise<SpawnSessionResult> {
    if (options.agent !== 'codex') return { type: 'error', errorMessage: 'The existing agent process is still alive, but its Hub connection cannot be verified. Stop this session explicitly, then resume it; its conversation will be preserved.' };
    return await reconnectSharedRunnerSession(result.sessionId, options)
        ?? { type: 'error', errorMessage: 'The existing Codex process has no verified shared runtime. Stop that session explicitly before reopening it.' };
}

/** Also used before spawning: /new roots share a PID and have no spawn cache. */
export async function reconnectSharedRunnerSession(sessionId: string, options?: SpawnSessionOptions): Promise<SpawnSessionResult | undefined> {
    try {
        const { findRuntime } = await import('@/codex/shared/registry');
        const runtime = await findRuntime(sessionId, { strict: true });
        if (!runtime) return undefined;
        const { runtimeControl } = await import('@/codex/shared/frontend');
        if (options?.token) throw new Error('Provider credentials cannot be replaced in a live execution; stop the session explicitly first');
        const settings = {
            ...(options?.permissionMode ? { permissionMode: options.permissionMode } : options?.yolo ? { permissionMode: 'yolo' } : {}),
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.modelReasoningEffort || options?.effort ? { modelReasoningEffort: options.modelReasoningEffort ?? options.effort } : {}),
            ...(options?.serviceTier ? { serviceTier: options.serviceTier } : {}),
            ...(options?.collaborationMode ? { collaborationMode: options.collaborationMode } : {})
        };
        const reply = await runtimeControl(runtime, 'hapi/reconnectSession', sessionId, {
            timeoutMs: 10_000, ...(options?.directory ? { directory: options.directory } : {}),
            ...(Object.keys(settings).length ? { settings } : {})
        });
        if (typeof reply === 'object' && reply !== null && 'connected' in reply && reply.connected === true) {
            return { type: 'success', sessionId };
        }
        return { type: 'error', errorMessage: 'The existing Codex session could not reconnect to the Hub. Its execution was preserved; retry when the connection is available.' };
    } catch (error) {
        return { type: 'error', errorMessage: `Could not reconnect the existing Codex session; its execution was preserved: ${error instanceof Error ? error.message : String(error)}` };
    }
}
