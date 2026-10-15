import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateLocalClaudeContext, resolveLocalClaudeModel } from './localContextWindow';
import type { RawJSONLines } from '../types';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('local Claude context evidence', () => {
    it('uses explicit model, then arguments, environment, project and user settings', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-model-')); dirs.push(dir);
        const config = join(dir, 'config'); await mkdir(config); await mkdir(join(dir, '.claude'));
        vi.stubEnv('ANTHROPIC_MODEL', ''); vi.stubEnv('CLAUDE_CONFIG_DIR', config);
        await writeFile(join(config, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));
        expect(await resolveLocalClaudeModel({ path: dir })).toBe('opus[1m]');
        await writeFile(join(dir, '.claude/settings.json'), JSON.stringify({ model: 'sonnet[1m]' }));
        expect(await resolveLocalClaudeModel({ path: dir })).toBe('sonnet[1m]');
        const options = { path: dir, env: { ANTHROPIC_MODEL: 'model-env' }, args: ['--model', 'model-arg'] };
        expect(await resolveLocalClaudeModel(options)).toBe('model-arg');
        expect(await resolveLocalClaudeModel({ ...options, model: 'model-ui' })).toBe('model-ui');
        expect(await resolveLocalClaudeModel({ ...options, args: ['--', '--model=ignored'] })).toBe('model-env');
    });
    it('does not treat a configured 1M alias as provider entitlement', () => {
        const message = { type: 'assistant', uuid: 'a', message: { model: 'claude-opus-5', content: [], usage: { input_tokens: 1000, output_tokens: 1 } } } as unknown as RawJSONLines;
        expect(annotateLocalClaudeContext(message, 'opus[1m]')).toBe(message);
        expect(annotateLocalClaudeContext(message, 'opus[1m]', true)).toMatchObject({ message: { usage: { context_window: 1_000_000 } } });
    });
    it('annotates every matching root sample, never another model, child, error or explicit capacity', () => {
        const message = { type: 'assistant', uuid: 'a', message: { model: 'claude-opus-5', content: [], usage: { input_tokens: 900_000, output_tokens: 1 } } } as unknown as RawJSONLines;
        for (let i = 0; i < 3; i++) expect(annotateLocalClaudeContext(message, 'opus[1m]')).toMatchObject({ message: { usage: { context_window: 1_000_000 } } });
        expect(annotateLocalClaudeContext(message, 'sonnet[1m]')).toBe(message);
        expect(annotateLocalClaudeContext(message, 'opus')).toBe(message);
        for (const changed of [{ ...message, isSidechain: true }, { ...message, isApiErrorMessage: true }]) expect(annotateLocalClaudeContext(changed as RawJSONLines, 'opus[1m]')).toBe(changed);
    });
});
