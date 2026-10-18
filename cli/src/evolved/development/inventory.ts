import { excludedSourcePath } from '@hapi/protocol/evolvedSourcePolicy'
import type { DevelopmentModuleInspectResult } from '@hapi/protocol/developmentModules'
import { RepoSubdirectorySchema } from '@hapi/protocol/evolvedDevelopment'
import { INSPECT_TIME_LIMIT_MS, inspectWorkflows, pushBuildFile, readGitHead } from './inspect'
import { joinRelative, readFailureText, SafeTree } from './safeTree'

/**
 * Provider `hapi.repository-inventory` v1 for development modules: a static, bounded inventory of the authorised
 * checkout. It reports which well-known project files exist directly in the module's directory, counts files by
 * extension below it, lists GitHub Actions workflows and reads HEAD from the Git files. It never parses project
 * files beyond that, never runs Git or project code and never returns file contents. The file list, limits and
 * skipped directories are host-owned; module data only selects the subdirectory (a validated `repo_path` value).
 */

/** Well-known project files looked up directly in the subdirectory (existence only, never parsed). */
export const INVENTORY_PROJECT_FILES: Readonly<Record<string, string>> = Object.freeze({
    'package.json': 'node', 'pnpm-lock.yaml': 'node', 'yarn.lock': 'node', 'package-lock.json': 'node', 'bun.lock': 'node',
    'pyproject.toml': 'python', 'requirements.txt': 'python', 'setup.py': 'python', 'setup.cfg': 'python', 'Pipfile': 'python', 'uv.lock': 'python', 'poetry.lock': 'python', 'manage.py': 'python',
    'Gemfile': 'ruby', 'go.mod': 'go', 'Cargo.toml': 'rust', 'composer.json': 'php',
    'pom.xml': 'jvm', 'build.gradle': 'jvm', 'build.gradle.kts': 'jvm', 'settings.gradle': 'jvm', 'settings.gradle.kts': 'jvm',
    'Package.swift': 'swift', 'pubspec.yaml': 'dart', 'mix.exs': 'elixir', 'CMakeLists.txt': 'cmake', 'Makefile': 'make',
    'Dockerfile': 'container', 'compose.yaml': 'container', 'docker-compose.yml': 'container',
})
/** Generated, vendored or tool directories that are not walked (in addition to the shared source policy). */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
    'build', 'dist', 'target', 'out', '.gradle', '.idea', '.vscode', 'Pods', 'DerivedData', '.build', '.dart_tool', 'vendor', '.hapi', 'coverage', '.next', '.nuxt'])
export const INVENTORY_LIMITS = Object.freeze({ depth: 6, files: 5000, directoryEntries: 2000, extensions: 8, buildFiles: 120 })

export type InventoryInput = {
    checkout: string
    repositoryId: string
    /** `repo_path` value of the module (`.` = repository root). */
    subdirectory: string
    timeLimitMs?: number
    now?: () => number
}
export type InventoryReport = Pick<DevelopmentModuleInspectResult, 'repositoryId' | 'observedAt' | 'head' | 'branch' | 'state' | 'message' | 'odooModules' | 'buildFiles' | 'warnings' | 'scanned'>
type BuildFile = DevelopmentModuleInspectResult['buildFiles'][number]

const text = (value: string, max: number) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, max)

export async function inventoryRepository(input: InventoryInput): Promise<InventoryReport> {
    const now = input.now ?? Date.now
    const base: InventoryReport = { repositoryId: input.repositoryId, observedAt: now(), head: null, branch: null, state: 'ready', odooModules: [], buildFiles: [], warnings: [], scanned: { files: 0, directories: 0, limitReached: false } }
    const subdirectory = RepoSubdirectorySchema.safeParse(input.subdirectory)
    if (!subdirectory.success) return { ...base, state: 'blocked', message: 'Das Modulverzeichnis ist kein gültiger Repository-Pfad; die Analyse wurde nicht ausgeführt.' }
    const relative = subdirectory.data === '.' ? '' : subdirectory.data
    const tree = await SafeTree.open(input.checkout, { reads: 400, bytes: 8 * 1024 * 1024, entries: 20_000, deadline: Date.now() + Math.min(input.timeLimitMs ?? INSPECT_TIME_LIMIT_MS, INSPECT_TIME_LIMIT_MS) })
    if (typeof tree === 'string') {
        return { ...base, state: tree === 'missing' ? 'missing' : 'blocked',
            message: tree === 'missing' ? 'Das Repository ist noch nicht in den Projektordner geklont.' : `Der Checkout ${readFailureText[tree]}; die Analyse wurde nicht ausgeführt.` }
    }
    const warnings: string[] = [], warn = (message: string) => { if (warnings.length < 50) warnings.push(text(message, 300)) }
    let limitReached = false
    const git = await readGitHead(tree)
    if (git.note) warn(git.note)
    const buildFiles: BuildFile[] = []
    const label = relative || '.'
    if (relative && excludedSourcePath(relative)) warn(`Das Modulverzeichnis ${label} ist ein geschützter Pfad und wird nicht gelesen.`)
    else {
        const listing = await tree.list(relative, INVENTORY_LIMITS.directoryEntries)
        if (typeof listing === 'string') warn(listing === 'missing' ? `Das Modulverzeichnis ${label} fehlt im Checkout.` : `Das Modulverzeichnis ${label} ${readFailureText[listing]}.`)
        else {
            if (listing.truncated) limitReached = true
            for (const entry of listing.entries) {
                const ecosystem = Object.hasOwn(INVENTORY_PROJECT_FILES, entry.name) ? INVENTORY_PROJECT_FILES[entry.name] : null
                if (!ecosystem) continue
                const path = joinRelative(relative, entry.name)
                if (excludedSourcePath(path)) continue
                if (entry.kind === 'file') pushBuildFile(buildFiles, { path, kind: 'other', facts: { projectFile: entry.name, ecosystem } })
                else if (entry.kind === 'symlink') warn(`${path} ${readFailureText.symlink}.`)
            }
            const counts = await countExtensions(tree, relative)
            if (counts.limitReached) limitReached = true
            const top = [...counts.byExtension].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).slice(0, INVENTORY_LIMITS.extensions)
            if (top.length || counts.total) {
                pushBuildFile(buildFiles, { path: label, kind: 'other', facts: { inventory: 'file_counts', files: String(counts.total), depth: String(INVENTORY_LIMITS.depth),
                    ...Object.fromEntries(top.map(([extension, count]) => [`ext.${extension}`, String(count)])) } })
            }
        }
    }
    await inspectWorkflows(tree, buildFiles)
    if (tree.timedOut) warn('Zeitlimit der Analyse erreicht; weitere Dateien wurden nicht gelesen.')
    if (tree.exhausted) limitReached = true
    if (limitReached) warn('Analysegrenze erreicht; das Ergebnis ist unvollständig.')
    return { ...base, head: git.head, branch: git.branch ? text(git.branch, 255) : null, buildFiles: buildFiles.slice(0, INVENTORY_LIMITS.buildFiles), warnings, scanned: { ...tree.scanned, limitReached } }
}

/** Counts regular files by lower-case extension; symlinks, special files, protected and skipped directories are not followed. */
async function countExtensions(tree: SafeTree, root: string): Promise<{ total: number; byExtension: Map<string, number>; limitReached: boolean }> {
    const byExtension = new Map<string, number>()
    let total = 0, limitReached = false
    const visit = async (relative: string, depth: number): Promise<void> => {
        if (limitReached) return
        if (depth > INVENTORY_LIMITS.depth) { limitReached = true; return }
        const listing = await tree.list(relative, INVENTORY_LIMITS.directoryEntries)
        if (typeof listing === 'string') return
        if (listing.truncated) limitReached = true
        for (const entry of listing.entries) {
            const path = joinRelative(relative, entry.name)
            if (excludedSourcePath(path) || entry.kind === 'symlink' || entry.kind === 'special') continue
            if (entry.kind === 'directory') { if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path, depth + 1); if (limitReached) return; continue }
            if (++total > INVENTORY_LIMITS.files) { total = INVENTORY_LIMITS.files; limitReached = true; return }
            const extension = /\.([a-z0-9]{1,10})$/.exec(entry.name.toLowerCase())?.[1]
            if (extension && entry.name.length > extension.length + 1) byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1)
        }
    }
    await visit(root, 0)
    return { total, byExtension, limitReached }
}
