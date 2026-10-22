import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real cursorLocal/kimiLocal -> spawnWithTerminalGuard -> spawnWithAbort -> cross-spawn
// chain; cross-spawn is only wrapped to record the options it was given.
const state = vi.hoisted(() => ({ command: '', calls: [] as Array<[string, string[], Record<string, unknown>]> }))
vi.mock('cross-spawn', async (importOriginal) => {
    const actual = await importOriginal<{ default: (...args: unknown[]) => unknown }>()
    return {
        default: (command: string, args: string[], options: Record<string, unknown>) => {
            state.calls.push([command, args, options])
            return actual.default(command, args, options)
        }
    }
})
vi.mock('@/agent/agentLaunchCommand', () => ({ getAgentLaunchCommand: () => state.command }))
vi.mock('@/ui/terminalState', () => ({ restoreTerminalState: () => {} }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { cursorLocal } from '@/cursor/cursorLocal'
import { kimiLocal } from '@/kimi/kimiLocal'

const CMD_METACHARS = new Set(['&', '|', '<', '>', '(', ')', '%', '!', '"', '^'])
type CrossSpawnParse = (command: string, args: string[], options: Record<string, unknown>) => {
    args: string[]
    options: Record<string, unknown>
}

/** cross-spawn's real parser as initialised on Windows (isWin is read at module load). */
function loadWindowsCrossSpawnParse(): CrossSpawnParse {
    const require = createRequire(import.meta.url)
    const parsePath = require.resolve('cross-spawn/lib/parse')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    delete require.cache[parsePath]
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
        return require(parsePath) as CrossSpawnParse
    } finally {
        Object.defineProperty(process, 'platform', platform)
        delete require.cache[parsePath]
    }
}

function unescapedCmdMetachars(payload: string): string[] {
    const line = payload.slice(1, -1)
    const found: string[] = []
    for (let index = 0; index < line.length; index += 1) {
        if (line[index] === '^') {
            index += 1
            continue
        }
        if (CMD_METACHARS.has(line[index]!)) found.push(line[index]!)
    }
    return found
}

describe.skipIf(process.platform === 'win32')('local agent wrappers with hostile argv', () => {
    let root: string

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-local-argv-'))
        state.command = join(root, 'fake-agent')
        state.calls = []
        await writeFile(state.command, '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n')
        await chmod(state.command, 0o755)
        vi.stubEnv('ARGV_OUT', join(root, 'argv.json'))
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
    })

    async function expectLiteral(expected: string[]): Promise<void> {
        expect(JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'))).toEqual(expected)
        await expect(readFile(join(root, 'pwned'))).rejects.toThrow()

        const [, args, options] = state.calls[0]!
        expect(options.shell).toBeFalsy()
        const parsed = loadWindowsCrossSpawnParse()('agent', args, options)
        expect(parsed.options.windowsVerbatimArguments).toBe(true)
        expect(unescapedCmdMetachars(parsed.args[3]!)).toEqual([])
    }

    it('cursorLocal passes model/worktree/add-dir/chat id literally without a shell', async () => {
        const pwned = join(root, 'pwned')
        const model = `gpt" & touch ${pwned} & "`
        const worktree = `wt|touch ${pwned}`
        const dir = `$(touch ${pwned}) (x) %PATH% !x! <in >out`
        const chatId = `chat;touch ${pwned}`

        await cursorLocal({ abort: new AbortController().signal, chatId, path: root, model, worktree, addDirs: [dir] })

        await expectLiteral(['--resume', chatId, '--model', model, '--worktree', worktree, '--add-dir', dir])
    })

    it('kimiLocal passes session/model literally without a shell', async () => {
        const pwned = join(root, 'pwned')
        const sessionId = `s" & touch ${pwned} & "`
        const model = `m|touch ${pwned}`

        await kimiLocal({ abort: new AbortController().signal, path: root, sessionId, model })

        await expectLiteral(['--session', sessionId, '--model', model])
    })
})
