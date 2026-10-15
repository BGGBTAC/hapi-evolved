import { expect, it } from 'bun:test'
import { validateAuthority, workspaceReadOnly, droppedPrivileges } from './supervisor'
it('requires current project, profile, root and an unexpired lease', () => {
    const expected = { projectId: 'p', profile: 'workspace', rootPath: '/workspaces/p' }
    expect(validateAuthority({ ...expected, expiresAt: 2000 }, expected, 1000)).toBe(true)
    for (const change of [{ projectId: 'other' }, { profile: 'restricted' }, { rootPath: '/workspaces/other' }, { expiresAt: 1000 }]) {
        expect(validateAuthority({ ...expected, expiresAt: 2000, ...change }, expected, 1000)).toBe(false)
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
