import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
    DEVELOPMENT_MODULE_API_VERSION,
    developmentModuleCanonicalJson,
    developmentModuleSupportIssues,
    type DevelopmentModuleDefinition,
} from '@hapi/protocol/developmentModules'
import { PLUGIN_MANIFEST_FILE, PLUGIN_MAX_BYTES, validatePluginManifestSource, type PluginManifest, type PluginManifestIssue } from '@hapi/protocol/pluginManifest'
import { runnerDevelopmentProvider } from './providers'

/**
 * Offline author tooling for `hapi-evolved.plugin.json`: the same shared schema the Hub installer uses, readable path
 * issues, the module digests the Hub preview will show and honest support information. Reads one local file
 * (bounded); never fetches, installs or executes anything.
 */

export const PLUGIN_VALIDATE_USAGE = `hapi evolved plugin validate [<plugin-directory-or-manifest-file>]

Validates a local ${PLUGIN_MANIFEST_FILE} (default: ./${PLUGIN_MANIFEST_FILE}) with the schema of the Hub installer.
Prints each development module with the digest the installation preview will show. Offline: nothing is fetched,
installed or executed. Exit code 1 when the manifest is invalid.`

/**
 * Same-plugin agents/skills that shape a module task's assignment. Mirrors hub/src/evolved/developmentModules.ts
 * `pluginModuleDependencies`; a test computes both digests for the same manifest so they cannot drift silently.
 */
export function pluginModuleDependencies(manifest: Pick<PluginManifest, 'agents' | 'skills'>, definition: Pick<DevelopmentModuleDefinition, 'tasks'>) {
    const referenced = new Set(definition.tasks.map(task => task.specialist).filter(id => !id.startsWith('builtin:')))
    const agents = manifest.agents.filter(agent => referenced.has(agent.id)).sort((a, b) => a.id.localeCompare(b.id))
    const skillIds = new Set(agents.flatMap(agent => agent.skills))
    return {
        agents: agents.map(agent => ({ id: agent.id, name: agent.name, instructions: agent.instructions, providerPreference: agent.providerPreference, model: agent.model ?? null, skills: agent.skills })),
        skills: manifest.skills.filter(skill => skillIds.has(skill.id)).sort((a, b) => a.id.localeCompare(b.id)).map(skill => ({ id: skill.id, name: skill.name, instructions: skill.instructions })),
    }
}

/** Module digest as computed by the Hub for installation previews and installed plugins (independent of the plugin UUID). */
export function pluginModuleDigest(manifest: PluginManifest, definition: DevelopmentModuleDefinition): string {
    const canonical = developmentModuleCanonicalJson({ apiVersion: DEVELOPMENT_MODULE_API_VERSION, id: definition.id, content: definition, dependencies: pluginModuleDependencies(manifest, definition) })
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export type PluginModuleReport = {
    id: string; title: string; contentVersion: string; digest: string
    /** `unsupported` = the Hub accepts the manifest but the module cannot be activated (unknown provider/version). */
    availability: 'supported' | 'unsupported'; reasons: string[]
    providers: Array<{ kind: 'doctor' | 'inspect'; id: string; version: number; runner: 'implemented' | 'not_implemented' }>
    counts: { fields: number; topics: number; recipes: number; tasks: number; checks: number; integrations: number }
}
export type PluginValidationReport =
    | { ok: true; file: string; manifest: Pick<PluginManifest, 'schemaVersion' | 'id' | 'name' | 'version'>; agents: number; skills: number; themes: number; developmentModules: PluginModuleReport[]; warnings: string[] }
    | { ok: false; file: string; issues: PluginManifestIssue[] }

export function moduleReport(manifest: PluginManifest, definition: DevelopmentModuleDefinition): PluginModuleReport {
    const reasons = developmentModuleSupportIssues(definition)
    const providers: PluginModuleReport['providers'] = []
    if (definition.doctor) providers.push({ kind: 'doctor', ...definition.doctor.provider, runner: runnerDevelopmentProvider(definition.doctor.provider, 'module_doctor') ? 'implemented' : 'not_implemented' })
    if (definition.inspect) providers.push({ kind: 'inspect', ...definition.inspect.provider, runner: runnerDevelopmentProvider(definition.inspect.provider, 'module_inspect') ? 'implemented' : 'not_implemented' })
    return {
        id: definition.id, title: definition.title, contentVersion: definition.contentVersion, digest: pluginModuleDigest(manifest, definition),
        availability: reasons.length ? 'unsupported' : 'supported', reasons, providers,
        counts: { fields: definition.fields.length, topics: definition.topics.length, recipes: definition.recipes.length, tasks: definition.tasks.length,
            checks: definition.doctor?.checks.length ?? 0, integrations: definition.integrations.length },
    }
}

/** Advisory findings that do not block installation. */
function warnings(file: string, manifest: PluginManifest, today: string): string[] {
    const found: string[] = []
    if (basename(file) !== PLUGIN_MANIFEST_FILE) found.push(`The installer reads only ${PLUGIN_MANIFEST_FILE} in the repository root; this file is named ${basename(file).slice(0, 80)}.`)
    manifest.developmentModules.forEach((module, moduleIndex) => {
        const base = `developmentModules.${moduleIndex}`
        for (const reason of developmentModuleSupportIssues(module)) found.push(`${base}: ${reason} Projects cannot activate this module.`)
        const sources: Array<[string, { verifiedAt: string }[]]> = [
            ...module.topics.map((topic, index) => [`${base}.topics.${index}.sources`, topic.sources] as [string, { verifiedAt: string }[]]),
            ...module.recipes.map((recipe, index) => [`${base}.recipes.${index}.sources`, recipe.sources] as [string, { verifiedAt: string }[]]),
            ...module.integrations.map((integration, index) => [`${base}.integrations.${index}.sources`, integration.sources] as [string, { verifiedAt: string }[]]),
        ]
        for (const [path, list] of sources) list.forEach((source, index) => {
            if (source.verifiedAt > today) found.push(`${path}.${index}.verifiedAt ${source.verifiedAt} lies in the future.`)
        })
    })
    return found.slice(0, 64)
}

/** Resolves a directory to its manifest file and reads at most PLUGIN_MAX_BYTES + 1 bytes. */
export function readPluginManifestFile(target: string): { file: string; source: string } | { file: string; issue: string } {
    let file = resolve(target)
    try { if (statSync(file).isDirectory()) file = join(file, PLUGIN_MANIFEST_FILE) } catch { return { file, issue: 'File not found.' } }
    let fd: number
    // O_NONBLOCK: opening a FIFO without writer must not block; the type is checked on the opened descriptor.
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0)) } catch { return { file, issue: 'File not found or not readable.' } }
    try {
        const info = fstatSync(fd)
        if (!info.isFile()) return { file, issue: 'Not a regular file.' }
        if (info.size > PLUGIN_MAX_BYTES) return { file, issue: 'Plugin manifest exceeds 512 KiB.' }
        const buffer = Buffer.alloc(PLUGIN_MAX_BYTES + 1)
        let length = 0
        for (let read = 1; read > 0 && length < buffer.length;) { read = readSync(fd, buffer, length, buffer.length - length, length); length += read }
        if (length > PLUGIN_MAX_BYTES) return { file, issue: 'Plugin manifest exceeds 512 KiB.' }
        // Strict like the Hub installer: invalid UTF-8 is an error, never silently replaced.
        try { return { file, source: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) } }
        catch { return { file, issue: 'Plugin manifest must be valid UTF-8.' } }
    } finally { closeSync(fd) }
}

export function validatePluginManifestFile(target: string, today = new Date().toISOString().slice(0, 10)): PluginValidationReport {
    const read = readPluginManifestFile(target)
    if ('issue' in read) return { ok: false, file: read.file, issues: [{ path: '', message: read.issue }] }
    const result = validatePluginManifestSource(read.source)
    if (!result.ok) return { ok: false, file: read.file, issues: result.issues }
    const manifest = result.manifest
    return {
        ok: true, file: read.file,
        manifest: { schemaVersion: manifest.schemaVersion, id: manifest.id, name: manifest.name, version: manifest.version },
        agents: manifest.agents.length, skills: manifest.skills.length, themes: manifest.themes.length,
        developmentModules: manifest.developmentModules.map(definition => moduleReport(manifest, definition)),
        warnings: warnings(read.file, manifest, today),
    }
}

/** Loads one module definition from a local manifest for offline doctor/inspect (`--definition`, `--module`). */
export function loadLocalModule(target: string, localId?: string): { file: string; manifest: PluginManifest; definition: DevelopmentModuleDefinition } {
    const read = readPluginManifestFile(target)
    if ('issue' in read) throw new Error(`${read.file}: ${read.issue}`)
    const result = validatePluginManifestSource(read.source)
    if (!result.ok) throw new Error(`${read.file} is not a valid plugin manifest: ${result.issues.slice(0, 5).map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}. Run hapi evolved plugin validate for all issues.`)
    const modules = result.manifest.developmentModules
    if (!modules.length) throw new Error(`${read.file} contains no developmentModules`)
    const definition = localId === undefined ? (modules.length === 1 ? modules[0] : undefined) : modules.find(module => module.id === localId)
    if (!definition) throw new Error(localId === undefined ? `Choose a module with --module (${modules.map(module => module.id).join(', ')})` : `Module ${localId.slice(0, 64)} is not defined in ${read.file}`)
    return { file: read.file, manifest: result.manifest, definition }
}
