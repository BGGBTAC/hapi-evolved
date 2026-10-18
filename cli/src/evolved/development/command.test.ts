import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEVELOPMENT_CONTRACT_VERSION, defaultDevelopmentSettings, DevelopmentContextSchema } from '@hapi/protocol/evolvedDevelopment'
import { DevelopmentModuleContextSchema, developmentSettingsToModuleSettings } from '@hapi/protocol/developmentModules'
import { EvolvedRequestError, type EvolvedClient } from '../client'
import { runDevelopmentCommand } from './command'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const write = (file: string, body: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body) }

it.each(['v1 Hub', 'v2 Hub'] as const)('local --odoo-major/--addons override the saved Hub settings instead of being ignored (%s)', async hub => {
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'evolved-command-'))); directories.push(checkout)
    write(join(checkout, 'root19/__manifest__.py'), "{'name': 'Root 19', 'version': '19.0.1.0.0', 'license': 'LGPL-3'}")
    write(join(checkout, 'custom/nested20/__manifest__.py'), "{'name': 'Nested 20', 'version': '20.0.1.0.0', 'license': 'LGPL-3'}")
    const saved = defaultDevelopmentSettings('odoo'); saved.odoo!.major = 19; saved.repositoryId = '42'
    const context = DevelopmentContextSchema.parse({ contractVersion: DEVELOPMENT_CONTRACT_VERSION, projectId: 'p', revision: 1, mode: 'odoo', observedAt: 0, dataNotice: 'data', settings: saved, pack: null,
        repository: { state: 'granted', repositoryId: '42', fullName: 'acme/repo', permission: 'read', checkoutPath: checkout, relativePath: 'repositories/acme/repo' }, integrations: [], lastDoctor: null })
    const digest = `sha256:${'b'.repeat(64)}`
    const moduleContext = DevelopmentModuleContextSchema.parse({ contractVersion: 2, projectId: 'p', revision: 1, observedAt: 0, dataNotice: 'data',
        active: { moduleId: 'builtin:odoo', state: 'ready', reasons: [], installedDigest: digest, adoptedDigest: digest },
        module: { id: 'builtin:odoo', origin: 'builtin', title: 'Odoo', digest, contentVersion: '2026.10.17', source: { kind: 'builtin' }, brief: [], constraints: [], topics: [], recipes: [], tasks: [],
            doctor: null, inspect: { provider: { id: 'builtin.odoo', version: 1 }, directoryField: null } },
        settings: developmentSettingsToModuleSettings(saved), repository: context.repository, integrations: [], lastDoctor: null })
    // An older Hub does not know the modules routes (plain 404 without code); the CLI then reads the v1 context.
    const client = () => ({
        developmentModulesContext: async () => { if (hub === 'v1 Hub') throw new EvolvedRequestError('Evolved request failed (404)', 404); return moduleContext },
        developmentContext: async () => { if (hub === 'v2 Hub') throw new Error('v2 Hub must not be asked for the v1 context'); return context },
    }) as unknown as EvolvedClient
    const overridden = await runDevelopmentCommand(['inspect', '--local', '--odoo-major', '20', '--addons', 'custom', '--checkout', checkout], client) as { odooModules: Array<{ technicalName: string; versionMatchesMajor: boolean }> }
    expect(overridden.odooModules.map(module => [module.technicalName, module.versionMatchesMajor])).toEqual([['nested20', true]])
    const saved19 = await runDevelopmentCommand(['inspect', '--local', '--checkout', checkout], client) as { odooModules: Array<{ technicalName: string }> }
    expect(saved19.odooModules.map(module => module.technicalName)).toEqual(['root19'])
    await expect(runDevelopmentCommand(['inspect', '--local', '--mode', 'android', '--odoo-major', '20', '--checkout', checkout], client)).rejects.toThrow(/only to the odoo mode/)
    await expect(runDevelopmentCommand(['inspect', '--local', '--addons', '../x', '--checkout', checkout], client)).rejects.toThrow()
})
