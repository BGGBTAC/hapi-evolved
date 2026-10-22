import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCursorAcpArgs } from '@/cursor/utils/cursorAcpBackend';
import { AcpStdioTransport, buildAcpStdioSpawnOptions } from './AcpStdioTransport';

const HOSTILE_MODEL = 'gpt-5" & echo pwned-model > pwned.txt & "';
const HOSTILE_WORKTREE = 'wt|calc.exe';
const HOSTILE_DIR = 'C:\\work\\a&b (x) %PATH% !x! <in >out';
const CMD_METACHARS = new Set(['&', '|', '<', '>', '(', ')', '%', '!', '"', '^']);

type CrossSpawnParse = (command: string, args: string[], options: Record<string, unknown>) => {
    command: string;
    args: string[];
    options: Record<string, unknown>;
};

/** Load cross-spawn's real parser as it initialises on Windows (isWin is read at module load). */
function loadWindowsCrossSpawnParse(): CrossSpawnParse {
    const require = createRequire(import.meta.url);
    const parsePath = require.resolve('cross-spawn/lib/parse');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    delete require.cache[parsePath];
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
        return require(parsePath) as CrossSpawnParse;
    } finally {
        Object.defineProperty(process, 'platform', platform);
        delete require.cache[parsePath];
    }
}

/** Return metacharacters cmd.exe would interpret (not caret-escaped) in a `/s /c "<line>"` payload. */
function unescapedCmdMetachars(payload: string): string[] {
    expect(payload.startsWith('"') && payload.endsWith('"')).toBe(true);
    const line = payload.slice(1, -1);
    const found: string[] = [];
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index]!;
        if (char === '^') {
            index += 1;
            continue;
        }
        if (CMD_METACHARS.has(char)) found.push(char);
    }
    return found;
}

describe('ACP agent argv with shell metacharacters', () => {
    const args = buildCursorAcpArgs({ model: HOSTILE_MODEL, worktree: HOSTILE_WORKTREE, addDirs: [HOSTILE_DIR] });

    it('keeps untrusted model/worktree/add-dir values as literal argv entries', () => {
        expect(args).toEqual(['--worktree', HOSTILE_WORKTREE, '--add-dir', HOSTILE_DIR, '--model', HOSTILE_MODEL, 'acp']);
    });

    it('escapes every cmd.exe metacharacter when Windows needs a .cmd shim', () => {
        const parse = loadWindowsCrossSpawnParse();
        const parsed = parse('agent', args, buildAcpStdioSpawnOptions({}) as Record<string, unknown>);

        // Node is told the cmd line is pre-escaped, so cross-spawn's escaping is what cmd.exe sees.
        expect(parsed.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
        expect(parsed.options.windowsVerbatimArguments).toBe(true);
        expect(unescapedCmdMetachars(parsed.args[3]!)).toEqual([]);
        expect(parsed.args[3]).toContain('pwned-model');
    });

    it('would have left metacharacters live with the previous shell:true contract', () => {
        const parse = loadWindowsCrossSpawnParse();
        const parsed = parse('agent', args, { ...buildAcpStdioSpawnOptions({}), shell: true });

        // With shell:true cross-spawn hands the raw args to cmd.exe unchanged.
        expect(parsed.args).toEqual(args);
        expect(parsed.options.windowsVerbatimArguments).toBeUndefined();
    });
});

describe.skipIf(process.platform === 'win32')('ACP stdio transport with a real child process', () => {
    let dir: string | null = null;

    afterEach(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
        dir = null;
    });

    it('delivers hostile argv verbatim and runs no shell command', async () => {
        dir = await mkdtemp(join(tmpdir(), 'hapi-acp-argv-'));
        const output = join(dir, 'argv.json');
        const script = 'require("fs").writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(1)))';
        const hostile = ['--model', `$(touch ${join(dir, 'pwned')}); touch ${join(dir, 'pwned2')}`, '--add-dir', HOSTILE_DIR];

        const transport = await AcpStdioTransport.create({
            command: process.execPath,
            args: ['-e', script, '--', ...hostile],
            env: { PATH: process.env.PATH ?? '', ARGV_OUT: output }
        });
        try {
            let written: string | null = null;
            for (let attempt = 0; attempt < 100 && written === null; attempt += 1) {
                written = await readFile(output, 'utf8').catch(() => null);
                if (written === null) await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(JSON.parse(written ?? 'null')).toEqual(hostile);
            await expect(readFile(join(dir, 'pwned'))).rejects.toThrow();
            await expect(readFile(join(dir, 'pwned2'))).rejects.toThrow();
        } finally {
            await transport.close().catch(() => {});
        }
    });
});
