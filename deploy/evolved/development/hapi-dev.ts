/**
 * hapi-dev: reviewed setup/test helpers for HAPI-eVolved development modes.
 *
 * Runs only when an agent session (or a person in a terminal) explicitly calls
 * it. Everything is installed below <project>/.hapi/.cache/toolchain, logs/artifacts
 * go to <project>/.hapi/.cache/artifacts (shared contract roots). Nothing is deleted, reset or replaced;
 * existing directories are reused. Every external program is started with a
 * fixed argv (no shell), validated names and a minimal environment.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { Readable } from 'node:stream'
import { odooToolchain, POSTGRES_PORT, toolchainPaths } from '../../../cli/src/evolved/development/layout'
import { isAndroidDebugVariant, RepoSubdirectorySchema } from '../../../shared/src/evolvedDevelopment'
import { resolveSwiftBinary } from '../../../cli/src/evolved/development/swiftToolchain'
import { pipeline } from 'node:stream/promises'

export class UsageError extends Error {}
const fail = (message: string): never => { throw new UsageError(message) }

// ------------------------------------------------------------------ pinned downloads (verified 2026-10-17)
export const ANDROID_CMDLINE_TOOLS = {
    url: 'https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip',
    sha256: '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583',
    source: 'https://developer.android.com/studio#command-line-tools-only',
} as const
export const ANDROID_CLI_URL = 'https://dl.google.com/android/cli/latest/linux_x86_64/android'
export const SWIFT_DEFAULT_VERSION = '6.4.1'
export const SWIFT_KEYS_URL = 'https://www.swift.org/keys/all-keys.asc'
const ODOO_REPOSITORY = 'https://github.com/odoo/odoo.git'

// ------------------------------------------------------------------ validation (mirrors shared/src/evolvedDevelopment.ts)
const MODULE = /^[a-z][a-z0-9_]{0,63}$/
const DB_SLUG = /^[a-z0-9][a-z0-9_]{0,31}$/
const GRADLE_MODULE = /^:?[A-Za-z0-9_][A-Za-z0-9_-]{0,63}(?::[A-Za-z0-9_][A-Za-z0-9_-]{0,63}){0,7}$/
const VARIANT = /^[a-z][A-Za-z0-9]{0,63}$/
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{1,400}$/

export function odooMajor(value: string | undefined): 19 | 20 {
    if (value === '19' || value === '20') return Number(value) as 19 | 20
    return fail('--major muss 19 oder 20 sein.')
}
export function moduleList(value: string | undefined): string[] {
    const modules = (value ?? '').split(',').filter(Boolean)
    if (!modules.length || modules.length > 32 || !modules.every(module => MODULE.test(module))) fail('--modules braucht 1–32 technische Modulnamen (a-z, 0-9, _), durch Komma getrennt.')
    return [...new Set(modules)]
}
export function databaseName(slug: string | undefined): string {
    if (!slug || !DB_SLUG.test(slug)) fail('--db-slug muss /^[a-z0-9][a-z0-9_]{0,31}$/ entsprechen.')
    return `hapi_test_${slug}`
}

// ------------------------------------------------------------------ layout
export type Layout = ReturnType<typeof layout>
/** Same layout as the doctor (cli/src/evolved/development/layout.ts) and the pack recipes' {toolchainDir}. */
export function layout(projectRoot: string) {
    const shared = toolchainPaths(projectRoot), at = (path: string) => join(projectRoot, path)
    return {
        projectRoot, toolchain: at(shared.toolchain), artifacts: at(shared.artifacts), downloads: at(shared.downloads),
        odoo: (major: 19 | 20) => { const odoo = odooToolchain(major); return { base: at(odoo.base), source: at(odoo.source), record: at(odoo.record), venv: at(odoo.venv), data: at(odoo.data) } },
        pg: { base: at(shared.postgresBase), data: at(shared.postgresData), run: shared.postgresSocketAbsolute, log: at(shared.postgresLog) },
        android: { sdk: at(shared.androidSdk), gradleHome: at(shared.gradleHome), cli: at(shared.androidCli) },
        swift: at(shared.swift),
    }
}

/** The project root must be the managed workspace (or an explicit, canonical directory outside system paths). */
export function projectRoot(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
    const value = explicit ?? env.EVOLVED_RUNNER_ROOT
    if (!value) fail('Projektordner unbekannt: EVOLVED_RUNNER_ROOT fehlt. Außerhalb eines Runners --project-root <ordner> angeben.')
    if (!isAbsolute(value!) || normalize(value!) !== value || value === '/' || !SAFE_PATH.test(value!)) fail('Der Projektordner muss ein kanonischer absoluter Pfad aus [A-Za-z0-9._/-] sein.')
    if (/^\/(?:etc|usr|bin|sbin|lib|lib64|proc|sys|dev|boot|var|opt|app|runner)(?:\/|$)/.test(value!)) fail('Systemverzeichnisse sind als Projektordner nicht erlaubt.')
    let real: string
    try { real = realpathSync(value!) } catch { return fail('Der Projektordner existiert nicht.') }
    if (real !== value) fail('Der Projektordner darf keine symbolische Verknüpfung enthalten.')
    if (!statSync(real).isDirectory()) fail('Der Projektordner ist kein Verzeichnis.')
    return real
}

/** A checkout/package directory inside the project root, without symlinks. */
export function insideProject(root: string, value: string | undefined, label: string): string {
    if (!value) return fail(`${label} fehlt.`)
    const absolute = isAbsolute(value) ? value : join(root, value)
    let real: string
    try { real = realpathSync(absolute) } catch { return fail(`${label} existiert nicht.`) }
    const inside = relative(root, real)
    // The project root itself is a legitimate checkout/package location; anything outside is not.
    if (real !== normalize(absolute).replace(/\/$/, '') || inside.startsWith('..') || isAbsolute(inside)) fail(`${label} muss ein Verzeichnis im Projektordner ohne Verknüpfungen sein.`)
    if (!statSync(real).isDirectory()) fail(`${label} ist kein Verzeichnis.`)
    return real
}

// ------------------------------------------------------------------ process helpers
export type Step = { argv: string[]; cwd?: string; env?: Record<string, string>; log?: string; stdin?: 'ignore' | 'inherit' }
const BASE_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
export type Runtime = {
    dryRun: boolean
    out: (line: string) => void
    run: (step: Step) => Promise<number>
    env: NodeJS.ProcessEnv
    isTTY: boolean
    fetch: typeof fetch
    now: () => Date
}

function environment(step: Step, env: NodeJS.ProcessEnv): Record<string, string> {
    // HOME keeps tool caches in the private runner home; no credentials are added.
    return { ...BASE_ENV, HOME: env.HOME ?? '/nonexistent', TMPDIR: env.TMPDIR ?? '/tmp', ...step.env }
}

export function defaultRuntime(dryRun: boolean): Runtime {
    return {
        dryRun, env: process.env, isTTY: !!process.stdin.isTTY, fetch, now: () => new Date(),
        out: line => console.log(line),
        run: step => new Promise(resolve => {
            const child = spawn(step.argv[0], step.argv.slice(1), { cwd: step.cwd ?? '/', env: environment(step, process.env), shell: false,
                stdio: [step.stdin ?? 'ignore', 'pipe', 'pipe'] })
            const log = step.log ? createWriteStream('', { fd: openSync(step.log, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600) }) : null
            for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { process.stdout.write(chunk); log?.write(chunk) })
            child.on('error', () => { log?.end(); resolve(127) })
            child.on('close', code => { log?.end(); resolve(code ?? 1) })
        }),
    }
}

async function execute(runtime: Runtime, step: Step, what: string, quietCodes: readonly number[] = []): Promise<number> {
    runtime.out(`$ ${step.argv.map(part => /^[A-Za-z0-9_./:=,@%+-]+$/.test(part) ? part : JSON.stringify(part)).join(' ')}${step.cwd ? `   (in ${step.cwd})` : ''}`)
    if (runtime.dryRun) return 0
    const code = await runtime.run(step)
    // quietCodes: the caller interprets these documented, non-failure exit codes itself.
    if (code !== 0 && !quietCodes.includes(code)) runtime.out(`✗ ${what} endete mit Code ${code}.`)
    return code
}

function effects(runtime: Runtime, list: string[]) { runtime.out(`Effekte: ${list.join('; ')}.`) }

/**
 * Creates or verifies a helper-owned directory one component at a time below `base` (the project root,
 * or /tmp for the private socket directory). Existing components must be real directories owned by this
 * user; symlinks are never followed and nothing existing is removed.
 */
export function managedDirectory(base: string, path: string, create: boolean, mode = 0o700): void {
    const inside = relative(base, path)
    if (inside.startsWith('..') || isAbsolute(inside)) fail(`${path} liegt nicht unter ${base}.`)
    const uid = process.getuid?.()
    let current = base
    for (const part of inside === '' ? [] : inside.split('/')) {
        current = join(current, part)
        let info = lstatOrNull(current)
        if (!info && create) { try { mkdirSync(current, { mode }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error } info = lstatOrNull(current) }
        if (!info) { if (create) fail(`${current} konnte nicht angelegt werden.`); return }
        if (info.isSymbolicLink() || !info.isDirectory()) fail(`${current} ist eine Verknüpfung oder kein Verzeichnis; HAPI schreibt dort nicht hinein und löscht nichts.`)
        if (uid !== undefined && info.uid !== uid) fail(`${current} gehört nicht diesem Benutzer; HAPI schreibt dort nicht hinein.`)
    }
}
function lstatOrNull(path: string) { try { return lstatSync(path) } catch { return null } }
function baseOf(paths: Layout, path: string): string {
    return relative(paths.projectRoot, path).startsWith('..') ? '/tmp' : paths.projectRoot
}
function ensureDirectory(runtime: Runtime, paths: Layout, path: string, mode = 0o700) {
    managedDirectory(baseOf(paths, path), path, !runtime.dryRun, mode)
}
/** Write a helper-owned file without following a pre-existing symlink at the target. */
export function writeManagedFile(paths: Layout, path: string, data: string) {
    managedDirectory(baseOf(paths, path), join(path, '..'), true)
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    try { writeSync(fd, data) } finally { closeSync(fd) }
}
/** An existing helper target must be a real directory, never a link to somewhere else. */
function reusable(path: string): boolean {
    const info = lstatOrNull(path)
    if (!info) return false
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`${path} existiert, ist aber eine Verknüpfung oder kein Verzeichnis; bitte prüfen. HAPI verändert es nicht.`)
    return true
}

function exists(path: string): boolean { try { lstatSync(path); return true } catch { return false } }

export function systemTool(candidates: string[]): string | null {
    for (const candidate of candidates) {
        try {
            const real = realpathSync(candidate), info = statSync(real)
            if (info.isFile() && (info.mode & 0o111) && (info.mode & 0o022) === 0) return candidate
        } catch {}
    }
    return null
}
export function postgresBin(minimum = 13): string {
    let versions: string[] = []
    try { versions = readdirSync('/usr/lib/postgresql').filter(name => /^[0-9]{2}$/.test(name)).sort((a, b) => Number(b) - Number(a)) } catch {}
    for (const version of versions) {
        const bin = `/usr/lib/postgresql/${version}/bin`
        if (Number(version) >= minimum && ['initdb', 'pg_ctl', 'postgres', 'pg_isready', 'psql'].every(name => systemTool([`${bin}/${name}`]))) return bin
    }
    return fail(`Keine PostgreSQL-Server-Programme ≥ ${minimum} unter /usr/lib/postgresql gefunden (Development-Image nötig).`)
}
function javaHome(): string {
    const java = systemTool(['/usr/bin/java'])
    if (!java) fail('Kein JDK gefunden (Development-Image nötig).')
    return realpathSync(java!).replace(/\/bin\/java$/, '')
}

function timestamp(runtime: Runtime) { return runtime.now().toISOString().replace(/[:.]/g, '-') }
function artifactDirectory(runtime: Runtime, paths: Layout, kind: string): string {
    const directory = join(paths.artifacts, kind, timestamp(runtime))
    ensureDirectory(runtime, paths, directory)
    return directory
}
/** Regular files below `directory` (relative paths), never following links; bounded. */
function artifactFiles(directory: string, prefix = '', depth = 0, found: string[] = []): string[] {
    if (depth > 8 || found.length >= 2000) return found
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) artifactFiles(directory, path, depth + 1, found)
        else if (entry.isFile() && path !== 'SHA256SUMS') found.push(path)
    }
    return found
}
async function sha256File(path: string): Promise<string> {
    const hash = createHash('sha256')
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex')
}
async function writeChecksums(runtime: Runtime, directory: string) {
    if (runtime.dryRun) return
    const lines: string[] = []
    for (const name of artifactFiles(directory)) lines.push(`${await sha256File(join(directory, name))}  ${name}`)
    const fd = openSync(join(directory, 'SHA256SUMS'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeSync(fd, lines.join('\n') + '\n') } finally { closeSync(fd) }
    runtime.out(`Artefakte: ${directory} (SHA256SUMS)`)
    for (const line of lines) runtime.out(`  ${line}`)
}

async function download(runtime: Runtime, url: string, target: string, expectedSha256: string | null): Promise<string> {
    runtime.out(`Download: ${url}`)
    if (runtime.dryRun) return expectedSha256 ?? 'dry-run'
    const response = await runtime.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) })
    if (!response.ok || !response.body) fail(`Download fehlgeschlagen (${response.status}).`)
    const partial = `${target}.${randomBytes(4).toString('hex')}.part`
    const hash = createHash('sha256')
    const file = createWriteStream(partial, { mode: 0o600, flags: 'wx' })
    await pipeline(Readable.fromWeb(response.body as never), async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk } }, file)
    const digest = hash.digest('hex')
    if (expectedSha256 && digest !== expectedSha256) fail(`Prüfsumme stimmt nicht (${digest}); die Datei bleibt zur Prüfung unter ${partial}.`)
    renameSync(partial, target)
    return digest
}

// ------------------------------------------------------------------ Hub context (Android licence acknowledgement)
export async function licenceAcknowledged(runtime: Runtime, flags: Flags): Promise<boolean> {
    if (runtime.env.HAPI_EVOLVED_PROXY === '1') {
        // Managed runner: only the human-set project setting counts; agent flags are ignored.
        const response = await runtime.fetch(new URL(`/api/evolved/projects/${encodeURIComponent(runtime.env.EVOLVED_PROJECT_ID ?? '')}/development/context`, runtime.env.HAPI_EVOLVED_URL ?? 'http://runner-proxy:3010'),
            { headers: { authorization: 'Bearer evolved-local' }, redirect: 'error', signal: AbortSignal.timeout(20_000) }).catch(() => null)
        const context = response?.ok ? await response.json().catch(() => null) as { settings?: { android?: { sdkLicensesAcknowledged?: unknown } } } | null : null
        return context?.settings?.android?.sdkLicensesAcknowledged === true
    }
    return flags['human-acknowledged-sdk-licenses'] === true
}

// ------------------------------------------------------------------ commands
type Flags = Record<string, string | true>

async function odooSource(runtime: Runtime, paths: Layout, flags: Flags) {
    const major = odooMajor(flagValue(flags, 'major')), odoo = paths.odoo(major)
    effects(runtime, ['lädt den öffentlichen Community-Quellcode (odoo/odoo, Branch ' + major + '.0, Tiefe 1)', `schreibt nur ${odoo.base}`])
    const git = systemTool(['/usr/bin/git']) ?? fail('git fehlt.')
    if (reusable(odoo.source)) {
        runtime.out(`${odoo.source} existiert bereits und wird nicht verändert.`)
    } else {
        ensureDirectory(runtime, paths, odoo.base)
        if (await execute(runtime, { argv: [git!, 'clone', '--depth', '1', '--branch', `${major}.0`, '--single-branch', '--no-tags', ODOO_REPOSITORY, odoo.source] }, 'git clone')) return 1
    }
    const head = runtime.dryRun ? null : spawnSync(git!, ['-C', odoo.source, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...BASE_ENV, HOME: '/nonexistent' } }).stdout.trim()
    if (head && /^[a-f0-9]{40}$/.test(head)) {
        writeManagedFile(paths, odoo.record, JSON.stringify({ repository: ODOO_REPOSITORY, branch: `${major}.0`, commit: head, recordedAt: runtime.now().toISOString() }, null, 2) + '\n')
        runtime.out(`Odoo ${major}.0 Commit: ${head} (in ${odoo.record} festgehalten)`)
    }
    return 0
}

async function odooVenv(runtime: Runtime, paths: Layout, flags: Flags) {
    const major = odooMajor(flagValue(flags, 'major')), odoo = paths.odoo(major)
    const requirements = join(odoo.source, 'requirements.txt')
    if (!runtime.dryRun && !existsSync(requirements)) fail(`${requirements} fehlt; zuerst „hapi-dev odoo source --major ${major}“.`)
    effects(runtime, ['lädt Python-Pakete aus PyPI', `installiert nur in ${odoo.venv}`, 'baut psycopg2/python-ldap mit den Systemheadern'])
    const python = systemTool(['/usr/bin/python3']) ?? fail('python3 fehlt.')
    ensureDirectory(runtime, paths, odoo.base)
    if (!reusable(odoo.venv)) {
        if (await execute(runtime, { argv: [python!, '-m', 'venv', odoo.venv] }, 'venv')) return 1
    } else runtime.out(`${odoo.venv} existiert bereits; es wird nur nachinstalliert.`)
    const pip = join(odoo.venv, 'bin/python')
    // The runner's /tmp is a small tmpfs; build psycopg2/python-ldap in the project instead.
    const buildTemp = join(paths.toolchain, 'tmp')
    ensureDirectory(runtime, paths, buildTemp)
    if (await execute(runtime, { argv: [pip, '-m', 'pip', 'install', '--disable-pip-version-check', '--require-virtualenv', '-r', requirements], env: { TMPDIR: buildTemp, PIP_NO_INPUT: '1' } }, 'pip install')) return 1
    if (!runtime.dryRun) writeManagedFile(paths, join(odoo.venv, '.hapi-requirements'), `requirements.txt sha256 ${await sha256File(requirements)} installiert ${runtime.now().toISOString()}\n`)
    return 0
}

export function odooTestArgv(paths: Layout, major: 19 | 20, repository: string, addons: string[], modules: string[], database: string, port: number, httpPort = 8069): string[] {
    const odoo = paths.odoo(major)
    const addonsPath = [...addons.map(path => path === '.' ? repository : join(repository, path)), join(odoo.source, 'addons')].join(',')
    return [join(odoo.venv, 'bin/python'), join(odoo.source, 'odoo-bin'), `--addons-path=${addonsPath}`, `--data-dir=${odoo.data}`,
        `--db_host=${paths.pg.run}`, `--db_port=${port}`, '--db_user=odoo', '-d', database, '-i', modules.join(','),
        '--test-tags', modules.map(module => `/${module}`).join(','), '--stop-after-init', '--log-level=test', '--max-cron-threads=0', `--http-port=${httpPort}`]
}

function addonsList(value: string | undefined): string[] {
    const list = (value ?? '.').split(',').filter(Boolean)
    // Same rule as the project settings (shared RepoSubdirectorySchema).
    if (!list.length || list.length > 16 || !list.every(path => RepoSubdirectorySchema.safeParse(path).success)) fail('--addons braucht repository-relative Pfade (z. B. addons,custom), ohne ..')
    return [...new Set(list)]
}

async function odooTest(runtime: Runtime, paths: Layout, flags: Flags) {
    const major = odooMajor(flagValue(flags, 'major')), modules = moduleList(flagValue(flags, 'modules')), database = databaseName(flagValue(flags, 'db-slug') ?? 'dev')
    const repository = insideProject(paths.projectRoot, flagValue(flags, 'repository'), '--repository'), addons = addonsList(flagValue(flags, 'addons'))
    for (const path of addons) if (path !== '.') insideProject(paths.projectRoot, join(repository, path), `Addons-Pfad ${path}`)
    if (!runtime.dryRun && !existsSync(join(paths.pg.run, `.s.PGSQL.${POSTGRES_PORT}`))) fail('Der Projekt-PostgreSQL läuft nicht; zuerst „hapi-dev postgres start“.')
    effects(runtime, ['führt Projekt- und Odoo-Code aus', `legt bei Bedarf die lokale Wegwerf-Datenbank ${database} an`, 'schreibt Logs unter .hapi/.cache/artifacts/odoo'])
    const artifacts = artifactDirectory(runtime, paths, 'odoo'), log = join(artifacts, 'test.log')
    const httpPort = flagValue(flags, 'http-port') ?? '8069'
    if (!/^[0-9]{4,5}$/.test(httpPort) || Number(httpPort) < 1024 || Number(httpPort) > 65535) fail('--http-port muss zwischen 1024 und 65535 liegen.')
    const code = await execute(runtime, { argv: odooTestArgv(paths, major, repository, addons, modules, database, 5432, Number(httpPort)), cwd: repository, log }, 'Odoo-Tests')
    if (!runtime.dryRun) {
        const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
        const summary = { exitCode: code, database, modules, major, failedLines: (text.match(/^.* (?:ERROR|CRITICAL) .*$/gm) ?? []).length,
            result: text.match(/[0-9]+ failed, [0-9]+ error\(s\) of [0-9]+ tests[^\n]*/g)?.slice(-1)[0] ?? null }
        writeManagedFile(paths, join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
        runtime.out(`Ergebnis: ${summary.result ?? 'keine Testzusammenfassung im Log'}; Exit-Code ${code}.`)
    }
    await writeChecksums(runtime, artifacts)
    return code
}

async function odooUpgradeDryRun(runtime: Runtime, paths: Layout, flags: Flags) {
    const repository = insideProject(paths.projectRoot, flagValue(flags, 'repository'), '--repository'), addons = addonsList(flagValue(flags, 'addons'))
    const from = flagValue(flags, 'from') ?? '19.0', to = flagValue(flags, 'to') ?? '20.0'
    if (!/^(?:1[0-9]|20)\.0$/.test(from) || !/^(?:1[0-9]|20)\.0$/.test(to)) fail('--from/--to wie 19.0 und 20.0 angeben.')
    const major = odooMajor(to.split('.')[0]), odoo = paths.odoo(major)
    effects(runtime, ['liest Projektmodule und führt das Odoo-Upgrade-Skript im Probelauf aus (--dry-run, keine Dateiänderung)', 'upstream analysiert zusätzlich die Odoo-Kernmodule des Addons-Pfads', 'schreibt das Log unter .hapi/.cache/artifacts/odoo'])
    const artifacts = artifactDirectory(runtime, paths, 'odoo'), log = join(artifacts, 'upgrade-dry-run.log')
    const addonsPath = addons.map(path => path === '.' ? repository : join(repository, path)).join(',')
    const code = await execute(runtime, { argv: [join(odoo.venv, 'bin/python'), join(odoo.source, 'odoo-bin'), 'upgrade_code', `--addons-path=${addonsPath}`, '--from', from, '--to', to, '--dry-run'], cwd: repository, log }, 'upgrade_code --dry-run', [1])
    if (!runtime.dryRun) {
        const outcome = upgradeDryRunOutcome(code, existsSync(log) ? readFileSync(log, 'utf8') : '')
        writeManagedFile(paths, join(artifacts, 'summary.json'), JSON.stringify({ exitCode: code, outcome, from, to }, null, 2) + '\n')
        runtime.out(UPGRADE_OUTCOME_TEXT[outcome])
    }
    await writeChecksums(runtime, artifacts)
    return code
}

/**
 * odoo/cli/upgrade_code.py (20.0) ends with sys.exit(int(is_dirty)): exit 1 in --dry-run means
 * "changes would be made", not a broken tool. An uncaught exception also exits 1, so a traceback in
 * the log keeps it a failure. Exit codes are passed through unchanged.
 */
export function upgradeDryRunOutcome(code: number, log: string): 'clean' | 'changes_proposed' | 'failed' {
    if (code === 0) return 'clean'
    if (code === 1 && !/^Traceback \(most recent call last\):/m.test(log)) return 'changes_proposed'
    return 'failed'
}
const UPGRADE_OUTCOME_TEXT = {
    clean: 'Probelauf: keine Änderungen vorgeschlagen (Exit 0). Es wurden keine Dateien verändert.',
    changes_proposed: 'Probelauf: Änderungen vorgeschlagen (Exit 1 bedeutet bei upgrade_code „würde Dateien ändern“). Es wurden keine Dateien verändert; Vorschläge stehen im Log.',
    failed: '✗ upgrade_code ist fehlgeschlagen (Traceback oder unerwarteter Exit-Code); das Log enthält die Ursache.',
} as const

const POSTGRES_MARKER = '# HAPI-eVolved: project-local cluster, Unix socket only (no TCP).'
export function postgresConfig(paths: Layout): string {
    return `\n${POSTGRES_MARKER}\nlisten_addresses = ''\nunix_socket_directories = '${paths.pg.run}'\nunix_socket_permissions = 0700\nport = ${POSTGRES_PORT}\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`
}
/**
 * Server options forced on every start. Command-line settings take precedence over postgresql.conf,
 * include files and postgresql.auto.conf, so a later `listen_addresses = '*'` cannot open TCP.
 * pg_ctl passes -o through /bin/sh; the socket path is validated to [A-Za-z0-9._/-] first.
 */
export function postgresServerOptions(paths: Layout): string {
    if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(paths.pg.run)) fail('Der Socket-Pfad enthält unzulässige Zeichen.')
    return `-c listen_addresses='' -c unix_socket_directories=${paths.pg.run} -c unix_socket_permissions=0700 -c port=${POSTGRES_PORT}`
}

export const NSS_WRAPPER_LIBRARIES = ['/usr/lib/x86_64-linux-gnu/libnss_wrapper.so', '/usr/lib/aarch64-linux-gnu/libnss_wrapper.so', '/usr/lib/libnss_wrapper.so']
export type Identity = { uid: number; gid: number; passwd: string; libraries: readonly string[]; trusted?: (path: string) => boolean }
function currentIdentity(): Identity {
    let passwd = ''
    try { passwd = readFileSync('/etc/passwd', 'utf8') } catch {}
    return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, passwd, libraries: NSS_WRAPPER_LIBRARIES }
}
function trustedLibrary(path: string): boolean {
    try {
        const real = realpathSync(path), info = statSync(real)
        return info.isFile() && (info.mode & 0o022) === 0 && (info.uid === 0 || info.uid === 65534) && real.startsWith('/usr/lib/')
    } catch { return false }
}
/**
 * initdb/postgres refuse to run when the effective UID has no passwd entry (arbitrary runner UIDs).
 * Like the official postgres image entrypoint, provide one through nss_wrapper — only in the environment
 * of the PostgreSQL helper processes, with passwd/group files owned by the project, never globally.
 */
export function postgresEnvironment(runtime: Runtime, paths: Layout, identity: Identity = currentIdentity()): Record<string, string> {
    if (identity.uid < 0 || identity.passwd.split('\n').some(line => line.split(':')[2] === String(identity.uid))) return {}
    const library = identity.libraries.find(identity.trusted ?? trustedLibrary)
    if (!library) fail(`Die Benutzer-ID ${identity.uid} hat keinen Eintrag in /etc/passwd, und libnss_wrapper fehlt. PostgreSQL braucht einen Benutzereintrag; bitte das Development-Image verwenden.`)
    const directory = join(paths.pg.base, 'nss')
    const passwd = join(directory, 'passwd'), group = join(directory, 'group')
    if (!runtime.dryRun) {
        ensureDirectory(runtime, paths, directory)
        writeManagedFile(paths, passwd, `hapi:x:${identity.uid}:${identity.gid}:HAPI PostgreSQL:${paths.pg.base}:/usr/sbin/nologin\n`)
        writeManagedFile(paths, group, `hapi:x:${identity.gid}:\n`)
    }
    return { LD_PRELOAD: library!, NSS_WRAPPER_PASSWD: passwd, NSS_WRAPPER_GROUP: group }
}

/** complete = initialised by this helper (PG_VERSION plus HAPI socket block); otherwise never reused silently. */
function clusterState(paths: Layout): 'missing' | 'complete' | 'incomplete' {
    const info = lstatOrNull(paths.pg.data)
    if (!info) return 'missing'
    if (info.isSymbolicLink() || !info.isDirectory()) return 'incomplete'
    try {
        return existsSync(join(paths.pg.data, 'PG_VERSION')) && readFileSync(join(paths.pg.data, 'postgresql.conf'), 'utf8').includes(POSTGRES_MARKER) ? 'complete' : 'incomplete'
    } catch { return 'incomplete' }
}
const INCOMPLETE_CLUSTER = (paths: Layout) => `${paths.pg.data} existiert, ist aber kein vollständig von HAPI eingerichteter Cluster (PG_VERSION oder HAPI-Socketblock fehlt). Es wird nichts gelöscht; bitte prüfen und den Ordner bei Bedarf selbst umbenennen.`

async function postgres(runtime: Runtime, paths: Layout, action: string | undefined, identity?: Identity) {
    const bin = postgresBin(13)
    const socket = join(paths.pg.run, `.s.PGSQL.${POSTGRES_PORT}`)
    if (Buffer.byteLength(socket) > 107) fail('Der Socket-Pfad ist für Unix-Sockets zu lang (max. 107 Bytes).')
    if (paths.pg.run !== join(paths.pg.base, 'run')) runtime.out(`Hinweis: Der Projektpfad ist für einen Unix-Socket zu lang; der Socket liegt im privaten Runner-Ordner ${paths.pg.run}.`)
    const pgCtl = [join(bin, 'pg_ctl'), '-D', paths.pg.data]
    const env = () => postgresEnvironment(runtime, paths, identity)
    if (action === 'init') {
        effects(runtime, [`legt einen neuen Cluster nur in ${paths.pg.data} an (Benutzer odoo, nur lokaler Socket, TCP abgelehnt)`, 'fsync aus: nur für Wegwerf-Testdaten'])
        const state = clusterState(paths)
        if (state === 'complete') { runtime.out(`${paths.pg.data} ist bereits eingerichtet und wird wiederverwendet.`); return 0 }
        if (state === 'incomplete') fail(INCOMPLETE_CLUSTER(paths))
        ensureDirectory(runtime, paths, join(paths.pg.data, '..'))
        const code = await execute(runtime, { argv: [join(bin, 'initdb'), '-D', paths.pg.data, '--username=odoo', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale'], env: env() }, 'initdb')
        if (code) {
            if (exists(paths.pg.data)) runtime.out(INCOMPLETE_CLUSTER(paths))
            return code
        }
        if (!runtime.dryRun) {
            const config = join(paths.pg.data, 'postgresql.conf')
            const fd = openSync(config, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
            try { writeSync(fd, postgresConfig(paths)) } finally { closeSync(fd) }
        }
        return 0
    }
    if (action === 'start') {
        if (!runtime.dryRun && clusterState(paths) !== 'complete') fail(clusterState(paths) === 'missing' ? 'Kein Cluster; zuerst „hapi-dev postgres init“.' : INCOMPLETE_CLUSTER(paths))
        effects(runtime, ['startet den Projekt-Cluster im Hintergrund; listen_addresses, Socketordner und Port werden beim Start erzwungen (nur Unix-Socket)'])
        ensureDirectory(runtime, paths, paths.pg.run)
        if (!runtime.dryRun) spawnSync('/bin/chmod', ['0700', paths.pg.run])
        return execute(runtime, { argv: [...pgCtl, '-l', paths.pg.log, '-w', '-t', '60', '-o', postgresServerOptions(paths), 'start'], env: env() }, 'pg_ctl start')
    }
    if (action === 'stop') return execute(runtime, { argv: [...pgCtl, '-m', 'fast', '-w', 'stop'], env: env() }, 'pg_ctl stop')
    if (action === 'status') {
        const code = await execute(runtime, { argv: [...pgCtl, 'status'], env: env() }, 'pg_ctl status')
        if (code === 0) await execute(runtime, { argv: [join(bin, 'pg_isready'), '-h', paths.pg.run, '-p', String(POSTGRES_PORT), '-U', 'odoo'], env: env() }, 'pg_isready')
        return code
    }
    return fail('postgres init|start|stop|status')
}

async function database(runtime: Runtime, paths: Layout, action: string | undefined, rest: string[], flags: Flags) {
    const bin = postgresBin(13)
    if (action === 'list') {
        return execute(runtime, { argv: [join(bin, 'psql'), '-h', paths.pg.run, '-p', '5432', '-U', 'odoo', '-d', 'postgres', '-At', '-c', "SELECT datname FROM pg_database WHERE datname LIKE 'hapi\\_test\\_%' ORDER BY 1"], env: postgresEnvironment(runtime, paths) }, 'psql')
    }
    if (action === 'drop') {
        const name = databaseName(rest[0])
        if (flags.confirm !== name) fail(`Zum Löschen ausdrücklich --confirm ${name} angeben. Es werden nur hapi_test_*-Datenbanken des Projekt-Clusters gelöscht.`)
        effects(runtime, [`löscht die Wegwerf-Datenbank ${name} im Projekt-Cluster`])
        return execute(runtime, { argv: [join(bin, 'dropdb'), '-h', paths.pg.run, '-p', '5432', '-U', 'odoo', '--if-exists', name], env: postgresEnvironment(runtime, paths) }, 'dropdb')
    }
    return fail('db list | db drop <slug> --confirm hapi_test_<slug>')
}

function sdkmanager(paths: Layout) { return join(paths.android.sdk, 'cmdline-tools/latest/bin/sdkmanager') }
function androidEnv(paths: Layout): Record<string, string> {
    return { JAVA_HOME: javaHome(), ANDROID_HOME: paths.android.sdk, ANDROID_SDK_ROOT: paths.android.sdk, GRADLE_USER_HOME: paths.android.gradleHome, ANDROID_USER_HOME: join(paths.android.sdk, '.android') }
}

async function androidSdk(runtime: Runtime, paths: Layout, action: string | undefined, flags: Flags) {
    if (!await licenceAcknowledged(runtime, flags)) {
        fail('Ein Projektadmin muss die Android-SDK-Lizenzprüfung zuerst in den Projekteinstellungen (Entwicklung → Android) bestätigen. Agenten können das nicht.')
    }
    if (action === 'bootstrap') {
        const latest = join(paths.android.sdk, 'cmdline-tools/latest')
        effects(runtime, [`lädt die Android-cmdline-tools (${ANDROID_CMDLINE_TOOLS.url}, SHA-256 geprüft)`, `entpackt nach ${latest}`])
        if (reusable(latest)) { runtime.out(`${latest} existiert bereits und wird nicht verändert.`); return 0 }
        ensureDirectory(runtime, paths, paths.downloads)
        const archive = join(paths.downloads, ANDROID_CMDLINE_TOOLS.url.split('/').pop()!)
        if (!exists(archive)) await download(runtime, ANDROID_CMDLINE_TOOLS.url, archive, ANDROID_CMDLINE_TOOLS.sha256)
        else if (!runtime.dryRun && await sha256File(archive) !== ANDROID_CMDLINE_TOOLS.sha256) fail(`${archive} hat eine falsche Prüfsumme; bitte prüfen.`)
        const staging = join(paths.android.sdk, `.staging-${randomBytes(4).toString('hex')}`)
        ensureDirectory(runtime, paths, staging)
        const unzip = systemTool(['/usr/bin/unzip']) ?? fail('unzip fehlt.')
        const code = await execute(runtime, { argv: [unzip!, '-q', archive, '-d', staging] }, 'unzip')
        if (code) return code
        if (!runtime.dryRun) { ensureDirectory(runtime, paths, join(paths.android.sdk, 'cmdline-tools')); renameSync(join(staging, 'cmdline-tools'), latest) }
        runtime.out('Weiter: Lizenzen liest und bestätigt ein Mensch interaktiv mit „hapi-dev android sdk licenses“ im Projektterminal.')
        return 0
    }
    if (action === 'licenses') {
        if (!runtime.isTTY) fail('Lizenzen werden nur interaktiv von einem Menschen in einem Terminal angenommen, nie automatisch durch Agenten.')
        effects(runtime, ['zeigt die Android-SDK-Lizenzen; Annahme nur durch Ihre Eingabe'])
        return execute(runtime, { argv: [sdkmanager(paths), `--sdk_root=${paths.android.sdk}`, '--licenses'], env: androidEnv(paths), stdin: 'inherit' }, 'sdkmanager --licenses')
    }
    if (action === 'install') {
        if (!runtime.dryRun && !existsSync(join(paths.android.sdk, 'licenses/android-sdk-license'))) fail('Noch keine angenommene SDK-Lizenz; zuerst „hapi-dev android sdk licenses“ (interaktiv).')
        const compileSdk = flagValue(flags, 'compile-sdk'), buildTools = flagValue(flags, 'build-tools')
        if (!compileSdk || !/^[1-9][0-9]?$/.test(compileSdk)) fail('--compile-sdk <Level> angeben, z. B. 35.')
        if (buildTools !== undefined && !/^[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,2}$/.test(buildTools)) fail('--build-tools wie 35.0.0 angeben.')
        const packages = [`platforms;android-${compileSdk}`, ...(buildTools ? [`build-tools;${buildTools}`] : []), ...(flags['platform-tools'] ? ['platform-tools'] : []), ...(flags.emulator ? ['emulator'] : [])]
        effects(runtime, [`lädt SDK-Pakete (${packages.join(', ')}) in ${paths.android.sdk}`, 'neue, noch nicht angenommene Lizenzen führen zum Abbruch statt zur automatischen Annahme'])
        return execute(runtime, { argv: [sdkmanager(paths), `--sdk_root=${paths.android.sdk}`, '--install', ...packages], env: androidEnv(paths), stdin: 'ignore' }, 'sdkmanager --install')
    }
    return fail('android sdk bootstrap|licenses|install')
}

export function gradleTask(kind: string, module: string, variant: string): string {
    if (!GRADLE_MODULE.test(module)) fail('--module wie app oder :feature:login angeben.')
    if (!VARIANT.test(variant)) fail('--variant wie debug angeben.')
    const prefix = module.startsWith(':') ? module : `:${module}`, Variant = variant[0].toUpperCase() + variant.slice(1)
    if (kind === 'unit-test') return `${prefix}:test${Variant}UnitTest`
    if (kind === 'lint') return `${prefix}:lint${Variant}`
    if (kind === 'assemble') return `${prefix}:assemble${Variant}`
    return fail('android gradle unit-test|lint|assemble')
}

export const ARTIFACT_LIMITS = { files: 500, bytes: 2 * 1024 * 1024 * 1024 } as const
type CopyBudget = { files: number; bytes: number; truncated: boolean }
/**
 * Copies matching regular files from `from` to `to/<prefix>/<relative path>`, preserving the relative
 * structure (no flattening, so equal file names never collide), skipping links, with one total budget.
 */
function copyTree(runtime: Runtime, paths: Layout, from: string, to: string, prefix: string, filter: (name: string) => boolean, budget: CopyBudget, relativePath = '', depth = 0): string[] {
    const source = relativePath ? join(from, relativePath) : from
    const info = lstatOrNull(source)
    if (runtime.dryRun || depth > 8 || !info || info.isSymbolicLink() || !info.isDirectory()) return []
    const copied: string[] = []
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const child = relativePath ? `${relativePath}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { copied.push(...copyTree(runtime, paths, from, to, prefix, filter, budget, child, depth + 1)); continue }
        if (!entry.isFile() || !filter(entry.name)) continue
        const size = lstatSync(join(from, child)).size
        if (budget.files <= 0 || budget.bytes < size) { budget.truncated = true; continue }
        const target = join(to, prefix, child)
        ensureDirectory(runtime, paths, join(target, '..'))
        copyFileSync(join(from, child), target, constants.COPYFILE_EXCL)
        budget.files--; budget.bytes -= size
        copied.push(join(prefix, child))
    }
    return copied
}

/**
 * Output directories of one variant below build/outputs/apk: AGP writes output-metadata.json with
 * "variantName"; fall back to the standard layout (debug → debug/, freeDebug → free/debug/).
 */
export function apkOutputDirectories(apkRoot: string, variant: string): string[] {
    const found: string[] = []
    const visit = (relativePath: string, depth: number) => {
        if (depth > 4 || found.length >= 20) return
        const directory = relativePath ? join(apkRoot, relativePath) : apkRoot
        const info = lstatOrNull(directory)
        if (!info || info.isSymbolicLink() || !info.isDirectory()) return
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const child = relativePath ? `${relativePath}/${entry.name}` : entry.name
            if (entry.isDirectory()) visit(child, depth + 1)
            else if (entry.isFile() && entry.name === 'output-metadata.json') {
                try {
                    const metadata = JSON.parse(readFileSync(join(apkRoot, child), 'utf8')) as { variantName?: unknown }
                    if (metadata.variantName === variant) found.push(relativePath)
                } catch {}
            }
        }
    }
    visit('', 0)
    if (found.length) return found
    const buildType = /[A-Z][a-z0-9]*$/.exec(variant)?.[0]
    const conventional = buildType && buildType !== variant ? `${variant.slice(0, -buildType.length)}/${buildType.toLowerCase()}` : variant
    const info = lstatOrNull(join(apkRoot, conventional))
    return info?.isDirectory() && !info.isSymbolicLink() ? [conventional] : []
}

async function androidGradle(runtime: Runtime, paths: Layout, kind: string | undefined, flags: Flags) {
    const project = insideProject(paths.projectRoot, flagValue(flags, 'project'), '--project')
    const module = flagValue(flags, 'module') ?? 'app', variant = flagValue(flags, 'variant') ?? 'debug', task = gradleTask(kind ?? '', module, variant)
    // Release variants may use signing configuration and secrets; this helper only builds debug APKs.
    if (kind === 'assemble' && !isAndroidDebugVariant(variant)) fail('assemble baut nur Debug-Varianten (debug oder <flavor>Debug); Release-Builds und Signierung gehören nicht in diesen Helfer.')
    const gradlew = join(project, 'gradlew')
    if (!runtime.dryRun && (!existsSync(gradlew) || !lstatSync(gradlew).isFile())) fail('gradlew fehlt im Projektverzeichnis.')
    effects(runtime, ['führt Projekt-Buildskripte (Gradle) aus', 'lädt Gradle und Abhängigkeiten', `Cache in ${paths.android.gradleHome}`, 'Artefakte unter .hapi/.cache/artifacts/android'])
    ensureDirectory(runtime, paths, paths.android.gradleHome)
    const artifacts = artifactDirectory(runtime, paths, 'android'), log = join(artifacts, 'gradle.log')
    const code = await execute(runtime, { argv: ['/bin/sh', gradlew, '--no-daemon', '--console=plain', task], cwd: project, env: androidEnv(paths), log }, `Gradle ${task}`)
    const moduleDirectory = join(project, module.replace(/^:/, '').split(':').join('/'))
    const Variant = variant[0].toUpperCase() + variant.slice(1)
    const budget: CopyBudget = { ...ARTIFACT_LIMITS, truncated: false }
    let copied: string[] = []
    if (kind === 'assemble') {
        const apkRoot = join(moduleDirectory, 'build/outputs/apk')
        for (const directory of runtime.dryRun ? [] : apkOutputDirectories(apkRoot, variant)) {
            copied.push(...copyTree(runtime, paths, join(apkRoot, directory), artifacts, join('apk', directory), name => name.endsWith('.apk') || name === 'output-metadata.json', budget))
        }
    }
    if (kind === 'unit-test') copied = copyTree(runtime, paths, join(moduleDirectory, `build/test-results/test${Variant}UnitTest`), artifacts, 'test-results', name => name.endsWith('.xml'), budget)
    if (kind === 'lint') copied = copyTree(runtime, paths, join(moduleDirectory, 'build/reports'), artifacts, 'reports', name => /^lint-results.*\.(?:xml|html|sarif)$/.test(name), budget)
    if (budget.truncated) runtime.out(`Hinweis: Artefaktgrenze erreicht (${ARTIFACT_LIMITS.files} Dateien); nicht alles wurde kopiert.`)
    await writeChecksums(runtime, artifacts)
    if (!runtime.dryRun && code === 0 && kind === 'assemble' && !copied.some(path => path.endsWith('.apk'))) {
        runtime.out(`✗ Gradle meldete Erfolg, aber für die Variante ${variant} wurde kein APK unter ${join(moduleDirectory, 'build/outputs/apk')} gefunden. Kein Artefakt; bitte das Gradle-Log prüfen.`)
        return 3
    }
    if (!runtime.dryRun && code === 0 && !copied.length) runtime.out(`Hinweis: Keine ${kind === 'lint' ? 'Lint-Berichte' : 'JUnit-Berichte'} gefunden.`)
    return code
}

async function androidCli(runtime: Runtime, paths: Layout) {
    const target = join(paths.android.cli, 'android')
    effects(runtime, [`lädt die offizielle Android CLI von ${ANDROID_CLI_URL}`, 'Google veröffentlicht dafür keine Prüfsumme; HAPI hält die SHA-256 der geladenen Datei fest', 'keine globale Installation, keine Skills (android init wird nicht ausgeführt)'])
    if (exists(target)) { runtime.out(`${target} existiert bereits; zum Aktualisieren „${target} update --no-metrics“.`); return 0 }
    ensureDirectory(runtime, paths, paths.android.cli)
    const digest = await download(runtime, ANDROID_CLI_URL, target, null)
    if (!runtime.dryRun) {
        statSync(target)
        spawnSync('/bin/chmod', ['0700', target])
        writeManagedFile(paths, join(paths.android.cli, 'install.json'), JSON.stringify({ url: ANDROID_CLI_URL, sha256: digest, publishedChecksum: false, installedAt: runtime.now().toISOString() }, null, 2) + '\n')
    }
    runtime.out(`SHA-256: ${digest}. Aufrufe immer mit --no-metrics, z. B. „${target} --no-metrics docs search <Begriff>“.`)
    return 0
}

function selectSwift(runtime: Runtime, paths: Layout, version: string): number {
    if (!runtime.dryRun) writeManagedFile(paths, join(paths.swift, 'current.json'), JSON.stringify({ version, selectedAt: runtime.now().toISOString() }, null, 2) + '\n')
    runtime.out(`Aktive Swift-Version: ${version} (${join(paths.swift, 'current.json')})`)
    return 0
}
/** Swift binary of the version recorded in swift/current.json, if installed. */
export function projectSwift(paths: Layout): string | null {
    try {
        const version = JSON.parse(readFileSync(join(paths.swift, 'current.json'), 'utf8')).version
        if (typeof version !== 'string' || !/^[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/.test(version)) return null
        const resolved = resolveSwiftBinary(join(paths.swift, version))
        return resolved.ok ? resolved.binary : null
    } catch { return null }
}

export function swiftPlatform(osRelease: string, arch: string): { directory: string; suffix: string } {
    const id = /^ID=("?)([a-z]+)\1$/m.exec(osRelease)?.[2], version = /^VERSION_ID="?([0-9.]+)"?$/m.exec(osRelease)?.[1]
    const platform = id === 'debian' && (version === '12' || version === '13') ? `debian${version}`
        : id === 'ubuntu' && (version === '22.04' || version === '24.04') ? `ubuntu${version}` : null
    if (!platform) return fail('Für dieses Betriebssystem bietet hapi-dev keine geprüfte Swift-Toolchain an (Debian 12/13, Ubuntu 22.04/24.04).')
    if (arch !== 'x64' && arch !== 'arm64') fail('Nur x86_64 und aarch64 werden unterstützt.')
    const aarch = arch === 'arm64' ? '-aarch64' : ''
    return { directory: `${platform.replace('.', '')}${aarch}`, suffix: `${platform}${aarch}` }
}
export function swiftUrls(version: string, platform: { directory: string; suffix: string }) {
    if (!/^[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/.test(version)) fail('--version wie 6.4.1 angeben.')
    const tarball = `https://download.swift.org/swift-${version}-release/${platform.directory}/swift-${version}-RELEASE/swift-${version}-RELEASE-${platform.suffix}.tar.gz`
    return { tarball, signature: `${tarball}.sig` }
}

async function swift(runtime: Runtime, paths: Layout, action: string | undefined, flags: Flags) {
    if (action === 'install') {
        const version = flagValue(flags, 'version') ?? SWIFT_DEFAULT_VERSION
        const urls = swiftUrls(version, swiftPlatform(readFileSync('/etc/os-release', 'utf8'), process.arch))
        effects(runtime, [`lädt die Swift-Toolchain ${version} von swift.org`, 'prüft die PGP-Signatur mit den Schlüsseln von swift.org und bricht sonst ab', `entpackt nach ${paths.swift}`, 'unter Linux nur portable Swift-Pakete, keine iOS-Apps'])
        const target = join(paths.swift, version)
        if (reusable(target)) { runtime.out(`${target} existiert bereits und wird nicht verändert.`); return selectSwift(runtime, paths, version) }
        ensureDirectory(runtime, paths, paths.downloads)
        const tarball = join(paths.downloads, urls.tarball.split('/').pop()!), signature = `${tarball}.sig`, keys = join(paths.downloads, 'swift-all-keys.asc')
        const digest = exists(tarball) && !runtime.dryRun ? await sha256File(tarball) : await download(runtime, urls.tarball, tarball, null)
        if (!exists(signature)) await download(runtime, urls.signature, signature, null)
        if (!exists(keys)) await download(runtime, SWIFT_KEYS_URL, keys, null)
        const gpg = systemTool(['/usr/bin/gpg']) ?? fail('gpg fehlt.')
        const home = join(paths.downloads, `.gnupg-${randomBytes(4).toString('hex')}`)
        ensureDirectory(runtime, paths, home)
        if (await execute(runtime, { argv: [gpg!, '--batch', '--homedir', home, '--import', keys] }, 'gpg --import')) return 1
        if (await execute(runtime, { argv: [gpg!, '--batch', '--homedir', home, '--verify', signature, tarball] }, 'gpg --verify')) { runtime.out('Signatur ungültig: Installation abgebrochen.'); return 1 }
        const staging = join(paths.swift, `.staging-${randomBytes(4).toString('hex')}`)
        ensureDirectory(runtime, paths, staging)
        const tar = systemTool(['/usr/bin/tar', '/bin/tar']) ?? fail('tar fehlt.')
        if (await execute(runtime, { argv: [tar!, '-xzf', tarball, '-C', staging, '--strip-components=1', '--no-same-owner'] }, 'tar')) return 1
        if (!runtime.dryRun) {
            renameSync(staging, target)
            writeManagedFile(paths, join(target, '.hapi-install.json'), JSON.stringify({ version, url: urls.tarball, sha256: digest, signature: 'verified', installedAt: runtime.now().toISOString() }, null, 2) + '\n')
        }
        runtime.out(`Swift ${version} installiert: ${join(target, 'usr/bin/swift')}`)
        return selectSwift(runtime, paths, version)
    }
    if (action === 'test') {
        const packageDirectory = insideProject(paths.projectRoot, flagValue(flags, 'package'), '--package')
        if (!runtime.dryRun && !existsSync(join(packageDirectory, 'Package.swift'))) fail('Package.swift fehlt im angegebenen Verzeichnis.')
        // The toolchain recorded in swift/current.json (installed by this helper) wins; otherwise a system Swift.
        const binary = projectSwift(paths) ?? systemTool(['/usr/bin/swift']) ?? fail('Keine Swift-Toolchain; zuerst „hapi-dev swift install“.')
        runtime.out(`Swift: ${binary}`)
        effects(runtime, ['baut und testet das Swift-Paket (führt Projektcode aus)', 'Targets mit UIKit/SwiftUI sind unter Linux nicht baubar', 'Log unter .hapi/.cache/artifacts/ios'])
        const artifacts = artifactDirectory(runtime, paths, 'ios'), log = join(artifacts, 'swift-test.log')
        const scratch = join(paths.toolchain, 'swift/build', createHash('sha256').update(packageDirectory).digest('hex').slice(0, 16))
        ensureDirectory(runtime, paths, scratch)
        // SwiftPM compiles and executes the manifest from TMPDIR; the runner's /tmp tmpfs is noexec.
        const buildTemp = join(paths.toolchain, 'tmp')
        ensureDirectory(runtime, paths, buildTemp)
        const code = await execute(runtime, { argv: [binary!, 'test', '--package-path', packageDirectory, '--scratch-path', scratch], cwd: packageDirectory, log, env: { TMPDIR: buildTemp } }, 'swift test')
        await writeChecksums(runtime, artifacts)
        return code
    }
    return fail('swift install [--version X.Y.Z] | swift test --package <dir>')
}

// ------------------------------------------------------------------ entry
export const USAGE = `hapi-dev – geprüfte Einrichtungs- und Testhelfer für HAPI-eVolved-Entwicklungsmodi

Allgemein: [--project-root <dir>] [--dry-run]   (Standard: EVOLVED_RUNNER_ROOT)
  paths
  odoo source --major 19|20
  odoo venv --major 19|20
  odoo test --major 19|20 --repository <checkout> --modules a,b [--addons addons,custom] [--db-slug dev] [--http-port 8069]
  odoo upgrade-dry-run --repository <checkout> [--addons …] [--from 19.0 --to 20.0]
  postgres init|start|stop|status
  db list | db drop <slug> --confirm hapi_test_<slug>
  android sdk bootstrap|licenses|install --compile-sdk 35 [--build-tools 35.0.0] [--platform-tools] [--emulator]
  android gradle unit-test|lint|assemble --project <checkout>/<dir> [--module :app] [--variant debug]
  android cli install
  swift install [--version ${SWIFT_DEFAULT_VERSION}]
  swift test --package <dir>

Alles landet unter <projekt>/.hapi/.cache/toolchain bzw. .hapi/.cache/artifacts. Vorhandene Ordner werden nie ersetzt oder gelöscht.`

const BOOLEAN_FLAGS = new Set(['dry-run', 'platform-tools', 'emulator', 'human-acknowledged-sdk-licenses', 'help'])
export function parse(argv: string[]): { positional: string[]; flags: Flags } {
    const positional: string[] = [], flags: Flags = {}
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]
        if (!arg.startsWith('--')) { positional.push(arg); continue }
        const name = arg.slice(2)
        if (!/^[a-z][a-z-]{0,40}$/.test(name) || Object.hasOwn(flags, name)) fail(`Unbekannte oder doppelte Option ${arg.slice(0, 40)}`)
        if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue }
        const value = argv[++index]
        if (value === undefined || value.startsWith('--')) fail(`Option ${arg} braucht einen Wert.`)
        flags[name] = value
    }
    return { positional, flags }
}
function flagValue(flags: Flags, name: string): string | undefined {
    const value = flags[name]
    return typeof value === 'string' ? value : undefined
}

export async function main(argv: string[], runtimeFactory: (dryRun: boolean) => Runtime = defaultRuntime, identity?: Identity): Promise<number> {
    const { positional, flags } = parse(argv)
    if (flags.help || positional.length === 0) { console.log(USAGE); return 0 }
    const runtime = runtimeFactory(flags['dry-run'] === true)
    const paths = layout(projectRoot(flagValue(flags, 'project-root'), runtime.env))
    const [group, action, ...rest] = positional
    if (group === 'paths') { runtime.out(JSON.stringify({ ...paths, odoo: { 19: paths.odoo(19), 20: paths.odoo(20) } }, null, 2)); return 0 }
    if (group === 'odoo' && action === 'source') return odooSource(runtime, paths, flags)
    if (group === 'odoo' && action === 'venv') return odooVenv(runtime, paths, flags)
    if (group === 'odoo' && action === 'test') return odooTest(runtime, paths, flags)
    if (group === 'odoo' && action === 'upgrade-dry-run') return odooUpgradeDryRun(runtime, paths, flags)
    if (group === 'postgres') return postgres(runtime, paths, action, identity)
    if (group === 'db') return database(runtime, paths, action, rest, flags)
    if (group === 'android' && action === 'sdk') return androidSdk(runtime, paths, rest[0], flags)
    if (group === 'android' && action === 'gradle') return androidGradle(runtime, paths, rest[0], flags)
    if (group === 'android' && action === 'cli' && rest[0] === 'install') return androidCli(runtime, paths)
    if (group === 'swift') return swift(runtime, paths, action, flags)
    return fail('Unbekannter Befehl. hapi-dev --help')
}

if (import.meta.main) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
        console.error(error instanceof UsageError ? error.message : `Fehler: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 2
    })
}
