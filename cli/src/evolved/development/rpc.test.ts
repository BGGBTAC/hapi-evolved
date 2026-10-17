import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultDevelopmentSettings, DevelopmentDoctorResultSchema, DevelopmentInspectResultSchema } from '@hapi/protocol/evolvedDevelopment'
import { checkedCheckout, developmentRpc, developmentRunnerRoot } from './rpc'

const projectId = '6d5f2b1e-1f7c-4f63-9d7b-4f1f7d0f8e11'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const repository = (root: string) => ({ id: '42', owner: 'acme', name: 'erp', fullName: 'acme/erp', permission: 'read' as const, cloneUrl: 'https://github.com/acme/erp.git', path: `${root}/repositories/acme/erp` })

describe('evolved-development RPC', () => {
    it('only answers inside the managed project runner identity', () => {
        const env = { EVOLVED_RUNNER_ROOT: `/managed-workspaces/${projectId}`, EVOLVED_PROJECT_ID: projectId, HAPI_EVOLVED_PROXY: '1' }
        if (process.getuid?.() !== 0) expect(developmentRunnerRoot(projectId, env)).toBe(`/managed-workspaces/${projectId}`)
        expect(() => developmentRunnerRoot('other', env)).toThrow()
        expect(() => developmentRunnerRoot(projectId, { ...env, HAPI_EVOLVED_PROXY: '' })).toThrow()
        expect(() => developmentRunnerRoot(projectId, { ...env, EVOLVED_RUNNER_ROOT: '/etc' })).toThrow()
        expect(() => developmentRunnerRoot(projectId, { ...env, EVOLVED_RUNNER_ROOT: '/workspaces/../etc' })).toThrow()
    })

    it('revalidates the repository path instead of trusting the Hub payload', () => {
        const root = `/managed-workspaces/${projectId}`
        expect(checkedCheckout(root, repository(root))).toBe(`${root}/repositories/acme/erp`)
        for (const change of [{ path: '/etc' }, { path: `${root}/repositories/acme/../../x` }, { fullName: 'evil/erp' }, { cloneUrl: 'https://evil.test/acme/erp.git' }]) {
            expect(() => checkedCheckout(root, { ...repository(root), ...change })).toThrow()
        }
    })

    it('returns structured errors for invalid requests and foreign runners without running checks', async () => {
        expect(await developmentRpc({ action: 'shell', command: 'id' }, {})).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } })
        const settings = defaultDevelopmentSettings('odoo')
        expect(await developmentRpc({ action: 'doctor', projectId, revision: 1, mode: 'odoo', settings, repository: null, checks: [] }, {}))
            .toEqual({ error: { code: 'unavailable', message: expect.any(String) } })
    })

    it('runs doctor and inspect for the exact project root and returns contract-valid results', async () => {
        if (process.getuid?.() === 0) return
        const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'evolved-rpc-'))); directories.push(workspace)
        // The RPC accepts /workspaces/<dir> roots; emulate it with a symlink-free real directory via the env contract.
        const root = `/workspaces/${workspace.split('/').pop()}`
        const env = { EVOLVED_RUNNER_ROOT: root, EVOLVED_PROJECT_ID: projectId, HAPI_EVOLVED_PROXY: '1' }
        const settings = defaultDevelopmentSettings('odoo')
        const doctor = await developmentRpc({ action: 'doctor', projectId, revision: 3, mode: 'odoo', settings, repository: null, checks: ['git', 'odoo.source'] }, env)
        expect(DevelopmentDoctorResultSchema.parse(doctor).checks.map(check => check.id)).toEqual(['git', 'odoo.source', 'python.headers', 'build.libraries'])
        const inspect = await developmentRpc({ action: 'inspect', projectId, revision: 3, mode: 'odoo', settings, repository: repository(root) }, env)
        // /workspaces/<dir> does not exist on the test host: the checkout is honestly missing, never another directory.
        expect(DevelopmentInspectResultSchema.parse(inspect)).toMatchObject({ state: 'missing', repositoryId: '42', odooModules: [] })
        mkdirSync(join(workspace, 'x'))
        writeFileSync(join(workspace, 'x/__manifest__.py'), '{}')
    })
})
