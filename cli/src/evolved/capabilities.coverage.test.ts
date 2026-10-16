import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { EVOLVED_CAPABILITIES } from './capabilities'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const capabilities = Object.values(EVOLVED_CAPABILITIES)

function source(path: string): ts.SourceFile {
    return ts.createSourceFile(path, readFileSync(resolve(repositoryRoot, path), 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
    inspect(node)
    ts.forEachChild(node, child => visit(child, inspect))
}

function unwrap(node: ts.Expression): ts.Expression {
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression
    return node
}

function literal(node: ts.Node | undefined): string {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
    throw new Error(`Inventory needs an explicit string: ${node?.getText() ?? '<missing>'}`)
}

function sorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort()
}

/** Follow called create*Routes factory imports, not a copy of the composition's module list. */
function registeredRouteModules(readSource: (path: string) => ts.SourceFile = source): string[] {
    const pending = ['hub/src/evolved/runtime.ts'], visited = new Set<string>(), modules = new Set<string>()
    while (pending.length) {
        const path = pending.pop()!
        if (visited.has(path)) continue
        visited.add(path)
        const file = readSource(path), imports = new Map<string, { name: string; module: string }>(), namespaces = new Map<string, string>()
        for (const statement of file.statements) {
            if (!ts.isImportDeclaration(statement)) continue
            const defaultImport = statement.importClause?.name
            if (defaultImport) imports.set(defaultImport.text, { name: defaultImport.text, module: literal(statement.moduleSpecifier) })
            const bindings = statement.importClause?.namedBindings
            if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, literal(statement.moduleSpecifier))
            if (!bindings || !ts.isNamedImports(bindings)) continue
            for (const binding of bindings.elements) imports.set(binding.name.text, {
                name: binding.propertyName?.text ?? binding.name.text,
                module: literal(statement.moduleSpecifier),
            })
        }
        visit(file, node => {
            if (!ts.isCallExpression(node)) return
            const expression = node.expression
            let imported = ts.isIdentifier(expression) ? imports.get(expression.text) : undefined
            if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
                const module = namespaces.get(expression.expression.text)
                if (module) imported = { name: expression.name.text, module }
            }
            if (!imported || !(/^create.*Routes$/.test(imported.name) || imported.name === 'createGithubGitTransport')) return
            if (!imported.module.startsWith('.')) throw new Error(`Inspect external route factory ${path}: ${imported.module}`)
            const importedPath = relative(repositoryRoot, resolve(repositoryRoot, dirname(path), imported.module.replace(/\.(?:js|ts)$/, '') + '.ts')).split('\\').join('/')
            modules.add(importedPath)
            pending.push(importedPath)
        })
    }
    return sorted(modules)
}

function registeredToolNames(file: ts.SourceFile): string[] {
    const names: string[] = []
    visit(file, node => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'registerTool') return
        const argument = node.arguments[0]
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
            names.push(argument.text)
            return
        }
        // The Codex bridge registers [name, schema] tuples. Read their real names;
        // do not whitelist today's spawn_peer/archive_peer pair in the collector.
        if (argument && ts.isIdentifier(argument)) {
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
                if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)) continue
                const binding = parent.initializer.declarations[0]?.name
                const index = binding && ts.isArrayBindingPattern(binding)
                    ? binding.elements.findIndex(element => ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === argument.text)
                    : -1
                const direct = binding && ts.isIdentifier(binding) && binding.text === argument.text
                if (index < 0 && !direct) continue
                const entries = unwrap(parent.expression)
                if (!ts.isArrayLiteralExpression(entries)) break
                for (const entry of entries.elements) {
                    const value = unwrap(entry)
                    if (direct) names.push(literal(value))
                    else if (ts.isArrayLiteralExpression(value)) names.push(literal(value.elements[index]))
                    else throw new Error(`Inventory needs explicit tool tuples in ${file.fileName}`)
                }
                return
            }
        }
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        throw new Error(`Unresolved tool registration at ${file.fileName}:${line}; extend the inventory collector instead of skipping it`)
    })
    return sorted(names)
}

function productionSources(directory: string): string[] {
    return readdirSync(resolve(repositoryRoot, directory), { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return productionSources(path)
        return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec|d)\.tsx?$/.test(entry.name) ? [path] : []
    })
}

function workspaceTabs(): string[] {
    const file = source('web/src/evolved/workspaceNavigation.tsx')
    let tabs: string[] | undefined
    visit(file, node => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== 'workspacePages' || !node.initializer) return
        const pages = unwrap(node.initializer)
        if (!ts.isArrayLiteralExpression(pages)) throw new Error('Inspect dynamic workspacePages inventory')
        tabs = pages.elements.map(page => {
            if (!ts.isObjectLiteralExpression(page)) throw new Error('Inspect dynamic workspace page')
            const id = page.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(file) === 'id')
            return literal(id && ts.isPropertyAssignment(id) ? id.initializer : undefined)
        })
    })
    if (!tabs?.length) throw new Error('workspacePages inventory was not found')
    return sorted(tabs)
}

describe('Evolved capability surface inventory (not prose or individual API-route completeness)', () => {
    it('covers every feature module called by the real Hub route composition, including nested factories', () => {
        expect(sorted(capabilities.flatMap(capability => [...capability.routeModules]))).toEqual(registeredRouteModules())
    })

    it('covers the real workspace navigation without importing the browser runtime', () => {
        expect(sorted(capabilities.flatMap(capability => [...capability.workspaceTabs]))).toEqual(workspaceTabs())
    })

    it('covers registrations in supported agent adapters and shared CLI modules, including conditional tools', () => {
        // Only Claude and Codex are supported Evolved adapters. Reading source
        // inventories every gate without opening an MCP server or a credential.
        const paths = ['cli/src/claude', 'cli/src/codex', 'cli/src/evolved', 'cli/src/modules'].flatMap(productionSources)
        const names = paths.flatMap(path => {
            const file = source(path)
            return /\bregisterTool\b/.test(file.text) ? registeredToolNames(file) : []
        })
        expect(sorted(capabilities.flatMap(capability => [...capability.tools]))).toEqual(sorted(names))
    })

    it('detects future tuple registrations and fails on unresolved dynamic tool names', () => {
        const parse = (text: string) => ts.createSourceFile('inventory-example.ts', text, ts.ScriptTarget.Latest, true)
        expect(registeredToolNames(parse(`for (const [name, schema] of [['future_tool', {}]] as const) server.registerTool(name, schema, callback)`))).toEqual(['future_tool'])
        expect(() => registeredToolNames(parse('server.registerTool(nameFromRuntime(), schema, callback)'))).toThrow('Unresolved tool registration')
    })

    it('discovers new called feature factories and nested aliases without a hardcoded module list', () => {
        const files: Record<string, string> = {
            'hub/src/evolved/runtime.ts': `import { createFutureRoutes as wire, createUnusedRoutes } from './future'; wire()`,
            'hub/src/evolved/future.ts': `import * as child from './child'; child.createChildRoutes()`,
            'hub/src/evolved/child.ts': 'export function createChildRoutes() {}',
        }
        expect(registeredRouteModules(path => {
            if (!(path in files)) throw new Error(`Unexpected inventory lookup: ${path}`)
            return ts.createSourceFile(path, files[path], ts.ScriptTarget.Latest, true)
        })).toEqual(['hub/src/evolved/child.ts', 'hub/src/evolved/future.ts'])
    })

    it('keeps the human-only side channel distinct from agent peer communication', () => {
        expect(EVOLVED_CAPABILITIES.sidechannel.access).toBe('browser')
        expect(EVOLVED_CAPABILITIES.sidechannel.tools).toEqual([])
        expect(EVOLVED_CAPABILITIES.peers.tools).toEqual(expect.arrayContaining(['list_peers', 'search_peers', 'inspect_peer', 'ping_peer', 'spawn_peer', 'archive_peer']))
    })
})
