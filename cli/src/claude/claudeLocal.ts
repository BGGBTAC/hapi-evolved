import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "@/ui/logger";
import { getProjectPath } from "./utils/path";
import { appendMcpConfigArg } from "./utils/mcpConfig";
import { getSystemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { spawnWithTerminalGuard } from "@/utils/spawnWithTerminalGuard";
import { getHapiBlobsDir } from "@/constants/uploadPaths";
import { stripNewlinesForWindowsShellArg } from "@/utils/shellEscape";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import type { SessionModel } from "@/api/types";

function withoutTrackedModelArgs(args: string[]): string[] {
    const filtered: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--model') {
            if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                i++;
            }
            continue;
        }
        if (arg.startsWith('--model=')) {
            continue;
        }
        filtered.push(arg);
    }

    return filtered;
}

/** Claude's repeated append flag replaces the earlier value. Merge it once. */
function takeAppendSystemPrompt(args: string[] | undefined): { args: string[]; prompt: string; file?: string } {
    const filtered: string[] = [];
    let prompt = '';
    let file: string | undefined;
    for (let i = 0; i < (args?.length ?? 0); i++) {
        const arg = args![i];
        if (arg === '--') { filtered.push(...args!.slice(i)); break; }
        const separator = arg.indexOf('=');
        const flag = separator === -1 ? arg : arg.slice(0, separator);
        if (flag !== '--append-system-prompt' && flag !== '--append-system-prompt-file') {
            filtered.push(arg);
            continue;
        }
        const value = separator === -1 ? args![++i] : arg.slice(separator + 1);
        if (value === undefined) throw new Error(`Missing ${flag} value`);
        file = flag === '--append-system-prompt-file' ? value : undefined;
        prompt = file === undefined ? value : '';
    }
    return { args: filtered, prompt, file };
}

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[]
    model?: SessionModel
    allowedTools?: string[]
    hookSettingsPath: string
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Check if user passed explicit session control flags.
    const hasContinueFlag = opts.claudeArgs?.includes('--continue');
    const hasResumeFlag = opts.claudeArgs?.includes('--resume');
    const hasUserSessionControl = Boolean(hasContinueFlag || hasResumeFlag);

    // Determine session strategy:
    // - If resuming an existing session: use --resume (unless user already supplied session control)
    // - If starting fresh: let Claude create a new session ID (reported via SessionStart hook)
    // Claude owns transcript discovery (custom config roots, renamed worktrees,
    // and newly created empty sessions). A local probe must never silently
    // replace an explicit resume with a fresh, context-free session.
    const startFrom = opts.sessionId;

    if (opts.abort.aborted) {
        logger.debug('[ClaudeLocal] Abort already signaled before spawn; skipping launch');
        return startFrom ?? null;
    }

    // Build args for Claude CLI
    const args: string[] = [];

    if (startFrom && !hasUserSessionControl) {
        // Resume existing session
        args.push('--resume', startFrom);
    }

    const userSystemPrompt = takeAppendSystemPrompt(opts.claudeArgs);
    const hapiSystemPrompt = getSystemPrompt();
    const systemPromptArgIndex = args.length;
    if (userSystemPrompt.file !== undefined) {
        // Populate this private file immediately before spawning, inside the
        // cleanup scope. File-based instructions must never enter argv/logs.
        args.push('--append-system-prompt-file', '');
    } else {
        args.push('--append-system-prompt', stripNewlinesForWindowsShellArg(
            [userSystemPrompt.prompt, hapiSystemPrompt].filter(Boolean).join('\n\n')
        ));
    }

    const cleanupMcpConfig = appendMcpConfigArg(args, opts.mcpServers, {
        baseDir: projectDir
    });

    if (opts.allowedTools && opts.allowedTools.length > 0) {
        args.push('--allowedTools', opts.allowedTools.join(','));
    }

    // Once model state is available, it is authoritative over startup args.
    const claudeArgs = opts.model === undefined
        ? userSystemPrompt.args
        : withoutTrackedModelArgs(userSystemPrompt.args);
    if (claudeArgs) {
        args.push(...claudeArgs);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }

    // Add hook settings for session tracking
    args.push('--settings', opts.hookSettingsPath);
    logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);

    // Add blobs directory for file upload access
    args.push('--add-dir', getHapiBlobsDir());
    logger.debug(`[ClaudeLocal] Adding blobs directory: ${getHapiBlobsDir()}`);

    // Prepare environment variables
    // Note: Local mode uses global Claude installation
    //
    // SDK metadata extraction (extractSDKMetadata → query()) sets
    // CLAUDE_CODE_ENTRYPOINT='sdk-ts' on the current process. If leaked
    // into the local spawn, Claude Code thinks it was SDK-launched and
    // excludes the session from `claude --resume`. Destructure it out
    // so the child uses its own default entrypoint.
    const { CLAUDE_CODE_ENTRYPOINT: _, ...cleanEnv } = process.env
    const env = {
        ...cleanEnv,
        DISABLE_AUTOUPDATER: '1',
        ...opts.claudeEnvVars
    }

    // Get Claude executable path (absolute path on Windows for shell: false)
    const claudeCommand = getDefaultClaudeCodePath();
    logger.debug(`[ClaudeLocal] Using claude executable: ${claudeCommand}`);

    // Spawn the process
    let systemPromptDirectory: string | undefined;
    try {
        if (userSystemPrompt.file !== undefined) {
            const userPrompt = readFileSync(resolve(opts.path, userSystemPrompt.file), 'utf8');
            systemPromptDirectory = mkdtempSync(join(tmpdir(), 'hapi-claude-instructions-'));
            const file = join(systemPromptDirectory, 'instructions.txt');
            writeFileSync(file, [userPrompt, hapiSystemPrompt].filter(Boolean).join('\n\n'), { mode: 0o600 });
            args[systemPromptArgIndex + 1] = file;
        }
        logger.debug(`[ClaudeLocal] Spawning claude with args: ${JSON.stringify(args)}`);
        await spawnWithTerminalGuard({
            command: claudeCommand,
            args,
            cwd: opts.path,
            env: withBunRuntimeEnv(env, { allowBunBeBun: false }),
            signal: opts.abort,
            logLabel: 'ClaudeLocal',
            spawnName: 'claude',
            installHint: 'Claude CLI',
            includeCause: true,
            logExit: true,
            shell: false  // Use absolute path, no shell needed
        });
    } finally {
        try { cleanupMcpConfig?.(); }
        finally { if (systemPromptDirectory) rmSync(systemPromptDirectory, { recursive: true, force: true }); }
    }

    return startFrom ?? null;
}
