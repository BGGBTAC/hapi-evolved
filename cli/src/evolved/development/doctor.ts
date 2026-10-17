import { realpath } from 'node:fs/promises'
import { containsCredential } from '@hapi/protocol/evolvedSourcePolicy'
import {
    DEVELOPMENT_CONTRACT_VERSION,
    type DevelopmentDoctorCheck,
    type DevelopmentDoctorResult,
    type DevelopmentSettings,
    type SpecializedDevelopmentMode,
} from '@hapi/protocol/evolvedDevelopment'
import { readGitHead } from './inspect'
import { ACCESS, compareVersions, createProbeSystem, findTrusted, firstLine, parseVersion, type ProbeSystem, type TrustedExecutable } from './probes'
import { joinRelative, SafeTree } from './safeTree'
import { odooToolchain, toolchainPaths } from './layout'
import { resolveSwiftBinary, SWIFT_BINARY_PROBLEM } from './swiftToolchain'

type Check = DevelopmentDoctorCheck
type Category = Check['category']
type Remedy = NonNullable<Check['remedy']>

export const DOCTOR_TOTAL_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 4_000

/** Requirements per Odoo series from odoo/release.py (verified 2026-10-17); a cloned source overrides them. */
export const ODOO_REQUIREMENTS = {
    19: { python: { min: [3, 10], max: [3, 14] }, postgresql: 13 },
    20: { python: { min: [3, 12], max: [3, 14] }, postgresql: 16 },
} as const

const DOCS = {
    xcodeCloud: 'https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow',
    xcode: 'https://developer.apple.com/xcode/system-requirements/',
    emulator: 'https://developer.android.com/studio/run/emulator-acceleration',
    sdkmanager: 'https://developer.android.com/tools/sdkmanager',
    jdks: 'https://developer.android.com/build/jdks',
    androidCli: 'https://developer.android.com/tools/agents/android-cli',
    swift: 'https://www.swift.org/install/linux/',
    odooSource: 'https://www.odoo.com/documentation/20.0/administration/on_premise/source.html',
    wkhtmltopdf: 'https://github.com/wkhtmltopdf/packaging/releases',
} as const

export type DoctorInput = {
    mode: SpecializedDevelopmentMode
    settings: DevelopmentSettings
    /** Project root (EVOLVED_RUNNER_ROOT). Toolchains live below `<root>/${DEVELOPMENT_TOOLCHAIN_DIRECTORY}`. */
    projectRoot: string | null
    /** Authorised checkout directory, or null when no repository is bound. */
    checkout: string | null
    /** Requested check ids; empty = default set for the mode. */
    checks: readonly string[]
    /** ANDROID_HOME / ANDROID_SDK_ROOT of the runner process; values are paths only and never reported. */
    androidSdkEnvironment?: Readonly<Record<string, string | undefined>>
    system?: ProbeSystem
    now?: () => number
    imageMarkerPath?: string
    deadlineMs?: number
}

type Context = Omit<DoctorInput, 'system' | 'now'> & { system: ProbeSystem; deadline: number; cache: Map<string, Promise<unknown>> }
type Probe = { label: string; category: Category; modes: readonly SpecializedDevelopmentMode[] | 'all'; run: (context: Context) => Promise<Omit<Check, 'id' | 'label' | 'category'>> }

const clean = (value: string, max: number) => {
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, max)
    return containsCredential(text) ? '[zurückgehalten]' : text
}
const recipe = (recipeId: string, text: string): Remedy => ({ kind: 'recipe', recipeId, text })
const operator = (text: string): Remedy => ({ kind: 'operator', text })
const manual = (text: string, url?: string): Remedy => url ? { kind: 'manual', text, url } : { kind: 'manual', text }
const docs = (text: string, url: string): Remedy => ({ kind: 'docs', text, url })
const IMAGE_HINT = 'Der Betreiber kann das optionale Development-Image (deploy/evolved/Runner.development.Dockerfile) für diesen Runner bauen und taggen.'

function memo<T>(context: Context, key: string, factory: () => Promise<T>): Promise<T> {
    if (!context.cache.has(key)) context.cache.set(key, factory())
    return context.cache.get(key) as Promise<T>
}

async function versionOf(context: Context, executable: TrustedExecutable, argv: readonly string[], pattern?: RegExp): Promise<string | null> {
    const remaining = context.deadline - Date.now()
    if (remaining <= 50) return null
    const output = await context.system.run(executable, argv, { timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining), maxBytes: 16 * 1024 })
    // A version banner from a failing process is not evidence of a working tool.
    if (!output.ok || output.code !== 0) return null
    const combined = `${output.stdout}\n${output.stderr}`
    if (pattern) { const match = pattern.exec(combined); return match ? clean(match[1] ?? match[0], 120) : null }
    const line = firstLine(combined)
    return line ? clean(line, 120) : null
}

async function tool(context: Context, name: string, extra: readonly string[] = []) {
    return memo(context, `tool:${name}`, () => findTrusted(context.system, name, extra))
}


async function projectTree(context: Context, relative: string): Promise<SafeTree | null> {
    if (!context.projectRoot) return null
    return memo(context, `tree:${relative}`, async () => {
        const tree = await SafeTree.open(relative ? `${context.projectRoot}/${relative}` : context.projectRoot!, { reads: 200, bytes: 8 * 1024 * 1024, entries: 5000 })
        return typeof tree === 'string' ? null : tree
    })
}

async function checkoutTree(context: Context): Promise<SafeTree | 'unbound' | 'missing' | 'blocked'> {
    if (!context.checkout) return 'unbound'
    return memo(context, 'checkout', async () => {
        const tree = await SafeTree.open(context.checkout!, { reads: 200, bytes: 8 * 1024 * 1024, entries: 5000 })
        return tree === 'missing' ? 'missing' : typeof tree === 'string' ? 'blocked' : tree
    })
}

function odooMajor(context: Context): 19 | 20 | null { return context.settings.odoo?.major ?? null }

/** Read a few `KEY = value` constants from odoo/release.py without importing it. */
async function odooRelease(context: Context): Promise<{ major: number | null; minPython: number[] | null; maxPython: number[] | null; minPostgres: number | null; head: string | null; branch: string | null } | null> {
    const major = odooMajor(context)
    if (!major) return null
    return memo(context, 'odoo-release', async () => {
        const tree = await projectTree(context, odooToolchain(major).source)
        if (!tree) return null
        const release = await tree.readText('odoo/release.py', 64 * 1024)
        if (!release.ok) return null
        const tuple = (name: string) => {
            const match = new RegExp(`^${name}\\s*=\\s*\\(([^)\\n]{1,80})\\)`, 'm').exec(release.text)
            return match ? match[1].split(',').map(part => part.trim()).filter(part => /^[0-9]+$/.test(part)).map(Number) : null
        }
        const version = tuple('version_info')
        const pg = /^MIN_PG_VERSION\s*=\s*([0-9]{1,3})\s*$/m.exec(release.text)?.[1]
        const git = await readGitHead(tree)
        return { major: version?.[0] ?? null, minPython: tuple('MIN_PY_VERSION'), maxPython: tuple('MAX_PY_VERSION'), minPostgres: pg ? Number(pg) : null, head: git.head, branch: git.branch }
    })
}

async function requirements(context: Context) {
    const major = odooMajor(context)
    if (!major) return null
    const release = await odooRelease(context)
    const fallback = ODOO_REQUIREMENTS[major]
    const fromSource = release && release.major === major
    return {
        major,
        source: fromSource ? 'odoo/release.py im Projekt' : 'HAPI-Handbuch (Stand 2026-10-17)',
        pythonMin: fromSource && release.minPython ? release.minPython : [...fallback.python.min],
        pythonMax: fromSource && release.maxPython ? release.maxPython : [...fallback.python.max],
        postgres: fromSource && release.minPostgres ? release.minPostgres : fallback.postgresql,
    }
}

async function systemPython(context: Context) {
    return memo(context, 'python', async () => {
        const executable = await tool(context, 'python3')
        if (!executable) return null
        const version = await versionOf(context, executable, ['-I', '-S', '-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], /^([0-9]+\.[0-9]+\.[0-9]+)$/m)
        return { executable, version }
    })
}

async function postgresServer(context: Context) {
    return memo(context, 'postgres', async () => {
        const directories = (await context.system.list('/usr/lib/postgresql')).filter(name => /^[0-9]{2}$/.test(name)).sort((left, right) => Number(right) - Number(left))
        for (const major of directories) {
            const postgres = await context.system.trusted(`/usr/lib/postgresql/${major}/bin/postgres`)
            const initdb = await context.system.trusted(`/usr/lib/postgresql/${major}/bin/initdb`)
            const pgCtl = await context.system.trusted(`/usr/lib/postgresql/${major}/bin/pg_ctl`)
            if (postgres && initdb && pgCtl) return { major: Number(major), postgres, version: await versionOf(context, postgres, ['--version'], /PostgreSQL\)?\s+([0-9]+(?:\.[0-9]+)?)/) }
        }
        return null
    })
}

const PROBES: Record<string, Probe> = {
    'image.marker': {
        label: 'Runner-Image', category: 'image', modes: 'all',
        run: async context => {
            const marker = await readImageMarker(context)
            if (!marker) return { state: 'warning', detail: 'Kein Image-Marker (/etc/hapi-runner-image): vermutlich das Basis-Image. Die Werkzeuge werden trotzdem einzeln geprüft.', remedy: operator(IMAGE_HINT) }
            return { state: 'ready', version: clean(`${marker.variant ?? 'unbekannt'} (Schema ${marker.schema ?? '?'})`, 120), detail: clean(`Image-Marker: ${Object.entries(marker).map(([key, value]) => `${key}=${value}`).join(', ')}. Nur ein Hinweis; Werkzeuge werden einzeln geprüft.`, 500) }
        },
    },
    'repository.checkout': {
        label: 'Gebundener Repository-Checkout', category: 'project', modes: 'all',
        run: async context => {
            const tree = await checkoutTree(context)
            if (typeof tree === 'string') return repositoryState(tree)
            const git = await readGitHead(tree)
            if (await tree.kind('.git') !== 'directory') return { state: 'warning', detail: 'Der Checkout hat kein normales .git-Verzeichnis.' }
            return { state: 'ready', version: git.head ? git.head.slice(0, 12) : undefined,
                detail: clean(`Checkout vorhanden${git.branch ? `, Branch ${git.branch}` : ''}${git.head ? `, Commit ${git.head}` : ''}. Aus Dateien gelesen, Git wurde nicht ausgeführt.`, 500) }
        },
    },
    git: {
        label: 'Git', category: 'toolchain', modes: 'all',
        run: async context => {
            const git = await tool(context, 'git')
            if (!git) return { state: 'missing', detail: 'git wurde in den Systemverzeichnissen nicht gefunden.', remedy: operator(IMAGE_HINT) }
            const version = await versionOf(context, git, ['--version'], /git version ([0-9][^\s]{0,40})/)
            return version ? { state: 'ready', version, detail: git.path } : { state: 'unknown', detail: 'git antwortete nicht auf --version.' }
        },
    },
    python: {
        label: 'Python', category: 'toolchain', modes: ['odoo'],
        run: async context => {
            const python = await systemPython(context), required = await requirements(context)
            if (!python) return { state: 'missing', detail: 'python3 wurde in den Systemverzeichnissen nicht gefunden.', remedy: operator(IMAGE_HINT) }
            if (!python.version) return { state: 'unknown', detail: 'python3 lieferte keine Version.' }
            const version = parseVersion(python.version)!
            if (!required) return { state: 'ready', version: `Python ${python.version}`, detail: python.executable.path }
            const range = `${required.pythonMin.join('.')}–${required.pythonMax.join('.')}`
            if (compareVersions(version.slice(0, 2), required.pythonMin) < 0 || compareVersions(version.slice(0, 2), required.pythonMax) > 0) {
                return { state: 'missing', version: `Python ${python.version}`, detail: `Odoo ${required.major}.0 benötigt Python ${range} (${required.source}).`, remedy: operator(IMAGE_HINT) }
            }
            return { state: 'ready', version: `Python ${python.version}`, detail: `${python.executable.path}; Odoo ${required.major}.0 benötigt ${range} (${required.source}).` }
        },
    },
    'python.venv': {
        label: 'Python venv/ensurepip', category: 'toolchain', modes: ['odoo'],
        run: async context => {
            const python = await systemPython(context)
            if (!python) return { state: 'missing', detail: 'python3 fehlt.', remedy: operator(IMAGE_HINT) }
            const remaining = context.deadline - Date.now()
            const output = remaining > 50 ? await context.system.run(python.executable, ['-I', '-c', 'import venv, ensurepip'], { timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining) }) : null
            if (!output || !output.ok) return { state: 'unknown', detail: 'Die venv-Prüfung lief nicht vollständig.' }
            return output.code === 0 ? { state: 'ready', detail: 'Die Module venv und ensurepip sind importierbar.' }
                : { state: 'missing', detail: 'venv/ensurepip fehlen (Debian: python3-venv).', remedy: operator(IMAGE_HINT) }
        },
    },
    'python.headers': {
        label: 'Python-Header', category: 'toolchain', modes: ['odoo'],
        run: async context => {
            const python = await systemPython(context)
            const version = python?.version ? parseVersion(python.version) : null
            if (!version) return { state: 'unknown', detail: 'Ohne Python-Version nicht prüfbar.' }
            const header = `/usr/include/python${version[0]}.${version[1]}/Python.h`
            return await context.system.exists(header) === 'file' ? { state: 'ready', detail: header }
                : { state: 'missing', detail: `${header} fehlt; psycopg2 und python-ldap lassen sich dann nicht bauen.`, remedy: operator(IMAGE_HINT) }
        },
    },
    'build.libraries': {
        label: 'Compiler und Bibliotheken für Odoo', category: 'toolchain', modes: ['odoo'],
        run: async context => {
            const required: Array<[string, string]> = [
                ['libpq (psycopg2)', '/usr/include/postgresql/libpq-fe.h'], ['libxml2 (lxml)', '/usr/include/libxml2/libxml/parser.h'],
                ['libxslt (lxml)', '/usr/include/libxslt/xslt.h'], ['LDAP (python-ldap)', '/usr/include/ldap.h'], ['SASL (python-ldap)', '/usr/include/sasl/sasl.h'],
            ]
            const missing: string[] = []
            for (const [label, path] of required) if (await context.system.exists(path) !== 'file') missing.push(label)
            const cc = await tool(context, 'gcc') ?? await tool(context, 'cc')
            if (!cc) missing.unshift('C-Compiler')
            if (!await tool(context, 'pkg-config') && !await tool(context, 'pkgconf')) missing.push('pkg-config')
            return missing.length ? { state: 'missing', detail: clean(`Fehlt: ${missing.join(', ')}.`, 500), remedy: operator(IMAGE_HINT) }
                : { state: 'ready', detail: 'Compiler, pkg-config und die Header für libpq, libxml2, libxslt, LDAP und SASL sind vorhanden.' }
        },
    },
    'postgresql.client': {
        label: 'PostgreSQL-Client', category: 'database', modes: ['odoo'],
        run: async context => {
            const psql = await tool(context, 'psql')
            if (!psql) return { state: 'missing', detail: 'psql wurde nicht gefunden.', remedy: operator(IMAGE_HINT) }
            const version = await versionOf(context, psql, ['--version'], /([0-9]+(?:\.[0-9]+)?)/)
            return version ? { state: 'ready', version: `psql ${version}`, detail: 'Nur der Client ist vorhanden; das sagt nichts über eine erreichbare Datenbank.' }
                : { state: 'unknown', detail: 'psql lieferte keine Version.' }
        },
    },
    'postgresql.server': {
        label: 'PostgreSQL-Server-Programme', category: 'database', modes: ['odoo'],
        run: async context => {
            const server = await postgresServer(context), required = await requirements(context)
            if (server && !server.version) return { state: 'unknown', detail: `/usr/lib/postgresql/${server.major}/bin/postgres lieferte keine Version; die Installation ist möglicherweise defekt.` }
            if (!server) return { state: 'missing', detail: 'initdb/pg_ctl/postgres unter /usr/lib/postgresql/<Version>/bin fehlen.', remedy: operator(IMAGE_HINT) }
            if (required && server.major < required.postgres) return { state: 'missing', version: `PostgreSQL ${server.version ?? server.major}`, detail: `Odoo ${required.major}.0 benötigt PostgreSQL ≥ ${required.postgres} (${required.source}).`, remedy: operator(IMAGE_HINT) }
            return { state: 'ready', version: `PostgreSQL ${server.version ?? server.major}`, detail: `Server-Programme vorhanden${required ? `; Odoo ${required.major}.0 benötigt ≥ ${required.postgres}` : ''}. Es läuft kein globaler Dienst.` }
        },
    },
    'odoo.source': {
        label: 'Odoo-Quellcode im Projekt', category: 'project', modes: ['odoo'],
        run: async context => {
            const major = odooMajor(context)
            if (!major) return { state: 'unknown', detail: 'Keine Odoo-Version konfiguriert.' }
            if (!context.projectRoot) return { state: 'unknown', detail: 'Kein Projektordner bekannt.' }
            const path = odooToolchain(major).source
            const tree = await projectTree(context, path)
            if (!tree) return { state: 'missing', detail: `${path} fehlt.`, remedy: recipe('odoo-source', `Rezept odoo-source klont odoo/odoo Branch ${major}.0 in das Projekt.`) }
            const release = await odooRelease(context)
            if (!release) return { state: 'warning', detail: `${path}/odoo/release.py fehlt oder ist nicht lesbar.`, remedy: recipe('odoo-source', 'Quellcode prüfen; vorhandene Ordner werden nie automatisch ersetzt.') }
            if (release.major !== major) return { state: 'missing', version: release.major ? `Odoo ${release.major}` : undefined, detail: `Der Quellcode ist nicht Odoo ${major}.0.`, remedy: manual(`Einen separaten Checkout für ${major}.0 anlegen; HAPI überschreibt den vorhandenen nicht.`) }
            if (await tree.kind('odoo-bin') !== 'file') return { state: 'warning', detail: 'odoo-bin fehlt im Quellcode.' }
            const toolchainTree = await projectTree(context, odooToolchain(major).base)
            const recorded = toolchainTree ? await toolchainTree.readText('source.json', 4096) : null
            const commit = recorded?.ok ? safeJson(recorded.text)?.commit : null
            const recordedCommit = typeof commit === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) ? commit : null
            const mismatch = recordedCommit && release.head && recordedCommit !== release.head
            return { state: mismatch ? 'warning' : 'ready', version: `Odoo ${major}.0${release.head ? ` @ ${release.head.slice(0, 12)}` : ''}`,
                detail: clean(`${path}${release.branch ? `, Branch ${release.branch}` : ''}${release.head ? `, Commit ${release.head}` : ', Commit unbekannt'}${mismatch ? `; source.json nennt ${recordedCommit!.slice(0, 40)}, der Checkout wurde danach verändert` : recordedCommit ? '; entspricht source.json' : '; source.json fehlt'}. Aus Dateien gelesen, nichts ausgeführt.`, 500) }
        },
    },
    'odoo.venv': {
        label: 'Odoo-venv im Projekt', category: 'project', modes: ['odoo'],
        run: async context => {
            const major = odooMajor(context)
            if (!major || !context.projectRoot) return { state: 'unknown', detail: 'Keine Odoo-Version oder kein Projektordner.' }
            const path = odooToolchain(major).venv
            const tree = await projectTree(context, path)
            if (!tree) return { state: 'missing', detail: `${path} fehlt.`, remedy: recipe('odoo-venv', 'Rezept odoo-venv legt das venv an und installiert die Requirements des Quellcodes.') }
            const config = await tree.readText('pyvenv.cfg', 8192)
            if (!config.ok) return { state: 'warning', detail: 'pyvenv.cfg fehlt; das ist kein gültiges venv.', remedy: manual('Ordner prüfen; HAPI löscht ihn nicht automatisch.') }
            const version = /^version(?:_info)?\s*=\s*([0-9]+\.[0-9]+\.[0-9]+)/m.exec(config.text)?.[1] ?? null
            // venv/bin/python is normally a symlink to the system interpreter; resolve it and require a trusted target.
            const interpreter = await venvInterpreter(context, `${context.projectRoot}/${path}/bin/python`)
            if (interpreter !== 'trusted') return { state: 'warning', version: version ? `Python ${version}` : undefined,
                detail: interpreter === 'missing' ? 'bin/python fehlt im venv.' : 'bin/python verweist nicht auf einen vertrauenswürdigen System-Interpreter (z. B. Verzeichnis, Kopie oder defekter Link).',
                remedy: recipe('odoo-venv', 'Rezept odoo-venv erneut ausführen; vorhandene Dateien bleiben erhalten.') }
            const series = version ? version.split('.').slice(0, 2).join('.') : null
            const sitePackages = series ? `lib/python${series}/site-packages` : null
            const installed = sitePackages ? (await Promise.all(['psycopg2', 'lxml', 'werkzeug'].map(async name => await tree.kind(`${sitePackages}/${name}/__init__.py`) === 'file'))) : []
            const required = await requirements(context)
            const parsed = version ? parseVersion(version) : null
            if (required && parsed && (compareVersions(parsed.slice(0, 2), required.pythonMin) < 0 || compareVersions(parsed.slice(0, 2), required.pythonMax) > 0)) {
                return { state: 'missing', version: `Python ${version}`, detail: `Das venv nutzt Python ${version}; Odoo ${required.major}.0 benötigt ${required.pythonMin.join('.')}–${required.pythonMax.join('.')}.`, remedy: manual('Ein neues venv mit passendem Python anlegen; das vorhandene wird nicht gelöscht.') }
            }
            if (!installed.length || installed.some(value => !value)) return { state: 'warning', version: version ? `Python ${version}` : undefined, detail: 'Das venv existiert, aber psycopg2/lxml/werkzeug sind nicht installiert.', remedy: recipe('odoo-venv', 'Requirements des Quellcodes in das venv installieren.') }
            return { state: 'ready', version: version ? `Python ${version}` : undefined, detail: `${path}; Paketdateien von psycopg2, lxml und werkzeug vorhanden (nur Dateien gelesen, Importfähigkeit nicht geprüft).` }
        },
    },
    'postgresql.cluster': {
        label: 'Projekteigener PostgreSQL-Cluster', category: 'database', modes: ['odoo'],
        run: async context => {
            if (!context.projectRoot) return { state: 'unknown', detail: 'Kein Projektordner bekannt.' }
            const paths = toolchainPaths(context.projectRoot)
            const data = await projectTree(context, paths.postgresData)
            if (!data) return { state: 'missing', detail: `${paths.postgresData} fehlt.`, remedy: recipe('odoo-postgres-cluster', 'Rezept postgres-cluster legt einen Cluster nur mit Unix-Socket an (kein TCP).') }
            const version = await data.readText('PG_VERSION', 64)
            if (!version.ok) return { state: 'warning', detail: 'PG_VERSION fehlt; Verzeichnis ist kein initialisierter Cluster.' }
            const pid = await data.readText('postmaster.pid', 4096)
            if (!pid.ok) return { state: 'warning', version: `PostgreSQL ${version.text.trim()}`, detail: 'Cluster ist angelegt, läuft aber nicht.', remedy: recipe('odoo-postgres-cluster', 'Mit „hapi-dev postgres start“ ausdrücklich starten.') }
            const lines = pid.text.split('\n')
            const processId = Number(lines[0]), socketDirectory = lines[4] ?? '', listen = (lines[5] ?? '').trim(), status = (lines[7] ?? '').trim()
            let alive = false
            if (Number.isSafeInteger(processId) && processId > 1) { try { process.kill(processId, 0); alive = true } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM' } }
            if (!alive) return { state: 'warning', version: `PostgreSQL ${version.text.trim()}`, detail: 'postmaster.pid ist veraltet; der Server läuft nicht.', remedy: recipe('odoo-postgres-cluster', 'Mit „hapi-dev postgres start“ prüfen und starten; nichts wird gelöscht.') }
            if (listen) return { state: 'warning', version: `PostgreSQL ${version.text.trim()}`, detail: 'Der Cluster lauscht auf TCP; vorgesehen ist nur der Unix-Socket.' }
            const ready = await pgIsReady(context, socketDirectory, lines[3]?.trim() ?? '')
            return ready === true ? { state: 'ready', version: `PostgreSQL ${version.text.trim()}`, detail: `Läuft lokal nur über den Unix-Socket (${paths.postgresSocketAbsolute === `${context.projectRoot}/${paths.postgresBase}/run` ? `${paths.postgresBase}/run` : 'privater Ordner im Runner-/tmp, weil der Projektpfad für Sockets zu lang ist'}); Status ${clean(status, 20) || 'unbekannt'}.` }
                : { state: 'warning', version: `PostgreSQL ${version.text.trim()}`, detail: ready === false ? 'Der Prozess läuft, nimmt aber keine Verbindungen an.' : 'Verbindungsbereitschaft nicht prüfbar (pg_isready fehlt).' }
        },
    },
    node: {
        label: 'Node.js', category: 'toolchain', modes: ['odoo'],
        run: async context => {
            const node = await tool(context, 'node')
            if (!node) return { state: 'missing', detail: 'node fehlt.' }
            const version = await versionOf(context, node, ['--version'], /v([0-9]+\.[0-9]+\.[0-9]+)/)
            return version ? { state: 'ready', version: `Node ${version}`, detail: 'Für Asset-/RTL-Werkzeuge; die Projektabhängigkeiten werden nicht geprüft.' } : { state: 'unknown', detail: 'node lieferte keine Version.' }
        },
    },
    browser: {
        label: 'Headless-Browser (HttpCase, Touren, HOOT)', category: 'runtime', modes: ['odoo'],
        run: async context => {
            for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
                const browser = await tool(context, name)
                if (!browser) continue
                const version = await versionOf(context, browser, ['--version'], /([0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)/)
                return { state: version ? 'ready' : 'unknown', version: version ? `${name} ${version}` : undefined, detail: `${browser.path}; nur nach ausdrücklichem Start durch Odoo-Tests verwendet.` }
            }
            return { state: 'missing', detail: 'Kein Chromium/Chrome. Python-Unit-Tests laufen trotzdem; HttpCase-, Tour- und HOOT-Tests werden übersprungen oder schlagen fehl.', remedy: operator('Chromium ist im Development-Image nicht enthalten; der Betreiber kann es bei Bedarf ergänzen.') }
        },
    },
    ssh: {
        label: 'SSH-Client (Odoo.sh-Builds)', category: 'integration', modes: ['odoo'],
        run: async context => {
            const ssh = await tool(context, 'ssh')
            if (!ssh) return { state: 'missing', detail: 'ssh fehlt.', remedy: operator(IMAGE_HINT) }
            const version = await versionOf(context, ssh, ['-V'], /(OpenSSH_[0-9][^\s,]{0,30})/)
            return { state: version ? 'ready' : 'unknown', version: version ?? undefined, detail: 'Nur der Client ist vorhanden. Es wurde keine Verbindung aufgebaut; Odoo.sh-Zugriff braucht einen eigenen, freigegebenen Schlüssel.' }
        },
    },
    wkhtmltopdf: {
        label: 'wkhtmltopdf (PDF-Berichte)', category: 'toolchain', modes: ['odoo'],
        run: async context => {
            const executable = await tool(context, 'wkhtmltopdf')
            if (!executable) return { state: 'missing', detail: 'Nicht installiert (in Debian 13 nicht paketiert). Nur für PDF-Berichte nötig; Odoo empfiehlt 0.12.6 mit gepatchtem Qt.', remedy: docs('Optional vom Betreiber aus den offiziellen Paketen ergänzen.', DOCS.wkhtmltopdf) }
            const version = await versionOf(context, executable, ['--version'], /wkhtmltopdf ([0-9][^\s]{0,30})/)
            return { state: version ? 'ready' : 'unknown', version: version ? `wkhtmltopdf ${version}` : undefined, detail: executable.path }
        },
    },
    swift: {
        label: 'Swift-Toolchain', category: 'toolchain', modes: ['ios'],
        run: async context => {
            const swift = await tool(context, 'swift')
            if (swift) {
                const version = await versionOf(context, swift, ['--version'], /Swift version ([0-9][^\s]{0,40})/)
                return { state: version ? 'ready' : 'unknown', version: version ? `Swift ${version}` : undefined, detail: `${swift.path}; unter Linux nur portable Swift-Pakete.` }
            }
            if (!context.projectRoot) return { state: 'missing', detail: 'Keine Swift-Toolchain in den Systemverzeichnissen.' }
            const path = toolchainPaths(context.projectRoot).swift
            const tree = await projectTree(context, path)
            const record = tree ? await tree.readText('current.json', 8192) : null
            if (record?.ok) {
                const parsed = safeJson(record.text)
                const version = typeof parsed?.version === 'string' && /^[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/.test(parsed.version) ? parsed.version : null
                // Metadata only: the official usr/bin/swift is an internal symlink to swift-driver.
                const resolved = version ? resolveSwiftBinary(`${context.projectRoot}/${path}/${version}`) : null
                if (version && resolved?.ok) return { state: 'ready', version: `Swift ${version}`,
                    detail: `${path}/${version}/usr/bin/swift (projekteigen, signaturgeprüft installiert, nicht ausgeführt). Unter Linux nur portable Swift-Pakete.` }
                return { state: 'warning', detail: resolved && !resolved.ok ? `swift/current.json nennt ${version}, aber ${SWIFT_BINARY_PROBLEM[resolved.reason]}.` : 'swift/current.json nennt keine vollständige Toolchain.', remedy: recipe('ios-swift-toolchain', 'Rezept erneut ausführen; vorhandene Installationen bleiben erhalten.') }
            }
            return { state: 'missing', detail: 'Keine Swift-Toolchain. Optional: signierte Linux-Toolchain von swift.org in das Projekt installieren.', remedy: recipe('ios-swift-toolchain', 'Rezept swift-toolchain lädt und prüft die signierte Toolchain.') }
        },
    },
    xcodebuild: {
        label: 'Xcode', category: 'toolchain', modes: ['ios'],
        run: async context => {
            if (context.system.platform !== 'darwin') return { state: 'unsupported', detail: 'Xcode, iOS-Builds, Signierung und Simulator gibt es nur auf macOS. Dieser Runner ist Linux.', remedy: docs('Native Builds über einen eigenen Mac, Xcode Cloud oder GitHub Actions (macOS) ausführen.', DOCS.xcodeCloud) }
            const xcodebuild = await context.system.trusted('/usr/bin/xcodebuild')
            if (!xcodebuild) return { state: 'missing', detail: 'xcodebuild fehlt.', remedy: docs('Xcode installieren.', DOCS.xcode) }
            const version = await versionOf(context, xcodebuild, ['-version'], /Xcode ([0-9][^\s]{0,20})/)
            return { state: version ? 'ready' : 'missing', version: version ? `Xcode ${version}` : undefined, detail: version ? '/usr/bin/xcodebuild' : 'Nur die Command Line Tools, kein vollständiges Xcode ausgewählt.' }
        },
    },
    simulator: {
        label: 'iOS-Simulator', category: 'device', modes: ['ios'],
        run: async context => context.system.platform !== 'darwin'
            ? { state: 'unsupported', detail: 'Der iOS-Simulator läuft nur auf macOS.' }
            : { state: 'unknown', detail: 'Simulatoren werden nicht automatisch gestartet oder aufgelistet; bei Bedarf in einer Sitzung „xcrun simctl list“ ausführen.' },
    },
    'host.macos': {
        label: 'macOS-Host für Xcode', category: 'runtime', modes: ['ios'],
        run: async context => context.system.platform === 'darwin'
            ? { state: 'ready', detail: 'macOS-Host. Ob Xcode und Simulatoren nutzbar sind, zeigen die Prüfungen xcodebuild und simulator.' }
            : { state: 'unsupported', detail: 'Linux-Runner: keine iOS-App-Builds, keine Signierung, kein Simulator, keine UIKit-/SwiftUI-/XCUITest-Tests. Möglich sind Codearbeit und portable Swift-Pakete.', remedy: docs('Native Builds und UI-Tests über einen eigenen Mac, Xcode Cloud oder GitHub Actions (macOS).', DOCS.xcodeCloud) },
    },
    'ios.project': {
        label: 'iOS-Projektdateien', category: 'project', modes: ['ios'],
        run: async context => {
            const tree = await checkoutTree(context)
            if (typeof tree === 'string') return repositoryState(tree)
            const ios = context.settings.ios
            const base = !ios || ios.projectDirectory === '.' ? '' : ios.projectDirectory
            if (ios?.projectFile) {
                const kind = await tree.kind(ios.projectFile)
                return kind === 'file' || kind === 'directory' ? { state: 'ready', detail: clean(`${ios.projectFile} vorhanden.`, 500) } : { state: 'missing', detail: clean(`${ios.projectFile} fehlt im Checkout.`, 500) }
            }
            const listing = await tree.list(base, 500)
            if (typeof listing === 'string') return { state: 'missing', detail: `Verzeichnis ${base || '.'} fehlt.` }
            const found = listing.entries.filter(entry => entry.kind === 'directory' && /\.(?:xcodeproj|xcworkspace)$/.test(entry.name) || entry.kind === 'file' && entry.name === 'Package.swift').map(entry => entry.name)
            return found.length ? { state: 'ready', detail: clean(`Gefunden: ${found.slice(0, 6).join(', ')}. Für Details die statische Analyse verwenden.`, 500) }
                : { state: 'missing', detail: 'Kein .xcodeproj, .xcworkspace oder Package.swift im Projektverzeichnis.' }
        },
    },
    java: {
        label: 'JDK', category: 'toolchain', modes: ['android'],
        run: async context => {
            const java = await tool(context, 'java')
            if (!java) return { state: 'missing', detail: 'java fehlt.', remedy: operator(IMAGE_HINT) }
            const version = await versionOf(context, java, ['-Xmx64m', '-XX:+UseSerialGC', '-version'], /version "([0-9][^"]{0,30})"/)
            if (!version) return { state: 'unknown', detail: 'java lieferte keine Version.' }
            const major = parseVersion(version)?.[0] ?? 0
            const wanted = context.settings.android?.jdkMajor ?? null
            const javac = await tool(context, 'javac')
            if (!javac) return { state: 'missing', version: `Java ${version}`, detail: 'Nur eine JRE: javac fehlt.', remedy: operator(IMAGE_HINT) }
            if (major < 17) return { state: 'missing', version: `Java ${version}`, detail: 'Aktuelle Android-Gradle-Plugins benötigen mindestens JDK 17.', remedy: docs('JDK passend zur AGP-Version wählen.', DOCS.jdks) }
            if (wanted && wanted !== major) return { state: 'warning', version: `Java ${version}`, detail: `Konfiguriert ist JDK ${wanted}; vorhanden ist ${major}. Gradle-Toolchains können ein anderes JDK verlangen.`, remedy: docs('JDK-Anforderung der AGP-/Gradle-Version prüfen.', DOCS.jdks) }
            return { state: 'ready', version: `Java ${version}`, detail: `${java.path}${wanted ? '' : '; JDK-Anforderung des Projekts nicht konfiguriert'}` }
        },
    },
    'android.sdk': {
        label: 'Android-SDK-Verzeichnis', category: 'sdk', modes: ['android'],
        run: async context => {
            const sdk = await androidSdk(context)
            if (!sdk) return { state: 'missing', detail: `Kein projekteigenes SDK unter ${context.projectRoot ? toolchainPaths(context.projectRoot).androidSdk : 'dem Projektordner'}.`, remedy: recipe('android-sdk-setup', 'Rezept android-sdk-setup installiert das SDK nach der Lizenzbestätigung durch einen Menschen.') }
            const entries = await sdk.tree.list('', 100)
            const names = typeof entries === 'string' ? [] : entries.entries.filter(entry => entry.kind === 'directory').map(entry => entry.name)
            return names.length ? { state: 'ready', detail: clean(`${sdk.label}; Pakete: ${names.slice(0, 10).join(', ')}.`, 500) } : { state: 'missing', detail: `${sdk.label} ist leer.`, remedy: recipe('android-sdk-setup', 'Rezept android-sdk-setup ausführen.') }
        },
    },
    'android.sdkmanager': {
        label: 'sdkmanager (cmdline-tools)', category: 'sdk', modes: ['android'],
        run: async context => {
            const sdk = await androidSdk(context)
            if (!sdk) return { state: 'missing', detail: 'Kein SDK.', remedy: recipe('android-sdk-setup', 'Rezept android-sdk-setup ausführen.') }
            const properties = await sdk.tree.readText('cmdline-tools/latest/source.properties', 16 * 1024)
            const revision = properties.ok ? /^Pkg\.Revision\s*=\s*([0-9][0-9.]{0,20})/m.exec(properties.text)?.[1] : null
            const binary = await sdk.tree.kind('cmdline-tools/latest/bin/sdkmanager')
            return revision && binary === 'file' ? { state: 'ready', version: `cmdline-tools ${revision}`, detail: 'Aus source.properties gelesen; sdkmanager wurde nicht ausgeführt.' }
                : { state: 'missing', detail: 'cmdline-tools/latest/bin/sdkmanager fehlt.', remedy: recipe('android-sdk-setup', 'Rezept android-sdk-setup ausführen.') }
        },
    },
    'android.licenses': {
        label: 'Android-SDK-Lizenzen', category: 'sdk', modes: ['android'],
        run: async context => {
            if (!context.settings.android?.sdkLicensesAcknowledged) return { state: 'missing', detail: 'Ein Projektadmin hat die Prüfung der Android-SDK-Lizenzen noch nicht bestätigt. Agenten können das nicht.', remedy: manual('In den Projekteinstellungen unter Entwicklung → Android die Lizenzprüfung bestätigen.', DOCS.sdkmanager) }
            const sdk = await androidSdk(context)
            const license = sdk ? await sdk.tree.kind('licenses/android-sdk-license') : 'missing'
            return license === 'file' ? { state: 'ready', detail: 'Bestätigt und im projekteigenen SDK hinterlegt.' }
                : { state: 'warning', detail: 'Bestätigt, aber im SDK ist noch keine Lizenzdatei hinterlegt.', remedy: recipe('android-sdk-setup', 'Rezept android-sdk-setup führt die Lizenzannahme ausdrücklich durch.') }
        },
    },
    'android.platform': {
        label: 'Android-Plattform und Build-Tools', category: 'sdk', modes: ['android'],
        run: async context => {
            const sdk = await androidSdk(context)
            if (!sdk) return { state: 'missing', detail: 'Kein projekteigenes SDK.', remedy: recipe('android-sdk-setup', 'Rezept android-sdk-setup ausführen.') }
            const platforms = await sdk.tree.list('platforms', 200), buildTools = await sdk.tree.list('build-tools', 200)
            const installed = typeof platforms === 'string' ? [] : platforms.entries.filter(entry => entry.kind === 'directory').map(entry => entry.name)
            const tools = typeof buildTools === 'string' ? [] : buildTools.entries.filter(entry => entry.kind === 'directory').map(entry => entry.name)
            const compileSdk = context.settings.android?.compileSdk
            if (!installed.length || !tools.length) return { state: 'missing', detail: clean(`Plattformen: ${installed.join(', ') || 'keine'}; Build-Tools: ${tools.join(', ') || 'keine'}.`, 500), remedy: recipe('android-sdk-setup', 'Rezept android-sdk-setup mit compileSdk ausführen.') }
            if (compileSdk && !installed.includes(`android-${compileSdk}`)) return { state: 'missing', detail: clean(`android-${compileSdk} fehlt; vorhanden: ${installed.join(', ')}.`, 500), remedy: recipe('android-sdk-setup', `Plattform android-${compileSdk} installieren.`) }
            return { state: 'ready', version: clean(installed.slice(-3).join(', '), 120), detail: clean(`Build-Tools: ${tools.slice(-3).join(', ')}.`, 500) }
        },
    },
    'android.platform-tools': {
        label: 'Android platform-tools (adb)', category: 'sdk', modes: ['android'],
        run: async context => {
            const sdk = await androidSdk(context)
            const properties = sdk ? await sdk.tree.readText('platform-tools/source.properties', 16 * 1024) : null
            const revision = properties?.ok ? /^Pkg\.Revision\s*=\s*([0-9][0-9.]{0,20})/m.exec(properties.text)?.[1] : null
            const adb = sdk ? await sdk.tree.kind('platform-tools/adb') : 'missing'
            if (revision && adb !== 'file') return { state: 'warning', version: `platform-tools ${revision}`, detail: 'platform-tools sind unvollständig: adb fehlt.', remedy: recipe('android-sdk-setup', 'platform-tools erneut installieren.') }
            return revision ? { state: 'ready', version: `platform-tools ${revision}`, detail: 'adb vorhanden; nicht ausgeführt, Geräte werden nicht verbunden.' }
                : { state: 'missing', detail: 'platform-tools fehlen (nur für Gerätetests nötig).', remedy: recipe('android-sdk-setup', 'Optional mit platform-tools installieren.') }
        },
    },
    'android.cli': {
        label: 'Offizielle Android CLI (optional)', category: 'toolchain', modes: ['android'],
        run: async context => {
            const system = await tool(context, 'android')
            if (system) return { state: 'ready', detail: `${system.path} (nicht ausgeführt; Aufrufe mit --no-metrics).` }
            const tree = context.projectRoot ? await projectTree(context, toolchainPaths(context.projectRoot).androidCli) : null
            const kind = tree ? await tree.kind('android') : 'missing'
            if (kind === 'file') return { state: 'ready', detail: `${toolchainPaths(context.projectRoot!).androidCli}/android (projekteigen, nicht ausgeführt; Aufrufe mit --no-metrics).` }
            return { state: 'missing', detail: 'Optional. Gradle und adb funktionieren auch ohne die Android CLI.', remedy: docs('Optional: „hapi-dev android-cli install“ lädt die offizielle CLI in das Projekt.', DOCS.androidCli) }
        },
    },
    'gradle.wrapper': {
        label: 'Gradle-Wrapper', category: 'project', modes: ['android'],
        run: async context => {
            const tree = await checkoutTree(context)
            if (typeof tree === 'string') return repositoryState(tree)
            const android = context.settings.android
            const base = !android || android.projectDirectory === '.' ? '' : android.projectDirectory
            const gradlew = await tree.kind(joinRelative(base, 'gradlew'))
            const properties = await tree.readText(joinRelative(base, 'gradle/wrapper/gradle-wrapper.properties'), 64 * 1024)
            if (gradlew !== 'file' || !properties.ok) return { state: 'missing', detail: 'gradlew oder gradle-wrapper.properties fehlt im Android-Projektverzeichnis.' }
            const url = /^distributionUrl\s*=\s*(.+)$/m.exec(properties.text)?.[1]?.trim().replace(/\\:/g, ':') ?? ''
            const version = /gradle-([0-9][0-9A-Za-z.+-]{0,40})-(?:bin|all)\.zip$/.exec(url)?.[1]
            if (await tree.kind(joinRelative(base, 'gradle/wrapper/gradle-wrapper.jar')) !== 'file') return { state: 'missing', version: version ? `Gradle ${version}` : undefined, detail: 'gradle/wrapper/gradle-wrapper.jar fehlt; gradlew kann so nicht starten.' }
            if (!/^https:\/\/services\.gradle\.org\/distributions\//.test(url)) return { state: 'warning', version: version ? `Gradle ${version}` : undefined, detail: 'Der Wrapper lädt Gradle nicht von services.gradle.org. Vor dem ersten Build prüfen.' }
            return { state: 'ready', version: version ? `Gradle ${version}` : undefined, detail: 'Statisch gelesen; der Wrapper wurde nicht ausgeführt.' }
        },
    },
    'android.project': {
        label: 'Android-Projektdateien', category: 'project', modes: ['android'],
        run: async context => {
            const tree = await checkoutTree(context)
            if (typeof tree === 'string') return repositoryState(tree)
            const android = context.settings.android
            const base = !android || android.projectDirectory === '.' ? '' : android.projectDirectory
            const settingsFile = await tree.kind(joinRelative(base, 'settings.gradle.kts')) === 'file' || await tree.kind(joinRelative(base, 'settings.gradle')) === 'file'
            const module = joinRelative(base, (android?.module ?? 'app').replace(/^:/, '').split(':').join('/'))
            const moduleBuild = await tree.kind(joinRelative(module, 'build.gradle.kts')) === 'file' || await tree.kind(joinRelative(module, 'build.gradle')) === 'file'
            if (!settingsFile) return { state: 'missing', detail: 'settings.gradle(.kts) fehlt im Android-Projektverzeichnis.' }
            if (!moduleBuild) return { state: 'missing', detail: clean(`Modul ${android?.module ?? 'app'} hat keine build.gradle(.kts).`, 500) }
            return { state: 'ready', detail: clean(`settings.gradle und Modul ${android?.module ?? 'app'} gefunden.`, 500) }
        },
    },
    kvm: {
        label: 'KVM-Beschleunigung', category: 'device', modes: ['android'],
        run: async context => {
            if (context.system.platform !== 'linux') return { state: 'unsupported', detail: 'KVM gibt es nur unter Linux.' }
            const kind = await context.system.exists('/dev/kvm')
            if (kind === 'missing') return { state: 'missing', detail: '/dev/kvm ist in diesem Runner nicht vorhanden; der Emulator wäre unbeschleunigt unbrauchbar.', remedy: docs('Gerätetests auf echter Hardware oder in CI mit KVM ausführen.', DOCS.emulator) }
            if (kind !== 'char') return { state: 'warning', detail: '/dev/kvm ist kein Gerät.' }
            return await context.system.accessible('/dev/kvm', ACCESS.R_OK | ACCESS.W_OK)
                ? { state: 'ready', detail: '/dev/kvm ist les- und schreibbar.' }
                : { state: 'missing', detail: '/dev/kvm existiert, ist für diesen Benutzer aber nicht zugänglich.', remedy: operator('Der Betreiber müsste den Gerätezugriff ausdrücklich freigeben; das ändert die Isolation des Runners.') }
        },
    },
    'android.emulator': {
        label: 'Android-Emulator', category: 'device', modes: ['android'],
        run: async context => {
            const kvm = await PROBES.kvm.run(context)
            if (kvm.state !== 'ready') return { state: 'unsupported', detail: 'Ohne zugängliches KVM kein brauchbarer Emulator in diesem Runner.', remedy: docs('Debug-APK auf ein eigenes Gerät übertragen oder CI mit Emulator verwenden.', DOCS.emulator) }
            const sdk = await androidSdk(context)
            if (!sdk || await sdk.tree.kind('emulator/emulator') !== 'file') return { state: 'missing', detail: 'Emulator-Paket fehlt im projekteigenen SDK.' }
            return { state: 'unknown', detail: 'Emulator vorhanden; Beschleunigung und Systemimages werden nicht automatisch geprüft oder gestartet („emulator -accel-check“ ausdrücklich in einer Sitzung).' }
        },
    },
}

function repositoryState(state: 'unbound' | 'missing' | 'blocked'): Omit<Check, 'id' | 'label' | 'category'> {
    if (state === 'unbound') return { state: 'unknown', detail: 'Kein Repository gebunden.', remedy: manual('Ein freigegebenes Repository in den Entwicklungseinstellungen wählen.') }
    if (state === 'missing') return { state: 'missing', detail: 'Das Repository ist noch nicht geklont.', remedy: manual('Repository über GitHub im Projekt klonen (evolved_repository_sync).') }
    return { state: 'warning', detail: 'Der Checkout-Pfad ist eine Verknüpfung oder unsicher; nicht gelesen.' }
}

/** Explicit ANDROID_HOME/ANDROID_SDK_ROOT of the runner process (absolute), else the project-owned SDK. */
async function venvInterpreter(context: Context, absolute: string): Promise<'trusted' | 'untrusted' | 'missing'> {
    const kind = await context.system.exists(absolute)
    if (kind === 'missing') return 'missing'
    const target = await realpath(absolute).catch(() => null)
    if (!target || target.startsWith(`${context.projectRoot}/`)) return 'untrusted'
    return await context.system.trusted(target) ? 'trusted' : 'untrusted'
}

async function androidSdk(context: Context): Promise<{ tree: SafeTree; label: string } | null> {
    return memo(context, 'android-sdk', async () => {
        for (const [name, value] of Object.entries(context.androidSdkEnvironment ?? {})) {
            if (!value || !value.startsWith('/') || value.length > 1024) continue
            const tree = await SafeTree.open(value.replace(/\/+$/, ''), { reads: 200, bytes: 4 * 1024 * 1024, entries: 5000 })
            if (typeof tree !== 'string') return { tree, label: `SDK aus ${name}` }
        }
        if (!context.projectRoot) return null
        const path = toolchainPaths(context.projectRoot).androidSdk
        const tree = await projectTree(context, path)
        return tree ? { tree, label: path } : null
    })
}

async function pgIsReady(context: Context, socketDirectory: string, port: string): Promise<boolean | null> {
    if (!context.projectRoot || socketDirectory !== toolchainPaths(context.projectRoot).postgresSocketAbsolute || !/^[0-9]{2,5}$/.test(port)) return null
    const server = await postgresServer(context)
    const executable = server ? await context.system.trusted(`/usr/lib/postgresql/${server.major}/bin/pg_isready`) : await tool(context, 'pg_isready')
    if (!executable) return null
    const remaining = context.deadline - Date.now()
    if (remaining <= 50) return null
    // Unix socket only: -h is the project's socket directory, never a TCP host.
    // Explicit -U: libpq would otherwise look up the (possibly passwd-less) runner UID.
    const output = await context.system.run(executable, ['-h', socketDirectory, '-p', port, '-U', 'odoo', '-t', '2', '-q'], { timeoutMs: Math.min(3000, remaining) })
    return output.ok ? output.code === 0 : null
}

async function readImageMarker(context: Context): Promise<Record<string, string> | null> {
    const path = context.imageMarkerPath ?? '/etc/hapi-runner-image'
    const tree = await SafeTree.open('/etc').catch(() => null)
    if (path === '/etc/hapi-runner-image' && tree && typeof tree !== 'string') {
        const marker = await tree.readText('hapi-runner-image', 4096)
        return marker.ok ? parseMarker(marker.text) : null
    }
    const separator = path.lastIndexOf('/')
    const directory = await SafeTree.open(path.slice(0, separator))
    if (typeof directory === 'string') return null
    const marker = await directory.readText(path.slice(separator + 1), 4096)
    return marker.ok ? parseMarker(marker.text) : null
}

function parseMarker(text: string): Record<string, string> {
    const values: Record<string, string> = {}
    for (const line of text.split('\n').slice(0, 32)) {
        const match = /^([a-z][a-z0-9_-]{0,31})=([A-Za-z0-9 ._:/+-]{0,100})$/.exec(line.trim())
        if (match) values[match[1]] = match[2]
    }
    return values
}

function safeJson(text: string): Record<string, unknown> | null {
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null } catch { return null }
}

export const DOCTOR_CHECK_IDS = Object.keys(PROBES)

/** Runner-side extras appended to the pack's checks; the hub accepts results it did not request. */
const EXTRA_CHECKS: Record<SpecializedDevelopmentMode, readonly string[]> = {
    odoo: ['python.headers', 'build.libraries'],
    ios: ['ios.project'],
    android: ['android.platform', 'android.project'],
}

export function defaultDoctorChecks(mode: SpecializedDevelopmentMode): string[] {
    return Object.entries(PROBES).filter(([, probe]) => probe.modes === 'all' || probe.modes.includes(mode)).map(([id]) => id)
}

export function doctorCheckLabel(id: string): string | null {
    return Object.hasOwn(PROBES, id) ? PROBES[id].label : null
}

/** Bounded, read-only toolchain doctor. Fixed probes only; never runs project scripts or contacts the network. */
export async function runDevelopmentDoctor(input: DoctorInput): Promise<DevelopmentDoctorResult> {
    const now = input.now ?? Date.now, started = Date.now()
    const system = input.system ?? createProbeSystem()
    const context: Context = { ...input, system, deadline: started + Math.min(input.deadlineMs ?? DOCTOR_TOTAL_TIMEOUT_MS, DOCTOR_TOTAL_TIMEOUT_MS), cache: new Map() }
    const base = input.checks.length ? input.checks : defaultDoctorChecks(input.mode)
    const all = [...new Set([...base, ...EXTRA_CHECKS[input.mode]])]
    const requested = all.slice(0, 64)
    const checks: Check[] = []
    let truncated = all.length > 64
    for (const id of requested) {
        const probe = Object.hasOwn(PROBES, id) ? PROBES[id] : null
        if (!probe) { checks.push({ id, label: 'Unbekannte Prüfung', category: 'runtime', state: 'unknown', detail: 'Diese Prüfung kennt dieser Runner nicht; ggf. ist ein neueres Runner-Image nötig.' }); continue }
        if (Date.now() >= context.deadline) { truncated = true; checks.push({ id, label: probe.label, category: probe.category, state: 'unknown', detail: 'Zeitlimit des Doctors erreicht; nicht geprüft.' }); continue }
        let outcome: Omit<Check, 'id' | 'label' | 'category'>
        try {
            outcome = await Promise.race([
                probe.run(context),
                new Promise<Omit<Check, 'id' | 'label' | 'category'>>(resolve => setTimeout(() => resolve({ state: 'unknown', detail: 'Zeitlimit dieser Prüfung erreicht.' }), Math.max(1, Math.min(PROBE_TIMEOUT_MS + 1000, context.deadline - Date.now()))).unref?.()),
            ])
        } catch { outcome = { state: 'unknown', detail: 'Die Prüfung ist fehlgeschlagen.' } }
        checks.push({ id, label: probe.label, category: probe.category, ...outcome,
            ...(outcome.detail ? { detail: clean(outcome.detail, 500) } : {}), ...(outcome.version ? { version: clean(outcome.version, 120) } : {}) })
    }
    const marker = await readImageMarker(context).catch(() => null)
    return {
        contractVersion: DEVELOPMENT_CONTRACT_VERSION, mode: input.mode, observedAt: now(), durationMs: Math.min(120_000, Date.now() - started),
        host: { os: clean(system.platform, 40), arch: clean(system.arch, 40), image: marker?.variant ? clean(`${marker.variant}${marker.schema ? ` v${marker.schema}` : ''}`, 120) : null },
        checks, truncated,
    }
}
