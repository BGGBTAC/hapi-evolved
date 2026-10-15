import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { checkRepository, checkWorkflowPolicy } from './check-workflows'

function workflow(job: string, trigger = 'push', permissions = 'contents: read'): string {
    return `name: Fixture\non: ${trigger}\npermissions:\n  ${permissions}\njobs:\n  check:\n${job}`
}

describe('publication workflow boundaries', () => {
    test('the actual workflows satisfy the policy', () => {
        expect(checkRepository(resolve(import.meta.dir, '../..'))).toEqual([])
    })
    test('an ordinary read-only test remains allowed', () => {
        expect(checkWorkflowPolicy('test.yml', workflow('    steps:\n      - run: bun test'))).toEqual([])
    })
    test.each([
        '',
        "    if: github.repository == 'tiann/hapi' || true\n",
        "    if: github.repository != 'tiann/hapi'\n",
        "    if: contains(github.repository, 'tiann/hapi')\n",
    ])('rejects missing or bypassable upstream guard: %s', guard => {
        expect(checkWorkflowPolicy('release.yml', workflow(`${guard}    steps:\n      - run: bun test`)).length).toBeGreaterThan(0)
    })
    test('permits a guarded upstream writer with additional restrictions', () => {
        const job = "    if: github.repository == 'tiann/hapi' && github.ref == 'refs/heads/main'\n    permissions:\n      contents: write\n    steps:\n      - run: gh release create v1"
        expect(checkWorkflowPolicy('release.yml', workflow(job))).toEqual([])
    })
    test('rejects unguarded privileged event and token writes', () => {
        const job = '    permissions:\n      issues: write\n    steps:\n      - run: node reply.js'
        expect(checkWorkflowPolicy('reply.yml', workflow(job, 'issue_comment'))).toHaveLength(2)
    })
    test.each([
        '      - uses: openai/codex-action@v1\n',
        '      - uses: docker/login-action@v3\n',
        '      - run: npm publish\n',
        "      - run: node deploy.js\n        env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n",
        '      - uses: docker/build-push-action@v6\n        with:\n          push: true\n',
    ])('rejects unguarded publishing or credentials', step => {
        expect(checkWorkflowPolicy('new.yml', workflow(`    steps:\n${step}`)).length).toBeGreaterThan(0)
    })
    test('requires pinned Bun and ephemeral checkout credentials', () => {
        const job = '    steps:\n      - uses: actions/checkout@v4\n      - uses: oven-sh/setup-bun@v2\n'
        expect(checkWorkflowPolicy('test.yml', workflow(job))).toHaveLength(2)
    })
    test('also rejects job-level credentials and reusable-workflow secret inheritance', () => {
        expect(checkWorkflowPolicy('new.yml', workflow("    env:\n      TOKEN: ${{ secrets.TOKEN }}\n    steps: []"))).toHaveLength(1)
        expect(checkWorkflowPolicy('new.yml', workflow('    uses: owner/repo/.github/workflows/publish.yml@main\n    secrets: inherit'))).toHaveLength(1)
    })
    test('rejects automatic preview creation and malformed YAML', () => {
        expect(checkWorkflowPolicy('evolved-preview.yml', workflow('    steps: []'))).toHaveLength(1)
        expect(checkWorkflowPolicy('bad.yml', '{')).toEqual(['bad.yml: invalid YAML'])
    })
})

test('source bundle contains the committed tree, exact version and verifiable hashes', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'evolved-source-test-'))
    const run = (args: string[], env?: Record<string, string | undefined>) => {
        const result = Bun.spawnSync(args, { cwd: folder, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
        expect(result.exitCode).toBe(0)
        return result.stdout.toString().trim()
    }
    try {
        run(['git', 'init', '--quiet'])
        writeFileSync(resolve(folder, 'package.json'), JSON.stringify({ version: '0.1.0', packageManager: 'bun@1.3.14' }))
        writeFileSync(resolve(folder, 'README.md'), 'Committed source\n')
        run(['git', 'add', 'package.json', 'README.md'])
        run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'])
        const commit = run(['git', 'rev-parse', 'HEAD'])
        writeFileSync(resolve(folder, 'README.md'), 'Uncommitted edit excluded\n')
        writeFileSync(resolve(folder, 'untracked-secret.txt'), 'Never include working-tree files\n')
        const output = resolve(folder, 'artifact')
        run([process.execPath, resolve(import.meta.dir, 'bundle-source.ts')], { SOURCE_BUNDLE_DIR: output, GITHUB_ACTIONS: 'false' })
        const manifest = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8'))
        expect(manifest).toMatchObject({ version: '0.1.0', commit, sourceOnly: true, status: 'preview' })
        expect(manifest.validation.runUrl).toBeNull()
        const entries = run(['tar', '-tzf', resolve(output, manifest.archive)]).split('\n')
        expect(entries.some(name => name.endsWith('/untracked-secret.txt'))).toBe(false)
        const readme = entries.find(name => name.endsWith('/README.md'))!
        expect(run(['tar', '-xOzf', resolve(output, manifest.archive), readme])).toBe('Committed source')
        for (const line of readFileSync(resolve(output, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
            const [expected, name] = line.split('  ')
            expect(createHash('sha256').update(readFileSync(resolve(output, name!))).digest('hex')).toBe(expected!)
        }
    } finally {
        rmSync(folder, { recursive: true, force: true })
    }
})
