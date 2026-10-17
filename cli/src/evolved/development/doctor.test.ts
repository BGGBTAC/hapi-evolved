import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultDevelopmentSettings, DevelopmentDoctorResultSchema, type DevelopmentSettings } from '@hapi/protocol/evolvedDevelopment'
import { developmentPack } from '@hapi/protocol/developmentPacks'
import { DOCTOR_CHECK_IDS, runDevelopmentDoctor } from './doctor'
import { createProbeSystem, findTrusted, PROBE_ENVIRONMENT, trustedExecutable, type ProbeOutput, type ProbeSystem, type TrustedExecutable } from './probes'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'evolved-doctor-'))); directories.push(path); return path }
function write(root: string, path: string, content: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }

type Tool = { output?: string; code?: number; fail?: ProbeOutput }
/** Fake host: only listed absolute executables exist and are trusted; every run is recorded. */
function fakeSystem(tools: Record<string, Tool>, options: { platform?: NodeJS.Platform; files?: Record<string, 'file' | 'directory' | 'char'>; listings?: Record<string, string[]>; accessible?: boolean } = {}) {
    const runs: Array<{ path: string; argv: readonly string[] }> = []
    const system: ProbeSystem = {
        platform: options.platform ?? 'linux', arch: 'x64', uid: 1000,
        trusted: async path => Object.hasOwn(tools, path) ? { path, resolved: path } : null,
        run: async (executable: TrustedExecutable, argv) => {
            runs.push({ path: executable.path, argv })
            const tool = tools[executable.path]
            return tool.fail ?? { ok: true, code: tool.code ?? 0, stdout: tool.output ?? '', stderr: '' }
        },
        exists: async path => options.files?.[path] ?? 'missing',
        accessible: async () => options.accessible ?? false,
        list: async path => options.listings?.[path] ?? [],
    }
    return { system, runs }
}
const odoo = (major: 19 | 20): DevelopmentSettings => { const settings = defaultDevelopmentSettings('odoo'); settings.odoo!.major = major; return settings }
const byId = (result: { checks: Array<{ id: string }> }) => Object.fromEntries(result.checks.map(check => [check.id, check])) as Record<string, any>

describe('development doctor', () => {
    it('implements every check id the bundled packs request', () => {
        for (const mode of ['odoo', 'ios', 'android'] as const) {
            for (const check of developmentPack(mode).doctorChecks) expect(DOCTOR_CHECK_IDS).toContain(check.id)
        }
    })

    it('distinguishes missing, unsupported and unknown and never claims success for absent tools', async () => {
        const { system, runs } = fakeSystem({})
        const settings = defaultDevelopmentSettings('ios')
        const result = await runDevelopmentDoctor({ mode: 'ios', settings, projectRoot: null, checkout: null, system, checks: ['image.marker', 'git', 'host.macos', 'xcodebuild', 'simulator', 'swift', 'repository.checkout', 'future.check'], imageMarkerPath: '/nonexistent/marker' })
        DevelopmentDoctorResultSchema.parse(result)
        const checks = byId(result)
        expect(checks.git.state).toBe('missing')
        expect(checks['host.macos'].state).toBe('unsupported')
        expect(checks['host.macos'].detail).toMatch(/UIKit/)
        expect(checks.xcodebuild.state).toBe('unsupported')
        expect(checks.simulator.state).toBe('unsupported')
        expect(checks.swift.state).toBe('missing')
        expect(checks['repository.checkout'].state).toBe('unknown')
        expect(checks['future.check']).toMatchObject({ state: 'unknown', label: 'Unbekannte Prüfung' })
        expect(checks['image.marker'].state).toBe('warning')
        expect(result.checks.filter(check => check.state === 'ready').map(check => check.id)).toEqual([])
        expect(runs).toEqual([])
    })

    it('checks Python and PostgreSQL against the selected Odoo series', async () => {
        const tools = {
            '/usr/bin/python3': { output: '3.11.9\n' },
            '/usr/bin/psql': { output: 'psql (PostgreSQL) 15.8\n' },
            '/usr/lib/postgresql/15/bin/postgres': { output: 'postgres (PostgreSQL) 15.8\n' },
            '/usr/lib/postgresql/15/bin/initdb': {}, '/usr/lib/postgresql/15/bin/pg_ctl': {},
        }
        const listings = { '/usr/lib/postgresql': ['15'] }
        const nineteen = byId(await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(19), projectRoot: null, checkout: null, checks: ['python', 'postgresql.server', 'postgresql.client'], ...fakeSystemInput(tools, listings) }))
        expect(nineteen.python).toMatchObject({ state: 'ready', version: 'Python 3.11.9' })
        expect(nineteen['postgresql.server']).toMatchObject({ state: 'ready', version: 'PostgreSQL 15.8' })
        expect(nineteen['postgresql.client'].detail).toMatch(/nichts über eine erreichbare Datenbank/)
        const twenty = byId(await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(20), projectRoot: null, checkout: null, checks: ['python', 'postgresql.server'], ...fakeSystemInput(tools, listings) }))
        expect(twenty.python).toMatchObject({ state: 'missing', version: 'Python 3.11.9' })
        expect(twenty.python.detail).toMatch(/3\.12–3\.14/)
        expect(twenty['postgresql.server'].state).toBe('missing')
        expect(twenty['postgresql.server'].detail).toMatch(/≥ 16/)
        const tooNew = byId(await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(20), projectRoot: null, checkout: null, checks: ['python'], ...fakeSystemInput({ '/usr/bin/python3': { output: '3.15.0\n' } }, {}) }))
        expect(tooNew.python.state).toBe('missing')
    })

    it('prefers requirements from the project Odoo source and reads its commit without running Git', async () => {
        const root = temp(), source = join(root, '.hapi/.cache/toolchain/odoo/20/src')
        write(source, 'odoo/release.py', 'version_info = (20, 0, 0, FINAL, 0)\nMIN_PY_VERSION = (3, 12)\nMAX_PY_VERSION = (3, 13)\nMIN_PG_VERSION = 16\n')
        write(source, 'odoo-bin', '#!/usr/bin/env python3\n')
        write(source, '.git/HEAD', 'ref: refs/heads/20.0\n')
        write(source, '.git/packed-refs', `# pack-refs\n${'b'.repeat(40)} refs/heads/20.0\n`)
        write(root, '.hapi/.cache/toolchain/odoo/20/source.json', JSON.stringify({ commit: 'b'.repeat(40) }))
        const result = byId(await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(20), projectRoot: root, checkout: null, checks: ['odoo.source', 'python'], ...fakeSystemInput({ '/usr/bin/python3': { output: '3.14.0\n' } }, {}) }))
        expect(result['odoo.source']).toMatchObject({ state: 'ready', version: `Odoo 20.0 @ ${'b'.repeat(12)}` })
        expect(result['odoo.source'].detail).toMatch(/entspricht source.json/)
        // release.py of the checkout caps Python at 3.13 here; it wins over the handbook value.
        expect(result.python.state).toBe('missing')
        expect(result.python.detail).toMatch(/odoo\/release.py im Projekt/)
        const wrongSeries = byId(await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(19), projectRoot: root, checkout: null, checks: ['odoo.source'], ...fakeSystemInput({}, {}) }))
        expect(wrongSeries['odoo.source'].state).toBe('missing')
    })

    it('reports the project PostgreSQL cluster honestly (not running, stale pid, TCP)', async () => {
        const root = temp(), data = '.hapi/.cache/toolchain/postgresql/17/data'
        const input = (checks: string[]) => ({ mode: 'odoo' as const, settings: odoo(20), projectRoot: root, checkout: null, checks, ...fakeSystemInput({}, {}) })
        expect(byId(await runDevelopmentDoctor(input(['postgresql.cluster'])))['postgresql.cluster'].state).toBe('missing')
        write(root, `${data}/PG_VERSION`, '17\n')
        expect(byId(await runDevelopmentDoctor(input(['postgresql.cluster'])))['postgresql.cluster'].detail).toMatch(/läuft aber nicht/)
        write(root, `${data}/postmaster.pid`, `999999999\n${root}/${data}\n0\n5432\n${root}/.hapi/.cache/toolchain/postgresql/run\n\n0 0\nready\n`)
        expect(byId(await runDevelopmentDoctor(input(['postgresql.cluster'])))['postgresql.cluster'].detail).toMatch(/veraltet/)
        write(root, `${data}/postmaster.pid`, `${process.pid}\n${root}/${data}\n0\n5432\n${root}/.hapi/.cache/toolchain/postgresql/run\n127.0.0.1\n0 0\nready\n`)
        expect(byId(await runDevelopmentDoctor(input(['postgresql.cluster'])))['postgresql.cluster'].detail).toMatch(/TCP/)
    })

    it('gates Android SDK licences on the human acknowledgement and never executes SDK or wrapper files', async () => {
        const root = temp(), checkout = join(root, 'repositories/o/app'), marker = join(root, 'ran')
        write(root, '.hapi/.cache/toolchain/android/sdk/cmdline-tools/latest/source.properties', 'Pkg.Revision=19.0\n')
        write(root, '.hapi/.cache/toolchain/android/sdk/cmdline-tools/latest/bin/sdkmanager', `#!/bin/sh\ntouch ${marker}\n`)
        chmodSync(join(root, '.hapi/.cache/toolchain/android/sdk/cmdline-tools/latest/bin/sdkmanager'), 0o755)
        write(checkout, 'gradlew', `#!/bin/sh\ntouch ${marker}\n`)
        chmodSync(join(checkout, 'gradlew'), 0o755)
        write(checkout, 'gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip\n')
        write(checkout, 'gradle/wrapper/gradle-wrapper.jar', 'PK')
        write(checkout, '.git/HEAD', `${'c'.repeat(40)}\n`)
        const settings = defaultDevelopmentSettings('android')
        const run = (value: DevelopmentSettings) => runDevelopmentDoctor({ mode: 'android', settings: value, projectRoot: root, checkout, checks: [], androidSdkEnvironment: {}, ...fakeSystemInput({ '/usr/bin/java': { output: 'openjdk version "21.0.5" 2024-10-15' }, '/usr/bin/javac': {} }, {}) })
        const before = byId(await run(settings))
        expect(before['android.licenses']).toMatchObject({ state: 'missing', remedy: { kind: 'manual' } })
        expect(before['android.sdkmanager']).toMatchObject({ state: 'ready', version: 'cmdline-tools 19.0' })
        expect(before['gradle.wrapper']).toMatchObject({ state: 'ready', version: 'Gradle 8.11.1' })
        expect(before['repository.checkout']).toMatchObject({ state: 'ready', version: 'c'.repeat(12) })
        expect(before.kvm.state).toBe('missing')
        expect(before['android.emulator'].state).toBe('unsupported')
        expect(before.java).toMatchObject({ state: 'ready', version: 'Java 21.0.5' })
        settings.android!.sdkLicensesAcknowledged = true
        expect(byId(await run(settings))['android.licenses'].state).toBe('warning')
        write(root, '.hapi/.cache/toolchain/android/sdk/licenses/android-sdk-license', '\n24333f8a63b6825ea9c5514f83c2829b004d1fee')
        expect(byId(await run(settings))['android.licenses'].state).toBe('ready')
        settings.android!.jdkMajor = 17
        expect(byId(await run(settings)).java.state).toBe('warning')
        expect(existsSync(marker)).toBe(false)
    })

    it('enforces per-probe and total time limits and bounded, credential-free output', async () => {
        const slow: ProbeSystem = { ...fakeSystemInput({ '/usr/bin/git': {} }, {}).system, run: () => new Promise(() => {}) }
        const started = Date.now()
        const result = await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(19), projectRoot: null, checkout: null, checks: ['git', 'git', 'python'], system: slow, deadlineMs: 300 })
        expect(Date.now() - started).toBeLessThan(6500)
        expect(result.checks.map(check => check.id)).toEqual(['git', 'python', 'python.headers', 'build.libraries'])
        expect(result.checks.every(check => check.state !== 'ready')).toBe(true)
        const leaking = byId(await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(19), projectRoot: null, checkout: null, checks: ['node'], ...fakeSystemInput({ '/usr/bin/node': { output: `v22.1.0 password=${'p'.repeat(20)}` } }, {}) }))
        expect(JSON.stringify(leaking)).not.toContain('p'.repeat(20))
    })

    it('runs real fixed probes on this host and returns a contract-valid result', async () => {
        const root = temp()
        const result = await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(20), projectRoot: root, checkout: null, checks: [] })
        expect(DevelopmentDoctorResultSchema.parse(result)).toEqual(result)
        expect(result.durationMs).toBeLessThan(20_500)
        expect(byId(result)['odoo.source'].state).toBe('missing')
        const android = await runDevelopmentDoctor({ mode: 'android', settings: defaultDevelopmentSettings('android'), projectRoot: root, checkout: null, checks: [] })
        DevelopmentDoctorResultSchema.parse(android)
    }, 30_000)
})

describe('doctor false-readiness regressions', () => {
    it('requires a successful exit for version probes and a real PostgreSQL version', async () => {
        const failing = fakeSystem({ '/usr/bin/git': { output: 'git version 2.48.0', code: 1 }, '/usr/lib/postgresql/17/bin/postgres': { output: 'postgres (PostgreSQL) 17.2', code: 1 },
            '/usr/lib/postgresql/17/bin/initdb': {}, '/usr/lib/postgresql/17/bin/pg_ctl': {} }, { listings: { '/usr/lib/postgresql': ['17'] } }).system
        const result = byId(await runDevelopmentDoctor({ mode: 'odoo', settings: odoo(20), projectRoot: null, checkout: null, checks: ['git', 'postgresql.server'], system: failing, imageMarkerPath: '/nonexistent/marker' }))
        expect(result.git.state).toBe('unknown')
        expect(result['postgresql.server'].state).toBe('unknown')
    })

    it('does not accept a venv whose bin/python is a directory or whose packages are empty directories', async () => {
        const root = temp(), venv = join(root, '.hapi/.cache/toolchain/odoo/20/venv')
        write(venv, 'pyvenv.cfg', 'version = 3.13.5\n')
        mkdirSync(join(venv, 'bin/python'), { recursive: true })
        for (const name of ['psycopg2', 'lxml', 'werkzeug']) mkdirSync(join(venv, 'lib/python3.13/site-packages', name), { recursive: true })
        const interpreter = realpathSync('/usr/bin/python3')
        const run = () => runDevelopmentDoctor({ mode: 'odoo', settings: odoo(20), projectRoot: root, checkout: null, checks: ['odoo.venv'], system: fakeSystem({ [interpreter]: {} }, { files: { [join(venv, 'bin/python')]: 'file' } }).system, imageMarkerPath: '/nonexistent/marker' })
        expect(byId(await run())['odoo.venv'].state).toBe('warning')
        rmSync(join(venv, 'bin/python'), { recursive: true })
        symlinkSync('/usr/bin/python3', join(venv, 'bin/python'))
        // Interpreter is trusted now, but the package directories are still empty.
        expect(byId(await run())['odoo.venv'].detail).toMatch(/nicht installiert/)
        for (const name of ['psycopg2', 'lxml', 'werkzeug']) writeFileSync(join(venv, 'lib/python3.13/site-packages', name, '__init__.py'), '')
        expect(byId(await run())['odoo.venv'].state).toBe('ready')
    })

    it('requires adb for platform-tools and the wrapper JAR for gradle.wrapper', async () => {
        const root = temp(), checkout = join(root, 'repositories/o/app')
        write(root, '.hapi/.cache/toolchain/android/sdk/platform-tools/source.properties', 'Pkg.Revision=35.0.2\n')
        write(checkout, 'gradlew', '#!/bin/sh\n')
        write(checkout, 'gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip\n')
        const checks = byId(await runDevelopmentDoctor({ mode: 'android', settings: defaultDevelopmentSettings('android'), projectRoot: root, checkout, checks: ['android.platform-tools', 'gradle.wrapper'], androidSdkEnvironment: {}, ...fakeSystemInput({}, {}) }))
        expect(checks['android.platform-tools'].state).toBe('warning')
        expect(checks['gradle.wrapper'].state).toBe('missing')
        expect(checks['gradle.wrapper'].detail).toMatch(/gradle-wrapper.jar fehlt/)
    })
})

describe('doctor Swift toolchain layout', () => {
    it('recognises the official usr/bin/swift -> swift-driver link without executing it and rejects escapes', async () => {
        const root = temp(), swift = join(root, '.hapi/.cache/toolchain/swift'), version = join(swift, '6.4.1')
        write(version, 'usr/bin/swift-driver', '#!/bin/sh\nexit 99\n'); chmodSync(join(version, 'usr/bin/swift-driver'), 0o755)
        symlinkSync('swift-driver', join(version, 'usr/bin/swift'))
        write(swift, 'current.json', JSON.stringify({ version: '6.4.1' }))
        const { system, runs } = fakeSystem({})
        const run = async () => byId(await runDevelopmentDoctor({ mode: 'ios', settings: defaultDevelopmentSettings('ios'), projectRoot: root, checkout: null, checks: ['swift'], system, imageMarkerPath: '/nonexistent/marker' })).swift
        expect(await run()).toMatchObject({ state: 'ready', version: 'Swift 6.4.1' })
        expect(runs).toEqual([])
        rmSync(join(version, 'usr/bin/swift'))
        symlinkSync('/bin/sh', join(version, 'usr/bin/swift'))
        const escaped = await run()
        expect(escaped.state).toBe('warning')
        expect(escaped.detail).toMatch(/aus dem Versionsordner heraus/)
    })
})

describe('trusted executable lookup', () => {
    it('ignores PATH and rejects user-writable or project executables', async () => {
        const directory = temp()
        write(directory, 'python3', '#!/bin/sh\necho 9.9.9\n')
        chmodSync(join(directory, 'python3'), 0o755)
        expect(await trustedExecutable(join(directory, 'python3'))).toBeNull()
        symlinkSync('/usr/bin/env', join(directory, 'env-link'))
        expect(await trustedExecutable(join(directory, 'env-link'))).toBeNull()
        expect(await trustedExecutable('relative/python3')).toBeNull()
        const previous = process.env.PATH
        process.env.PATH = `${directory}:${previous}`
        try {
            const found = await findTrusted(createProbeSystem(), 'python3')
            if (found) expect(found.resolved.startsWith(directory)).toBe(false)
        } finally { process.env.PATH = previous }
        expect(await findTrusted(createProbeSystem(), '../bin/sh')).toBeNull()
        expect(PROBE_ENVIRONMENT).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent', TERM: 'dumb' })
    })
})

function fakeSystemInput(tools: Record<string, Tool>, listings: Record<string, string[]>) {
    return { system: fakeSystem(tools, { listings }).system, imageMarkerPath: '/nonexistent/marker' }
}
