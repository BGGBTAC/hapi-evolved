import { containsCredential, excludedSourcePath, isSafeSourcePath } from '@hapi/protocol/evolvedSourcePolicy'
import {
    DEVELOPMENT_CONTRACT_VERSION,
    type DevelopmentInspectResult,
    type DevelopmentSettings,
    type OdooModuleInventory,
    type SpecializedDevelopmentMode,
} from '@hapi/protocol/evolvedDevelopment'
import { dictGet, isDict, parsePythonLiteral, PythonLiteralError, sequence, type PythonDict, type PythonLiteral } from './pythonLiteral'
import { joinRelative, readFailureText, SafeTree } from './safeTree'
import { inspectCsv, inspectXml } from './staticChecks'

type BuildFile = DevelopmentInspectResult['buildFiles'][number]
type Facts = Record<string, string>

export const INSPECT_LIMITS = {
    modules: 500,
    manifestBytes: 256 * 1024,
    xmlBytes: 2 * 1024 * 1024,
    csvBytes: 2 * 1024 * 1024,
    textBytes: 512 * 1024,
    pbxprojBytes: 8 * 1024 * 1024,
    moduleDepth: 8,
    filesPerModule: 5000,
    totalFiles: 60_000,
    dataChecksPerModule: 500,
    xmlChecks: 400,
    swiftFiles: 600,
    buildFiles: 500,
    warnings: 50,
    issues: 50,
} as const

const ACCESS_COLUMNS = ['id', 'name', 'model_id:id', 'group_id:id', 'perm_read', 'perm_write', 'perm_create', 'perm_unlink']
/** odoo/odoo 20.0 (989d537, odoo/addons/base/models/ir_access.py): ir.access with operation and domain. */
const ACCESS_COLUMNS_20 = ['id', 'name', 'model_id', 'operation']
const ACCESS_OPERATIONS_20 = new Set(['crud', 'cru', 'crd', 'cud', 'rud', 'cr', 'cu', 'cd', 'ru', 'rd', 'ud', 'c', 'r', 'u', 'd'])
const APPLE_ONLY_IMPORTS = /^\s*(?:@testable\s+|@_exported\s+)?import\s+(?:class\s+|struct\s+|enum\s+|func\s+)?(UIKit|SwiftUI|AppKit|WatchKit|XCUITest|MapKit|StoreKit|WidgetKit|ARKit|RealityKit|SpriteKit|SceneKit|Cocoa)\b/m

const text = (value: string, max: number) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, max)

class Collector {
    readonly warnings: string[] = []
    /** Files classified by countModuleFiles, for its total limit; reported counts come from SafeTree.scanned. */
    moduleFiles = 0
    limitReached = false
    warn(message: string) {
        if (this.warnings.length < INSPECT_LIMITS.warnings) this.warnings.push(text(message, 300))
        else this.limitReached = true
    }
}

/** Reads `.git/HEAD` and the referenced ref without running Git (no hooks, config or fsmonitor). */
export async function readGitHead(tree: SafeTree): Promise<{ head: string | null; branch: string | null; note?: string }> {
    const kind = await tree.kind('.git')
    if (kind === 'missing') return { head: null, branch: null, note: 'Kein .git-Verzeichnis gefunden.' }
    if (kind !== 'directory') return { head: null, branch: null, note: 'Git-Metadaten liegen nicht als normales .git-Verzeichnis vor (z. B. Worktree); Commit nicht ermittelt.' }
    const head = await tree.readText('.git/HEAD', 4096)
    if (!head.ok) return { head: null, branch: null, note: 'HEAD ist nicht lesbar.' }
    const value = head.text.trim()
    if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) return { head: value, branch: null }
    const ref = /^ref: (refs\/heads\/[^\s]{1,240})$/.exec(value)?.[1]
    if (!ref || !isSafeSourcePath(ref) || ref.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) return { head: null, branch: null, note: 'HEAD hat ein unerwartetes Format.' }
    const branch = ref.slice('refs/heads/'.length)
    const loose = await tree.readText(`.git/${ref}`, 4096)
    if (loose.ok && /^[a-f0-9]{40}(?:[a-f0-9]{24})?\s*$/.test(loose.text)) return { head: loose.text.trim(), branch }
    const packed = await tree.readText('.git/packed-refs', 4 * 1024 * 1024)
    if (packed.ok) {
        for (const line of packed.text.split('\n')) {
            const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) (\S+)$/.exec(line)
            if (match && match[2] === ref) return { head: match[1], branch }
        }
    }
    return { head: null, branch, note: 'Der Branch hat noch keinen Commit oder die Referenz ist nicht lesbar.' }
}

function stringValue(value: PythonLiteral | undefined): string | null {
    return typeof value === 'string' ? value : null
}
function boolValue(value: PythonLiteral | undefined): boolean | null {
    if (typeof value === 'boolean') return value
    // `auto_install` may list trigger dependencies; any list means "auto install when those are installed".
    if (sequence(value)) return true
    return null
}
function stringList(value: PythonLiteral | undefined): string[] | null {
    const items = sequence(value)
    if (!items) return null
    return items.every(item => typeof item === 'string') ? items as string[] : null
}

/** Withhold values that look like credentials and never return control characters. */
/** Same withholding policy for every list value taken from untrusted manifests. */
function safeList(values: readonly string[], max: number, length: number, issues: string[], field: string): string[] {
    const kept = values.filter(value => !containsCredential(value))
    if (kept.length !== values.length) issues.push(`${field}: ${values.length - kept.length} Wert(e) sehen wie Zugangsdaten aus und werden nicht angezeigt.`)
    return kept.slice(0, max).map(value => text(value, length))
}

function safeValue(value: string | null, max: number, issues: string[], field: string): string | null {
    if (value === null) return null
    if (containsCredential(value)) { issues.push(`${field}: Wert sieht wie ein Zugangsdatum aus und wird nicht angezeigt.`); return null }
    return text(value, max)
}

async function countModuleFiles(tree: SafeTree, modulePath: string, collector: Collector) {
    const counts = { python: 0, xml: 0, csv: 0, js: 0, tests: 0 }
    let files = 0
    const visit = async (relative: string, depth: number): Promise<void> => {
        if (depth > INSPECT_LIMITS.moduleDepth) { collector.limitReached = true; return }
        const listing = await tree.list(relative, 2000)
        if (typeof listing === 'string') return
        if (listing.truncated) collector.limitReached = true
        for (const entry of listing.entries) {
            const path = joinRelative(relative, entry.name)
            if (excludedSourcePath(path) || entry.kind === 'symlink' || entry.kind === 'special') continue
            if (entry.kind === 'directory') { await visit(path, depth + 1); continue }
            if (++files > INSPECT_LIMITS.filesPerModule || ++collector.moduleFiles > INSPECT_LIMITS.totalFiles) { collector.limitReached = true; return }
            const name = entry.name.toLowerCase()
            if (name.endsWith('.py')) {
                counts.python++
                if (/(?:^|\/)tests(?:\/|$)/.test(path.slice(modulePath.length)) && name.startsWith('test_')) counts.tests++
            } else if (name.endsWith('.xml')) counts.xml++
            else if (name.endsWith('.csv')) counts.csv++
            else if (name.endsWith('.js')) counts.js++
        }
    }
    await visit(modulePath, 0)
    return counts
}

/**
 * Mirrors odoo/modules/module.py adapt_version + check_version of the 19.0 and 20.0 branches
 * (identical in both): 2–5 integer parts; versions with at most three parts that do not start with
 * the series get it prefixed; the result must start with "<major>.0.".
 */
export function odooVersionAccepted(version: string, major: number): boolean {
    const serie = `${major}.0`, parts = version.split('.')
    if (parts.length < 2 || parts.length > 5) return false
    if (version.startsWith(serie) && !/^[0-9]+$/.test(parts[0])) parts[0] = parts[0].replace(/[^0-9]/g, '')
    // Python int(): optional sign/whitespace, digits with single underscores.
    if (!parts.every(part => /^\s*[+-]?[0-9](?:_?[0-9])*\s*$/.test(part))) return false
    const adapted = parts.length <= 3 && !version.startsWith(serie) ? `${serie}.${version}` : version
    return adapted.startsWith(`${serie}.`)
}

function versionMatches(version: string | null, major: number | null, issues: string[]): boolean | null {
    if (version === null || major === null) return null
    if (!odooVersionAccepted(version, major)) {
        issues.push(`Odoo ${major}.0 lehnt diese Version ab; erlaubt sind x.y, x.y.z, ${major}.0.x.y oder ${major}.0.x.y.z.`)
        return false
    }
    if (!version.startsWith(`${major}.0`)) issues.push(`Kurze Versionsangabe: Odoo ergänzt die Serie ${major}.0 automatisch.`)
    return true
}

async function inspectOdooModule(tree: SafeTree, modulePath: string, technicalName: string, major: number | null, collector: Collector, xmlBudget: { remaining: number }): Promise<OdooModuleInventory> {
    const issues: string[] = []
    const inventory: OdooModuleInventory = {
        path: modulePath, technicalName: text(technicalName, 100), manifest: 'invalid', name: null, version: null, versionMatchesMajor: null,
        license: null, installable: null, application: null, autoInstall: null, depends: [], externalPython: [], data: [], demo: [], assetsBundles: [],
        missingDataFiles: [], security: { accessCsv: false, accessRules: null, securityXmlFiles: 0 },
        counts: { python: 0, xml: 0, csv: 0, js: 0, tests: 0 }, hasMigrations: false, issues,
    }
    if (!/^[a-z0-9_]{1,100}$/.test(technicalName)) issues.push('Der Verzeichnisname ist kein gültiger technischer Modulname (nur a-z, 0-9, _).')
    const source = await tree.readText(joinRelative(modulePath, '__manifest__.py'), INSPECT_LIMITS.manifestBytes)
    let manifest: PythonDict | null = null
    if (!source.ok) {
        inventory.manifest = source.reason === 'binary' ? 'invalid' : 'unsafe'
        issues.push(`__manifest__.py ${readFailureText[source.reason]}.`)
    } else {
        try {
            const value = parsePythonLiteral(source.text)
            if (isDict(value)) { manifest = value; inventory.manifest = 'valid' }
            else issues.push('__manifest__.py enthält kein Dictionary-Literal.')
        } catch (error) {
            // Only the classification is reported; manifest text is never echoed.
            issues.push(`__manifest__.py ist kein reines Python-Literal (${error instanceof PythonLiteralError ? text(error.message, 120) : 'Parserfehler'}); es wird nie ausgeführt.`)
        }
    }
    if (manifest) {
        for (const [key] of manifest.entries) if (typeof key !== 'string') { issues.push('Manifest enthält nicht-textuelle Schlüssel.'); break }
        inventory.name = safeValue(stringValue(dictGet(manifest, 'name')), 200, issues, 'name')
        if (!inventory.name) issues.push('Manifest hat keinen Namen (name).')
        inventory.version = safeValue(stringValue(dictGet(manifest, 'version')), 40, issues, 'version')
        inventory.versionMatchesMajor = versionMatches(inventory.version, major, issues)
        if (!inventory.version) issues.push('Manifest hat keine Version.')
        inventory.license = safeValue(stringValue(dictGet(manifest, 'license')), 40, issues, 'license')
        if (!inventory.license) issues.push('Manifest hat keine Lizenz; Odoo nimmt LGPL-3 an und warnt.')
        const installable = dictGet(manifest, 'installable')
        inventory.installable = installable === undefined ? true : typeof installable === 'boolean' ? installable : null
        if (inventory.installable === false) issues.push('Modul ist als nicht installierbar markiert (installable=False).')
        const application = dictGet(manifest, 'application')
        inventory.application = application === undefined ? false : boolValue(application)
        const autoInstall = dictGet(manifest, 'auto_install')
        inventory.autoInstall = autoInstall === undefined ? false : boolValue(autoInstall)
        const depends = dictGet(manifest, 'depends')
        const dependsList = depends === undefined ? [] : stringList(depends)
        if (!dependsList) issues.push('depends ist keine Liste von Modulnamen.')
        inventory.depends = safeList(dependsList ?? [], 200, 100, issues, 'depends')
        if ((dependsList ?? []).some(value => !/^[a-z0-9_]{1,100}$/.test(value))) issues.push('depends enthält ungültige Modulnamen.')
        const external = dictGet(manifest, 'external_dependencies')
        if (external !== undefined) {
            const python = external && isDict(external) ? stringList(dictGet(external, 'python')) : null
            if (external && isDict(external) && dictGet(external, 'python') !== undefined && !python) issues.push('external_dependencies.python ist keine Textliste.')
            inventory.externalPython = safeList(python ?? [], 100, 100, issues, 'external_dependencies.python')
        }
        const assets = dictGet(manifest, 'assets')
        if (assets !== undefined) {
            if (!isDict(assets)) issues.push('assets ist kein Dictionary.')
            else inventory.assetsBundles = safeList(assets.entries.map(([key]) => key).filter((key): key is string => typeof key === 'string'), 50, 120, issues, 'assets')
        }
        for (const field of ['data', 'demo'] as const) {
            const raw = dictGet(manifest, field)
            if (raw === undefined) continue
            const rawList = stringList(raw)
            if (!rawList) { issues.push(`${field} ist keine Liste von Dateipfaden.`); continue }
            const list = rawList.filter(entry => !containsCredential(entry))
            if (list.length !== rawList.length) issues.push(`${field}: ${rawList.length - list.length} Pfad(e) sehen wie Zugangsdaten aus und werden nicht angezeigt.`)
            const limit = field === 'data' ? 500 : 200
            if (list.length > limit) issues.push(`${field} hat mehr als ${limit} Einträge; nur die ersten werden geprüft.`)
            let checked = 0
            for (const entry of list.slice(0, limit)) {
                if (!isSafeSourcePath(entry)) {
                    issues.push(`${field}: unsicherer Pfad wird nicht geprüft.`)
                    continue
                }
                inventory[field].push(text(entry, 1024))
                if (++checked > INSPECT_LIMITS.dataChecksPerModule) continue
                const path = joinRelative(modulePath, entry), kind = await tree.kind(path)
                if (kind === 'missing') { if (inventory.missingDataFiles.length < 100) inventory.missingDataFiles.push(text(entry, 1024)); continue }
                if (kind !== 'file') { issues.push(`${field}: ${text(entry, 120)} ${kind === 'symlink' ? readFailureText.symlink : readFailureText.special}.`); continue }
                if (excludedSourcePath(path)) { issues.push(`${field}: ${text(entry, 120)} liegt in einem geschützten Pfad und wird nicht gelesen.`); continue }
                if (entry.toLowerCase().endsWith('.xml') && xmlBudget.remaining > 0) {
                    xmlBudget.remaining--
                    const xml = await tree.readText(path, INSPECT_LIMITS.xmlBytes)
                    if (!xml.ok) issues.push(`${text(entry, 120)} ${readFailureText[xml.reason]}.`)
                    else {
                        const result = inspectXml(xml.text)
                        if (result.wellFormed === false) issues.push(`${text(entry, 120)}: XML nicht wohlgeformt (${result.reason}).`)
                        else if (result.wellFormed === null) issues.push(`${text(entry, 120)}: Wohlgeformtheit nur strukturell geprüft (${result.reason}).`)
                        else if (!['odoo', 'openerp', 'templates'].includes(result.root ?? '')) issues.push(`${text(entry, 120)}: Wurzelelement <${text(result.root ?? '', 40)}> statt <odoo>.`)
                        if (result.doctype) issues.push(`${text(entry, 120)}: enthält DOCTYPE; Entitäten werden nicht ausgewertet.`)
                    }
                } else if (entry.toLowerCase().endsWith('.xml')) collector.limitReached = true
                const legacyAccess = /(?:^|\/)ir\.model\.access\.csv$/.test(entry), access20 = /(?:^|\/)ir\.access\.csv$/.test(entry)
                if (field === 'data' && (legacyAccess || access20)) {
                    inventory.security.accessCsv = true
                    // Odoo 20 replaced ir.model.access (perm_* columns) with ir.access (operation + domain).
                    if (legacyAccess && major === 20) issues.push(`${text(entry, 120)}: Odoo 20 hat kein Modell ir.model.access mehr; Zugriffsrechte gehören nach security/ir.access.csv (Spalten id, name, model_id, group_id/id, operation, domain).`)
                    if (access20 && major === 19) issues.push(`${text(entry, 120)}: ir.access gibt es erst ab Odoo 20; Odoo 19 erwartet ir.model.access.csv.`)
                    const csv = await tree.readText(path, INSPECT_LIMITS.csvBytes)
                    if (!csv.ok) issues.push(`${text(entry, 120)} ${readFailureText[csv.reason]}.`)
                    else {
                        const parsed = inspectCsv(csv.text)
                        inventory.security.accessRules = (inventory.security.accessRules ?? 0) + parsed.rows
                        const header = parsed.header.map(column => column.replace(/\/id$/, ':id'))
                        const expected = legacyAccess ? ACCESS_COLUMNS.filter(column => column !== 'group_id:id') : ACCESS_COLUMNS_20
                        const missingColumns = expected.filter(column => !header.includes(column))
                        if (missingColumns.length) issues.push(`${text(entry, 120)}: Spalten fehlen (${missingColumns.join(', ')}).`)
                        if (!parsed.valid) issues.push(`${text(entry, 120)}: Zeilen haben eine abweichende Spaltenzahl.`)
                        if (access20 && parsed.invalidValues(header.indexOf('operation'), value => ACCESS_OPERATIONS_20.has(value))) issues.push(`${text(entry, 120)}: unbekannte operation-Werte (erlaubt: Kombinationen aus c, r, u, d).`)
                    }
                }
                if (field === 'data' && entry.startsWith('security/') && entry.toLowerCase().endsWith('.xml')) inventory.security.securityXmlFiles++
            }
        }
        if (inventory.missingDataFiles.length) issues.push(`${inventory.missingDataFiles.length} im Manifest referenzierte Datei(en) fehlen.`)
    }
    inventory.counts = await countModuleFiles(tree, modulePath, collector)
    if (inventory.counts.python > 0 && await tree.kind(joinRelative(modulePath, '__init__.py')) !== 'file') issues.push('__init__.py fehlt, obwohl Python-Dateien vorhanden sind.')
    inventory.hasMigrations = await tree.kind(joinRelative(modulePath, 'migrations')) === 'directory' || await tree.kind(joinRelative(modulePath, 'upgrades')) === 'directory'
    if (issues.length > INSPECT_LIMITS.issues) issues.splice(INSPECT_LIMITS.issues - 1, issues.length, 'Weitere Hinweise wurden gekürzt.')
    return inventory
}

async function inspectOdoo(tree: SafeTree, settings: DevelopmentSettings, collector: Collector, buildFiles: BuildFile[], odooSource: SafeTree | null) {
    const odoo = settings.odoo
    const major = odoo?.major ?? null
    const modules: OdooModuleInventory[] = []
    const xmlBudget = { remaining: INSPECT_LIMITS.xmlChecks }
    const seen = new Set<string>()
    for (const addonsPath of odoo?.addonsPaths?.length ? odoo.addonsPaths : ['.']) {
        const base = addonsPath === '.' ? '' : addonsPath
        const listing = await tree.list(base, 4000)
        if (typeof listing === 'string') { collector.warn(`Addons-Pfad ${addonsPath} ${readFailureText[listing]}.`); continue }
        if (listing.truncated) collector.limitReached = true
        for (const requirements of ['requirements.txt']) {
            const path = joinRelative(base, requirements)
            if (await tree.kind(path) === 'file') {
                const content = await tree.readText(path, INSPECT_LIMITS.textBytes)
                const lines = content.ok ? content.text.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).length : null
                pushBuildFile(buildFiles, { path, kind: 'odoo_requirements', facts: lines === null ? undefined : { requirements: String(lines) } })
            }
        }
        for (const entry of listing.entries) {
            const modulePath = joinRelative(base, entry.name)
            if (excludedSourcePath(modulePath) || entry.name.startsWith('.')) continue
            if (entry.kind === 'symlink') {
                if (await tree.kind(joinRelative(base, entry.name)) === 'symlink') collector.warn(`${modulePath} ist eine symbolische Verknüpfung und wird nicht als Modul gelesen.`)
                continue
            }
            if (entry.kind !== 'directory') continue
            const manifestKind = await tree.kind(joinRelative(modulePath, '__manifest__.py'))
            if (manifestKind === 'missing') {
                if (await tree.kind(joinRelative(modulePath, '__openerp__.py')) !== 'missing') collector.warn(`${modulePath} hat nur __openerp__.py; Odoo ${major ?? '19/20'} lädt ausschließlich __manifest__.py.`)
                continue
            }
            if (seen.has(entry.name)) { collector.warn(`Modul ${entry.name} existiert in mehreren Addons-Pfaden; Odoo verwendet den ersten Fund.`); continue }
            seen.add(entry.name)
            if (modules.length >= INSPECT_LIMITS.modules) { collector.limitReached = true; break }
            modules.push(await inspectOdooModule(tree, modulePath, entry.name, major, collector, xmlBudget))
        }
    }
    for (const configured of odoo?.modules ?? []) if (!seen.has(configured)) collector.warn(`Konfiguriertes Modul ${configured} wurde in den Addons-Pfaden nicht gefunden.`)
    const external = new Set<string>()
    for (const module of modules) for (const dependency of module.depends) if (!seen.has(dependency)) external.add(dependency)
    if (external.size) {
        if (odooSource) {
            const unresolved: string[] = []
            for (const dependency of [...external].sort().slice(0, 200)) {
                if (!/^[a-z0-9_]{1,100}$/.test(dependency)) { unresolved.push(dependency); continue }
                const found = await odooSource.kind(`addons/${dependency}/__manifest__.py`) === 'file' || await odooSource.kind(`odoo/addons/${dependency}/__manifest__.py`) === 'file'
                if (!found) unresolved.push(dependency)
            }
            if (unresolved.length) collector.warn(`Abhängigkeiten weder im Repository noch in den Odoo-Community-Quellen gefunden: ${unresolved.slice(0, 20).join(', ')}${unresolved.length > 20 ? ' …' : ''} (z. B. Enterprise oder fehlende Repositorys).`)
        } else collector.warn(`${external.size} Abhängigkeit(en) liegen außerhalb des Repositorys (z. B. Odoo-Standardmodule); ohne Odoo-Quellen im Projekt nicht prüfbar.`)
    }
    if (!modules.length) collector.warn('In den konfigurierten Addons-Pfaden wurde kein Odoo-Modul (__manifest__.py) gefunden.')
    return modules
}

export function pushBuildFile(buildFiles: BuildFile[], file: BuildFile) {
    if (buildFiles.length >= INSPECT_LIMITS.buildFiles) return
    if (file.facts) {
        const facts: Facts = {}
        for (const [key, value] of Object.entries(file.facts)) {
            if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/.test(key) || containsCredential(value)) continue
            facts[key] = text(value, 200)
        }
        file = Object.keys(facts).length ? { ...file, facts } : { path: file.path, kind: file.kind }
    }
    buildFiles.push(file)
}

/** First literal assignment such as `compileSdk = 35` or `minSdkVersion 24`; never evaluated. */
function gradleFact(source: string, pattern: RegExp): string | null {
    return pattern.exec(source)?.[1] ?? null
}

function gradleModuleDirectory(module: string): string {
    return module.replace(/^:/, '').split(':').join('/')
}

async function inspectAndroid(tree: SafeTree, settings: DevelopmentSettings, collector: Collector, buildFiles: BuildFile[]) {
    const android = settings.android
    const base = !android || android.projectDirectory === '.' ? '' : android.projectDirectory
    if (await tree.kind(base) !== 'directory') { collector.warn(`Android-Projektverzeichnis ${base || '.'} fehlt.`); return }
    let settingsFound = false
    for (const name of ['settings.gradle.kts', 'settings.gradle']) {
        const path = joinRelative(base, name), content = await tree.readText(path, INSPECT_LIMITS.textBytes)
        if (!content.ok) { if (content.reason !== 'missing') collector.warn(`${path} ${readFailureText[content.reason]}.`); continue }
        settingsFound = true
        const includes = content.text.match(/include\s*\(?\s*["']:[A-Za-z0-9_:-]+["']/g)?.length ?? 0
        const rootName = gradleFact(content.text, /rootProject\.name\s*=\s*["']([^"'\n]{1,100})["']/)
        pushBuildFile(buildFiles, { path, kind: 'gradle_settings', facts: { includes: String(includes), ...(rootName ? { rootProjectName: rootName } : {}) } })
    }
    if (!settingsFound) collector.warn('Keine settings.gradle(.kts) gefunden; Gradle-Projektwurzel prüfen.')
    const moduleDirectory = joinRelative(base, gradleModuleDirectory(android?.module ?? 'app'))
    for (const directory of [base, moduleDirectory]) {
        for (const name of ['build.gradle.kts', 'build.gradle']) {
            const path = joinRelative(directory, name), content = await tree.readText(path, INSPECT_LIMITS.textBytes)
            if (!content.ok) continue
            const facts: Facts = {}
            const source = content.text
            const fact = (key: string, pattern: RegExp) => { const value = gradleFact(source, pattern); if (value) facts[key] = value }
            fact('namespace', /namespace\s*=?\s*["']([A-Za-z0-9_.]{1,155})["']/)
            fact('applicationId', /applicationId\s*=?\s*["']([A-Za-z0-9_.]{1,155})["']/)
            fact('compileSdk', /compileSdk(?:Version)?\s*=?\s*\(?\s*([0-9]{1,3})\b/)
            fact('minSdk', /minSdk(?:Version)?\s*=?\s*\(?\s*([0-9]{1,3})\b/)
            fact('targetSdk', /targetSdk(?:Version)?\s*=?\s*\(?\s*([0-9]{1,3})\b/)
            fact('jvmToolchain', /jvmToolchain\s*\(\s*([0-9]{1,2})\s*\)/)
            fact('javaVersion', /JavaVersion\.VERSION_([0-9_]{1,5})/)
            fact('androidPluginVersion', /id\s*\(?\s*["']com\.android\.(?:application|library)["']\s*\)?\s*version\s*["']([0-9][0-9A-Za-z.+-]{0,40})["']/)
            pushBuildFile(buildFiles, { path, kind: 'gradle_build', facts })
            if (directory === moduleDirectory && android) {
                if (android.applicationId && facts.applicationId && facts.applicationId !== android.applicationId) collector.warn(`applicationId im Build (${facts.applicationId}) weicht von der Konfiguration (${android.applicationId}) ab.`)
                if (android.compileSdk && facts.compileSdk && Number(facts.compileSdk) !== android.compileSdk) collector.warn(`compileSdk im Build (${facts.compileSdk}) weicht von der Konfiguration (${android.compileSdk}) ab.`)
            }
        }
    }
    if (!buildFiles.some(file => file.kind === 'gradle_build' && file.path.startsWith(moduleDirectory ? `${moduleDirectory}/` : ''))) collector.warn(`Für das Modul ${android?.module ?? 'app'} wurde keine build.gradle(.kts) gefunden.`)
    const wrapperPath = joinRelative(base, 'gradle/wrapper/gradle-wrapper.properties')
    const wrapper = await tree.readText(wrapperPath, 64 * 1024)
    if (wrapper.ok) {
        const url = /^distributionUrl\s*=\s*(.+)$/m.exec(wrapper.text)?.[1]?.trim().replace(/\\:/g, ':') ?? null
        const version = url ? /gradle-([0-9][0-9A-Za-z.+-]{0,40})-(?:bin|all)\.zip$/.exec(url)?.[1] ?? null : null
        const trusted = !!url && /^https:\/\/services\.gradle\.org\/distributions\/gradle-[0-9A-Za-z.+-]+-(?:bin|all)\.zip$/.test(url)
        pushBuildFile(buildFiles, { path: wrapperPath, kind: 'gradle_wrapper', facts: {
            ...(version ? { gradleVersion: version } : {}),
            distributionHost: trusted ? 'services.gradle.org' : 'unbekannt',
            checksumPinned: /^distributionSha256Sum\s*=\s*[a-f0-9]{64}\s*$/m.test(wrapper.text) ? 'yes' : 'no',
        } })
        if (!trusted) collector.warn('gradle-wrapper.properties lädt Gradle nicht von https://services.gradle.org; vor einem Build prüfen.')
        const jar = await tree.kind(joinRelative(base, 'gradle/wrapper/gradle-wrapper.jar'))
        if (jar !== 'file') collector.warn('gradle-wrapper.jar fehlt oder ist keine reguläre Datei.')
    } else if (wrapper.reason !== 'missing') collector.warn(`${wrapperPath} ${readFailureText[wrapper.reason]}.`)
    const catalogPath = joinRelative(base, 'gradle/libs.versions.toml')
    const catalog = await tree.readText(catalogPath, INSPECT_LIMITS.textBytes)
    if (catalog.ok) {
        const facts: Facts = {}
        for (const key of ['agp', 'kotlin', 'composeBom', 'androidGradlePlugin']) {
            const value = new RegExp(`^${key}\\s*=\\s*"([0-9][0-9A-Za-z.+-]{0,40})"`, 'm').exec(catalog.text)?.[1]
            if (value) facts[key] = value
        }
        pushBuildFile(buildFiles, { path: catalogPath, kind: 'version_catalog', facts })
    }
    const manifestPath = joinRelative(moduleDirectory, 'src/main/AndroidManifest.xml')
    const manifest = await tree.readText(manifestPath, INSPECT_LIMITS.xmlBytes)
    if (manifest.ok) {
        const xml = inspectXml(manifest.text)
        pushBuildFile(buildFiles, { path: manifestPath, kind: 'android_manifest', facts: { wellFormed: xml.wellFormed === null ? 'unchecked' : xml.wellFormed ? 'yes' : 'no', ...(xml.root ? { root: xml.root } : {}) } })
        if (xml.wellFormed === false) collector.warn(`AndroidManifest.xml nicht wohlgeformt (${xml.reason}).`)
    }
}

async function findDirectories(tree: SafeTree, base: string, suffixes: string[], depth: number, collector: Collector, found: string[] = []): Promise<string[]> {
    if (depth < 0 || found.length >= 50) return found
    const listing = await tree.list(base, 2000)
    if (typeof listing === 'string') return found
    for (const entry of listing.entries) {
        const path = joinRelative(base, entry.name)
        if (excludedSourcePath(path) || entry.kind !== 'directory' || ['build', 'DerivedData', 'Pods', '.build'].includes(entry.name)) continue
        if (suffixes.some(suffix => entry.name.endsWith(suffix))) { found.push(path); continue }
        await findDirectories(tree, path, suffixes, depth - 1, collector, found)
    }
    return found
}

async function inspectIos(tree: SafeTree, settings: DevelopmentSettings, collector: Collector, buildFiles: BuildFile[]) {
    const ios = settings.ios
    const base = !ios || ios.projectDirectory === '.' ? '' : ios.projectDirectory
    if (await tree.kind(base) !== 'directory') { collector.warn(`iOS-Projektverzeichnis ${base || '.'} fehlt.`); return }
    const containers = await findDirectories(tree, base, ['.xcodeproj', '.xcworkspace'], 3, collector)
    const schemes = new Set<string>()
    for (const container of containers) {
        if (container.endsWith('.xcworkspace')) { if (!container.endsWith('.xcodeproj/project.xcworkspace')) pushBuildFile(buildFiles, { path: container, kind: 'xcworkspace' }); continue }
        const facts: Facts = {}
        const pbx = await tree.readText(`${container}/project.pbxproj`, INSPECT_LIMITS.pbxprojBytes)
        if (pbx.ok) {
            const values = (key: string) => [...new Set([...pbx.text.matchAll(new RegExp(`\\b${key} = "?([A-Za-z0-9_.$(){}-]{1,120})"?;`, 'g'))].map(match => match[1]))].slice(0, 8).join(', ')
            for (const key of ['IPHONEOS_DEPLOYMENT_TARGET', 'PRODUCT_BUNDLE_IDENTIFIER', 'SWIFT_VERSION', 'MARKETING_VERSION', 'SDKROOT']) {
                const value = values(key)
                if (value) facts[key.toLowerCase().replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())] = value
            }
            facts.nativeTargets = String(pbx.text.match(/isa = PBXNativeTarget;/g)?.length ?? 0)
        } else collector.warn(`${container}/project.pbxproj ${readFailureText[pbx.reason]}.`)
        const schemeListing = await tree.list(`${container}/xcshareddata/xcschemes`, 200)
        if (typeof schemeListing !== 'string') {
            for (const entry of schemeListing.entries) if (entry.kind === 'file' && entry.name.endsWith('.xcscheme')) schemes.add(entry.name.slice(0, -'.xcscheme'.length))
        }
        pushBuildFile(buildFiles, { path: container, kind: 'xcodeproj', facts })
    }
    if (schemes.size) pushBuildFile(buildFiles, { path: base || '.', kind: 'other', facts: { sharedSchemes: [...schemes].sort().slice(0, 20).join(', ') } })
    if (ios?.scheme && containers.length && !schemes.has(ios.scheme)) collector.warn(`Das Scheme ${ios.scheme} ist nicht als geteiltes Scheme (xcshareddata) eingecheckt; CI und Xcode Cloud sehen nur geteilte Schemes.`)
    if (ios?.projectFile && await tree.kind(ios.projectFile) === 'missing') collector.warn(`Konfigurierte Projektdatei ${ios.projectFile} fehlt.`)
    const packagePath = joinRelative(base, 'Package.swift')
    const pkg = await tree.readText(packagePath, INSPECT_LIMITS.textBytes)
    if (pkg.ok) {
        const facts: Facts = {}
        const tools = /^\/\/\s*swift-tools-version:\s*([0-9]+(?:\.[0-9]+){0,2})/m.exec(pkg.text)?.[1]
        if (tools) facts.toolsVersion = tools
        const platforms = [...pkg.text.matchAll(/\.(iOS|macOS|tvOS|watchOS|visionOS|macCatalyst)\(\s*(?:\.v([0-9_]+)|"([0-9.]+)")/g)].map(match => `${match[1]} ${match[2] ?? match[3]}`)
        if (platforms.length) facts.platforms = platforms.slice(0, 6).join(', ')
        // Linux testability: targets whose sources import Apple-only frameworks cannot build on Linux.
        const appleOnly = new Set<string>(), portable = new Set<string>()
        let swiftFiles = 0
        for (const root of ['Sources', 'Tests']) {
            const listing = await tree.list(joinRelative(base, root), 500)
            if (typeof listing === 'string') continue
            for (const target of listing.entries.filter(entry => entry.kind === 'directory')) {
                let apple = false
                const scan = async (relative: string, depth: number): Promise<void> => {
                    if (apple || depth > 6 || swiftFiles >= INSPECT_LIMITS.swiftFiles) return
                    const files = await tree.list(relative, 1000)
                    if (typeof files === 'string') return
                    for (const file of files.entries) {
                        const path = joinRelative(relative, file.name)
                        if (excludedSourcePath(path)) continue
                        if (file.kind === 'directory') await scan(path, depth + 1)
                        else if (file.kind === 'file' && file.name.endsWith('.swift') && swiftFiles++ < INSPECT_LIMITS.swiftFiles) {
                            const source = await tree.readText(path, 256 * 1024)
                            if (source.ok && APPLE_ONLY_IMPORTS.test(source.text)) { apple = true; return }
                        }
                        if (apple) return
                    }
                }
                await scan(joinRelative(base, root, target.name), 0)
                ;(apple ? appleOnly : portable).add(target.name)
            }
        }
        if (swiftFiles >= INSPECT_LIMITS.swiftFiles) collector.limitReached = true
        if (appleOnly.size) facts.appleOnlyTargets = [...appleOnly].sort().slice(0, 20).join(', ')
        if (portable.size) facts.linuxCandidateTargets = [...portable].sort().slice(0, 20).join(', ')
        pushBuildFile(buildFiles, { path: packagePath, kind: 'swiftpm', facts })
        if (appleOnly.size) collector.warn(`Targets mit UIKit/SwiftUI/AppKit-Importen sind unter Linux nicht baubar oder testbar: ${[...appleOnly].sort().slice(0, 10).join(', ')}.`)
    } else if (pkg.reason !== 'missing') collector.warn(`${packagePath} ${readFailureText[pkg.reason]}.`)
    if (!containers.length && !pkg.ok) collector.warn('Weder .xcodeproj/.xcworkspace noch Package.swift im iOS-Projektverzeichnis gefunden.')
    for (const name of ['PrivacyInfo.xcprivacy']) {
        const found = await findFile(tree, base, name, 4)
        for (const path of found) pushBuildFile(buildFiles, { path, kind: 'privacy_manifest' })
    }
}

async function findFile(tree: SafeTree, base: string, name: string, depth: number, found: string[] = []): Promise<string[]> {
    if (depth < 0 || found.length >= 20) return found
    const listing = await tree.list(base, 2000)
    if (typeof listing === 'string') return found
    for (const entry of listing.entries) {
        const path = joinRelative(base, entry.name)
        if (excludedSourcePath(path) || ['build', 'DerivedData', 'Pods', '.build', 'node_modules'].includes(entry.name)) continue
        if (entry.kind === 'file' && entry.name === name) found.push(path)
        else if (entry.kind === 'directory') await findFile(tree, path, name, depth - 1, found)
    }
    return found
}

export async function inspectWorkflows(tree: SafeTree, buildFiles: BuildFile[]) {
    const listing = await tree.list('.github/workflows', 100)
    if (typeof listing === 'string') return
    for (const entry of listing.entries) {
        if (entry.kind !== 'file' || !/\.ya?ml$/.test(entry.name)) continue
        const path = `.github/workflows/${entry.name}`
        if (excludedSourcePath(path)) continue
        const content = await tree.readText(path, INSPECT_LIMITS.textBytes)
        const facts: Facts = {}
        if (content.ok) {
            const name = /^name:\s*["']?([^"'\n]{1,100})["']?\s*$/m.exec(content.text)?.[1]
            if (name) facts.name = name
            const runners = [...new Set([...content.text.matchAll(/runs-on:\s*["']?([A-Za-z0-9_.-]{1,60})/g)].map(match => match[1]))]
            if (runners.length) facts.runsOn = runners.slice(0, 6).join(', ')
        }
        pushBuildFile(buildFiles, { path, kind: 'ci_workflow', facts })
    }
}

export const INSPECT_TIME_LIMIT_MS = 35_000

export type InspectInput = {
    /** Overall time budget (default 35 s). */
    timeLimitMs?: number
    checkout: string
    repositoryId: string
    mode: SpecializedDevelopmentMode
    settings: DevelopmentSettings
    /** Optional project-owned Odoo source checkout used to resolve core dependencies. */
    odooSourceDirectory?: string | null
    now?: () => number
}

/** Static, read-only inventory of an authorised checkout. Never runs Git, Gradle, Xcode, Swift or Python. */
export async function inspectRepository(input: InspectInput): Promise<DevelopmentInspectResult> {
    const now = input.now ?? Date.now
    const base: DevelopmentInspectResult = {
        contractVersion: DEVELOPMENT_CONTRACT_VERSION, mode: input.mode, repositoryId: input.repositoryId, observedAt: now(),
        head: null, branch: null, state: 'ready', odooModules: [], buildFiles: [], warnings: [], scanned: { files: 0, directories: 0, limitReached: false },
    }
    // Below the Hub's 45 s RPC timeout: stop starting I/O and return a marked partial result.
    const limits = { reads: 4000, bytes: 64 * 1024 * 1024, entries: 50_000, deadline: Date.now() + (input.timeLimitMs ?? INSPECT_TIME_LIMIT_MS) }
    const tree = await SafeTree.open(input.checkout, limits)
    if (typeof tree === 'string') {
        return { ...base, state: tree === 'missing' ? 'missing' : 'blocked',
            message: tree === 'missing' ? 'Das Repository ist noch nicht in den Projektordner geklont.' : `Der Checkout ${readFailureText[tree]}; die Analyse wurde nicht ausgeführt.` }
    }
    const collector = new Collector()
    const git = await readGitHead(tree)
    if (git.note) collector.warn(git.note)
    const buildFiles: BuildFile[] = []
    let odooModules: OdooModuleInventory[] = []
    if (input.mode === 'odoo') {
        const source = input.odooSourceDirectory ? await SafeTree.open(input.odooSourceDirectory, { ...limits, reads: 400, entries: 5000 }) : null
        odooModules = await inspectOdoo(tree, input.settings, collector, buildFiles, typeof source === 'string' ? null : source)
    } else if (input.mode === 'android') await inspectAndroid(tree, input.settings, collector, buildFiles)
    else await inspectIos(tree, input.settings, collector, buildFiles)
    await inspectWorkflows(tree, buildFiles)
    if (tree.timedOut) collector.warn('Zeitlimit der Analyse erreicht; weitere Dateien wurden nicht gelesen.')
    if (tree.exhausted) collector.limitReached = true
    if (collector.limitReached) collector.warn('Analysegrenze erreicht; das Ergebnis ist unvollständig.')
    return { ...base, head: git.head, branch: git.branch ? text(git.branch, 255) : null, odooModules, buildFiles, warnings: collector.warnings,
        scanned: { ...tree.scanned, limitReached: collector.limitReached } }
}
