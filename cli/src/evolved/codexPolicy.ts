import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { SandboxPolicy } from '../codex/appServerTypes';

/** Network access is independent of the supervised project's filesystem profile. */
export function evolvedCodexInternetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.HAPI_EVOLVED_PROXY === '1' && ['restricted', 'workspace', 'extended'].includes(env.EVOLVED_RUNNER_PROFILE ?? '');
}
export function evolvedCodexNetworkConfig(env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
    return evolvedCodexInternetEnabled(env) ? { 'sandbox_workspace_write.network_access': true } : {};
}
export function withEvolvedCodexNetworkAccess<T extends SandboxPolicy>(policy: T, env: NodeJS.ProcessEnv = process.env): T {
    return evolvedCodexInternetEnabled(env) && (policy.type === 'readOnly' || policy.type === 'workspaceWrite')
        ? { ...policy, networkAccess: true } : policy;
}
/** The supervisor verifies this immutable lease profile before spawning the Runner. */
function profile(env: NodeJS.ProcessEnv): string | undefined {
    if (!env.EVOLVED_PROJECT_ID && env.HAPI_EVOLVED_PROXY !== '1') return undefined;
    if (!['restricted', 'workspace', 'extended'].includes(env.EVOLVED_RUNNER_PROFILE ?? '')) throw new Error('Evolved Runner profile is missing or invalid');
    return env.EVOLVED_RUNNER_PROFILE;
}
function denied(): never { throw new Error('Project profile forbids this native sandbox or approval policy'); }
function withinRoot(value: unknown, env: NodeJS.ProcessEnv): boolean {
    if (typeof value !== 'string' || !isAbsolute(value) || !env.EVOLVED_RUNNER_ROOT) return false;
    try {
        const rel = relative(realpathSync(env.EVOLVED_RUNNER_ROOT), realpathSync(value));
        return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
    } catch { return false; }
}
export function assertEvolvedCodexPermission(mode: unknown, env = process.env): void {
    const value = profile(env);
    if (!value || value === 'extended' || mode === undefined) return;
    if (!(value === 'restricted' ? ['read-only'] : ['read-only', 'default']).includes(String(mode))) denied();
}
const CONFIG_FIELDS = new Set(['model', 'model_reasoning_effort', 'service_tier', 'sandbox_mode', 'approval_policy', 'approvals_reviewer',
    'sandbox_workspace_write.writable_roots', 'sandbox_workspace_write.network_access', 'sandbox_workspace_write.exclude_tmpdir_env_var', 'sandbox_workspace_write.exclude_slash_tmp']);
const FRONTEND_METHODS = new Set(['initialize', 'initialized', 'ping', 'thread/start', 'thread/resume', 'thread/fork', 'thread/archive', 'thread/unarchive',
    'thread/read', 'thread/turns/list', 'thread/list', 'thread/loaded/list', 'thread/name/set', 'thread/metadata/update', 'thread/settings/update', 'thread/compact/start', 'thread/unsubscribe',
    'thread/queue/list', 'thread/queue/add', 'thread/queue/delete', 'thread/queue/start', 'thread/goal/get', 'thread/goal/set', 'thread/goal/clear',
    'turn/start', 'turn/interrupt', 'turn/steer', 'model/list', 'collaborationMode/list', 'experimentalFeature/list', 'config/read', 'configRequirements/read',
    'skills/list', 'app/list', 'mcpServerStatus/list', 'account/read', 'account/rateLimits/read']);
export function assertEvolvedCodexFrontendMethod(method: string | undefined, env = process.env): void {
    const value = profile(env);
    if (value && value !== 'extended' && (!method || !FRONTEND_METHODS.has(method))) throw new Error('Project profile forbids this native frontend operation');
}
export function assertEvolvedCodexNativePolicy(params: Record<string, unknown>, env = process.env): void {
    const value = profile(env);
    if (!value || value === 'extended') return;
    if (params.profile != null || params.permissionProfile != null || params.activePermissionProfile != null) denied();
    if (params.cwd != null && !withinRoot(params.cwd, env)) denied();
    if (params.config != null && (typeof params.config !== 'object' || Array.isArray(params.config))) denied();
    const config = (params.config ?? {}) as Record<string, unknown>;
    if (Object.keys(config).some(key => !CONFIG_FIELDS.has(key))) denied();
    const policy = (params.sandboxPolicy ?? undefined) as Record<string, unknown> | undefined;
    if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy))) denied();
    const sandboxes = [params.sandbox, config.sandbox_mode, policy?.type].filter(item => item != null);
    const allowed = value === 'restricted' ? ['read-only', 'readOnly'] : ['read-only', 'readOnly', 'workspace-write', 'workspaceWrite'];
    if (sandboxes.some(item => typeof item !== 'string' || !allowed.includes(item))) denied();
    if ([params.approvalsReviewer, config.approvals_reviewer].some(item => item != null && item !== 'user')) denied();
    for (const approval of [params.approvalPolicy, config.approval_policy]) {
        if (approval == null) continue;
        if (value === 'restricted') { if (approval !== 'never') denied(); }
        else if (approval === 'never') { if (!sandboxes.length || sandboxes.some(item => item !== 'read-only' && item !== 'readOnly')) denied(); }
        else if (approval !== 'on-request' && approval !== 'untrusted') denied();
    }
    if (policy && Object.keys(policy).some(key => !['type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp', 'access'].includes(key))) denied();
    for (const roots of [policy?.writableRoots, config['sandbox_workspace_write.writable_roots']]) {
        if (roots === undefined) continue;
        if (value === 'restricted' || !Array.isArray(roots) || roots.some(root => !withinRoot(root, env))) denied();
    }
    for (const network of [policy?.networkAccess, config['sandbox_workspace_write.network_access']]) {
        if (network !== undefined && (typeof network !== 'boolean' || (network && !evolvedCodexInternetEnabled(env)))) denied();
    }
    for (const key of ['excludeTmpdirEnvVar', 'excludeSlashTmp']) if (policy?.[key] !== undefined && typeof policy[key] !== 'boolean') denied();
    for (const key of ['sandbox_workspace_write.exclude_tmpdir_env_var', 'sandbox_workspace_write.exclude_slash_tmp']) if (config[key] !== undefined && typeof config[key] !== 'boolean') denied();
    if (policy?.access !== undefined) {
        const access = policy.access as Record<string, unknown>;
        if (!access || access.type !== 'fullAccess' || Object.keys(access).length !== 1) denied();
    }
}
