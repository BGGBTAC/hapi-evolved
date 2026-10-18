import { describe, expect, test } from 'bun:test'
import {
    DEVELOPMENT_MODULE_LIMITS, DevelopmentModuleDefinitionSchema, DevelopmentModuleSettingsSchema, DevelopmentModuleViewSchema, applicableModuleItems, developmentModuleDefaults,
    developmentModuleSupportIssues, developmentSettingsToModuleSettings, developmentTaskEffects, developmentTaskRequiresWritableProfile, moduleSettingsToDevelopmentSettings, parseDevelopmentModuleId, validateDevelopmentModuleValues,
    type DevelopmentModuleDefinitionInput, type DevelopmentModuleField,
} from './developmentModules'
import { builtinDevelopmentModuleView } from './developmentModuleBuiltins'
import { applicablePack } from './developmentPacks'
import { defaultAndroidSettings, defaultDevelopmentSettings, defaultIosSettings, defaultOdooSettings, type DevelopmentSettings } from './evolvedDevelopment'
import { validatePluginManifestSource, type PluginManifestInput } from './pluginManifest'

const source = { title: 'Docs', url: 'https://example.com/docs', verifiedAt: '2026-10-17' }
function moduleFixture(id = 'flutter'): DevelopmentModuleDefinitionInput {
    return {
        apiVersion: 1, id, title: 'Flutter', summary: 'Flutter apps', contentVersion: '2026.10.17-1', brief: ['Uses pubspec.yaml.'],
        fields: [
            { id: 'appDirectory', kind: 'repo_path', label: 'App directory', required: true, default: '.' },
            { id: 'channel', kind: 'select', label: 'Channel', required: true, default: 'stable', options: [{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }] },
            { id: 'minSdk', kind: 'number', label: 'minSdk', min: 0, max: 99, default: null },
            { id: 'web', kind: 'boolean', label: 'Web target', default: false },
            { id: 'flavors', kind: 'text_list', label: 'Flavors', format: 'identifier', maxItems: 4, maxLength: 32 },
        ],
        topics: [{ id: 'pub', title: 'Dependencies', summary: 'pub get', body: 'Run pub get.', sources: [source] },
            { id: 'beta-only', title: 'Beta channel', summary: 'Beta notes', body: 'Beta.', sources: [source], when: { field: 'channel', in: ['beta'] } }],
        recipes: [{ id: 'test', title: 'Run tests', summary: 'flutter test', kind: 'test', effects: ['runs_project_code'], prerequisites: ['git'],
            steps: [{ title: 'Test', detail: 'Run the tests.', argv: ['flutter', 'test', '{checkout}/{appDirectory}'] }] }],
        tasks: [{ id: 'tests', title: 'Tests', description: 'Run tests', kind: 'test', specialist: 'builtin:tests', recipeIds: ['test'], topicIds: ['pub', 'beta-only'], defaultTask: 'Run the tests.', effects: [], requiresRepository: true }],
        doctor: { provider: { id: 'hapi.toolchain', version: 1 }, checks: [{ id: 'git', required: true }, { id: 'java' }] },
        inspect: { provider: { id: 'hapi.repository-inventory', version: 1 }, directoryField: 'appDirectory' },
        integrations: [{ id: 'github-status', title: 'GitHub', kind: 'live_read', provider: 'github.commit-status', description: 'Commit status' }],
    }
}
const manifest = (modules: DevelopmentModuleDefinitionInput[], extra: Partial<PluginManifestInput> = {}): string =>
    JSON.stringify({ schemaVersion: 2, id: 'acme-flutter', name: 'Flutter', description: 'Flutter development', version: '1.0.0', developmentModules: modules, ...extra })
const issues = (definition: DevelopmentModuleDefinitionInput) => {
    const result = DevelopmentModuleDefinitionSchema.safeParse(definition)
    return result.success ? [] : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
}

describe('development module manifests', () => {
    test('a plugin may contribute only a development module; v1 manifests still parse; v1 cannot carry modules', () => {
        const parsed = validatePluginManifestSource(manifest([moduleFixture()]))
        expect(parsed.ok).toBe(true)
        if (parsed.ok) {
            expect(parsed.manifest.developmentModules[0]!.tasks[0]!.effects).toEqual([])
            expect(parsed.manifest.agents).toEqual([])
        }
        const legacy = JSON.stringify({ schemaVersion: 1, id: 'old', name: 'Old', description: 'Old plugin', version: '1.0.0', skills: [{ id: 'q', name: 'Q', description: 'Q', instructions: 'Q' }] })
        expect(validatePluginManifestSource(legacy).ok).toBe(true)
        const mixed = validatePluginManifestSource(manifest([moduleFixture()], { schemaVersion: 1 }))
        expect(mixed.ok).toBe(false)
        expect(validatePluginManifestSource(manifest([])).ok).toBe(false)
    })
    test('specialists are builtin or agents of the same manifest', () => {
        const module = moduleFixture()
        module.tasks![0]!.specialist = 'flutter-agent'
        expect(validatePluginManifestSource(manifest([module])).ok).toBe(false)
        const withAgent = validatePluginManifestSource(manifest([module], { agents: [{ id: 'flutter-agent', name: 'Flutter', description: 'Flutter', instructions: 'Work on Flutter.' }] }))
        expect(withAgent.ok).toBe(true)
        module.tasks![0]!.specialist = 'plugin:00000000-0000-0000-0000-000000000000:other'
        expect(validatePluginManifestSource(manifest([module])).ok).toBe(false)
    })
    test.each([
        ['unknown placeholder', (m: DevelopmentModuleDefinitionInput) => { m.recipes![0]!.steps[0]!.argv = ['sh', '-c', '{secret}'] }],
        ['unbalanced braces', (m: DevelopmentModuleDefinitionInput) => { m.recipes![0]!.steps[0]!.argv = ['echo', '{checkout'] }],
        ['missing recipe', (m: DevelopmentModuleDefinitionInput) => { m.tasks![0]!.recipeIds = ['nope'] }],
        ['missing topic', (m: DevelopmentModuleDefinitionInput) => { m.tasks![0]!.topicIds = ['nope'] }],
        ['prerequisite outside doctor', (m: DevelopmentModuleDefinitionInput) => { m.recipes![0]!.prerequisites = ['kvm'] }],
        ['builtin-only precondition', (m: DevelopmentModuleDefinitionInput) => { m.tasks![0]!.preconditions = ['android_sdk_license_acknowledged'] }],
        ['licence acknowledgement effect', (m: DevelopmentModuleDefinitionInput) => { m.tasks![0]!.effects = ['requires_license_acknowledgement'] }],
        ['builtin-only provider', (m: DevelopmentModuleDefinitionInput) => { m.doctor = { provider: { id: 'builtin.odoo', version: 1 }, checks: [] } }],
        ['check not offered by provider', (m: DevelopmentModuleDefinitionInput) => { m.doctor!.checks = [{ id: 'odoo.source' }] }],
        ['directory field of the wrong kind', (m: DevelopmentModuleDefinitionInput) => { m.inspect!.directoryField = 'channel' }],
        ['select default outside options', (m: DevelopmentModuleDefinitionInput) => { (m.fields![1] as { default: string }).default = 'nightly' }],
        ['number default outside range', (m: DevelopmentModuleDefinitionInput) => { (m.fields![2] as { default: number }).default = 120 }],
        ['condition on a text list', (m: DevelopmentModuleDefinitionInput) => { m.topics![1]!.when = { field: 'flavors', in: ['x'] } }],
        ['condition value outside options', (m: DevelopmentModuleDefinitionInput) => { m.topics![1]!.when = { field: 'channel', in: ['nightly'] } }],
        ['live read without provider', (m: DevelopmentModuleDefinitionInput) => { m.integrations![0]!.provider = null }],
        ['duplicate field', (m: DevelopmentModuleDefinitionInput) => { m.fields!.push({ id: 'web', kind: 'boolean', label: 'Again' }) }],
        ['hidden characters', (m: DevelopmentModuleDefinitionInput) => { m.topics![0]!.body = 'Run‮ pub get' }],
        ['remote schema reference', (m: DevelopmentModuleDefinitionInput) => { (m as Record<string, unknown>).$ref = 'https://example.com/schema.json' }],
        ['executable doctor command', (m: DevelopmentModuleDefinitionInput) => { (m.doctor as Record<string, unknown>).argv = ['bash', '-c', 'id'] }],
        ['regular expression field', (m: DevelopmentModuleDefinitionInput) => { (m.fields![0] as Record<string, unknown>).pattern = '^(a+)+$' }],
        ['too many fields', (m: DevelopmentModuleDefinitionInput) => { m.fields = Array.from({ length: DEVELOPMENT_MODULE_LIMITS.fields + 1 }, (_, index) => ({ id: `f${index}`, kind: 'boolean' as const, label: `F${index}` })) }],
        ['too many options', (m: DevelopmentModuleDefinitionInput) => { m.fields = Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, kind: 'select' as const, label: 'S', options: Array.from({ length: 24 }, (_, option) => ({ value: `o${option}`, label: 'O' })) })) }],
        ['oversized task payload', (m: DevelopmentModuleDefinitionInput) => {
            m.recipes = Array.from({ length: 8 }, (_, index) => ({ id: `r${index}`, title: 'R', summary: 'R', kind: 'test' as const, steps: Array.from({ length: 4 }, () => ({ title: 'S', detail: 'x'.repeat(1200) })) }))
            m.tasks![0]!.recipeIds = m.recipes.map(recipe => recipe.id)
        }],
    ] as const)('rejects %s', (_name, mutate) => {
        const module = structuredClone(moduleFixture())
        mutate(module)
        expect(issues(module).length).toBeGreaterThan(0)
    })
    test('unknown provider versions parse but are reported as unsupported, never silently mapped', () => {
        const module = moduleFixture()
        module.doctor = { provider: { id: 'acme.flutter-doctor', version: 3 }, checks: [{ id: 'flutter' }] }
        module.recipes![0]!.prerequisites = ['flutter']
        const parsed = DevelopmentModuleDefinitionSchema.parse(module)
        expect(developmentModuleSupportIssues(parsed)).toHaveLength(1)
        expect(developmentModuleSupportIssues(DevelopmentModuleDefinitionSchema.parse(moduleFixture()))).toEqual([])
        expect(DevelopmentModuleDefinitionSchema.safeParse({ ...moduleFixture(), apiVersion: 2 }).success).toBe(false)
    })
})

describe('module values', () => {
    const fields = DevelopmentModuleDefinitionSchema.parse(moduleFixture()).fields as DevelopmentModuleField[]
    test('defaults fill missing keys and keep false/0 values', () => {
        expect(developmentModuleDefaults(fields)).toEqual({ appDirectory: '.', channel: 'stable', minSdk: null, web: false, flavors: [] })
        const result = validateDevelopmentModuleValues(fields, { minSdk: 0, web: false, flavors: ['free'] })
        expect(result).toEqual({ ok: true, values: { appDirectory: '.', channel: 'stable', minSdk: 0, web: false, flavors: ['free'] } })
    })
    test.each([
        [{ channel: null }, 'channel'], [{ channel: 'nightly' }, 'channel'], [{ minSdk: 100 }, 'minSdk'], [{ minSdk: 1.5 }, 'minSdk'], [{ appDirectory: '../etc' }, 'appDirectory'],
        [{ web: 'yes' }, 'web'], [{ flavors: ['free', 'free'] }, 'flavors'], [{ flavors: ['a b'] }, 'flavors'], [{ unknown: 1 }, 'unknown'],
    ])('rejects %j at the right field', (values, field) => {
        const result = validateDevelopmentModuleValues(fields, values)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.issues.map(issue => issue.field)).toContain(field)
    })
})

describe('canonical settings and legacy adapter', () => {
    test('v1 settings round-trip losslessly with inactive sections', () => {
        const v1: DevelopmentSettings = { mode: 'ios', repositoryId: '42', odoo: { ...defaultOdooSettings(19), modules: ['sale_custom'] }, ios: defaultIosSettings(), android: { ...defaultAndroidSettings(), sdkLicensesAcknowledged: true } }
        const v2 = developmentSettingsToModuleSettings(v1)
        expect(v2.activeModuleId).toBe('builtin:ios')
        expect(DevelopmentModuleSettingsSchema.parse(v2)).toEqual(v2)
        expect(moduleSettingsToDevelopmentSettings(v2)).toEqual(v1)
        expect(moduleSettingsToDevelopmentSettings(developmentSettingsToModuleSettings(defaultDevelopmentSettings()))).toEqual(defaultDevelopmentSettings())
    })
    test('plugin modules have no v1 projection (never reported as none) and entries are keyed by plugin ids only', () => {
        const id = `plugin:${crypto.randomUUID()}:flutter`
        const settings = { ...developmentSettingsToModuleSettings(defaultDevelopmentSettings()), activeModuleId: id,
            modules: { [id]: { moduleDigest: `sha256:${'a'.repeat(64)}`, settingsVersion: 1 as const, values: {}, adopted: { pluginId: id.split(':')[1]!, pluginVersion: '1.0.0', repository: 'acme/flutter', commitSha: 'b'.repeat(40), manifestSha256: 'c'.repeat(64), at: 1 } } } }
        expect(DevelopmentModuleSettingsSchema.safeParse(settings).success).toBe(true)
        expect(moduleSettingsToDevelopmentSettings(settings)).toBeNull()
        expect(DevelopmentModuleSettingsSchema.safeParse({ ...settings, modules: {} }).success).toBe(false)
        expect(DevelopmentModuleSettingsSchema.safeParse({ ...settings, modules: { 'builtin:odoo': settings.modules[id] } }).success).toBe(false)
        expect(parseDevelopmentModuleId('plugin:not-a-uuid:flutter')).toBeNull()
        expect(parseDevelopmentModuleId('builtin:odoo')).toEqual({ origin: 'builtin', mode: 'odoo' })
    })
})

describe('builtin modules use the generic view', () => {
    test.each(['odoo', 'ios', 'android'] as const)('%s view is valid and applicability matches the v1 pack filter', mode => {
        const view = builtinDevelopmentModuleView(mode)
        expect(DevelopmentModuleViewSchema.safeParse(view).success).toBe(true)
        for (const major of [19, 20] as const) {
            const settings = defaultDevelopmentSettings(mode)
            if (settings.odoo) settings.odoo.major = major
            const legacy = applicablePack(settings)!, items = applicableModuleItems(view, settings[mode] as Record<string, unknown>)
            expect(items.topics.map(topic => topic.id)).toEqual(legacy.topics.map(topic => topic.id))
            expect(items.tasks.map(task => [task.id, task.topicIds, task.effects])).toEqual(legacy.tasks.map(task => [task.id, task.topicIds, task.effects]))
            expect(items.checks.map(check => check.id)).toEqual(legacy.doctorChecks.map(check => check.id))
        }
    })
})

describe('byte budgets keep valid modules startable and editable', () => {
    const big = (length: number, seed: string) => (seed + 'x'.repeat(length)).slice(0, length)
    test('a task with a plugin specialist must leave room for the assignment', () => {
        const module = moduleFixture()
        module.recipes = [{ id: 'long', title: 'Long', summary: 'Long', kind: 'test', steps: Array.from({ length: 20 }, (_, index) => ({ title: `S${index}`, detail: big(1000, `d${index}`) })) }]
        module.tasks = [{ id: 'plan', title: 'Plan', description: 'Plan', kind: 'develop', specialist: 'planner', recipeIds: ['long'], defaultTask: 'Plan.', requiresRepository: false }]
        module.doctor = null; module.inspect = null
        const agents = [{ id: 'planner', name: 'Planner', description: 'Plans', instructions: big(16_000, 'a'), skills: ['one', 'two'] }]
        const skills = ['one', 'two'].map(id => ({ id, name: id, description: id, instructions: big(16_000, id) }))
        const tooLarge = validatePluginManifestSource(manifest([module], { agents, skills }))
        expect(tooLarge.ok).toBe(false)
        if (!tooLarge.ok) expect(tooLarge.issues.some(issue => issue.path === 'developmentModules.0.tasks.0' && issue.message.includes('too little room'))).toBe(true)
        // The same task with a builtin specialist, or a lean plugin specialist, is accepted.
        expect(validatePluginManifestSource(manifest([{ ...module, tasks: [{ ...module.tasks[0]!, specialist: 'builtin:implementation' }] }], { agents, skills })).ok).toBe(true)
        expect(validatePluginManifestSource(manifest([module], { agents: [{ ...agents[0]!, skills: [] }], skills })).ok).toBe(true)
    })
    test('defaults and values are limited to 8 KiB per module', () => {
        const list = (id: string, defaults: string[]) => ({ id, kind: 'text_list' as const, label: id, maxItems: 32, maxLength: 200, default: defaults })
        const items = (seed: string) => Array.from({ length: 32 }, (_, index) => big(200, `${seed}${index}-`))
        expect(issues({ ...moduleFixture(), fields: [list('a', items('a')), list('b', items('b'))] }).some(issue => issue.includes('Default values'))).toBe(true)
        const fields = DevelopmentModuleDefinitionSchema.parse({ ...moduleFixture(), fields: [list('a', []), list('b', [])], tasks: [], recipes: [], inspect: null, topics: [] }).fields as DevelopmentModuleField[]
        const result = validateDevelopmentModuleValues(fields, { a: items('a'), b: items('b') })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.issues[0]).toMatchObject({ field: '' })
        expect(validateDevelopmentModuleValues(fields, { a: items('a') }).ok).toBe(true)
    })
})

describe('effective task effects', () => {
    test('recipe effects belong to the task; only consequential effects need a writable profile', () => {
        const odoo = applicablePack(defaultDevelopmentSettings('odoo'))!
        const setup = odoo.tasks.find(task => task.id === 'odoo-setup-runtime')!
        const effects = developmentTaskEffects(setup, odoo.recipes)
        for (const recipe of odoo.recipes.filter(item => setup.recipeIds.includes(item.id))) for (const effect of recipe.effects) expect(effects).toContain(effect)
        expect(developmentTaskRequiresWritableProfile(effects)).toBe(true)
        // A task without own effects inherits them from its recipe; unrelated recipes do not count.
        expect(developmentTaskEffects({ effects: [], recipeIds: ['r'] }, [{ id: 'r', effects: ['installs_in_project'] }, { id: 'x', effects: ['remote_cost'] }])).toEqual(['installs_in_project'])
        expect(developmentTaskRequiresWritableProfile(developmentTaskEffects({ effects: ['reads_repository'], recipeIds: ['r'] }, [{ id: 'r', effects: ['manual_handoff'] }]))).toBe(false)
        const review = odoo.tasks.find(task => task.id === 'odoo-sh-build')!
        expect(developmentTaskRequiresWritableProfile(developmentTaskEffects(review, odoo.recipes))).toBe(false)
    })
})

describe('Odoo.sh build task names no default stage', () => {
    test('the task and its recipe require an explicitly named configured stage or ref and ask otherwise, for every hosting', () => {
        for (const hosting of ['odoo_sh', 'local', 'self_hosted'] as const) {
            const odoo = applicablePack({ ...defaultDevelopmentSettings('odoo'), odoo: { ...defaultOdooSettings(20), hosting } })!
            const task = odoo.tasks.find(item => item.id === 'odoo-sh-build')!
            // Still offered (reusable with an explicit ref), read-only, no new permission requirement.
            expect(task).toBeDefined()
            expect(developmentTaskRequiresWritableProfile(developmentTaskEffects(task, odoo.recipes))).toBe(false)
            const recipe = odoo.recipes.find(item => item.id === 'odoo-sh-diagnose')!
            for (const text of [task.defaultTask, task.description, ...recipe.steps.map(step => step.detail)]) {
                // No preselected stage: neither a concrete environment parameter nor "staging/production" as the default.
                expect(text).not.toMatch(/environment=(staging|production)/)
                expect(text).not.toMatch(/(?:of|for) the (?:staging|production) environment/i)
            }
            const target = recipe.steps.find(step => step.title === 'Choose the target')!.detail
            for (const text of [task.defaultTask, target]) {
                expect(text).toMatch(/staging or production/)
                expect(text).toMatch(/ref/)
                expect(text).toMatch(/ask/)
                expect(text).toMatch(/unavailable/)
                expect(text).toMatch(/never (?:choose|assume)/)
            }
        }
    })
})
