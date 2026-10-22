import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    DEVELOPMENT_MODULE_PROVIDERS,
    DevelopmentModuleDoctorResultSchema,
    DevelopmentModuleInspectResultSchema,
    HAPI_TOOLCHAIN_CHECKS,
} from '@hapi/protocol/developmentModules'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { runToolchainDoctor, TOOLCHAIN_CHECK_IDS, TOOLCHAIN_PROBE_ARGV } from './doctor'
import { INVENTORY_LIMITS, inventoryRepository } from './inventory'
import { RUNNER_DEVELOPMENT_PROVIDER_CAPABILITIES, RUNNER_DEVELOPMENT_PROVIDERS, runnerDevelopmentProvider } from './providers'
import { developmentRpc } from './rpc'
import type { ProbeOutput, ProbeSystem, TrustedExecutable } from './probes'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'evolved-module-'))); directories.push(path); return path }
function write(root: string, path: string, content: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }

type Tool = { output?: string; stderr?: string; code?: number; fail?: ProbeOutput }
function fakeSystem(tools: Record<string, Tool>, options: { files?: Record<string, 'file' | 'directory' | 'char'>; accessible?: boolean; platform?: NodeJS.Platform } = {}) {
    const runs: Array<{ path: string; argv: readonly string[] }> = []
    const system: ProbeSystem = {
        platform: options.platform ?? 'linux', arch: 'x64', uid: 1000,
        trusted: async path => Object.hasOwn(tools, path) ? { path, resolved: path } : null,
        run: async (executable: TrustedExecutable, argv) => {
            runs.push({ path: executable.path, argv })
            const tool = tools[executable.path]
            return tool.fail ?? { ok: true, code: tool.code ?? 0, stdout: tool.output ?? '', stderr: tool.stderr ?? '' }
        },
        exists: async path => options.files?.[path] ?? 'missing',
        accessible: async () => options.accessible ?? false,
        list: async () => [],
    }
    return { system, runs }
}
const byId = (result: { checks: Array<{ id: string }> }) => Object.fromEntries(result.checks.map(check => [check.id, check])) as Record<string, any>
const projectId = '6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11'
const moduleId = `plugin:${projectId}:django`
const moduleDigest = `sha256:${'c'.repeat(64)}`
const repository = (root: string) => ({ id: '42', owner: 'acme', name: 'web', fullName: 'acme/web', permission: 'read' as const, cloneUrl: 'https://github.com/acme/web.git', path: `${root}/repositories/acme/web` })

describe('provider registry', () => {
    it('advertises exactly the implemented providers with the shared capability names', () => {
        expect([...RUNNER_DEVELOPMENT_PROVIDER_CAPABILITIES].sort()).toEqual([MACHINE_CAPABILITIES.EvolvedDevelopmentInventoryProvider, MACHINE_CAPABILITIES.EvolvedDevelopmentToolchainProvider, MACHINE_CAPABILITIES.EvolvedDevelopmentClaudeAdsProvider].sort())
        for (const [id, provider] of Object.entries(RUNNER_DEVELOPMENT_PROVIDERS)) {
            const shared = DEVELOPMENT_MODULE_PROVIDERS[id]!
            expect(shared.pluginUsable).toBe(true)
            expect(shared.versions).toContain(provider.version)
            expect(RUNNER_DEVELOPMENT_PROVIDER_CAPABILITIES).toContain(shared.capability)
        }
        // Every runner-capability provider usable by plugins is implemented here; nothing else is claimed.
        const sharedRunnerProviders = Object.entries(DEVELOPMENT_MODULE_PROVIDERS).filter(([, spec]) => spec.pluginUsable && spec.capability).map(([id]) => id).sort()
        expect(Object.keys(RUNNER_DEVELOPMENT_PROVIDERS).sort()).toEqual(sharedRunnerProviders)
    })

    it('matches provider id, version and action exactly', () => {
        expect(runnerDevelopmentProvider({ id: 'hapi.toolchain', version: 1 }, 'module_doctor')).toBe('hapi.toolchain')
        expect(runnerDevelopmentProvider({ id: 'hapi.repository-inventory', version: 1 }, 'module_inspect')).toBe('hapi.repository-inventory')
        for (const [ref, action] of [[{ id: 'hapi.toolchain', version: 2 }, 'module_doctor'], [{ id: 'hapi.toolchain', version: 1 }, 'module_inspect'],
            [{ id: 'hapi.repository-inventory', version: 1 }, 'module_doctor'], [{ id: 'builtin.odoo', version: 1 }, 'module_doctor'], [{ id: 'toString', version: 1 }, 'module_doctor'],
            [{ id: '__proto__', version: 1 }, 'module_inspect']] as const) expect(runnerDevelopmentProvider(ref, action)).toBeNull()
    })
})

describe('hapi.toolchain v1', () => {
    it('implements exactly the shared check catalogue', () => {
        expect([...TOOLCHAIN_CHECK_IDS].sort()).toEqual(Object.keys(HAPI_TOOLCHAIN_CHECKS).sort())
    })

    it('runs only trusted system executables with the fixed argv, in the requested order, without extras', async () => {
        const { system, runs } = fakeSystem({
            '/usr/bin/git': { output: 'git version 2.47.3' }, '/usr/bin/python3': { output: 'Python 3.13.5' }, '/usr/bin/node': { output: 'v24.10.0' },
            '/usr/bin/java': { stderr: 'openjdk version "21.0.8" 2025-07-15' }, '/usr/bin/javac': {}, '/usr/bin/ssh': { stderr: 'OpenSSH_10.0p2 Debian-7, OpenSSL 3.5.1' },
        }, { files: { '/dev/kvm': 'char' }, accessible: true })
        const result = await runToolchainDoctor({ projectRoot: null, checkout: null, system, imageMarkerPath: '/nonexistent/marker', checks: ['ssh', 'git', 'python', 'node', 'java', 'kvm', 'git'] })
        expect(result.checks.map(check => check.id)).toEqual(['ssh', 'git', 'python', 'node', 'java', 'kvm'])
        expect(runs).toEqual([
            { path: '/usr/bin/ssh', argv: TOOLCHAIN_PROBE_ARGV.ssh.slice(1) },
            { path: '/usr/bin/git', argv: TOOLCHAIN_PROBE_ARGV.git.slice(1) },
            { path: '/usr/bin/python3', argv: TOOLCHAIN_PROBE_ARGV.python.slice(1) },
            { path: '/usr/bin/node', argv: TOOLCHAIN_PROBE_ARGV.node.slice(1) },
            { path: '/usr/bin/java', argv: TOOLCHAIN_PROBE_ARGV.java.slice(1) },
        ])
        expect(runs.map(run => run.argv)).toEqual([['-V'], ['--version'], ['--version'], ['--version'], ['-Xmx64m', '-XX:+UseSerialGC', '-version']])
        const checks = byId(result)
        expect(checks.git).toMatchObject({ state: 'ready', version: '2.47.3', label: HAPI_TOOLCHAIN_CHECKS.git!.label, category: 'toolchain' })
        expect(checks.python).toMatchObject({ state: 'ready', version: 'Python 3.13.5' })
        expect(checks.node).toMatchObject({ state: 'ready', version: 'Node 24.10.0' })
        expect(checks.java).toMatchObject({ state: 'ready', version: 'Java 21.0.8' })
        expect(checks.ssh).toMatchObject({ state: 'ready', version: 'OpenSSH_10.0p2' })
        expect(checks.kvm).toMatchObject({ state: 'ready', category: 'device' })
        // No Odoo/Android interpretation: a generic module gets presence and version only.
        expect(JSON.stringify(result)).not.toMatch(/Odoo|Android|Gradle/)
    })

    it('reports unknown ids without running anything and never claims ready for absent or failing tools', async () => {
        const { system, runs } = fakeSystem({ '/usr/bin/python3': { code: 1, output: 'Python 3.13.5' }, '/usr/bin/java': { stderr: 'openjdk version "17.0.1"' } })
        const result = await runToolchainDoctor({ projectRoot: null, checkout: null, system, imageMarkerPath: '/nonexistent/marker',
            checks: ['python.venv', 'odoo.source', 'android.sdk', 'git', 'python', 'node', 'java', 'kvm', 'repository.checkout', 'image.marker', 'constructor', '__proto__'] })
        // `__proto__` is not a valid check id on the wire (the RPC schema rejects it); here it only proves no prototype lookup.
        DevelopmentModuleDoctorResultSchema.parse({ contractVersion: 2, moduleId, moduleDigest, provider: { id: 'hapi.toolchain', version: 1 }, ...result, checks: result.checks.filter(check => check.id !== '__proto__') })
        const checks = byId(result)
        for (const id of ['python.venv', 'odoo.source', 'android.sdk', 'constructor', '__proto__']) expect(checks[id]).toMatchObject({ state: 'unknown', label: 'Unbekannte Prüfung' })
        expect(checks.git.state).toBe('missing')
        expect(checks.python.state).toBe('unknown')
        expect(checks.node.state).toBe('missing')
        expect(checks.java).toMatchObject({ state: 'warning', detail: expect.stringContaining('javac') })
        expect(checks.kvm.state).toBe('missing')
        expect(checks['repository.checkout'].state).toBe('unknown')
        expect(checks['image.marker'].state).toBe('warning')
        expect(result.checks.filter(check => check.state === 'ready')).toEqual([])
        expect(runs.map(run => run.path)).toEqual(['/usr/bin/python3', '/usr/bin/java'])
    })

    it('runs no defaults for an empty check list and bounds the number of checks', async () => {
        const { system, runs } = fakeSystem({})
        expect((await runToolchainDoctor({ projectRoot: null, checkout: null, system, imageMarkerPath: '/nonexistent/marker', checks: [] })).checks).toEqual([])
        const many = await runToolchainDoctor({ projectRoot: null, checkout: null, system, imageMarkerPath: '/nonexistent/marker', checks: Array.from({ length: 70 }, (_, index) => `x${index}`) })
        expect(many.checks).toHaveLength(64)
        expect(many.truncated).toBe(true)
        expect(runs).toEqual([])
    })
})

describe('hapi.repository-inventory v1', () => {
    function checkout() {
        const root = temp()
        write(root, '.git/HEAD', 'ref: refs/heads/main\n')
        write(root, '.git/refs/heads/main', `${'a'.repeat(40)}\n`)
        write(root, 'web/manage.py', 'SENTINEL-CONTENT import os\n')
        write(root, 'web/requirements.txt', 'Django==6.1.2\nSENTINEL-CONTENT\n')
        write(root, 'web/pyproject.toml', '[project]\nname = "SENTINEL-CONTENT"\n')
        write(root, 'web/shop/models.py', 'SENTINEL-CONTENT')
        write(root, 'web/shop/tests/test_models.py', 'SENTINEL-CONTENT')
        write(root, 'web/shop/templates/shop/index.html', '<p>SENTINEL-CONTENT</p>')
        write(root, 'web/node_modules/left-pad/index.js', 'SENTINEL-CONTENT')
        write(root, 'web/.venv/lib/site.py', 'SENTINEL-CONTENT')
        write(root, 'web/.env', 'SECRET_KEY=SENTINEL-CONTENT')
        write(root, 'web/secrets/prod.py', 'SENTINEL-CONTENT')
        write(root, 'web/config/server.pem', 'SENTINEL-CONTENT')
        write(root, '.github/workflows/ci.yml', 'name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n')
        return root
    }

    it('reports well-known project files, extension counts, workflows and HEAD without returning contents', async () => {
        const root = checkout()
        const result = await inventoryRepository({ checkout: root, repositoryId: '42', subdirectory: 'web', now: () => 7 })
        expect(result).toMatchObject({ repositoryId: '42', observedAt: 7, head: 'a'.repeat(40), branch: 'main', state: 'ready', odooModules: [] })
        expect(result.buildFiles).toEqual([
            { path: 'web/manage.py', kind: 'other', facts: { projectFile: 'manage.py', ecosystem: 'python' } },
            { path: 'web/pyproject.toml', kind: 'other', facts: { projectFile: 'pyproject.toml', ecosystem: 'python' } },
            { path: 'web/requirements.txt', kind: 'other', facts: { projectFile: 'requirements.txt', ecosystem: 'python' } },
            // node_modules, .venv, .env, secrets/ and *.pem are neither walked nor counted.
            { path: 'web', kind: 'other', facts: { inventory: 'file_counts', files: '6', depth: String(INVENTORY_LIMITS.depth), 'ext.py': '3', 'ext.html': '1', 'ext.toml': '1', 'ext.txt': '1' } },
            { path: '.github/workflows/ci.yml', kind: 'ci_workflow', facts: { name: 'CI', runsOn: 'ubuntu-latest' } },
        ])
        expect(JSON.stringify(result)).not.toContain('SENTINEL-CONTENT')
        expect(JSON.stringify(result)).not.toMatch(/\.env|secrets|server\.pem|left-pad/)
        DevelopmentModuleInspectResultSchema.parse({ contractVersion: 2, moduleId, moduleDigest, provider: { id: 'hapi.repository-inventory', version: 1 }, ...result })
    })

    it('lists and counts hard-linked files as metadata but never reads their content', async () => {
        const root = checkout()
        linkSync(join(root, 'web/requirements.txt'), join(root, 'web/Gemfile'))
        linkSync(join(root, '.github/workflows/ci.yml'), join(root, '.github/workflows/linked.yml'))
        const result = await inventoryRepository({ checkout: root, repositoryId: '42', subdirectory: 'web' })
        expect(result.buildFiles).toContainEqual({ path: 'web/Gemfile', kind: 'other', facts: { projectFile: 'Gemfile', ecosystem: 'ruby' } })
        expect(result.buildFiles.find(file => file.facts?.inventory === 'file_counts')!.facts).toMatchObject({ files: '7' })
        // ci.yml and linked.yml share an inode with two links: both are listed, neither is read.
        expect(result.buildFiles.filter(file => file.kind === 'ci_workflow')).toEqual([
            { path: '.github/workflows/ci.yml', kind: 'ci_workflow' }, { path: '.github/workflows/linked.yml', kind: 'ci_workflow' }])
        expect(JSON.stringify(result)).not.toContain('SENTINEL-CONTENT')
    })

    it('does not follow symlinks or special files and refuses unsafe module directories', async () => {
        const root = checkout(), outside = temp()
        write(outside, 'package.json', '{"name":"outside"}')
        write(outside, 'secret.py', 'SENTINEL-OUTSIDE')
        symlinkSync(join(outside, 'package.json'), join(root, 'web/package.json'))
        symlinkSync(outside, join(root, 'web/linked'))
        symlinkSync(outside, join(root, 'escape'))
        const fifo = spawnSync('mkfifo', [join(root, 'web/Makefile')]).status === 0
        const result = await inventoryRepository({ checkout: root, repositoryId: '42', subdirectory: 'web' })
        expect(result.buildFiles.map(file => file.path)).not.toContain('web/package.json')
        if (fifo) expect(result.buildFiles.map(file => file.path)).not.toContain('web/Makefile')
        expect(result.warnings).toContain('web/package.json ist eine symbolische Verknüpfung und wird nicht gelesen.')
        expect(JSON.stringify(result)).not.toMatch(/SENTINEL-OUTSIDE|outside/)
        const counts = result.buildFiles.find(file => file.facts?.inventory === 'file_counts')!
        expect(counts.facts).toMatchObject({ files: '6' })
        const linked = await inventoryRepository({ checkout: root, repositoryId: '42', subdirectory: 'escape' })
        expect(linked.state).toBe('ready')
        expect(linked.warnings).toContain('Das Modulverzeichnis escape ist eine symbolische Verknüpfung und wird nicht gelesen.')
        expect(linked.buildFiles.filter(file => file.kind === 'other')).toEqual([])
        for (const subdirectory of ['../x', '/etc', 'web/../..', '-rf', '.git/..', '']) {
            expect(await inventoryRepository({ checkout: root, repositoryId: '42', subdirectory })).toMatchObject({ state: 'blocked', buildFiles: [] })
        }
        const secret = await inventoryRepository({ checkout: root, repositoryId: '42', subdirectory: 'web/secrets' })
        expect(secret.warnings).toContain('Das Modulverzeichnis web/secrets ist ein geschützter Pfad und wird nicht gelesen.')
        expect(JSON.stringify(secret)).not.toContain('prod.py')
        const missing = await inventoryRepository({ checkout: root, repositoryId: '42', subdirectory: 'nope' })
        expect(missing).toMatchObject({ state: 'ready', warnings: expect.arrayContaining(['Das Modulverzeichnis nope fehlt im Checkout.']) })
    })

    it('distinguishes a missing or linked checkout and marks depth limits as incomplete', async () => {
        const root = temp()
        expect(await inventoryRepository({ checkout: join(root, 'absent'), repositoryId: '42', subdirectory: '.' })).toMatchObject({ state: 'missing', buildFiles: [] })
        const real = checkout()
        symlinkSync(real, join(root, 'link'))
        expect(await inventoryRepository({ checkout: join(root, 'link'), repositoryId: '42', subdirectory: '.' })).toMatchObject({ state: 'blocked', buildFiles: [] })
        write(real, `deep/${Array.from({ length: INVENTORY_LIMITS.depth + 2 }, (_, index) => `d${index}`).join('/')}/x.py`, '')
        const deep = await inventoryRepository({ checkout: real, repositoryId: '42', subdirectory: 'deep' })
        expect(deep.scanned.limitReached).toBe(true)
        expect(deep.warnings).toContain('Analysegrenze erreicht; das Ergebnis ist unvollständig.')
    })
})

describe('evolved-development RPC v2 actions', () => {
    const env = { EVOLVED_RUNNER_ROOT: `/managed-workspaces/${projectId}`, EVOLVED_PROJECT_ID: projectId, HAPI_EVOLVED_PROXY: '1' }
    const doctor = (extra: Record<string, unknown> = {}) => ({ action: 'module_doctor', contractVersion: 2, projectId, revision: 3, moduleId, moduleDigest, provider: { id: 'hapi.toolchain', version: 1 }, checks: ['git'], repository: null, ...extra })
    const inspect = (root: string, extra: Record<string, unknown> = {}) => ({ action: 'module_inspect', contractVersion: 2, projectId, revision: 3, moduleId, moduleDigest, provider: { id: 'hapi.repository-inventory', version: 1 }, subdirectory: 'web', repository: repository(root), ...extra })

    it('accepts exactly the contract fields: no settings, commands, paths or executables from module data', async () => {
        const root = `/managed-workspaces/${projectId}`
        for (const request of [
            doctor({ settings: { mode: 'odoo' } }), doctor({ argv: ['sh', '-c', 'id'] }), doctor({ executable: '/bin/sh' }), doctor({ checks: ['../x'] }), doctor({ checks: 'git' }),
            doctor({ contractVersion: 1 }), doctor({ moduleDigest: 'sha256:abc' }), doctor({ moduleId: 'plugin:x:django' }), doctor({ action: 'module_shell' }),
            inspect(root, { subdirectory: '../..' }), inspect(root, { subdirectory: '/etc' }), inspect(root, { repository: null }), inspect(root, { path: '/etc' }), inspect(root, { checks: [] }),
        ]) expect(await developmentRpc(request, env)).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } })
    })

    it('answers unknown providers and versions as unsupported without touching the runner root', async () => {
        for (const request of [doctor({ provider: { id: 'hapi.toolchain', version: 2 } }), doctor({ provider: { id: 'hapi.repository-inventory', version: 1 } }),
            doctor({ provider: { id: 'builtin.odoo', version: 1 } }), doctor({ provider: { id: 'acme.custom-tool', version: 1 } }),
            inspect('/managed-workspaces/x', { provider: { id: 'hapi.toolchain', version: 1 } })]) {
            expect(await developmentRpc(request, {})).toEqual({ error: { code: 'unsupported_provider', message: expect.stringContaining('nicht unterstützt') } })
        }
    })

    it('applies the v1 runner identity and checkout validation before any provider runs', async () => {
        expect(await developmentRpc(doctor(), {})).toEqual({ error: { code: 'unavailable', message: expect.any(String) } })
        expect(await developmentRpc(doctor(), { ...env, EVOLVED_PROJECT_ID: 'other' })).toEqual({ error: { code: 'unavailable', message: expect.any(String) } })
        const root = env.EVOLVED_RUNNER_ROOT
        for (const change of [{ path: '/etc' }, { path: `${root}/repositories/acme/../../x` }, { fullName: 'evil/web' }, { cloneUrl: 'https://evil.test/acme/web.git' }]) {
            if (process.getuid?.() === 0) continue
            expect(await developmentRpc(inspect(root, { repository: { ...repository(root), ...change } }), env)).toEqual({ error: { code: 'invalid_repository', message: expect.any(String) } })
        }
    })

    it('echoes the exact module id, digest and provider in contract-valid results', async () => {
        if (process.getuid?.() === 0) return
        const workspace = temp(), root = `/workspaces/${workspace.split('/').pop()}`
        const runnerEnv = { EVOLVED_RUNNER_ROOT: root, EVOLVED_PROJECT_ID: projectId, HAPI_EVOLVED_PROXY: '1' }
        const result = DevelopmentModuleDoctorResultSchema.parse(await developmentRpc(doctor({ checks: ['repository.checkout', 'future.check'] }), runnerEnv))
        expect(result).toMatchObject({ contractVersion: 2, moduleId, moduleDigest, provider: { id: 'hapi.toolchain', version: 1 } })
        expect(result.checks.map(check => [check.id, check.state])).toEqual([['repository.checkout', 'unknown'], ['future.check', 'unknown']])
        // /workspaces/<dir> does not exist on the test host: the checkout is honestly missing, never another directory.
        const inventory = DevelopmentModuleInspectResultSchema.parse(await developmentRpc(inspect(root), runnerEnv))
        expect(inventory).toMatchObject({ contractVersion: 2, moduleId, moduleDigest, provider: { id: 'hapi.repository-inventory', version: 1 }, repositoryId: '42', state: 'missing', odooModules: [], buildFiles: [] })
    })
})
