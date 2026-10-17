import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolveSwiftBinary } from '../../../cli/src/evolved/development/swiftToolchain'
import { acceptableSocket, ANDROID_CMDLINE_TOOLS, apkOutputDirectories, defaultRuntime, javaHome, openManagedAppend, systemTool, upgradeDryRunOutcome, gradleTask, insideProject, layout, main, managedDirectory, odooTestArgv, parse, postgresConfig, postgresEnvironment, postgresServerOptions, projectRoot, swiftPlatform, swiftUrls, UsageError, writeManagedFile, type Runtime, type Step } from './hapi-dev'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'hapi-dev-'))); directories.push(path); return path }

const FAKE_JAVA_HOME = '/opt/hapi-test-fake-jdk'
function fakeRuntime(options: { env?: NodeJS.ProcessEnv; tty?: boolean; context?: unknown; code?: number; log?: string } = {}) {
    const lines: string[] = [], steps: Step[] = [], requests: string[] = []
    const factory = (dryRun: boolean): Runtime => ({
        dryRun, env: options.env ?? {}, isTTY: options.tty ?? false, now: () => new Date('2026-10-17T12:00:00Z'),
        // Controlled fake JDK: unit tests never depend on (or trust) a host Java installation.
        javaHome: () => FAKE_JAVA_HOME,
        out: line => lines.push(line),
        run: async step => { steps.push(step); if (step.log && options.log !== undefined) writeFileSync(step.log, options.log); return options.code ?? 0 },
        fetch: (async (url: string | URL) => { requests.push(String(url)); return Response.json(options.context ?? {}) }) as typeof fetch,
    })
    return { factory, lines, steps, requests }
}

describe('hapi-dev validation', () => {
    test('accepts only canonical, non-system project roots without symlinks', () => {
        const root = temp(), link = join(temp(), 'link')
        symlinkSync(root, link)
        expect(projectRoot(root, {})).toBe(root)
        expect(projectRoot(undefined, { EVOLVED_RUNNER_ROOT: root })).toBe(root)
        for (const value of [undefined, 'relative', '/', '/etc', '/usr/local', '/app', `${root}/../x`, link, `${root} x`, `${root}/missing`]) {
            expect(() => projectRoot(value, {})).toThrow(UsageError)
        }
    })

    test('keeps repositories and packages inside the project and refuses symlinked escapes', () => {
        const root = temp(), outside = temp()
        mkdirSync(join(root, 'repositories/acme/erp'), { recursive: true })
        symlinkSync(outside, join(root, 'repositories/escape'))
        expect(insideProject(root, 'repositories/acme/erp', '--repository')).toBe(join(root, 'repositories/acme/erp'))
        for (const value of [outside, 'repositories/escape', '../', '/etc', undefined]) expect(() => insideProject(root, value, '--repository')).toThrow(UsageError)
        // The project root itself is a legitimate checkout or package location.
        expect(insideProject(root, root, '--repository')).toBe(root)
        expect(insideProject(root, '.', '--package')).toBe(root)
    })

    test('rejects option injection and shell metacharacters before anything runs', () => {
        expect(() => parse(['--major', '--dry-run'])).toThrow(UsageError)
        expect(() => parse(['--major', '19', '--major', '20'])).toThrow(UsageError)
        for (const [module, variant] of [['app;rm -rf /', 'debug'], ['app', 'debug$(id)'], ['-app', 'debug'], ['app', 'Debug']]) expect(() => gradleTask('assemble', module, variant)).toThrow(UsageError)
        expect(gradleTask('assemble', 'app', 'debug')).toBe(':app:assembleDebug')
        expect(gradleTask('unit-test', ':feature:login', 'freeDebug')).toBe(':feature:login:testFreeDebugUnitTest')
        expect(gradleTask('lint', 'app', 'release')).toBe(':app:lintRelease')
    })
})

describe('hapi-dev Odoo and PostgreSQL plans', () => {
    test('odoo test builds a fixed argv: repository addons first, Unix socket only, disposable hapi_test_ database', async () => {
        const root = temp(), repository = join(root, 'repositories/acme/erp')
        mkdirSync(join(repository, 'addons'), { recursive: true })
        const paths = layout(root)
        expect(odooTestArgv(paths, 20, repository, ['addons', '.'], ['sale_ext', 'stock_ext'], 'hapi_test_dev', 5432)).toEqual([
            `${root}/.hapi/.cache/toolchain/odoo/20/venv/bin/python`, `${root}/.hapi/.cache/toolchain/odoo/20/src/odoo-bin`,
            `--addons-path=${repository}/addons,${repository},${root}/.hapi/.cache/toolchain/odoo/20/src/addons`, `--data-dir=${root}/.hapi/.cache/toolchain/odoo/20/data`,
            `--db_host=${root}/.hapi/.cache/toolchain/postgresql/run`, '--db_port=5432', '--db_user=odoo', '-d', 'hapi_test_dev', '-i', 'sale_ext,stock_ext',
            '--test-tags', '/sale_ext,/stock_ext', '--stop-after-init', '--log-level=test', '--max-cron-threads=0', '--http-port=8069',
        ])
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, '--dry-run', 'odoo', 'test', '--major', '20', '--repository', 'repositories/acme/erp', '--modules', 'sale_ext', '--addons', 'addons'], fake.factory)).toBe(0)
        expect(fake.steps).toEqual([])
        expect(fake.lines.join('\n')).toMatch(/Effekte: führt Projekt- und Odoo-Code aus/)
        for (const bad of [['--modules', 'sale;id'], ['--modules', 'Sale'], ['--db-slug', 'x;drop'], ['--addons', '../other'], ['--major', '18']]) {
            const args = ['--project-root', root, '--dry-run', 'odoo', 'test', '--major', '20', '--repository', 'repositories/acme/erp', '--modules', 'sale_ext']
            const index = args.indexOf(bad[0]); if (index >= 0) args.splice(index, 2)
            await expect(main([...args, ...bad], fake.factory)).rejects.toThrow(UsageError)
        }
    })

    test('long managed workspace roots get a private short socket directory (sun_path limit)', () => {
        const managed = layout('/managed-workspaces/6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11')
        expect(managed.pg.run).toMatch(/^\/tmp\/hapi-pg-[a-f0-9]{16}$/)
        expect(managed.pg.data).toBe('/managed-workspaces/6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11/.hapi/.cache/toolchain/postgresql/17/data')
        expect(layout('/workspaces/demo').pg.run).toBe('/workspaces/demo/.hapi/.cache/toolchain/postgresql/run')
        expect(layout('/workspaces/demo').pg.run).not.toBe(layout('/workspaces/other').pg.run)
    })

    test('postgres reuses only complete clusters, refuses incomplete ones and forces socket-only options at start', async () => {
        if (!existsSync('/usr/lib/postgresql')) return
        const root = temp(), paths = layout(root), fake = fakeRuntime()
        expect(postgresConfig(paths)).toContain("listen_addresses = ''")
        expect(postgresConfig(paths)).toContain(`unix_socket_directories = '${root}/.hapi/.cache/toolchain/postgresql/run'`)
        // A partial directory (e.g. after a failed initdb) is never silently reused or deleted.
        mkdirSync(paths.pg.data, { recursive: true })
        writeFileSync(join(paths.pg.data, 'PG_VERSION'), '17\n')
        writeFileSync(join(paths.pg.data, 'postgresql.conf'), "listen_addresses = '*'\n")
        await expect(main(['--project-root', root, 'postgres', 'init'], fake.factory)).rejects.toThrow(/kein vollständig von HAPI eingerichteter Cluster/)
        await expect(main(['--project-root', root, 'postgres', 'start'], fake.factory)).rejects.toThrow(/kein vollständig/)
        expect(readFileSync(join(paths.pg.data, 'postgresql.conf'), 'utf8')).toBe("listen_addresses = '*'\n")
        expect(fake.steps).toEqual([])
        // Complete cluster whose config later re-enables TCP: start still forces the socket-only GUCs.
        writeFileSync(join(paths.pg.data, 'postgresql.conf'), postgresConfig(paths) + "listen_addresses = '*'\ninclude_if_exists = 'evil.conf'\n")
        expect(await main(['--project-root', root, 'postgres', 'init'], fake.factory)).toBe(0)
        expect(fake.lines.join('\n')).toMatch(/wird wiederverwendet/)
        expect(await main(['--project-root', root, 'postgres', 'start'], fake.factory)).toBe(0)
        const start = fake.steps.at(-1)!.argv
        expect(start.slice(-3)).toEqual(['-o', `-c listen_addresses='' -c unix_socket_directories=${root}/.hapi/.cache/toolchain/postgresql/run -c unix_socket_permissions=0700 -c port=5432`, 'start'])
        expect(postgresServerOptions(paths)).toBe(start.at(-2)!)
    })

    test('unknown runner UIDs get a project-scoped nss_wrapper identity only for PostgreSQL helpers', () => {
        const root = temp(), paths = layout(root), fake = fakeRuntime().factory(false)
        const known = { uid: 1000, gid: 1000, passwd: 'root:x:0:0::/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n', libraries: ['/lib/fake.so'], trusted: () => true }
        expect(postgresEnvironment(fake, paths, known)).toEqual({})
        const unknown = { ...known, uid: 1001, gid: 1001 }
        const env = postgresEnvironment(fake, paths, unknown)
        expect(env).toEqual({ LD_PRELOAD: '/lib/fake.so', NSS_WRAPPER_PASSWD: `${paths.pg.base}/nss/passwd`, NSS_WRAPPER_GROUP: `${paths.pg.base}/nss/group` })
        expect(readFileSync(env.NSS_WRAPPER_PASSWD, 'utf8')).toBe(`hapi:x:1001:1001:HAPI PostgreSQL:${paths.pg.base}:/usr/sbin/nologin\n`)
        expect(readFileSync(env.NSS_WRAPPER_GROUP, 'utf8')).toBe('hapi:x:1001:\n')
        expect(() => postgresEnvironment(fake, paths, { ...unknown, trusted: () => false })).toThrow(/libnss_wrapper fehlt/)
        // Not process-wide: the helper's own environment stays untouched.
        expect(process.env.LD_PRELOAD).toBeUndefined()
    })

    test('helper-owned cache and artifact roots never follow a pre-existing .hapi symlink', async () => {
        const root = temp(), outside = temp()
        mkdirSync(join(root, 'repo'))
        writeFileSync(join(root, 'repo/gradlew'), '#!/bin/sh\n')
        symlinkSync(outside, join(root, '.hapi'))
        const fake = fakeRuntime()
        await expect(main(['--project-root', root, 'android', 'gradle', 'unit-test', '--project', 'repo'], fake.factory)).rejects.toThrow(/Verknüpfung oder kein Verzeichnis/)
        expect(readdirSync(outside)).toEqual([])
        expect(fake.steps).toEqual([])
        expect(() => managedDirectory(root, join(root, '.hapi/.cache/toolchain'), true)).toThrow(UsageError)
        expect(() => writeManagedFile(layout(root), join(root, '.hapi/.cache/x.json'), '{}')).toThrow(UsageError)
        expect(readdirSync(outside)).toEqual([])
    })

    test('database drop is explicit, confirmed and limited to hapi_test_ names', async () => {
        if (!existsSync('/usr/lib/postgresql')) return
        const root = temp(), fake = fakeRuntime()
        await expect(main(['--project-root', root, 'db', 'drop', 'dev'], fake.factory)).rejects.toThrow(/--confirm hapi_test_dev/)
        await expect(main(['--project-root', root, 'db', 'drop', 'dev', '--confirm', 'production'], fake.factory)).rejects.toThrow(UsageError)
        await expect(main(['--project-root', root, 'db', 'drop', 'Prod;x', '--confirm', 'hapi_test_Prod;x'], fake.factory)).rejects.toThrow(UsageError)
        // Without a running project socket nothing is dropped; the plan (dry run) names only the confirmed database.
        await expect(main(['--project-root', root, 'db', 'drop', 'dev', '--confirm', 'hapi_test_dev'], fake.factory)).rejects.toThrow(/zuerst „hapi-dev postgres start“/)
        expect(await main(['--project-root', root, '--dry-run', 'db', 'drop', 'dev', '--confirm', 'hapi_test_dev'], fake.factory)).toBe(0)
        expect(fake.lines.join('\n')).toMatch(/dropdb .*--if-exists hapi_test_dev/)
        expect(fake.steps).toEqual([])
    })
})

describe('hapi-dev Android licence gate', () => {
    test('managed runners require the human project setting; agent flags are ignored', async () => {
        const root = temp(), env = { HAPI_EVOLVED_PROXY: '1', EVOLVED_PROJECT_ID: 'p1', HAPI_EVOLVED_URL: 'http://runner-proxy:3010' }
        const denied = fakeRuntime({ env, context: { settings: { android: { sdkLicensesAcknowledged: false } } } })
        await expect(main(['--project-root', root, '--dry-run', 'android', 'sdk', 'bootstrap', '--human-acknowledged-sdk-licenses'], denied.factory)).rejects.toThrow(/Projektadmin/)
        expect(denied.requests).toEqual(['http://runner-proxy:3010/api/evolved/projects/p1/development/context'])
        const allowed = fakeRuntime({ env, context: { settings: { android: { sdkLicensesAcknowledged: true } } } })
        expect(await main(['--project-root', root, '--dry-run', 'android', 'sdk', 'bootstrap'], allowed.factory)).toBe(0)
        expect(allowed.lines.join('\n')).toContain(ANDROID_CMDLINE_TOOLS.url)
        // Licences are accepted only interactively by a person, never in a non-TTY agent session.
        await expect(main(['--project-root', root, '--dry-run', 'android', 'sdk', 'licenses'], allowed.factory)).rejects.toThrow(/nur interaktiv/)
        const terminal = fakeRuntime({ env, tty: true, context: { settings: { android: { sdkLicensesAcknowledged: true } } } })
        expect(await main(['--project-root', root, '--dry-run', 'android', 'sdk', 'licenses'], terminal.factory)).toBe(0)
    })

    test('outside managed runners the person states the acknowledgement explicitly', async () => {
        const root = temp()
        await expect(main(['--project-root', root, '--dry-run', 'android', 'sdk', 'install', '--compile-sdk', '35'], fakeRuntime().factory)).rejects.toThrow(/Projektadmin/)
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, '--dry-run', '--human-acknowledged-sdk-licenses', 'android', 'sdk', 'install', '--compile-sdk', '35', '--build-tools', '35.0.0', '--platform-tools'], fake.factory)).toBe(0)
        expect(fake.lines.join('\n')).toContain('platforms;android-35, build-tools;35.0.0, platform-tools')
        await expect(main(['--project-root', root, '--dry-run', '--human-acknowledged-sdk-licenses', 'android', 'sdk', 'install', '--compile-sdk', '35;x'], fake.factory)).rejects.toThrow(UsageError)
    })
})

describe('hapi-dev Swift', () => {
    test('maps only supported Linux platforms to signed swift.org URLs', () => {
        expect(swiftPlatform('ID=debian\nVERSION_ID="13"\n', 'x64')).toEqual({ directory: 'debian13', suffix: 'debian13' })
        expect(swiftPlatform('ID=ubuntu\nVERSION_ID="24.04"\n', 'arm64')).toEqual({ directory: 'ubuntu2404-aarch64', suffix: 'ubuntu24.04-aarch64' })
        expect(() => swiftPlatform('ID=alpine\nVERSION_ID=3.20\n', 'x64')).toThrow(UsageError)
        expect(swiftUrls('6.4.1', { directory: 'debian13', suffix: 'debian13' })).toEqual({
            tarball: 'https://download.swift.org/swift-6.4.1-release/debian13/swift-6.4.1-RELEASE/swift-6.4.1-RELEASE-debian13.tar.gz',
            signature: 'https://download.swift.org/swift-6.4.1-release/debian13/swift-6.4.1-RELEASE/swift-6.4.1-RELEASE-debian13.tar.gz.sig',
        })
        expect(() => swiftUrls('6.4.1;id', { directory: 'debian13', suffix: 'debian13' })).toThrow(UsageError)
    })
})

describe('hapi-dev Android artifacts', () => {
    const artifactsOf = (root: string) => {
        const base = join(layout(root).artifacts, 'android')
        const run = readdirSync(base)[0]
        const files: string[] = []
        const walk = (directory: string, prefix = '') => { for (const entry of readdirSync(directory, { withFileTypes: true })) entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : files.push(`${prefix}${entry.name}`) }
        walk(join(base, run))
        return { files: files.sort(), sums: readFileSync(join(base, run, 'SHA256SUMS'), 'utf8') }
    }
    function project(root: string) {
        mkdirSync(join(root, 'repo'), { recursive: true })
        writeFileSync(join(root, 'repo/gradlew'), '# fixture, never executed\n')
        return join(root, 'repo')
    }

    test('flavored debug APKs are found via output metadata and keep their relative paths', async () => {
        const root = temp(), repo = project(root)
        for (const flavor of ['free', 'paid']) {
            mkdirSync(join(repo, `app/build/outputs/apk/${flavor}/debug`), { recursive: true })
            writeFileSync(join(repo, `app/build/outputs/apk/${flavor}/debug/app-${flavor}-debug.apk`), `${flavor} apk`)
            writeFileSync(join(repo, `app/build/outputs/apk/${flavor}/debug/output-metadata.json`), JSON.stringify({ variantName: `${flavor}Debug` }))
        }
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, 'android', 'gradle', 'assemble', '--project', 'repo', '--variant', 'freeDebug'], fake.factory)).toBe(0)
        expect(fake.steps[0].argv.at(-1)).toBe(':app:assembleFreeDebug')
        const result = artifactsOf(root)
        expect(result.files).toEqual(['SHA256SUMS', 'apk/free/debug/app-free-debug.apk', 'apk/free/debug/output-metadata.json', 'gradle.log'].filter(name => name !== 'gradle.log' || result.files.includes('gradle.log')))
        expect(result.sums).toContain('  apk/free/debug/app-free-debug.apk')
        expect(apkOutputDirectories(join(repo, 'app/build/outputs/apk'), 'paidDebug')).toEqual(['paid/debug'])
    })

    test('conventional layout without metadata, nested equal names and a missing APK is an explicit failure', async () => {
        const root = temp(), repo = project(root)
        for (const name of ['one', 'two']) {
            mkdirSync(join(repo, `app/build/test-results/testDebugUnitTest/${name}`), { recursive: true })
            writeFileSync(join(repo, `app/build/test-results/testDebugUnitTest/${name}/TEST-result.xml`), `<testsuite name="${name}"/>`)
        }
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, 'android', 'gradle', 'unit-test', '--project', 'repo'], fake.factory)).toBe(0)
        expect(artifactsOf(root).files).toEqual(expect.arrayContaining(['test-results/one/TEST-result.xml', 'test-results/two/TEST-result.xml']))
        const empty = temp(); project(empty)
        mkdirSync(join(empty, 'repo/app/build/outputs/apk/free/debug'), { recursive: true })
        expect(await main(['--project-root', empty, 'android', 'gradle', 'assemble', '--project', 'repo', '--variant', 'freeDebug'], fake.factory)).toBe(3)
        expect(fake.lines.join('\n')).toMatch(/kein APK/)
        mkdirSync(join(empty, 'repo/app/build/outputs/apk/debug'), { recursive: true })
        writeFileSync(join(empty, 'repo/app/build/outputs/apk/debug/app-debug.apk'), 'apk')
        expect(apkOutputDirectories(join(empty, 'repo/app/build/outputs/apk'), 'debug')).toEqual(['debug'])
    })

    test('release variants are never assembled (no signing secrets), checked before Gradle runs', async () => {
        const root = temp(); project(root)
        const fake = fakeRuntime()
        for (const variant of ['release', 'freeRelease', 'staging']) {
            await expect(main(['--project-root', root, 'android', 'gradle', 'assemble', '--project', 'repo', '--variant', variant], fake.factory)).rejects.toThrow(/nur Debug-Varianten/)
        }
        expect(fake.steps).toEqual([])
    })
})

describe('hapi-dev Odoo and Swift inputs', () => {
    test('all configured modules get selectors; dot-prefixed addons paths follow the shared settings rule', async () => {
        const root = temp(), repository = join(root, 'repositories/acme/erp')
        mkdirSync(join(repository, '.addons/custom'), { recursive: true })
        const argv = odooTestArgv(layout(root), 19, repository, ['.addons/custom'], ['a_mod', 'b_mod', 'c_mod'], 'hapi_test_dev', 5432)
        expect(argv).toContain('/a_mod,/b_mod,/c_mod')
        expect(argv).toContain('a_mod,b_mod,c_mod')
        expect(await main(['--project-root', root, '--dry-run', 'odoo', 'test', '--major', '19', '--repository', 'repositories/acme/erp', '--modules', 'a_mod,b_mod', '--addons', '.addons/custom'], fakeRuntime().factory)).toBe(0)
    })

    test('swift test uses the toolchain recorded in swift/current.json and the given package directory', async () => {
        const root = temp(), paths = layout(root)
        const binary = join(paths.swift, '6.4.1/usr/bin/swift')
        mkdirSync(join(binary, '..'), { recursive: true })
        writeFileSync(binary, '#!/bin/sh\n'); chmodSync(binary, 0o755)
        writeFileSync(join(paths.swift, 'current.json'), JSON.stringify({ version: '6.4.1' }))
        mkdirSync(join(root, 'repo/Packages/Core'), { recursive: true })
        writeFileSync(join(root, 'repo/Packages/Core/Package.swift'), '// swift-tools-version: 6.0\n')
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, 'swift', 'test', '--package', 'repo/Packages/Core'], fake.factory)).toBe(0)
        const step = fake.steps[0]
        expect(step.argv.slice(0, 4)).toEqual([binary, 'test', '--package-path', join(root, 'repo/Packages/Core')])
        expect(step.cwd).toBe(join(root, 'repo/Packages/Core'))
    })

    test('official Swift layout: usr/bin/swift -> swift-driver symlink inside the version tree is accepted and run by its link name', async () => {
        const root = temp(), paths = layout(root), version = join(paths.swift, '6.4.1')
        mkdirSync(join(version, 'usr/bin'), { recursive: true })
        writeFileSync(join(version, 'usr/bin/swift-driver'), '#!/bin/sh\n'); chmodSync(join(version, 'usr/bin/swift-driver'), 0o755)
        symlinkSync('swift-driver', join(version, 'usr/bin/swift'))
        writeFileSync(join(paths.swift, 'current.json'), JSON.stringify({ version: '6.4.1' }))
        mkdirSync(join(root, 'repositories/swift'), { recursive: true })
        writeFileSync(join(root, 'repositories/swift/Package.swift'), '// swift-tools-version: 6.0\n')
        expect(resolveSwiftBinary(version)).toEqual({ ok: true, binary: join(version, 'usr/bin/swift'), target: join(version, 'usr/bin/swift-driver') })
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, 'swift', 'test', '--package', 'repositories/swift'], fake.factory)).toBe(0)
        // argv[0] stays the link name: swift-driver selects its mode from it.
        expect(fake.steps[0].argv.slice(0, 4)).toEqual([join(version, 'usr/bin/swift'), 'test', '--package-path', join(root, 'repositories/swift')])
        // The manifest is compiled and executed from TMPDIR; /tmp is noexec in the runner, so a project-local
        // directory is created (even for a pure iOS project without pip setup) and passed to the child only.
        const buildTemp = join(root, '.hapi/.cache/toolchain/tmp')
        expect(fake.steps[0].env).toEqual({ TMPDIR: buildTemp })
        expect(lstatSync(buildTemp).isDirectory()).toBe(true)
        expect(lstatSync(buildTemp).mode & 0o777).toBe(0o700)
        expect(process.env.TMPDIR).not.toBe(buildTemp)
    })

    test('Swift links that escape the version tree, are broken or point to non-executables are rejected', async () => {
        const root = temp(), outside = temp()
        const make = (name: string) => { const version = join(root, name); mkdirSync(join(version, 'usr/bin'), { recursive: true }); return version }
        writeFileSync(join(outside, 'swift'), '#!/bin/sh\n'); chmodSync(join(outside, 'swift'), 0o755)
        const escape = make('escape'); symlinkSync(join(outside, 'swift'), join(escape, 'usr/bin/swift'))
        const sibling = make('sibling'); make('other'); writeFileSync(join(root, 'other/usr/bin/swift-driver'), '#!/bin/sh\n'); chmodSync(join(root, 'other/usr/bin/swift-driver'), 0o755)
        symlinkSync('../../../other/usr/bin/swift-driver', join(sibling, 'usr/bin/swift'))
        const broken = make('broken'); symlinkSync('swift-driver', join(broken, 'usr/bin/swift'))
        const plain = make('plain'); writeFileSync(join(plain, 'usr/bin/swift-driver'), 'data'); chmodSync(join(plain, 'usr/bin/swift-driver'), 0o644); symlinkSync('swift-driver', join(plain, 'usr/bin/swift'))
        const linkedBin = join(root, 'linkedbin'); mkdirSync(join(linkedBin, 'usr'), { recursive: true }); symlinkSync(join(root, 'other/usr/bin'), join(linkedBin, 'usr/bin'))
        expect(resolveSwiftBinary(escape)).toEqual({ ok: false, reason: 'escape' })
        expect(resolveSwiftBinary(sibling)).toEqual({ ok: false, reason: 'escape' })
        expect(resolveSwiftBinary(broken)).toEqual({ ok: false, reason: 'broken' })
        expect(resolveSwiftBinary(plain)).toEqual({ ok: false, reason: 'not_executable' })
        expect(resolveSwiftBinary(linkedBin)).toEqual({ ok: false, reason: 'unsafe' })
        expect(resolveSwiftBinary(join(root, 'absent'))).toEqual({ ok: false, reason: 'missing' })
    })
})

describe('hapi-dev Odoo upgrade dry run', () => {
    test('upstream exit 1 without traceback means proposed changes; tracebacks and other codes stay failures', () => {
        expect(upgradeDryRunOutcome(0, '')).toBe('clean')
        expect(upgradeDryRunOutcome(1, 'INFO odoo.cli.upgrade_code: would change addons/x/models.py\n')).toBe('changes_proposed')
        expect(upgradeDryRunOutcome(1, 'Traceback (most recent call last):\n  File "odoo-bin"\nKeyError: x\n')).toBe('failed')
        expect(upgradeDryRunOutcome(2, '')).toBe('failed')
        expect(upgradeDryRunOutcome(137, '')).toBe('failed')
    })

    test('exit 1 is passed through, explained and recorded without a generic failure line', async () => {
        const root = temp()
        mkdirSync(join(root, 'repositories/erp/addons'), { recursive: true })
        const fake = fakeRuntime({ code: 1, log: 'INFO odoo.cli.upgrade_code: would change 2 files\n' })
        expect(await main(['--project-root', root, 'odoo', 'upgrade-dry-run', '--repository', 'repositories/erp', '--addons', 'addons'], fake.factory)).toBe(1)
        expect(fake.steps[0].argv).toContain('--dry-run')
        const output = fake.lines.join('\n')
        expect(output).toMatch(/Änderungen vorgeschlagen/)
        expect(output).not.toMatch(/✗/)
        const base = join(layout(root).artifacts, 'odoo'), run = readdirSync(base)[0]
        expect(JSON.parse(readFileSync(join(base, run, 'summary.json'), 'utf8'))).toEqual({ exitCode: 1, outcome: 'changes_proposed', from: '19.0', to: '20.0' })
        const failing = fakeRuntime({ code: 1, log: 'Traceback (most recent call last):\nValueError\n' })
        const other = temp(); mkdirSync(join(other, 'repositories/erp'), { recursive: true })
        expect(await main(['--project-root', other, 'odoo', 'upgrade-dry-run', '--repository', 'repositories/erp'], failing.factory)).toBe(1)
        expect(failing.lines.join('\n')).toMatch(/✗ upgrade_code ist fehlgeschlagen/)
    })
})

describe('hapi-dev never writes or reads through links (CodeQL triage regressions)', () => {
    test('helper state behind a hard link or symlink is rejected; normal reruns replace own files', async () => {
        const root = temp(), outside = temp(), paths = layout(root)
        mkdirSync(join(paths.swift, '6.4.1'), { recursive: true })
        const sentinel = join(outside, 'sentinel'); writeFileSync(sentinel, 'OUTSIDE')
        linkSync(sentinel, join(paths.swift, 'current.json'))
        const fake = fakeRuntime()
        await expect(main(['--project-root', root, 'swift', 'install', '--version', '6.4.1'], fake.factory)).rejects.toThrow(/mehrere harte Links/)
        expect(readFileSync(sentinel, 'utf8')).toBe('OUTSIDE')
        rmSync(join(paths.swift, 'current.json'))
        symlinkSync(sentinel, join(paths.swift, 'current.json'))
        await expect(main(['--project-root', root, 'swift', 'install', '--version', '6.4.1'], fake.factory)).rejects.toThrow(/Verknüpfung/)
        expect(readFileSync(sentinel, 'utf8')).toBe('OUTSIDE')
        rmSync(join(paths.swift, 'current.json'))
        // Normal rerun: an own regular file is replaced (atomic rename), no temp files remain.
        expect(await main(['--project-root', root, 'swift', 'install', '--version', '6.4.1'], fake.factory)).toBe(0)
        expect(await main(['--project-root', root, 'swift', 'install', '--version', '6.4.1'], fake.factory)).toBe(0)
        expect(JSON.parse(readFileSync(join(paths.swift, 'current.json'), 'utf8')).version).toBe('6.4.1')
        expect(readdirSync(paths.swift).filter(name => name.endsWith('.tmp'))).toEqual([])
        expect(fake.steps).toEqual([])
    })

    test('append writers check the opened inode before writing', () => {
        const root = temp(), outside = temp()
        const sentinel = join(outside, 'sentinel'); writeFileSync(sentinel, 'OUTSIDE')
        linkSync(sentinel, join(root, 'gradle.log'))
        expect(() => openManagedAppend(join(root, 'gradle.log'), true)).toThrow(/mehrere harte Links/)
        symlinkSync(sentinel, join(root, 'link.log'))
        expect(() => openManagedAppend(join(root, 'link.log'), true)).toThrow()
        expect(readFileSync(sentinel, 'utf8')).toBe('OUTSIDE')
    })

    test('a symlinked parent of the build output is never collected; hard-linked report files are skipped', async () => {
        const root = temp(), outside = temp()
        mkdirSync(join(root, 'repo/app'), { recursive: true })
        writeFileSync(join(root, 'repo/gradlew'), '# fixture, never executed\n')
        mkdirSync(join(outside, 'test-results/testDebugUnitTest'), { recursive: true })
        writeFileSync(join(outside, 'test-results/testDebugUnitTest/private.xml'), 'OUTSIDE DATA')
        symlinkSync(outside, join(root, 'repo/app/build'))
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, 'android', 'gradle', 'unit-test', '--project', 'repo'], fake.factory)).toBe(3)
        expect(fake.lines.join('\n')).toMatch(/Verknüpfung; aus Sicherheitsgründen wird nichts daraus kopiert/)
        const runs = join(layout(root).artifacts, 'android')
        expect(existsSync(join(runs, readdirSync(runs)[0], 'test-results'))).toBe(false)

        const other = temp(), secret = join(temp(), 'secret.xml')
        writeFileSync(secret, 'OUTSIDE HARDLINK')
        const results = join(other, 'repo/app/build/test-results/testDebugUnitTest/nested')
        mkdirSync(results, { recursive: true })
        writeFileSync(join(other, 'repo/gradlew'), '# fixture\n')
        writeFileSync(join(results, 'TEST-ok.xml'), '<testsuite/>')
        linkSync(secret, join(results, 'TEST-linked.xml'))
        const second = fakeRuntime()
        expect(await main(['--project-root', other, 'android', 'gradle', 'unit-test', '--project', 'repo'], second.factory)).toBe(0)
        const base = join(layout(other).artifacts, 'android'), run = join(base, readdirSync(base)[0])
        expect(readFileSync(join(run, 'test-results/nested/TEST-ok.xml'), 'utf8')).toBe('<testsuite/>')
        expect(existsSync(join(run, 'test-results/nested/TEST-linked.xml'))).toBe(false)
        expect(second.lines.join('\n')).toMatch(/1 Datei\(en\) übersprungen/)
        expect(readFileSync(join(run, 'SHA256SUMS'), 'utf8')).not.toContain('TEST-linked.xml')
    })

    test('hard-linked output metadata does not select an APK directory', () => {
        const root = temp(), apk = join(root, 'apk'), outside = join(temp(), 'meta.json')
        mkdirSync(join(apk, 'odd/place'), { recursive: true })
        writeFileSync(outside, JSON.stringify({ variantName: 'freeDebug' }))
        linkSync(outside, join(apk, 'odd/place/output-metadata.json'))
        expect(apkOutputDirectories(apk, 'freeDebug')).toEqual([])
    })
})

describe('hapi-dev PostgreSQL cluster chain and tool discovery seams', () => {
    test('a symlinked postgresql/17 parent is rejected for start/stop/status/init and db commands; nothing is run or removed', async () => {
        if (!existsSync('/usr/lib/postgresql')) return
        const root = temp(), outside = temp(), paths = layout(root)
        mkdirSync(join(outside, 'data'), { recursive: true })
        writeFileSync(join(outside, 'data/PG_VERSION'), '16\n')
        writeFileSync(join(outside, 'data/postgresql.conf'), postgresConfig(paths))
        mkdirSync(paths.pg.base, { recursive: true })
        symlinkSync(outside, join(paths.pg.base, '17'))
        const fake = fakeRuntime()
        for (const args of [['postgres', 'start'], ['postgres', 'stop'], ['postgres', 'status'], ['postgres', 'init'], ['db', 'list']]) {
            await expect(main(['--project-root', root, ...args], fake.factory)).rejects.toThrow(/Verknüpfung oder kein Verzeichnis/)
        }
        expect(fake.steps).toEqual([])
        expect(readdirSync(join(outside, 'data')).sort()).toEqual(['PG_VERSION', 'postgresql.conf'])
        expect(lstatSync(join(paths.pg.base, '17')).isSymbolicLink()).toBe(true)
    })

    test('a valid existing cluster in real directories still starts with the forced socket-only options', async () => {
        if (!existsSync('/usr/lib/postgresql')) return
        const root = temp(), paths = layout(root)
        mkdirSync(paths.pg.data, { recursive: true })
        writeFileSync(join(paths.pg.data, 'PG_VERSION'), '17\n')
        writeFileSync(join(paths.pg.data, 'postgresql.conf'), postgresConfig(paths))
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, 'postgres', 'start'], fake.factory)).toBe(0)
        expect(fake.steps[0].argv).toContain(postgresServerOptions(paths))
    })

    test('hard-linked PG_VERSION/config or SDK licence files do not count as local state', async () => {
        const root = temp(), outside = temp(), paths = layout(root)
        mkdirSync(paths.pg.data, { recursive: true })
        writeFileSync(join(outside, 'conf'), postgresConfig(paths))
        linkSync(join(outside, 'conf'), join(paths.pg.data, 'postgresql.conf'))
        writeFileSync(join(paths.pg.data, 'PG_VERSION'), '17\n')
        if (existsSync('/usr/lib/postgresql')) await expect(main(['--project-root', root, 'postgres', 'start'], fakeRuntime().factory)).rejects.toThrow(/kein vollständig/)
        mkdirSync(join(paths.android.sdk, 'licenses'), { recursive: true })
        writeFileSync(join(outside, 'licence'), 'hash')
        linkSync(join(outside, 'licence'), join(paths.android.sdk, 'licenses/android-sdk-license'))
        await expect(main(['--project-root', root, '--human-acknowledged-sdk-licenses', 'android', 'sdk', 'install', '--compile-sdk', '35'], fakeRuntime().factory)).rejects.toThrow(/Noch keine angenommene SDK-Lizenz/)
    })

    test('production keeps the fixed trusted JDK discovery; systemTool rejects missing, non-executable and group/world-writable tools', () => {
        expect(defaultRuntime(true).javaHome).toBe(javaHome)
        const directory = temp()
        const tool = (name: string, mode: number) => { const path = join(directory, name); writeFileSync(path, '#!/bin/sh\n'); chmodSync(path, mode); return path }
        expect(systemTool([tool('ok', 0o755)])).toBe(join(directory, 'ok'))
        expect(systemTool([tool('plain', 0o644)])).toBeNull()
        expect(systemTool([tool('group', 0o775)])).toBeNull()
        expect(systemTool([tool('world', 0o757)])).toBeNull()
        expect(systemTool([join(directory, 'missing')])).toBeNull()
        symlinkSync(join(directory, 'group'), join(directory, 'link-to-group'))
        expect(systemTool([join(directory, 'link-to-group')])).toBeNull()
        expect(systemTool([join(directory, 'missing'), join(directory, 'ok')])).toBe(join(directory, 'ok'))
    })

    test('Android helpers use the injected JDK, not the host Java', async () => {
        const root = temp()
        mkdirSync(join(root, 'repo'), { recursive: true })
        writeFileSync(join(root, 'repo/gradlew'), '# fixture\n')
        const fake = fakeRuntime()
        expect(await main(['--project-root', root, 'android', 'gradle', 'unit-test', '--project', 'repo'], fake.factory)).toBe(0)
        expect(fake.steps[0].env?.JAVA_HOME).toBe(FAKE_JAVA_HOME)
    })
})

describe('hapi-dev PostgreSQL socket leaf', () => {
    function project() {
        const root = temp(), paths = layout(root)
        mkdirSync(join(root, 'repo'), { recursive: true })
        mkdirSync(paths.pg.run, { recursive: true })
        return { root, paths, socket: join(paths.pg.run, '.s.PGSQL.5432') }
    }
    const odooTest = (root: string) => ['--project-root', root, 'odoo', 'test', '--major', '20', '--repository', 'repo', '--modules', 'fixture']

    test('a symlink or regular file at the socket leaf is rejected before Odoo or db clients run', async () => {
        const outside = join(temp(), 'sentinel'); writeFileSync(outside, 'SYNTHETIC DATA')
        const linked = project(); symlinkSync(outside, linked.socket)
        const fake = fakeRuntime()
        await expect(main(odooTest(linked.root), fake.factory)).rejects.toThrow(/kein Unix-Socket dieses Benutzers/)
        const plain = project(); writeFileSync(plain.socket, '')
        await expect(main(odooTest(plain.root), fake.factory)).rejects.toThrow(/kein Unix-Socket/)
        if (existsSync('/usr/lib/postgresql')) await expect(main(['--project-root', linked.root, 'db', 'list'], fake.factory)).rejects.toThrow(/kein Unix-Socket/)
        expect(fake.steps).toEqual([])
        expect(readFileSync(outside, 'utf8')).toBe('SYNTHETIC DATA')
        expect(lstatSync(linked.socket).isSymbolicLink()).toBe(true)
    })

    test('a missing socket keeps the start guidance', async () => {
        const missing = project()
        await expect(main(odooTest(missing.root), fakeRuntime().factory)).rejects.toThrow(/zuerst „hapi-dev postgres start“/)
    })

    test('only an own, non-link Unix socket is accepted (also for the private /tmp fallback directory)', () => {
        const stat = (socket: boolean, link: boolean, uid: number) => ({ isSocket: () => socket, isSymbolicLink: () => link, uid })
        expect(acceptableSocket(stat(true, false, 1001), 1001)).toBe('ok')
        expect(acceptableSocket(stat(true, false, 1002), 1001)).toBe('unsafe')
        expect(acceptableSocket(stat(false, true, 1001), 1001)).toBe('unsafe')
        expect(acceptableSocket(stat(false, false, 1001), 1001)).toBe('unsafe')
        expect(acceptableSocket(null, 1001)).toBe('missing')
        expect(layout('/managed-workspaces/6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11').pg.run).toMatch(/^\/tmp\/hapi-pg-[a-f0-9]{16}$/)
    })

    test('a real listening Unix socket passes and Odoo is scheduled with it as db_host', async () => {
        const { root, paths, socket } = project()
        const server = createServer()
        const listening = await new Promise<boolean>(resolve => { server.once('error', () => resolve(false)); server.listen(socket, () => resolve(true)) })
        // Some sandboxes forbid binding Unix sockets; the pure check above still covers the rule there.
        if (!listening) return
        try {
            const fake = fakeRuntime()
            expect(await main(odooTest(root), fake.factory)).toBe(0)
            expect(fake.steps[0].argv).toContain(`--db_host=${paths.pg.run}`)
        } finally { await new Promise(resolve => server.close(resolve)) }
    })
})
