import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function run(args: string[], cwd: string): string {
    const result = Bun.spawnSync(args, {
        cwd, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
}

test('source bundle contains parseable JSON and standard checksums for its real archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'hapi-source-bundle-'))
    roots.push(root)
    run(['git', 'init', '--quiet'], root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0', packageManager: 'bun@1.3.14' }))
    writeFileSync(join(root, 'README.md'), 'Synthetic source archive fixture\n')
    run(['git', 'add', '--', 'package.json', 'README.md'], root)
    run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], root)
    const commit = run(['git', 'rev-parse', 'HEAD'], root)
    const output = join(root, 'bundle')
    const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, 'bundle-source.ts')], {
        cwd: root, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, SOURCE_BUNDLE_DIR: output, GITHUB_ACTIONS: 'false' },
    })
    expect(result.exitCode).toBe(0)
    const manifestBytes = readFileSync(join(output, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestBytes)
    expect(manifestBytes.endsWith('\n')).toBe(true)
    expect(manifest.commit).toBe(commit)
    expect(manifest.sourceOnly).toBe(true)
    const sums = readFileSync(join(output, 'SHA256SUMS'), 'utf8')
    expect(sums.endsWith('\n')).toBe(true)
    const lines = sums.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    for (const [index, filename] of [manifest.archive, 'manifest.json'].entries()) {
        const digest = createHash('sha256').update(readFileSync(join(output, filename))).digest('hex')
        expect(lines[index]).toBe(`${digest}  ${filename}`)
    }
    expect(run(['sha256sum', '-c', 'SHA256SUMS'], output)).toContain('manifest.json: OK')
    const stem = manifest.archive.replace(/\.tar\.gz$/, '')
    expect(run(['tar', '-xOzf', join(output, manifest.archive), `${stem}/README.md`], root))
        .toBe('Synthetic source archive fixture')
})
