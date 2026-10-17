import { describe, expect, test } from 'bun:test'
import {
    DevelopmentCreationSchema, DevelopmentDoctorResultSchema, DevelopmentKnowledgeQuerySchema, DevelopmentRpcRequestSchema, DevelopmentSettingsSchema,
    AndroidSettingsSchema, CommitStatusEntrySchema, DevelopmentIntegrationStatusSchema, GitBranchSchema, HttpsOutputUrlSchema, isAndroidDebugVariant,
    DEVELOPMENT_ARTIFACTS_DIRECTORY, DEVELOPMENT_TOOLCHAIN_DIRECTORY,
    GitRefSchema, OdooShBuildHostSchema, OdooShDashboardUrlSchema, RepoRelativePathSchema, XcodeSchemeSchema, GradleModuleSchema,
    defaultAndroidSettings, defaultDevelopmentSettings, defaultIosSettings, defaultOdooSettings, developmentApplies, developmentContentHash,
} from './evolvedDevelopment'

describe('development settings contract', () => {
    test('defaults are valid for every mode and keep inactive sections', () => {
        for (const mode of ['none', 'odoo', 'ios', 'android'] as const) expect(DevelopmentSettingsSchema.safeParse(defaultDevelopmentSettings(mode)).success).toBe(true)
        const odoo = defaultDevelopmentSettings('odoo'), android = defaultDevelopmentSettings('android', odoo)
        expect(android.mode).toBe('android')
        expect(android.odoo).toEqual(odoo.odoo)
        expect(defaultOdooSettings().major).toBe(20)
        expect(defaultIosSettings().buildStrategy).toBe('undecided')
        expect(defaultAndroidSettings().sdkLicensesAcknowledged).toBe(false)
    })
    test('a selected mode requires its section', () => {
        expect(DevelopmentSettingsSchema.safeParse({ mode: 'ios', repositoryId: null, odoo: null, ios: null, android: null }).success).toBe(false)
    })
    test.each(['../x', '/abs', 'a/../b', 'a\\b', '-rf', 'a/./b', 'a/‮b', 'a/.', ' x'])('rejects repository path %p', value => {
        expect(RepoRelativePathSchema.safeParse(value).success).toBe(false)
    })
    test('accepts ordinary repository paths', () => {
        for (const value of ['addons', 'src/custom_addons', 'ios/App.xcodeproj', 'Packages/Core', '.github/workflows']) expect(RepoRelativePathSchema.safeParse(value).success).toBe(true)
    })
    test.each(['-x', 'a..b', 'a b', 'refs/x?', 'a~1', 'a^', 'x.lock', 'a/', '.hidden', 'a@{1}', 'feat\u0000'])('rejects ref %p', value => {
        expect(GitRefSchema.safeParse(value).success).toBe(false)
    })
    test('accepts branches and full SHAs', () => {
        for (const value of ['main', 'feature/odoo-20', '19.0-dev', 'a'.repeat(40)]) expect(GitRefSchema.safeParse(value).success).toBe(true)
    })
    test('rejects command-shaped identifiers', () => {
        expect(XcodeSchemeSchema.safeParse('App; rm -rf /').success).toBe(false)
        expect(XcodeSchemeSchema.safeParse('$(id)').success).toBe(false)
        expect(XcodeSchemeSchema.safeParse('My App').success).toBe(true)
        expect(GradleModuleSchema.safeParse(':feature:login').success).toBe(true)
        expect(GradleModuleSchema.safeParse('app --init-script evil').success).toBe(false)
    })
    test('Odoo.sh links and hosts are strict', () => {
        expect(OdooShDashboardUrlSchema.safeParse('https://www.odoo.sh/project/acme').success).toBe(true)
        expect(OdooShDashboardUrlSchema.safeParse('https://www.odoo.sh/project/acme/branches/dev').success).toBe(true)
        for (const value of ['http://www.odoo.sh/project/acme', 'https://www.odoo.sh.evil.test/project/acme', 'https://user:pw@www.odoo.sh/project/acme', 'https://www.odoo.sh/project/acme?session=1', 'https://www.odoo.sh:8443/project/acme', 'https://www.odoo.sh/other', 'https://www.odoo.sh/project/acme#x'])
            expect(OdooShDashboardUrlSchema.safeParse(value).success).toBe(false)
        expect(OdooShBuildHostSchema.safeParse('acme-dev-123.dev.odoo.com').success).toBe(true)
        for (const value of ['evil.com', 'x.dev.odoo.com.evil.test', '-x.dev.odoo.com', 'a.b.dev.odoo.com', 'acme.odoo.com']) expect(OdooShBuildHostSchema.safeParse(value).success).toBe(false)
    })
    test('odoo cross-field rules', () => {
        const base = defaultDevelopmentSettings('odoo')
        const withOdoo = (patch: object) => DevelopmentSettingsSchema.safeParse({ ...base, odoo: { ...base.odoo!, ...patch } }).success
        expect(withOdoo({ odooSh: { dashboardUrl: 'https://www.odoo.sh/project/acme', buildId: null, buildHost: null, sshResourceId: null } })).toBe(false)
        expect(withOdoo({ hosting: 'odoo_sh', odooSh: { dashboardUrl: null, buildId: '12', buildHost: null, sshResourceId: null } })).toBe(false)
        expect(withOdoo({ hosting: 'odoo_sh', odooSh: { dashboardUrl: null, buildId: '12', buildHost: 'p-12.dev.odoo.com', sshResourceId: 'ssh-build' } })).toBe(true)
        expect(withOdoo({ enterpriseRepositoryId: '5' })).toBe(false)
        expect(withOdoo({ stage: 'production' })).toBe(false)
        expect(withOdoo({ major: 18 })).toBe(false)
        expect(withOdoo({ modules: ['sale', 'sale'] })).toBe(false)
    })
    test('creation mode cannot reference repositories', () => {
        expect(DevelopmentCreationSchema.safeParse({ settings: defaultDevelopmentSettings('odoo') }).success).toBe(true)
        expect(DevelopmentCreationSchema.safeParse({ settings: { ...defaultDevelopmentSettings('odoo'), repositoryId: '1' } }).success).toBe(false)
    })
    test('knowledge query accepts topic xor q with bounded limit', () => {
        expect(DevelopmentKnowledgeQuerySchema.safeParse({ q: 'tests', limit: '5' }).success).toBe(true)
        expect(DevelopmentKnowledgeQuerySchema.safeParse({ topic: 'a', q: 'b' }).success).toBe(false)
        expect(DevelopmentKnowledgeQuerySchema.safeParse({ limit: '21' }).success).toBe(false)
        expect(DevelopmentKnowledgeQuerySchema.safeParse({ path: '/etc' }).success).toBe(false)
    })
    test('RPC and doctor payloads are strict and bounded', () => {
        const settings = defaultDevelopmentSettings('odoo')
        expect(DevelopmentRpcRequestSchema.safeParse({ action: 'doctor', projectId: 'p', revision: 1, mode: 'odoo', settings, repository: null, checks: ['python'] }).success).toBe(true)
        expect(DevelopmentRpcRequestSchema.safeParse({ action: 'run', projectId: 'p', revision: 1, mode: 'odoo', settings, command: 'id' }).success).toBe(false)
        expect(DevelopmentRpcRequestSchema.safeParse({ action: 'inspect', projectId: 'p', revision: 1, mode: 'odoo', settings, repository: null }).success).toBe(false)
        const doctor = { contractVersion: 1, mode: 'android', observedAt: 1, durationMs: 1, host: { os: 'linux', arch: 'x64', image: null }, truncated: false, checks: [{ id: 'java', label: 'JDK', category: 'runtime', state: 'missing' }] }
        expect(DevelopmentDoctorResultSchema.safeParse(doctor).success).toBe(true)
        expect(DevelopmentDoctorResultSchema.safeParse({ ...doctor, checks: [{ ...doctor.checks[0], state: 'ok' }] }).success).toBe(false)
        expect(DevelopmentDoctorResultSchema.safeParse({ ...doctor, checks: [{ ...doctor.checks[0], remedy: { kind: 'docs', text: 'x', url: 'http://insecure.test' } }] }).success).toBe(false)
    })
    test('content hash is deterministic and key-order independent', () => {
        expect(developmentContentHash({ a: 1, b: [1, 2] })).toBe(developmentContentHash({ b: [1, 2], a: 1 }))
        expect(developmentContentHash({ a: 1 })).not.toBe(developmentContentHash({ a: 2 }))
        expect(developmentContentHash('x')).toMatch(/^fnv1a64:[a-f0-9]{16}$/)
    })
    test('version filter', () => {
        const settings = defaultDevelopmentSettings('odoo')
        expect(developmentApplies({ odooMajors: [19] }, { odoo: { ...settings.odoo!, major: 20 } })).toBe(false)
        expect(developmentApplies({ odooMajors: [19, 20] }, { odoo: { ...settings.odoo!, major: 20 } })).toBe(true)
        expect(developmentApplies({}, null)).toBe(true)
    })
    test('symbolic HEAD is not a declarable branch', () => {
        expect(GitBranchSchema.safeParse('HEAD').success).toBe(false)
        expect(GitBranchSchema.safeParse('@').success).toBe(false)
        expect(GitBranchSchema.safeParse('HEADS-up').success).toBe(true)
    })
    test('minSdk may not exceed compileSdk even without targetSdk', () => {
        expect(AndroidSettingsSchema.safeParse({ ...defaultAndroidSettings(), minSdk: 35, targetSdk: null, compileSdk: 34 }).success).toBe(false)
        expect(AndroidSettingsSchema.safeParse({ ...defaultAndroidSettings(), minSdk: 24, targetSdk: null, compileSdk: 35 }).success).toBe(true)
    })
    test('outgoing links are canonical https without credentials, port, query or fragment', () => {
        for (const value of ['javascript:alert(1)', 'http://example.test/', 'https://u:p@example.test/', 'https://example.test:8443/', 'https://example.test/?token=1', 'https://example.test/#x', 'https://EXAMPLE.test/'])
            expect(HttpsOutputUrlSchema.safeParse(value).success).toBe(false)
        expect(HttpsOutputUrlSchema.safeParse('https://www.odoo.sh/project/acme').success).toBe(true)
        expect(CommitStatusEntrySchema.safeParse({ context: 'ci', state: 'success', description: null, targetUrl: 'javascript:alert(1)', updatedAt: null }).success).toBe(false)
        expect(DevelopmentIntegrationStatusSchema.safeParse({ id: 'x', title: 'X', kind: 'manual', state: 'manual', detail: 'd', links: [{ label: 'l', url: 'data:text/html,x' }] }).success).toBe(false)
    })
    test('RPC request mode must equal the configured mode', () => {
        const settings = defaultDevelopmentSettings('android')
        expect(DevelopmentRpcRequestSchema.safeParse({ action: 'doctor', projectId: 'p', revision: 1, mode: 'odoo', settings, repository: null, checks: [] }).success).toBe(false)
        expect(DevelopmentRpcRequestSchema.safeParse({ action: 'doctor', projectId: 'p', revision: 1, mode: 'android', settings, repository: null, checks: [] }).success).toBe(true)
    })
    test('debug variant recognition never accepts release variants', () => {
        for (const value of ['debug', 'freeDebug', 'stagingDebug']) expect(isAndroidDebugVariant(value)).toBe(true)
        for (const value of ['release', 'productionRelease', 'debugRelease', 'Debug', 'debuggable']) expect(isAndroidDebugVariant(value)).toBe(false)
    })
    test('toolchain and artifacts live under the Codegraph-excluded .hapi/.cache subtree', () => {
        expect(DEVELOPMENT_TOOLCHAIN_DIRECTORY).toBe('.hapi/.cache/toolchain')
        expect(DEVELOPMENT_ARTIFACTS_DIRECTORY).toBe('.hapi/.cache/artifacts')
    })
})
