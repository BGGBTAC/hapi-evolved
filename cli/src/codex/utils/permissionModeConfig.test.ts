import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCodexPermissionModeConfig } from './permissionModeConfig';
afterEach(() => vi.unstubAllEnvs());

describe('resolveCodexPermissionModeConfig', () => {
    it('enables managed runner networking without changing sandbox or approvals', () => {
        vi.stubEnv('HAPI_EVOLVED_PROXY', '1');
        vi.stubEnv('EVOLVED_RUNNER_PROFILE', 'restricted');
        expect(resolveCodexPermissionModeConfig('read-only')).toEqual({ approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: true } });
        vi.stubEnv('EVOLVED_RUNNER_PROFILE', 'workspace');
        expect(resolveCodexPermissionModeConfig('default')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } });
        vi.stubEnv('HAPI_EVOLVED_PROXY', '');
        expect(resolveCodexPermissionModeConfig('read-only').sandboxPolicy).toEqual({ type: 'readOnly' });
    });
    it('uses on-request approvals for default mode', () => {
        expect(resolveCodexPermissionModeConfig('default')).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        });
    });

    it('keeps safe-yolo escalation available with a supported approval policy', () => {
        expect(resolveCodexPermissionModeConfig('safe-yolo')).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        });
    });
});
