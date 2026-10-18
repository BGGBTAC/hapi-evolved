import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PLUGIN_MAX_BYTES, validatePluginManifestSource, type PluginManifest } from '@hapi/protocol/pluginManifest'
import { DevelopmentModuleContextSchema, DevelopmentModuleInspectResultSchema, HAPI_TOOLCHAIN_CHECKS } from '@hapi/protocol/developmentModules'
import { EvolvedRequestError, type EvolvedClient } from '../client'
import { evolvedCommand } from '../../commands/evolved'
import { runDevelopmentCommand } from './command'
import { pluginModuleDigest, validatePluginManifestFile } from './pluginValidate'

/**
 * The Hub implementation is loaded at runtime (not through the CLI type program, whose rootDir is cli/src) so the
 * CLI digest is compared with the code that computes installation previews and installed digests.
 */
type HubModules = {
    developmentModuleDigest: (localId: string, content: unknown, dependencies?: unknown) => string
    pluginModuleDependencies: (manifest: PluginManifest, definition: PluginManifest['developmentModules'][number]) => unknown
    resolvePluginModules: (plugin: { id: string; enabled: boolean; manifest: PluginManifest; repository: string; repositoryId: string; commitSha: string; manifestSha256: string; revision?: number }) => Array<{ id: string; digest: string; state: string }>
}
const hubModulesPath = new URL('../../../../hub/src/evolved/developmentModules.ts', import.meta.url).href
const hub = () => import(/* @vite-ignore */ hubModulesPath) as Promise<HubModules>
const example = fileURLToPath(new URL('../../../../examples/plugins/django/hapi-evolved.plugin.json', import.meta.url))
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks() })
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'evolved-plugin-'))); directories.push(path); return path }
function write(root: string, path: string, content: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); return join(root, path) }
const exampleManifest = () => JSON.parse(readFileSync(example, 'utf8')) as Record<string, any>
const noHub = () => { throw new Error('offline commands must not create a Hub client') }

describe('Django example plugin', () => {
    it('parses with the shared installer schema and uses only real field kinds, providers and specialists', () => {
        const parsed = validatePluginManifestSource(readFileSync(example, 'utf8'))
        expect(parsed.ok).toBe(true)
        const manifest = (parsed as { manifest: PluginManifest }).manifest
        expect(manifest).toMatchObject({ schemaVersion: 2, id: 'django-kit' })
        const [module] = manifest.developmentModules
        expect(module.fields.map(field => field.kind)).toEqual(['repo_path', 'select', 'text', 'text_list', 'boolean'])
        expect(module.doctor?.provider).toEqual({ id: 'hapi.toolchain', version: 1 })
        expect(module.doctor?.checks.every(check => Object.hasOwn(HAPI_TOOLCHAIN_CHECKS, check.id))).toBe(true)
        expect(module.inspect).toEqual({ provider: { id: 'hapi.repository-inventory', version: 1 }, directoryField: 'projectDirectory' })
        expect(module.tasks.map(task => task.specialist)).toEqual(['builtin:implementation', 'builtin:tests', 'builtin:tests', 'django-reviewer'])
        expect(manifest.agents.map(agent => agent.id)).toEqual(['django-reviewer'])
        // Every source carries a verification date that is not in the future relative to this content version.
        const sources = [...module.topics.flatMap(topic => topic.sources), ...module.recipes.flatMap(recipe => recipe.sources), ...module.integrations.flatMap(entry => entry.sources)]
        expect(sources.length).toBeGreaterThan(10)
        expect(sources.every(source => source.verifiedAt === '2026-10-18' && source.url.startsWith('https://'))).toBe(true)
    })

    it('validates through the CLI with the digest the Hub computes for previews and installed plugins', async () => {
        const { developmentModuleDigest, pluginModuleDependencies: hubDependencies, resolvePluginModules } = await hub()
        const report = validatePluginManifestFile(join(dirname(example)), '2026-10-18')
        expect(report).toMatchObject({ ok: true, manifest: { schemaVersion: 2, id: 'django-kit', name: 'Django Kit', version: '1.0.0' }, agents: 1, skills: 1, themes: 0, warnings: [] })
        if (!report.ok) throw new Error('unreachable')
        const [module] = report.developmentModules
        expect(module).toMatchObject({ id: 'django', availability: 'supported', reasons: [], counts: { fields: 5, topics: 6, recipes: 4, tasks: 4, checks: 4, integrations: 2 },
            providers: [{ kind: 'doctor', id: 'hapi.toolchain', version: 1, runner: 'implemented' }, { kind: 'inspect', id: 'hapi.repository-inventory', version: 1, runner: 'implemented' }] })
        const manifest = (validatePluginManifestSource(readFileSync(example, 'utf8')) as { manifest: PluginManifest }).manifest, definition = manifest.developmentModules[0]
        expect(module.digest).toBe(developmentModuleDigest(definition.id, definition, hubDependencies(manifest, definition)))
        const installed = resolvePluginModules({ id: '6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11', enabled: true, manifest, repository: 'acme/django-kit', repositoryId: '42', commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), revision: 3 })
        expect(installed.map(entry => [entry.id, entry.digest, entry.state])).toEqual([['plugin:6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11:django', module.digest, 'ready']])
    })

    it('digest changes with executable content and the referenced specialist, not with unrelated themes, exactly like the Hub', async () => {
        const { developmentModuleDigest, pluginModuleDependencies: hubDependencies } = await hub()
        const base = exampleManifest()
        // Every variant is hashed by the CLI and by the Hub implementation; any drift in the dependency branch fails here.
        const digest = (value: Record<string, any>) => {
            const manifest = (validatePluginManifestSource(JSON.stringify(value)) as { manifest: PluginManifest }).manifest, definition = manifest.developmentModules[0]
            const cli = pluginModuleDigest(manifest, definition)
            expect(cli).toBe(developmentModuleDigest(definition.id, definition, hubDependencies(manifest, definition)))
            return cli
        }
        const original = digest(base)
        const recipe = structuredClone(base); recipe.developmentModules[0].recipes[1].steps[1].argv.push('--parallel')
        const agent = structuredClone(base); agent.agents[0].instructions += ' Prüfe auch Signale.'
        const model = structuredClone(base); model.agents[0].providerPreference = 'claude'; model.agents[0].model = 'claude-opus-5-5'
        const skill = structuredClone(base); skill.skills[0].instructions += ' Und Fixtures.'
        const theme = structuredClone(base); theme.themes = [{ id: 'calm', name: 'Ruhig', mode: 'light', colors: { background: '#ffffff', surface: '#f7fafc', text: '#15202b', muted: '#455565', accent: '#075985', accentText: '#ffffff', border: '#8899aa' } }]
        const unrelated = structuredClone(base); unrelated.agents.push({ id: 'unrelated', name: 'Unbeteiligt', description: 'Nicht von Aufgaben verwendet', instructions: 'Nichts.', providerPreference: 'either', skills: [] })
        const builtinOnly = structuredClone(base); builtinOnly.developmentModules[0].tasks[3].specialist = 'builtin:review'
        const description = structuredClone(base); description.agents[0].description = 'Andere Beschreibung'
        expect(new Set([original, digest(recipe), digest(agent), digest(model), digest(skill), digest(builtinOnly)]).size).toBe(6)
        expect(digest(theme)).toBe(original)
        expect(digest(unrelated)).toBe(original)
        expect(digest(description)).toBe(original)
        // With only builtin specialists, same-plugin agent/skill edits no longer affect the module.
        const builtinAgentEdit = structuredClone(builtinOnly); builtinAgentEdit.agents[0].instructions += ' Anders.'
        expect(digest(builtinAgentEdit)).toBe(digest(builtinOnly))
    })
})

const cliEntry = fileURLToPath(new URL('../../index.ts', import.meta.url))
/** The real CLI entry in a child process with a finite deadline (a blocking open would hit the timeout). */
function runCli(args: string[]) {
    const started = Date.now()
    const child = spawnSync(process.execPath.endsWith('bun') ? process.execPath : 'bun', [cliEntry, ...args], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: { ...process.env, HAPI_EVOLVED_PROXY: '', HAPI_EVOLVED_CAPABILITY_FILE: '' } })
    return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, ms: Date.now() - started }
}

describe('local manifest reading (FIFO, strict UTF-8)', () => {
    it('a FIFO without writer is refused promptly instead of blocking validate or --definition', () => {
        const root = temp(), fifo = join(root, 'hapi-evolved.plugin.json')
        if (spawnSync('mkfifo', [fifo]).status !== 0) return
        // Child process first: a regression (blocking open) is killed at the deadline and fails here instead of hanging this worker.
        const validate = runCli(['evolved', 'plugin', 'validate', fifo])
        expect(validate.signal).toBeNull()
        expect(validate.ms).toBeLessThan(15_000)
        expect(validate.status).toBe(1)
        expect(JSON.parse(validate.stdout)).toEqual({ ok: false, file: fifo, issues: [{ path: '', message: 'Not a regular file.' }] })
        const doctor = runCli(['evolved', 'development', 'doctor', '--local', '--definition', root])
        expect(doctor.signal).toBeNull()
        expect(doctor.status).not.toBe(0)
        expect(doctor.stderr + doctor.stdout).toContain('Not a regular file.')
        expect(validatePluginManifestFile(fifo)).toEqual({ ok: false, file: fifo, issues: [{ path: '', message: 'Not a regular file.' }] })
        expect(validatePluginManifestFile(root)).toEqual({ ok: false, file: fifo, issues: [{ path: '', message: 'Not a regular file.' }] })
    }, 40_000)

    it('rejects malformed UTF-8 like the Hub installer and accepts valid multibyte text unchanged', () => {
        const root = temp(), source = readFileSync(example, 'utf8')
        const bytes = Buffer.from(source.replace('"name": "Django Kit"', '"name": "bad__byte"'), 'utf8')
        const marker = bytes.indexOf('bad__byte') + 3
        bytes[marker] = 0xff; bytes[marker + 1] = 0xfe
        const malformed = join(root, 'bad', 'hapi-evolved.plugin.json'); mkdirSync(dirname(malformed)); writeFileSync(malformed, bytes)
        expect(validatePluginManifestFile(malformed)).toEqual({ ok: false, file: malformed, issues: [{ path: '', message: 'Plugin manifest must be valid UTF-8.' }] })
        const truncated = join(root, 'truncated', 'hapi-evolved.plugin.json'); mkdirSync(dirname(truncated))
        writeFileSync(truncated, Buffer.concat([Buffer.from(source.slice(0, source.lastIndexOf('}')), 'utf8'), Buffer.from([0xe2, 0x82]), Buffer.from('}')]))
        expect(validatePluginManifestFile(truncated)).toMatchObject({ ok: false, issues: [{ path: '', message: 'Plugin manifest must be valid UTF-8.' }] })
        const cli = runCli(['evolved', 'plugin', 'validate', malformed])
        expect(cli.status).toBe(1)
        expect(JSON.parse(cli.stdout)).toEqual({ ok: false, file: malformed, issues: [{ path: '', message: 'Plugin manifest must be valid UTF-8.' }] })
        expect(cli.stdout).not.toContain('\ufffd')
        expect(cli.stdout).not.toContain('\uFFFD')
        expect(runCli(['evolved', 'development', 'doctor', '--local', '--definition', malformed]).stderr).toContain('valid UTF-8')
        // Valid multibyte (German umlauts, emoji, CJK) passes and is preserved exactly.
        const valid = join(root, 'valid', 'hapi-evolved.plugin.json'); mkdirSync(dirname(valid))
        writeFileSync(valid, source.replace('"name": "Django Kit"', '"name": "Django Kit ÄÖü 🐍 漢字"'))
        const report = validatePluginManifestFile(valid)
        expect(report).toMatchObject({ ok: true, manifest: { name: 'Django Kit ÄÖü 🐍 漢字' } })
        const validCli = runCli(['evolved', 'plugin', 'validate', valid])
        expect(validCli.status).toBe(0)
        expect(JSON.parse(validCli.stdout)).toMatchObject({ ok: true, manifest: { name: 'Django Kit ÄÖü 🐍 漢字' } })
        // Size limit still applies before decoding.
        const big = join(root, 'big', 'hapi-evolved.plugin.json'); mkdirSync(dirname(big)); writeFileSync(big, Buffer.alloc(PLUGIN_MAX_BYTES + 1, 0xff))
        expect(validatePluginManifestFile(big)).toMatchObject({ ok: false, issues: [{ path: '', message: 'Plugin manifest exceeds 512 KiB.' }] })
    }, 60_000)
})

describe('hapi evolved plugin validate', () => {
    it('reports bounded path issues for invalid manifests', () => {
        const root = temp(), base = exampleManifest()
        const cases: Array<[Record<string, any> | string, string]> = [
            ['{not json', ''],
            [{ ...base, schemaVersion: 1 }, 'developmentModules'],
            [{ ...base, unexpected: true }, ''],
        ]
        const placeholder = structuredClone(base); placeholder.developmentModules[0].recipes[0].steps[0].argv = ['python3', '{home}/x']; cases.push([placeholder, 'developmentModules.0.recipes.0.steps.0.argv.1'])
        const specialist = structuredClone(base); specialist.developmentModules[0].tasks[3].specialist = 'other-plugin-agent'; cases.push([specialist, 'developmentModules.0.tasks.3.specialist'])
        const check = structuredClone(base); check.developmentModules[0].doctor.checks.push({ id: 'django.version', required: false }); cases.push([check, 'developmentModules.0.doctor.checks.4.id'])
        const field = structuredClone(base); field.developmentModules[0].fields.push({ id: 'cmd', kind: 'command', label: 'Befehl' }); cases.push([field, 'developmentModules.0.fields.5.kind'])
        const licence = structuredClone(base); licence.developmentModules[0].tasks[0].preconditions = ['android_sdk_license_acknowledged']; cases.push([licence, 'developmentModules.0.tasks.0.preconditions'])
        for (const [content, path] of cases) {
            const file = write(root, 'hapi-evolved.plugin.json', typeof content === 'string' ? content : JSON.stringify(content))
            const report = validatePluginManifestFile(file)
            expect(report.ok, JSON.stringify(content).slice(0, 80)).toBe(false)
            if (report.ok) continue
            expect(report.issues.length).toBeLessThanOrEqual(64)
            expect(report.issues.map(issue => issue.path)).toContain(path)
        }
        write(root, 'big/hapi-evolved.plugin.json', ' '.repeat(PLUGIN_MAX_BYTES + 1))
        expect(validatePluginManifestFile(join(root, 'big'))).toEqual({ ok: false, file: join(root, 'big/hapi-evolved.plugin.json'), issues: [{ path: '', message: 'Plugin manifest exceeds 512 KiB.' }] })
        expect(validatePluginManifestFile(join(root, 'absent'))).toMatchObject({ ok: false, issues: [{ path: '', message: 'File not found.' }] })
    })

    it('warns about installer naming, future verification dates and providers this HAPI cannot run', () => {
        const root = temp(), manifest = exampleManifest()
        manifest.developmentModules[0].topics[0].sources[0].verifiedAt = '2027-01-01'
        manifest.developmentModules[0].doctor = { provider: { id: 'hapi.toolchain', version: 2 }, checks: [{ id: 'git', required: true }] }
        manifest.developmentModules[0].recipes.forEach((recipe: { prerequisites: string[] }) => { recipe.prerequisites = recipe.prerequisites.filter(id => id === 'git') })
        const report = validatePluginManifestFile(write(root, 'django.json', JSON.stringify(manifest)), '2026-10-18')
        expect(report.ok).toBe(true)
        if (!report.ok) return
        expect(report.developmentModules[0]).toMatchObject({ availability: 'unsupported', providers: [{ kind: 'doctor', id: 'hapi.toolchain', version: 2, runner: 'not_implemented' }, { kind: 'inspect', runner: 'implemented' }] })
        expect(report.warnings).toEqual([
            'The installer reads only hapi-evolved.plugin.json in the repository root; this file is named django.json.',
            expect.stringContaining('hapi.toolchain v2'),
            'developmentModules.0.topics.0.sources.0.verifiedAt 2027-01-01 lies in the future.',
        ])
    })

    it('prints the report offline and sets exit code 1 only for invalid manifests', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => {})
        const previous = process.exitCode
        try {
            process.exitCode = undefined
            await evolvedCommand.run({ args: ['evolved', 'plugin', 'validate', example], subcommand: 'evolved', commandArgs: ['plugin', 'validate', example] })
            expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ ok: true, manifest: { id: 'django-kit' } })
            expect(process.exitCode).toBeUndefined()
            const bad = write(temp(), 'hapi-evolved.plugin.json', '{}')
            await evolvedCommand.run({ args: ['evolved', 'plugin', 'validate', bad], subcommand: 'evolved', commandArgs: ['plugin', 'validate', bad] })
            expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ ok: false })
            expect(process.exitCode).toBe(1)
        } finally { process.exitCode = previous }
    })
})

describe('local module doctor/inspect', () => {
    it('--definition runs the module checks and inventory offline, with local provenance', async () => {
        const checkout = temp()
        write(checkout, 'manage.py', '')
        write(checkout, 'requirements.txt', 'Django==6.1.2')
        const doctor = await runDevelopmentCommand(['doctor', '--local', '--definition', example], noHub) as Record<string, any>
        expect(doctor.source).toEqual({ kind: 'local-definition', file: example, pluginId: 'django-kit', pluginVersion: '1.0.0', moduleLocalId: 'django', moduleDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
        expect(doctor.provider).toEqual({ id: 'hapi.toolchain', version: 1 })
        expect(doctor.checks.map((check: { id: string }) => check.id)).toEqual(['repository.checkout', 'git', 'python', 'image.marker'])
        const inspect = await runDevelopmentCommand(['inspect', '--local', '--definition', dirname(example), '--module', 'django', '--checkout', checkout], noHub) as Record<string, any>
        expect(inspect.provider).toEqual({ id: 'hapi.repository-inventory', version: 1 })
        expect(inspect.buildFiles.map((file: { path: string }) => file.path)).toEqual(['manage.py', 'requirements.txt', '.'])
        const sub = await runDevelopmentCommand(['inspect', '--local', '--definition', example, '--checkout', checkout, '--subdirectory', 'missing'], noHub) as Record<string, any>
        expect(sub.warnings).toContain('Das Modulverzeichnis missing fehlt im Checkout.')
    })

    it('rejects ambiguous or unsafe local options before running anything', async () => {
        const checkout = temp()
        for (const [args, message] of [
            [['doctor', '--local', '--definition', example, '--mode', 'odoo'], /either --mode or --definition/],
            [['doctor', '--local', '--module', 'django'], /--module needs --definition/],
            [['doctor', '--local', '--definition', example, '--module', 'flask'], /not defined/],
            [['doctor', '--local', '--definition', example, '--odoo-major', '20'], /only to the odoo mode/],
            [['inspect', '--local', '--definition', example], /needs --checkout/],
            [['inspect', '--local', '--definition', example, '--checkout', checkout, '--subdirectory', '../x'], /repository-relative/],
            [['inspect', '--local', '--mode', 'ios', '--checkout', checkout, '--subdirectory', 'x'], /only to plugin modules/],
            [['doctor', '--definition', example], /need --local/],
            [['doctor', '--local', '--definition', join(checkout, 'absent.json')], /not found/],
        ] as const) await expect(runDevelopmentCommand([...args], noHub)).rejects.toThrow(message)
    })

    it('--local without --definition uses the active plugin module from the Hub with its saved directory, and refuses non-ready modules', async () => {
        const checkout = temp()
        write(checkout, 'app/pyproject.toml', '')
        write(checkout, 'pyproject.toml', '')
        const moduleId = 'plugin:6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11:zz-random', moduleDigest = `sha256:${'f'.repeat(64)}`
        const context = (state: 'ready' | 'adoption_required') => DevelopmentModuleContextSchema.parse({
            contractVersion: 2, projectId: 'p', revision: 2, observedAt: 0, dataNotice: 'data',
            active: { moduleId, state, reasons: state === 'ready' ? [] : ['Übernahme nötig.'], installedDigest: moduleDigest, adoptedDigest: state === 'ready' ? moduleDigest : `sha256:${'0'.repeat(64)}` },
            module: state !== 'ready' ? null : { id: moduleId, origin: 'plugin', title: 'Random', digest: moduleDigest, contentVersion: '1', brief: [], constraints: [], topics: [], recipes: [], tasks: [],
                source: { kind: 'plugin', pluginId: '6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11', pluginName: 'Random', pluginVersion: '1.0.0', repository: 'acme/random', repositoryId: '7', commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), enabled: true },
                doctor: { provider: { id: 'hapi.toolchain', version: 1 }, checks: [{ id: 'git', label: 'Git', category: 'toolchain', required: true, when: null }] },
                inspect: { provider: { id: 'hapi.repository-inventory', version: 1 }, directoryField: 'appDir' } },
            settings: { activeModuleId: moduleId, repositoryId: '42', odoo: null, ios: null, android: null,
                modules: { [moduleId]: { moduleDigest, settingsVersion: 1, values: { appDir: 'app' }, adopted: { pluginId: '6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11', pluginVersion: '1.0.0', repository: 'acme/random', commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), at: 1 } } } },
            repository: { state: 'granted', repositoryId: '42', fullName: 'acme/web', permission: 'read', checkoutPath: checkout, relativePath: 'repositories/acme/web' }, integrations: [], lastDoctor: null })
        let state: 'ready' | 'adoption_required' = 'ready'
        const client = () => ({ developmentModulesContext: async () => context(state), developmentContext: async () => { throw new Error('no v1 fallback for a v2 Hub') } }) as unknown as EvolvedClient
        const inspect = await runDevelopmentCommand(['inspect', '--local'], client) as Record<string, any>
        expect(DevelopmentModuleInspectResultSchema.parse(inspect)).toMatchObject({ contractVersion: 2, moduleId, moduleDigest, provider: { id: 'hapi.repository-inventory', version: 1 }, repositoryId: '42' })
        expect(inspect.buildFiles.map((file: { path: string }) => file.path)).toEqual(['app/pyproject.toml', 'app'])
        const doctor = await runDevelopmentCommand(['doctor', '--local'], client) as Record<string, any>
        expect(doctor).toMatchObject({ contractVersion: 2, moduleId, moduleDigest, provider: { id: 'hapi.toolchain', version: 1 } })
        expect(doctor.checks.map((check: { id: string }) => check.id)).toEqual(['git'])
        state = 'adoption_required'
        await expect(runDevelopmentCommand(['inspect', '--local'], client)).rejects.toMatchObject({ code: 'development_module_unavailable' })
        await expect(runDevelopmentCommand(['inspect', '--local', '--odoo-major', '20'], client)).rejects.toBeInstanceOf(EvolvedRequestError)
    })
})
