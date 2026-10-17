import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveSwiftBinary } from '../../../cli/src/evolved/development/swiftToolchain'
import { ANDROID_CMDLINE_TOOLS, apkOutputDirectories, upgradeDryRunOutcome, gradleTask, insideProject, layout, main, managedDirectory, odooTestArgv, parse, postgresConfig, postgresEnvironment, postgresServerOptions, projectRoot, swiftPlatform, swiftUrls, UsageError, writeManagedFile, type Runtime, type Step } from './hapi-dev'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'hapi-dev-'))); directories.push(path); return path }

function fakeRuntime(options: { env?: NodeJS.ProcessEnv; tty?: boolean; context?: unknown; code?: number; log?: string } = {}) {
    const lines: string[] = [], steps: Step[] = [], requests: string[] = []
    const factory = (dryRun: boolean): Runtime => ({
        dryRun, env: options.env ?? {}, isTTY: options.tty ?? false, now: () => new Date('2026-10-17T12:00:00Z'),
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
        expect(await main(['--project-root', root, 'db', 'drop', 'dev', '--confirm', 'hapi_test_dev'], fake.factory)).toBe(0)
        expect(fake.steps.at(-1)?.argv.slice(-2)).toEqual(['--if-exists', 'hapi_test_dev'])
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
        if (!existsSync('/usr/bin/java')) return
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
        if (!existsSync('/usr/bin/java')) return
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
