import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertTrackedUpstreamFiles } from './vendor'

test('vendor importer refuses files absent from the pinned Git index, even when ignored', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'hapi-ads-import-tracked-'))
    try {
        const git = (...args: string[]) => {
            const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
            expect(result.status, result.stderr).toBe(0)
        }
        git('init', '-q')
        writeFileSync(join(checkout, '.gitignore'), 'ignored.csv\n')
        writeFileSync(join(checkout, 'tracked.csv'), 'pinned source\n')
        writeFileSync(join(checkout, 'ignored.csv'), 'untracked source\n')
        mkdirSync(join(checkout, 'sub'))
        writeFileSync(join(checkout, 'sub', 'tracked.md'), 'pinned nested source\n')
        git('add', '.gitignore', 'tracked.csv', 'sub/tracked.md')
        expect(() => assertTrackedUpstreamFiles(checkout, ['tracked.csv', 'sub/tracked.md'])).not.toThrow()
        expect(() => assertTrackedUpstreamFiles(checkout, ['tracked.csv', 'ignored.csv'])).toThrow('Upstream file is not tracked: ignored.csv')
    } finally { rmSync(checkout, { recursive: true, force: true }) }
})
