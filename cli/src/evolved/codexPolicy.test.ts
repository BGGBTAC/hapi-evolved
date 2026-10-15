import { describe, expect, it } from 'vitest';
import { assertEvolvedCodexFrontendMethod, assertEvolvedCodexNativePolicy, assertEvolvedCodexPermission } from './codexPolicy';
const env = (profile: string) => ({ EVOLVED_PROJECT_ID: 'project', EVOLVED_RUNNER_PROFILE: profile });
describe('Evolved native Codex profile', () => {
    it('rejects slash/RPC permission escalation while preserving allowed settings', () => {
        for (const mode of ['default', 'autoReview', 'yolo', 'safe-yolo']) expect(() => assertEvolvedCodexPermission(mode, env('restricted'))).toThrow('profile');
        for (const mode of ['autoReview', 'yolo', 'safe-yolo']) expect(() => assertEvolvedCodexPermission(mode, env('workspace'))).toThrow('profile');
        expect(() => assertEvolvedCodexPermission('read-only', env('restricted'))).not.toThrow();
        expect(() => assertEvolvedCodexPermission('default', env('workspace'))).not.toThrow();
        expect(() => assertEvolvedCodexPermission('yolo', env('extended'))).not.toThrow();
        expect(() => assertEvolvedCodexPermission('default', env(''))).toThrow('invalid');
    });
    it('also guards native frontend overrides, including config aliases', () => {
        for (const params of [{ sandbox: 'danger-full-access' }, { sandboxPolicy: { type: 'dangerFullAccess' } }, { config: { sandbox_mode: 'danger-full-access' } }, { approvalsReviewer: 'auto_review' }, { approvalPolicy: 'never' }]) {
            expect(() => assertEvolvedCodexNativePolicy(params, env('workspace'))).toThrow();
        }
        expect(() => assertEvolvedCodexNativePolicy({ sandbox: 'read-only', approvalPolicy: 'never' }, env('restricted'))).not.toThrow();
        expect(() => assertEvolvedCodexNativePolicy({ sandbox: 'workspace-write', approvalPolicy: 'on-request' }, env('workspace'))).not.toThrow();
        expect(() => assertEvolvedCodexNativePolicy({ sandbox: 'read-only', approvalPolicy: 'on-request' }, env('restricted'))).toThrow();
    });
});

it('rejects conflicting aliases and untrusted native configuration before forwarding', () => {
    for (const params of [
        { sandbox: 'read-only', config: { sandbox_mode: 'danger-full-access' } },
        { approvalsReviewer: 'user', config: { approvals_reviewer: 'auto_review' } },
        { approvalPolicy: 'on-request', config: { approval_policy: 'never' } },
        { config: { notify: ['sh', '-c', 'bad'] } }, { config: { 'mcp_servers.untrusted.command': 'sh' } },
        { config: { profile: 'unsafe' } }, { profile: 'unsafe' },
        { sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/'], networkAccess: true } },
        { sandbox: 'read-only', sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'never' },
        { cwd: '/' }, { config: { 'sandbox_workspace_write.network_access': true } }
    ]) expect(() => assertEvolvedCodexNativePolicy(params, env('workspace'))).toThrow('profile');
    for (const method of ['config/value/write', 'config/batchWrite', 'command/exec', 'unknown/future']) {
        expect(() => assertEvolvedCodexFrontendMethod(method, env('workspace'))).toThrow('profile');
    }
    expect(() => assertEvolvedCodexFrontendMethod('thread/settings/update', env('workspace'))).not.toThrow();
    expect(() => assertEvolvedCodexNativePolicy({ sandbox: 'workspace-write', approvalPolicy: 'on-request', config: { model_reasoning_effort: 'high', 'sandbox_workspace_write.writable_roots': [], 'sandbox_workspace_write.network_access': false } }, env('workspace'))).not.toThrow();
});
