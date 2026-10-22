import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { CursorSession } from '@/cursor/session';
import type { EnhancedMode } from '@/cursor/loop';
import { cursorLegacyRemoteLauncher } from '@/cursor/cursorLegacyRemoteLauncher';
import { buildCursorAcpArgs } from '@/cursor/utils/cursorAcpBackend';
import { AcpStdioTransport } from './AcpStdioTransport';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/ui/ink/OpencodeDisplay', () => ({ OpencodeDisplay: () => null }));

// These tests deliberately run cmd.exe and a real Node child on Windows.
// Only UI/logging is stubbed: neither spawn nor cross-spawn is mocked.
describe.skipIf(process.platform !== 'win32')('native Windows agent argv', () => {
    let fixture: string;
    let bin: string;
    let output: string;
    let shim: string;
    let hostile: string;

    beforeEach(async () => {
        fixture = await mkdtemp(join(tmpdir(), 'hapi-native-argv-'));
        bin = join(fixture, 'node_modules', '.bin');
        await mkdir(bin, { recursive: true });
        output = join(fixture, 'argv.json');
        shim = join(bin, 'agent.cmd');
        // Standard npm-style .cmd forwarding; cross-spawn must handle the
        // second cmd.exe expansion of %* as well as the initial spawn.
        await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
        await writeFile(join(bin, 'argv.cjs'),
            'require("node:fs").writeFileSync(process.env.HAPI_TEST_ARGV_OUTPUT, JSON.stringify(process.argv.slice(2)))');
        vi.stubEnv('PATH', `${bin};${process.env.PATH ?? ''}`);
        vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
        vi.stubEnv('HAPI_TEST_ARGV_OUTPUT', output);
        hostile = `text" & echo injected>"${join(fixture, 'injected.txt')}" & rem " %COMSPEC% !literal! ^ | ( )`;
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        if (fixture) await rm(fixture, { recursive: true, force: true });
    });

    async function capturedArgs(): Promise<string[]> {
        // ACP returns before child startup. Bound the wait, and report a failed
        // launch as a failure rather than silently skipping Windows coverage.
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const text = await readFile(output, 'utf8').catch(() => null);
            if (text !== null) return JSON.parse(text) as string[];
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('The native .cmd child did not record its argv');
    }

    async function expectNoShellSideEffects(): Promise<void> {
        expect((await readdir(fixture)).sort()).toEqual(['argv.json', 'node_modules']);
    }

    it('passes ACP model/worktree/add-dir literally through a real .cmd shim', async () => {
        const args = buildCursorAcpArgs({ model: hostile, worktree: hostile, addDirs: [hostile] });
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        const transport = await AcpStdioTransport.create({ command: shim, args, env });
        try {
            expect(await capturedArgs()).toEqual(args);
            await expectNoShellSideEffects();
        } finally {
            await transport.close();
        }
    }, 15_000);

    it('passes a legacy chat prompt and model literally through the real launcher', async () => {
        const queue = new MessageQueue2<EnhancedMode>(() => 'fixture-model');
        queue.push(hostile, { permissionMode: 'default', model: hostile });
        queue.close();
        const session = new CursorSession({
            api: {} as never,
            client: {
                rpcHandlerManager: { registerHandler: vi.fn() },
                updateMetadata: vi.fn(),
                sendSessionEvent: vi.fn(),
                sendAgentMessage: vi.fn(),
                keepAlive: vi.fn(),
                emitMessagesConsumed: vi.fn(),
            } as never,
            path: fixture,
            logPath: join(fixture, 'unused.log'),
            sessionId: 'fixture-session',
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote',
        });
        await cursorLegacyRemoteLauncher(session);
        expect(await capturedArgs()).toEqual([
            '-p', hostile, '--output-format', 'stream-json', '--trust',
            '--workspace', fixture, '--resume', 'fixture-session', '--model', hostile,
        ]);
        await expectNoShellSideEffects();
    }, 15_000);
});
