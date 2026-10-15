import { expect, it } from 'bun:test'
import { validRunnerRoot } from './workspace'
import { validateAuthority, workspaceReadOnly, workspaceMountsSafe, droppedPrivileges } from './supervisor'
it('rejects nested mounts visible only in the runner namespace', () => {
    const root = '/workspaces/project', own = '1 0 1:0 / / ro - overlay overlay ro\n2 1 1:1 / /workspaces/project rw - ext4 disk rw'
    expect(workspaceMountsSafe(root, own)).toBe(true)
    expect(workspaceMountsSafe(root, `${own}\n3 2 1:2 / /workspaces/project/secrets ro - ext4 other ro`)).toBe(false)
    expect(workspaceMountsSafe(root, `${own}\n3 2 1:2 / /workspaces/project/escaped\\040folder ro - ext4 other ro`)).toBe(false)
    expect(workspaceMountsSafe(root, `${own}\n3 2 1:2 / /workspaces/project-other ro - ext4 other ro`)).toBe(true)
})
it('binds managed mounts to the exact project UUID and preserves explicit workspace mounts', () => {
    const id = '86bd0f72-511d-4ad4-9464-e45bc1c45917'
    expect(validRunnerRoot(`/managed-workspaces/${id}`, id)).toBe(true)
    expect(validRunnerRoot('/workspaces/project-1', id)).toBe(true)
    for (const root of ['/managed-workspaces/other', '/managed-workspaces', '/workspaces/a/b', '/workspaces/../runner', '/runner']) expect(validRunnerRoot(root, id)).toBe(false)
    expect(validRunnerRoot(`/managed-workspaces/${id}`, 'different-project')).toBe(false)
})
it('requires current project, profile, root and an active timed or permanent lease', () => {
    const expected = { projectId: 'p', profile: 'workspace', rootPath: '/workspaces/p' }
    expect(validateAuthority({ ...expected, expiresAt: 2000 }, expected, 1000)).toBe(true)
    expect(validateAuthority({ ...expected, expiresAt: null }, expected, 1000)).toBe(true)
    for (const expiresAt of [2000, null]) {
        for (const change of [{ projectId: 'other' }, { profile: 'restricted' }, { rootPath: '/workspaces/other' }]) {
            expect(validateAuthority({ ...expected, expiresAt, ...change }, expected, 1000)).toBe(false)
        }
    }
    for (const expiresAt of [undefined, 1000, 0, '2000', Infinity, NaN, false]) {
        expect(validateAuthority({ ...expected, expiresAt }, expected, 1000)).toBe(false)
    }
})
it('requires all identities, groups and capability sets to be dropped', () => {
    const status = 'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t\nCapInh:\t00000000\nCapPrm:\t00000000\nCapEff:\t00000000\nCapBnd:\t00000000\nCapAmb:\t00000000\n'
    expect(droppedPrivileges(status, 1000, 1000)).toBe(true)
    expect(droppedPrivileges(status.replace('Groups:\t', 'Groups:\t0'), 1000, 1000)).toBe(false)
    expect(droppedPrivileges(status.replace('CapBnd:\t00000000', 'CapBnd:\t00000080'), 1000, 1000)).toBe(false)
    expect(droppedPrivileges(status.replace('1000', '0'), 1000, 1000)).toBe(false)
})
it('checks the most specific mount, including escaped workspace paths', () => {
    const mounts = '1 0 1:0 / / ro - overlay overlay ro\n2 1 1:1 / /workspaces rw - ext4 disk rw\n3 2 1:2 / /workspaces/project\\040one ro - ext4 disk ro'
    expect(workspaceReadOnly('/workspaces/project one', mounts)).toBe(true)
    expect(workspaceReadOnly('/workspaces/project one/src', mounts)).toBe(true)
    expect(workspaceReadOnly('/workspaces/project two', mounts)).toBe(false)
})
