import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync, readFileSync, rmSync, statSync, symlinkSync, linkSync } from 'node:fs'
import { join } from 'node:path'

const { dir } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('node:os') as typeof import('node:os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: pathJoin } = require('node:path') as typeof import('node:path')
    return { dir: mkdtempSync(pathJoin(tmpdir(), 'hapi-cli-settings-')) }
})

vi.mock('@/configuration', () => ({
    configuration: {
        happyHomeDir: dir,
        settingsFile: join(dir, 'settings.json'),
        privateKeyFile: join(dir, 'access.key'),
        runnerStateFile: join(dir, 'runner.state.json'),
        runnerLockFile: join(dir, 'runner.state.json.lock'),
        logsDir: join(dir, 'logs'),
    },
}))

import { runnerStateForDisplay, updateSettings, writeRunnerState } from './persistence'

describe('updateSettings', () => {
    afterEach(() => {
        try {
            rmSync(join(dir, 'settings.json'), { force: true })
            rmSync(join(dir, 'settings.json.lock'), { force: true })
        } catch {
            // ignore
        }
    })

    it('rejects corrupt settings.json and leaves the original bytes intact', async () => {
        const settingsFile = join(dir, 'settings.json')
        writeFileSync(settingsFile, '{not-json')

        await expect(
            updateSettings((current) => ({ ...current, apiUrl: 'http://should-not-write' }))
        ).rejects.toThrow()

        expect(readFileSync(settingsFile, 'utf8')).toBe('{not-json')
    })
})

describe('writeRunnerState', () => {
    it.skipIf(process.platform === 'win32')('keeps the control token private, also over an older world-readable file', () => {
        const stateFile = join(dir, 'runner.state.json')
        writeFileSync(stateFile, '{}', { mode: 0o644 })

        writeRunnerState({ pid: 1, httpPort: 2, controlToken: 'secret', startTime: 'now', startedWithCliVersion: '0' })

        expect(statSync(stateFile).mode & 0o777).toBe(0o600)
        expect(JSON.parse(readFileSync(stateFile, 'utf8')).controlToken).toBe('secret')
        rmSync(stateFile, { force: true })
    })

    it.skipIf(process.platform === 'win32')('refuses links to other files without changing their contents', () => {
        const stateFile = join(dir, 'runner.state.json')
        const other = join(dir, 'unrelated.txt')
        const state = { pid: 1, httpPort: 2, controlToken: 'secret', startTime: 'now', startedWithCliVersion: '0' }
        writeFileSync(other, 'keep this file')
        for (const link of [symlinkSync, linkSync]) {
            link(other, stateFile)
            expect(() => writeRunnerState(state)).toThrow()
            expect(readFileSync(other, 'utf8')).toBe('keep this file')
            rmSync(stateFile)
        }
        rmSync(other)
    })
})

describe('runnerStateForDisplay', () => {
    it('redacts the control token for doctor output', () => {
        const printed = JSON.stringify(runnerStateForDisplay({ pid: 1, httpPort: 2, controlToken: 'secret-token', startTime: 'now', startedWithCliVersion: '0' }))
        expect(printed).not.toContain('secret-token')
        expect(printed).toContain('"httpPort":2')
    })
})
