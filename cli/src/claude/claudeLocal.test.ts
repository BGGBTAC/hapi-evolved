import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    spawn: vi.fn(async (_opts: unknown) => {}),
    writeFile: vi.fn(),
    removeDirectory: vi.fn()
}))

vi.mock('node:fs', () => ({
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => 'Instructions from user file'),
    mkdtempSync: vi.fn(() => '/tmp/private-hapi-prompt'),
    writeFileSync: harness.writeFile,
    rmSync: harness.removeDirectory
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}))

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: () => false
}))

vi.mock('./utils/path', () => ({
    getProjectPath: () => '/tmp/claude-project'
}))

vi.mock('./utils/mcpConfig', () => ({
    appendMcpConfigArg: () => undefined
}))

vi.mock('./utils/systemPrompt', () => ({
    getSystemPrompt: () => 'HAPI system prompt'
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: harness.spawn
}))

vi.mock('@/constants/uploadPaths', () => ({
    getHapiBlobsDir: () => '/tmp/hapi-blobs'
}))

vi.mock('@/utils/shellEscape', () => ({
    stripNewlinesForWindowsShellArg: (value: string) => value
}))

vi.mock('./sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}))

import { claudeLocal } from './claudeLocal'

function getSpawnArgs(): string[] {
    const call = harness.spawn.mock.calls[0]
    expect(call).toBeDefined()
    return (call[0] as { args: string[] }).args
}

describe('claudeLocal model arguments', () => {
    beforeEach(() => {
        harness.spawn.mockClear()
        harness.writeFile.mockClear()
        harness.removeDirectory.mockClear()
    })

    it('preserves an explicit native resume even when the local transcript probe has no history', async () => {
        await claudeLocal({ abort: new AbortController().signal, sessionId: 'requested-native-id',
            path: '/moved-workspace', hookSettingsPath: '/tmp/hooks.json',
            claudeEnvVars: { CLAUDE_CONFIG_DIR: '/isolated-config' } })
        expect(getSpawnArgs().slice(0, 2)).toEqual(['--resume', 'requested-native-id'])
    })

    it.each([
        ['--append-system-prompt', 'User instructions'],
        ['--append-system-prompt=User instructions']
    ])('preserves wrapper instructions with custom append arguments %j on resume', async (...claudeArgs) => {
        await claudeLocal({ abort: new AbortController().signal, sessionId: 'native-id',
            path: '/workspace', hookSettingsPath: '/tmp/hooks.json', claudeArgs })
        const args = getSpawnArgs()
        expect(args.slice(0, 2)).toEqual(['--resume', 'native-id'])
        expect(args.filter(arg => arg.startsWith('--append-system-prompt'))).toEqual(['--append-system-prompt'])
        expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('User instructions\n\nHAPI system prompt')
    })

    it('merges a user prompt file without leaving a competing native override', async () => {
        await claudeLocal({ abort: new AbortController().signal, sessionId: null,
            path: '/workspace', hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--append-system-prompt-file', 'extra.txt'] })
        const args = getSpawnArgs()
        expect(args).not.toContain('--append-system-prompt')
        expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/tmp/private-hapi-prompt/instructions.txt')
        expect(args.join(' ')).not.toContain('Instructions from user file')
        expect(harness.writeFile).toHaveBeenCalledWith('/tmp/private-hapi-prompt/instructions.txt',
            'Instructions from user file\n\nHAPI system prompt', { mode: 0o600 })
        expect(harness.removeDirectory).toHaveBeenCalledWith('/tmp/private-hapi-prompt', { recursive: true, force: true })
    })

    it('removes a merged prompt file even when native launch fails', async () => {
        harness.spawn.mockRejectedValueOnce(new Error('native launch failed'))
        await expect(claudeLocal({ abort: new AbortController().signal, sessionId: null,
            path: '/workspace', hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--append-system-prompt-file=extra.txt'] })).rejects.toThrow('native launch failed')
        expect(harness.removeDirectory).toHaveBeenCalledWith('/tmp/private-hapi-prompt', { recursive: true, force: true })
    })

    it('launches Claude with the current session model', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            model: 'claude-opus-4-1'
        })

        expect(getSpawnArgs()).toEqual([
            '--append-system-prompt', 'HAPI system prompt',
            '--model', 'claude-opus-4-1',
            '--settings', '/tmp/hooks.json',
            '--add-dir', '/tmp/hapi-blobs'
        ])
    })

    it('replaces a stale startup model with the current session model', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--model', 'claude-haiku-4-5', '--verbose'],
            model: 'claude-opus-4-1'
        })

        const args = getSpawnArgs()
        expect(args).not.toContain('claude-haiku-4-5')
        expect(args).toContain('--verbose')
        expect(args.filter((arg) => arg === '--model')).toHaveLength(1)
        expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
            '--model', 'claude-opus-4-1'
        ])
    })

    it('removes a stale startup model when the session returns to the default', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--model=claude-haiku-4-5', '--verbose'],
            model: null
        })

        const args = getSpawnArgs()
        expect(args).not.toContain('--model=claude-haiku-4-5')
        expect(args).not.toContain('--model')
        expect(args).toContain('--verbose')
    })
})
