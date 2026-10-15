import { isIndeterminateError, type CodexAppServerClient } from '../codexAppServerClient';

/** A bad rollout is isolated; a lost observer transport must reconnect. */
export async function restoreControlSubscriptions(
    client: Pick<CodexAppServerClient, 'request' | 'isInitialized'>,
    threadIds: Iterable<string>,
    unavailable: (threadId: string, error: unknown) => void
): Promise<void> {
    for (const threadId of threadIds) {
        try { await client.request('thread/resume', { threadId, excludeTurns: true }); }
        catch (error) {
            if (!client.isInitialized() || isIndeterminateError(error)) throw error;
            unavailable(threadId, error);
        }
    }
    if (!client.isInitialized()) throw new Error('Codex control transport disconnected during subscription');
}
