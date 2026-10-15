import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RawJSONLines } from '../types';

/** Startup evidence only. cost-state is written at teardown, not during a run. */
export async function resolveLocalClaudeModel(options: {
    path: string; model?: string | null; args?: string[]; env?: Record<string, string>;
}): Promise<string | undefined> {
    if (options.model) return options.model;
    const args = options.model === undefined ? options.args ?? [] : [];
    let argumentModel: string | undefined;
    for (let i = 0; i < args.length && args[i] !== '--'; i++) {
        if (args[i] === '--model') argumentModel = args[++i];
        else if (args[i].startsWith('--model=')) argumentModel = args[i].slice(8);
    }
    if (argumentModel) return argumentModel;
    const environment = { ...process.env, ...options.env };
    if (environment.ANTHROPIC_MODEL) return environment.ANTHROPIC_MODEL;
    const configDir = environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    for (const file of [join(options.path, '.claude/settings.local.json'), join(options.path, '.claude/settings.json'), join(configDir, 'settings.json')]) {
        try {
            if ((await stat(file)).size > 1024 * 1024) continue;
            const settings = JSON.parse(await readFile(file, 'utf8'));
            if (typeof settings?.model === 'string' && settings.model.trim()) return settings.model.trim();
        } catch { /* Missing or malformed optional settings provide no evidence. */ }
    }
    return undefined;
}

function sameModel(selection: string, actual: string): boolean {
    const base = selection.replace(/\[1m\]$/i, '');
    actual = actual.replace(/\[1m\]$/i, '');
    if (base === actual) return true;
    return ['opus', 'sonnet', 'haiku'].includes(base) && actual.startsWith(`claude-${base}-`);
}

export function annotateLocalClaudeContext(message: RawJSONLines, selectedModel: string | undefined, modelSwitchObserved = false): RawJSONLines {
    if (message.type !== 'assistant' || message.isSidechain || message.isApiErrorMessage || !message.message?.usage
        || message.message.usage.context_window || !selectedModel?.toLowerCase().endsWith('[1m]')
        || typeof message.message.model !== 'string' || !sameModel(selectedModel, message.message.model)) return message;
    const usage = message.message.usage;
    const observedTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    // Startup configuration expresses intent, not provider entitlement. A live
    // model-switch hook or >200k observed context supplies the runtime evidence.
    if (!modelSwitchObserved && observedTokens <= 200_000 && !message.message.model.toLowerCase().endsWith('[1m]')) return message;
    return { ...message, message: { ...message.message, usage: { ...message.message.usage, context_window: 1_000_000 } } };
}
