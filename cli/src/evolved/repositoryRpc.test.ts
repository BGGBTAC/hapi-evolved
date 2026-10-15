import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), sync: vi.fn(), request: vi.fn() }))
vi.mock('./repositoryWorkspace', () => ({
    inspectRepositories: mocks.inspect, syncRepository: mocks.sync,
    RepositoryWorkspaceError: class extends Error {}
}))
vi.mock('./client', () => ({ evolvedClientFromEnvironment: () => ({ request: mocks.request, projectPath: (path: string) => `/projects/${projectId}${path}` }) }))
import { repositoryRpc } from './repositoryRpc'
const projectId = '12345678-1234-4234-8234-123456789abc'
const jobId = '87654321-1234-4234-8234-123456789abc'
const root = `/managed-workspaces/${projectId}`
const repository = { id: '123', owner: 'example-owner', name: '.github', fullName: 'example-owner/.github', cloneUrl: 'https://github.com/example-owner/.github.git', path: `${root}/repositories/example-owner/.github`, permission: 'read' }
const sync = { action: 'clone', projectId, jobId, repository }
beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('HAPI_EVOLVED_PROXY', '1'); vi.stubEnv('EVOLVED_PROJECT_ID', projectId)
    vi.stubEnv('EVOLVED_RUNNER_ROOT', root); vi.stubEnv('EVOLVED_RUNNER_PROFILE', 'workspace')
    vi.spyOn(process, 'getuid').mockReturnValue(1001)
    mocks.request.mockResolvedValue({ authorized: true, machineId: 'machine-1', rootPath: root, repository })
    mocks.inspect.mockResolvedValue([{ id: '123', local: { state: 'missing', branch: null, dirty: null } }])
    mocks.sync.mockImplementation(async (_root, _repo, _action, authorize) => { await authorize(); return { state: 'ready', branch: 'main', dirty: false } })
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
it('only the fixed project daemon performs the job and checks live job authority before work', async () => {
    expect(await repositoryRpc(sync, 'machine-1')).toEqual({ local: { state: 'ready', branch: 'main', dirty: false } })
    expect(mocks.sync).toHaveBeenCalledWith(root, repository, 'clone', expect.any(Function))
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.request.mock.calls[0][0]).toBe(`/projects/${projectId}/repositories/123/authorization?jobId=${jobId}`)
})
it('reads hidden repository names from exact metadata without requesting mutation authority', async () => {
    await repositoryRpc({ action: 'status', projectId, repositories: [repository] }, 'machine-1')
    expect(mocks.inspect).toHaveBeenCalledWith(root, [repository]); expect(mocks.request).not.toHaveBeenCalled()
})
it('rejects cross-project, root, arbitrary paths, URLs and extra RPC fields before any work', async () => {
    for (const invalid of [
        { ...sync, projectId: jobId }, { ...sync, rootPath: '/tmp' },
        { ...sync, repository: { ...repository, path: '/tmp/other' } },
        { ...sync, repository: { ...repository, cloneUrl: 'https://evil.example.test/repo' } },
        { ...sync, repository: { ...repository, name: '..' } },
        { ...sync, action: 'reset' }
    ]) await expect(repositoryRpc(invalid, 'machine-1')).rejects.toBeDefined()
    vi.mocked(process.getuid!).mockReturnValue(0)
    await expect(repositoryRpc(sync, 'machine-1')).rejects.toBeDefined()
    expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled()
})
it('does not write in a restricted profile or outside the isolated proxy environment', async () => {
    vi.stubEnv('EVOLVED_RUNNER_PROFILE', 'restricted')
    await expect(repositoryRpc(sync, 'machine-1')).rejects.toThrow('read-only')
    vi.stubEnv('EVOLVED_RUNNER_PROFILE', 'workspace'); vi.stubEnv('HAPI_EVOLVED_PROXY', '0')
    await expect(repositoryRpc(sync, 'machine-1')).rejects.toThrow('unavailable')
    expect(mocks.sync).not.toHaveBeenCalled()
})
it('rejects mismatched live authority and rechecks before the worker changes files', async () => {
    for (const reply of [
        { authorized: false }, { authorized: true, machineId: 'other', rootPath: root, repository },
        { authorized: true, machineId: 'machine-1', rootPath: '/tmp', repository },
        { authorized: true, machineId: 'machine-1', rootPath: root, repository: { ...repository, id: '999' } }
    ]) {
        mocks.request.mockResolvedValue(reply)
        await expect(repositoryRpc(sync, 'machine-1')).rejects.toThrow('authorization changed')
    }
    expect(mocks.sync).not.toHaveBeenCalled()
})
