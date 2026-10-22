import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection, inputText } from './projection';
import { codexPlanProposalId } from './plan';
import { extractNotifySummary } from '@hapi/protocol/messages';

describe('shared history projection', () => {
    it.each([undefined, 'root'])('publishes only final summaries in live output and history replay (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const footer = 'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"Finished"}';
        const items = [
            { id: 'progress', type: 'agentMessage', phase: 'commentary', text: `Still working.\n${footer}` },
            { id: 'partial', type: 'agentMessage', phase: 'partial_answer', text: `More work.\n${footer}` },
            { id: 'footer-only', type: 'agentMessage', phase: 'commentary', text: footer },
            { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `Finished.\n${footer}` }
        ];
        for (const item of items) {
            await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
        }
        const live = send.mock.calls.slice();
        const bodies = live.map(([body]) => parentThreadId ? body.message : body);
        expect(bodies.map(body => body.message)).toEqual(['Still working.', 'More work.', `Finished.\n${footer}`]);
        expect(bodies.filter(body => extractNotifySummary(body.message))).toHaveLength(1);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items }] });
        expect(send.mock.calls).toEqual(live);
    });

    it.each([undefined, 'root'])('persists proposals without approval and replays the same IDs (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const item = { id: 'plan', type: 'plan', text: '# Final plan' };
        const params = { threadId: 'thread', turnId: 'turn', item };
        await projection.notification('item/completed', { ...params, item: { id: 'before', type: 'agentMessage', text: 'Preface' } });
        await projection.notification('item/started', params);
        await projection.notification('item/plan/delta', { ...params, itemId: 'plan', delta: '# Provisional' });
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', { ...params, item: { id: 'after', type: 'agentMessage', text: 'Postscript' } });
        expect(send).toHaveBeenCalledTimes(4);
        const bodies = send.mock.calls.map(([body]) => parentThreadId ? body.message : body);
        const callId = codexPlanProposalId('thread', 'turn', 'plan');
        expect(bodies).toEqual([
            expect.objectContaining({ type: 'message', message: 'Preface' }),
            expect.objectContaining({ type: 'tool-call', name: 'ExitPlanMode', callId, input: { plan: '# Final plan' } }),
            expect.objectContaining({ type: 'tool-call-result', callId, output: null }),
            expect.objectContaining({ type: 'message', message: 'Postscript' })
        ]);
        const original = send.mock.calls.slice(1, 3);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        expect(send.mock.calls).toEqual(original);
    });

    it('waits for final proposal content after an active snapshot', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'plan', type: 'plan', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'plan', type: 'plan', text: 'final' } });
        expect(send.mock.calls[0][0]).toMatchObject({ input: { plan: 'final' } });
        expect(send.mock.calls[1][0]).toMatchObject({ output: null });
    });

    it.each([undefined, 'root'])('emits canonical error flags for tools (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        for (const failed of [true, false]) {
            for (const type of ['mcpToolCall', 'collabAgentToolCall']) {
                const item = { id: `${type}-${failed}`, type, server: 'test', tool: 'spawnAgent',
                    status: failed ? 'failed' : 'completed', error: failed ? { message: 'failed' } : null,
                    result: { Ok: 'done' } };
                await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
                const body = send.mock.lastCall?.[0];
                const result = parentThreadId ? body.message : body;
                expect(result).toMatchObject({ type: 'tool-call-result', is_error: failed });
                expect(result).not.toHaveProperty('isError');
            }
        }
    });
    it('keeps each turn model through settings changes, reconnect replay and rerouting', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-a');
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'new' } }, 'model-b');
        projection.reset();
        // A replayed start must not rewrite the executing model either.
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-b');
        const usage = async (turnId: string) => projection.notification('thread/tokenUsage/updated', {
            threadId: 'thread', turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3 } }
        }, 'model-b');
        await usage('old');
        await projection.notification('model/rerouted', { threadId: 'thread', turnId: 'new', fromModel: 'model-b', toModel: 'model-c', reason: 'test' });
        await usage('new');
        const events = send.mock.calls.map(([body]) => body).filter(body => body.type === 'token_count');
        expect(events.map(body => body.model)).toEqual(['model-a', 'model-c']);
    });
    it('reports only the final same-turn assistant text with a durable completion id', async () => {
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'root', async () => {});
        await projection.notification('item/completed', { threadId: 'root', turnId: 'old', item: { type: 'agentMessage', id: 'old', text: 'Wrong turn' } });
        await projection.notification('item/completed', { threadId: 'root', turnId: 'current', item: { type: 'agentMessage', id: 'answer', text: 'Final answer' } });
        await projection.notification('turn/completed', { threadId: 'root', turn: { id: 'current', status: 'completed' } });
        await projection.notification('turn/completed', { threadId: 'root', turn: { id: 'current', status: 'completed' } });
        const events = send.mock.calls.filter(([body]) => body.type === 'hapi-turn-completed');
        expect(events).toEqual([[expect.objectContaining({ turnId: 'current', status: 'completed', finalText: 'Final answer' }), 'codex:root:current:hapi-turn-completed']]);
    });
    it('keeps intermediate status footers out of the peer-report final text', async () => {
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'root', async () => {});
        const footer = 'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"Finished"}';
        const complete = (id: string, phase: string, text: string) => projection.notification('item/completed', {
            threadId: 'root', turnId: 'turn', item: { type: 'agentMessage', id, phase, text }
        });
        await complete('final', 'final_answer', `Finished.\n${footer}`);
        await complete('footer-only', 'commentary', footer);
        await complete('late-commentary', 'commentary', `Late progress.\n${footer}`);
        await complete('late-partial', 'partial_answer', 'Partial answer arriving after the final.');
        await projection.notification('turn/completed', { threadId: 'root', turn: { id: 'turn', status: 'completed' } });
        await projection.notification('item/completed', { threadId: 'root', turnId: 'turn2', item: { type: 'agentMessage', id: 'c2', phase: 'commentary', text: `Progress.\n${footer}` } });
        await projection.notification('turn/completed', { threadId: 'root', turn: { id: 'turn2', status: 'completed' } });
        const events = send.mock.calls.map(([body]) => body).filter(body => body.type === 'hapi-turn-completed');
        expect(events.find(body => body.turnId === 'turn')).toEqual(expect.objectContaining({ finalText: `Finished.\n${footer}` }));
        expect(events.find(body => body.turnId === 'turn2')).toEqual(expect.objectContaining({ finalText: 'Progress.' }));
    });
    it('persists child identity separately without inventing execution settings from history', async () => {
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', async () => {}, 'root');
        const child = { id: 'child', taskName: 'Review', agentNickname: 'Astra', agentRole: 'reviewer', agentPath: '/root/review', model: 'unconfirmed-parent-model', reasoningEffort: 'high', turns: [] };
        await projection.history(child); projection.reset(); await projection.history(child);
        const first = send.mock.calls[0];
        expect(first[0]).toMatchObject({ type: 'agent-run-metadata', agentId: 'child', taskName: 'Review', nickname: 'Astra', agentRole: 'reviewer' });
        expect(first[0]).not.toHaveProperty('model'); expect(first[0]).not.toHaveProperty('reasoningEffort');
        expect(send.mock.calls[1]).toEqual(first);
        projection.childIdentity({ ...child, id: 'sibling', taskName: 'Wrong' });
        expect(send).toHaveBeenCalledTimes(2);
    });
    it('keeps image-only native inputs visible without embedding data URLs', () => {
        expect(inputText([{ type: 'image', url: 'data:image/png;base64,large' }])).toBe('[Image]');
        expect(inputText([{ type: 'localImage', path: '/tmp/image.png' }])).toBe('[Image: /tmp/image.png]');
    });
    it('replays after hub reconnect using the same durable local id', async () => {
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const snapshot = { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'complete' }] }] };
        await projection.history(snapshot); projection.reset(); await projection.history(snapshot);
        expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    });
    it('maps native historical fork turn boundaries to HAPI message local IDs', async () => {
        const session = { getMetadata: () => {}, sendAgentMessage: vi.fn(), sendUserMessage: vi.fn(), updateMetadata: vi.fn() } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [
            { id: 'turn-1', status: 'completed', items: [{ id: 'user-1', type: 'userMessage', clientId: 'local-1', content: [{ type: 'text', text: 'one' }] }] },
            { id: 'turn-2', status: 'completed', items: [{ id: 'user-2', type: 'userMessage', clientId: 'local-2', content: [{ type: 'text', text: 'two' }] }] }
        ] });
        expect(projection.firstMessageLocalIdForTurn('turn-1')).toBe('local-1');
        expect(projection.firstMessageLocalIdAfterTurn('turn-1')).toBe('local-2');
    });
    it('does not settle an active snapshot under the final message id', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'complete' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'complete' }), expect.any(String));
    });
    it('routes descendant answers into a scoped agent trace, not a root message', async () => {
        const send = vi.fn(); const user = vi.fn(); const committed = vi.fn(async () => {});
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendUserMessage: user } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', committed, 'root');
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'child answer' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-run-trace', agentId: 'child', message: expect.objectContaining({ message: 'child answer' }) }), expect.any(String));
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'child prompt' }], clientId: 'cid' } });
        expect(user).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    });

    it('announces parent compaction start via session event, deduping repeats', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const params = { threadId: 'thread', turnId: 'turn', item: { id: 'c1', type: 'contextCompaction' } };
        await projection.notification('item/started', params);
        await projection.notification('item/started', params);
        await projection.notification('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'c2', type: 'contextCompaction' } });
        expect(send).not.toHaveBeenCalled();
        expect(sendEvent.mock.calls).toEqual([
            [{ type: 'message', message: '📦 Compaction started' }],
            [{ type: 'message', message: '📦 Compaction started' }]
        ]);
    });
    it('keeps child compaction start as trace with statusText, never a parent status', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', async () => {}, 'root');
        await projection.notification('item/started', { threadId: 'child', turnId: 'turn', item: { id: 'c1', type: 'contextCompaction' } });
        expect(sendEvent).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
        const [body] = send.mock.calls[0];
        expect(body.type).toBe('agent-run-trace');
        expect(body.message.type).toBe('compaction_started');
        expect(body.message.statusText).toBe('📦 Compaction started');
    });
    it('emits live compaction start but not for completed history replay', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'completed',
            items: [{ id: 'c1', type: 'contextCompaction' }] }] });
        expect(sendEvent).not.toHaveBeenCalled();
        expect(send.mock.calls.map(([b]) => b).some((b) => b.message === '📦 Compaction started')).toBe(false);
        expect(send.mock.calls.map(([b]) => b)).toContainEqual(expect.objectContaining({ type: 'context_compacted' }));
        send.mockClear();
        await projection.notification('item/started', { threadId: 'thread', turnId: 'live', item: { id: 'c9', type: 'contextCompaction' } });
        expect(send).not.toHaveBeenCalled();
        expect(sendEvent).toHaveBeenCalledWith({ type: 'message', message: '📦 Compaction started' });
    });
});
