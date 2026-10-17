import { describe, expect, test } from 'bun:test'
import { DEVELOPMENT_PACKS, applicablePack, developmentCatalog, developmentPackRevision, searchDevelopmentTopics } from './developmentPacks'
import { DEVELOPMENT_HELPER_BIN, DevelopmentModeCatalogSchema, defaultDevelopmentSettings, defaultOdooSettings } from './evolvedDevelopment'

const odooSettings = (major: 19 | 20) => ({ ...defaultDevelopmentSettings('odoo'), odoo: defaultOdooSettings(major) })

describe('bundled development packs', () => {
    test('catalog validates and every mode has at least six sourced topics', () => {
        const catalog = DevelopmentModeCatalogSchema.parse(developmentCatalog())
        for (const entry of catalog.modes) {
            expect(entry.topics.length).toBeGreaterThanOrEqual(6)
            expect(entry.tasks.length).toBeGreaterThanOrEqual(5)
            expect(entry.topics.every(topic => !('body' in topic))).toBe(true)
        }
        for (const pack of Object.values(DEVELOPMENT_PACKS)) for (const topic of pack.topics) {
            expect(topic.sources.length).toBeGreaterThan(0)
            for (const source of topic.sources) { expect(source.url.startsWith('https://')).toBe(true); expect(source.verifiedAt).toBe('2026-10-17') }
        }
    })
    test('ids are unique and references resolve', () => {
        for (const pack of Object.values(DEVELOPMENT_PACKS)) {
            for (const kind of ['topics', 'recipes', 'tasks', 'doctorChecks', 'integrations'] as const) {
                const ids = pack[kind].map(item => item.id)
                expect(new Set(ids).size).toBe(ids.length)
            }
            const topics = new Set(pack.topics.map(topic => topic.id)), recipes = new Set(pack.recipes.map(recipe => recipe.id)), checks = new Set(pack.doctorChecks.map(check => check.id))
            for (const task of pack.tasks) {
                expect(task.recipeIds.every(id => recipes.has(id))).toBe(true)
                expect(task.topicIds.every(id => topics.has(id))).toBe(true)
            }
            for (const recipe of pack.recipes) expect(recipe.prerequisites.every(id => checks.has(id))).toBe(true)
        }
    })
    test('Odoo knowledge is version specific and states verified facts', () => {
        const nineteen = applicablePack(odooSettings(19))!, twenty = applicablePack(odooSettings(20))!
        expect(nineteen.topics.map(topic => topic.id)).toContain('odoo-runtime-19')
        expect(nineteen.topics.map(topic => topic.id)).not.toContain('odoo-runtime-20')
        expect(twenty.topics.map(topic => topic.id)).toContain('odoo-runtime-20')
        expect(nineteen.tasks.map(task => task.id)).not.toContain('odoo-upgrade-20')
        expect(twenty.tasks.map(task => task.id)).toContain('odoo-upgrade-20')
        const versions = DEVELOPMENT_PACKS.odoo.topics.find(topic => topic.id === 'odoo-versions')!.body
        expect(versions).toContain('Python 3.10'); expect(versions).toContain('PostgreSQL 13'); expect(versions).toContain('Python 3.12'); expect(versions).toContain('PostgreSQL 16')
        const api = DEVELOPMENT_PACKS.odoo.topics.find(topic => topic.id === 'odoo-external-api')!
        expect(api.body).toContain('Odoo 22')
        expect(api.body).not.toMatch(/removed in (Odoo )?20/i)
        // 19-only topic must only cite 19.0 documentation, 20-only only 20.0.
        for (const [id, major] of [['odoo-runtime-19', '19.0'], ['odoo-runtime-20', '20.0']] as const) {
            const topic = DEVELOPMENT_PACKS.odoo.topics.find(item => item.id === id)!
            expect(topic.sources.every(source => source.version === major)).toBe(true)
        }
        for (const topic of DEVELOPMENT_PACKS.odoo.topics) for (const source of topic.sources) expect(source.url).not.toContain('/documentation/master/')
    })
    test('mobile packs never claim native iOS builds on Linux or implicit licence acceptance', () => {
        const ios = DEVELOPMENT_PACKS.ios, android = DEVELOPMENT_PACKS.android
        expect(ios.constraints.join(' ')).toContain('cannot build')
        expect(ios.doctorChecks.find(check => check.id === 'xcodebuild')!.required).toBe(false)
        const setup = android.recipes.find(recipe => recipe.id === 'android-sdk-setup')!
        expect(setup.effects).toContain('requires_license_acknowledgement')
        expect(setup.guardrails.join(' ')).toContain('Never accept licences automatically')
        expect(JSON.stringify(android.recipes)).not.toMatch(/yes \|/)
    })
    test('recipe argv never relies on a shell', () => {
        for (const pack of Object.values(DEVELOPMENT_PACKS)) for (const recipe of pack.recipes) for (const step of recipe.steps) {
            if (!step.argv) continue
            expect(['sh', 'bash', 'zsh', 'eval'].includes(step.argv[0]!)).toBe(false)
            // sdkmanager package ids legitimately contain ';' — single argv elements, never shell syntax.
            expect(step.argv.some(arg => /&&|\|\||[|`<>]|\$\(/.test(arg))).toBe(false)
        }
    })
    test('revisions are stable content hashes', () => {
        expect(developmentPackRevision('odoo')).toBe(developmentPackRevision('odoo'))
        expect(new Set(['odoo', 'ios', 'android'].map(mode => developmentPackRevision(mode as 'odoo')))).toHaveProperty('size', 3)
    })
    test('search is local, ranked and bounded', () => {
        const topics = applicablePack(odooSettings(20))!.topics
        expect(searchDevelopmentTopics(topics, 'json-2 api')[0]!.topic.id).toBe('odoo-external-api')
        expect(searchDevelopmentTopics(topics, 'hoot tests')[0]!.topic.id).toBe('odoo-testing')
        expect(searchDevelopmentTopics(topics, 'x')).toEqual([])
        expect(searchDevelopmentTopics(topics, 'odoo', 100).length).toBeLessThanOrEqual(20)
        expect(searchDevelopmentTopics(applicablePack(defaultDevelopmentSettings('android'))!.topics, 'licenses sdkmanager')[0]!.topic.id).toBe('android-sdk-licenses')
    })
    test('task effects include every effect of the recipes they reference', () => {
        for (const pack of Object.values(DEVELOPMENT_PACKS)) for (const task of pack.tasks) {
            const recipeEffects = pack.recipes.filter(recipe => task.recipeIds.includes(recipe.id)).flatMap(recipe => recipe.effects)
            for (const effect of recipeEffects) expect(task.effects).toContain(effect)
        }
    })
    test('read-only review tasks only reference recipes that read or hand off', () => {
        for (const pack of Object.values(DEVELOPMENT_PACKS)) for (const task of pack.tasks.filter(item => item.specialist === 'builtin:review')) {
            for (const effect of task.effects) expect(['reads_repository', 'manual_handoff']).toContain(effect)
        }
        expect(DEVELOPMENT_PACKS.odoo.tasks.find(task => task.id === 'odoo-review')!.recipeIds).toEqual([])
        expect(DEVELOPMENT_PACKS.android.tasks.find(task => task.id === 'android-release-prep')!.effects).toEqual(['writes_repository'])
    })
    test('Odoo tests select every configured module through the helper', () => {
        const recipe = DEVELOPMENT_PACKS.odoo.recipes.find(item => item.id === 'odoo-test-module')!
        const argv = recipe.steps.find(step => step.argv)!.argv!
        expect(argv.slice(0, 3)).toEqual([DEVELOPMENT_HELPER_BIN, 'odoo', 'test'])
        expect(argv[argv.indexOf('--modules') + 1]).toBe('{modules}')
        expect(JSON.stringify(DEVELOPMENT_PACKS)).not.toContain('{module}:')
        expect(JSON.stringify(DEVELOPMENT_PACKS.odoo.recipes)).not.toContain('/{module}')
    })
    test('Swift tests use the helper-resolved installed toolchain and the checkout subdirectory', () => {
        const argv = DEVELOPMENT_PACKS.ios.recipes.find(item => item.id === 'ios-swiftpm-test')!.steps.find(step => step.argv)!.argv!
        expect(argv).toEqual([DEVELOPMENT_HELPER_BIN, 'swift', 'test', '--package', '{checkout}/{packageDirectory}'])
        for (const recipe of DEVELOPMENT_PACKS.ios.recipes) for (const step of recipe.steps) expect(['swift', 'xcodebuild']).not.toContain(step.argv?.[0])
    })
    test('debug APK and SDK setup carry server-enforced preconditions', () => {
        expect(DEVELOPMENT_PACKS.android.tasks.find(task => task.id === 'android-debug-apk')!.preconditions).toEqual(['android_debug_variant'])
        expect(DEVELOPMENT_PACKS.android.tasks.find(task => task.id === 'android-setup-sdk')!.preconditions).toEqual(['android_sdk_license_acknowledged'])
        for (const pack of Object.values(DEVELOPMENT_PACKS)) for (const task of pack.tasks.filter(item => item.kind === 'review' || item.kind === 'upgrade')) expect(task.preconditions).toEqual([])
    })
    test('recipes use the final .hapi/.cache layout and no competing paths', () => {
        const text = JSON.stringify(DEVELOPMENT_PACKS)
        for (const stale of ['.hapi/toolchain', '.hapi/artifacts', 'src.commit', '/pg/', 'ios/swift', 'preserving nothing else', 'android-null'])
            expect(text).not.toContain(stale)
        for (const pack of Object.values(DEVELOPMENT_PACKS)) for (const recipe of pack.recipes) for (const output of recipe.outputs) expect(output.startsWith('.hapi/.cache/')).toBe(true)
    })
    test('Odoo access control knowledge is version specific (19: ir.model.access/ir.rule, 20: ir.access)', () => {
        const ids = (major: 19 | 20) => applicablePack(odooSettings(major))!.topics.map(topic => topic.id)
        expect(ids(19)).toEqual(expect.arrayContaining(['odoo-security-19', 'odoo-module-manifest-19']))
        expect(ids(19)).not.toEqual(expect.arrayContaining(['odoo-security-20']))
        expect(ids(19).some(id => id.endsWith('-20'))).toBe(false)
        expect(ids(20)).toEqual(expect.arrayContaining(['odoo-security-20', 'odoo-module-manifest-20', 'odoo-security-migration-20']))
        expect(ids(20).some(id => id.endsWith('-19'))).toBe(false)
        const topic = (id: string) => DEVELOPMENT_PACKS.odoo.topics.find(item => item.id === id)!
        expect(topic('odoo-security-19').body).toContain('id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink')
        expect(topic('odoo-security-20').body).toContain('id,name,model_id,group_id/id,operation,domain')
        expect(topic('odoo-security-20').body).toContain('no ir.model.access or ir.rule model in 20.0')
        expect(topic('odoo-module-manifest-20').body).toContain('security/ir.access.csv')
        // No 19/20 topic still claims ir.model.access for 20.
        for (const item of DEVELOPMENT_PACKS.odoo.topics.filter(entry => entry.appliesTo.odooMajors?.includes(20) && entry.appliesTo.odooMajors.includes(19)))
            expect(item.body).not.toContain('ir.model.access.csv')
        for (const id of ['odoo-security-20', 'odoo-module-manifest-20', 'odoo-security-migration-20'])
            expect(topic(id).sources.some(source => source.url.startsWith('https://raw.githubusercontent.com/odoo/odoo/20.0/'))).toBe(true)
        for (const id of ['odoo-security-19', 'odoo-module-manifest-19']) expect(topic(id).sources.every(source => source.version === '19.0')).toBe(true)
    })
    test('task topic references in the applicable pack only name topics of the configured version', () => {
        for (const major of [19, 20] as const) {
            const pack = applicablePack(odooSettings(major))!, topics = new Set(pack.topics.map(topic => topic.id))
            for (const task of pack.tasks) for (const id of task.topicIds) expect(topics.has(id)).toBe(true)
        }
        expect(applicablePack(odooSettings(19))!.tasks.find(task => task.id === 'odoo-setup-runtime')!.topicIds).toEqual(['odoo-versions', 'odoo-runtime-19'])
    })
    test('every recipe helper call uses a command of the real hapi-dev interface', () => {
        const allowed = ['odoo source', 'odoo venv', 'odoo test', 'odoo upgrade-dry-run', 'postgres init', 'postgres start', 'postgres status',
            'android sdk bootstrap', 'android sdk licenses', 'android sdk install', 'android gradle unit-test', 'android gradle lint', 'android gradle assemble', 'swift install', 'swift test']
        for (const pack of Object.values(DEVELOPMENT_PACKS)) for (const recipe of pack.recipes) for (const step of recipe.steps) {
            if (step.argv?.[0] !== DEVELOPMENT_HELPER_BIN) continue
            const words = step.argv.slice(1).filter(word => !word.startsWith('--') && !word.startsWith('{'))
            expect(allowed.some(command => words.join(' ').startsWith(command))).toBe(true)
        }
    })
})
