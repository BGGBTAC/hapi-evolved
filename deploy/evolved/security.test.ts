import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const policy = JSON.parse(source('./security/runner-seccomp.json'))

describe('native runner sandbox policy', () => {
    test('retains the pinned Docker default and adds only the reviewed Bubblewrap operations', () => {
        const baseline = { ...policy, syscalls: policy.syscalls.slice(0, 60) }
        expect(createHash('sha256').update(JSON.stringify(baseline)).digest('hex'))
            .toBe('3e30a4b18c1cab37399d130ba2abfbaa15827f1db45c451253314c635f57907d')
        const additions = policy.syscalls.slice(60)
        expect(additions).toHaveLength(4)
        expect(additions.map((rule: { names: string[] }) => rule.names))
            .toEqual([['clone'], ['unshare'], ['mount', 'pivot_root'], ['umount2']])
        expect(additions.every((rule: { action: string }) => rule.action === 'SCMP_ACT_ALLOW')).toBe(true)
        for (const [index, flags] of [0x38020011].entries()) {
            expect(additions[index].args).toEqual([{ index: 0, value: flags, op: 'SCMP_CMP_EQ' }])
            expect(additions[index].includes).toEqual({ arches: ['amd64', 'arm64'] })
        }
        expect(additions[1].args).toEqual([{ index: 0, value: 0x10000000, op: 'SCMP_CMP_EQ' }])
        expect(additions[3].args).toEqual([{ index: 1, value: 2, op: 'SCMP_CMP_EQ' }])
        expect(policy.defaultAction).toBe('SCMP_ACT_ERRNO')
        expect(policy.syscalls.some((rule: { names: string[]; action: string; errnoRet?: number }) =>
            rule.names.includes('clone3') && rule.action === 'SCMP_ACT_ERRNO' && rule.errnoRet === 38)).toBe(true)
    })

    test('only the runner receives the reviewed policies; isolation and supervisor caps remain unchanged', () => {
        const compose = Bun.YAML.parse(source('./runner.compose.yml')) as {
            services: Record<string, { security_opt: string[]; cap_add?: string[]; cap_drop: string[]; read_only: boolean }>
        }
        expect(compose.services.runner.security_opt).toEqual([
            'no-new-privileges:true', 'apparmor=hapi-evolved-runner', 'seccomp=./security/runner-seccomp.json',
        ])
        expect(compose.services.runner.cap_add).toEqual(['SETUID', 'SETGID', 'SETPCAP'])
        for (const [name, service] of Object.entries(compose.services)) {
            expect(service.cap_drop).toEqual(['ALL'])
            expect(service.read_only).toBe(true)
            if (name !== 'runner') expect(service.security_opt).toEqual(['no-new-privileges:true'])
        }
    })

    test('AppArmor confines mounts to Bubblewrap construction and preserves host-kernel denies', () => {
        const profile = source('./security/runner.apparmor')
        expect(profile).toContain('profile hapi-evolved-runner flags=(attach_disconnected,mediate_deleted)')
        expect(profile).not.toMatch(/flags=\([^)]*(?:unconfined|complain)/)
        expect(profile).not.toMatch(/^\s*(?:mount|pivot_root)\s*,/m)
        expect(profile).toContain('mount options=(rw,silent,rslave) -> /,')
        expect(profile).toContain('pivot_root oldroot=/tmp/oldroot/ /tmp/,')
        expect(profile).toContain('pivot_root oldroot=/newroot/ /newroot/,')
        expect(profile).toContain('deny @{PROC}/sysrq-trigger rwklx,')
        expect(profile).toContain('deny /sys/kernel/security/** rwklx,')
        expect(profile).not.toContain('change_profile')
    })

    test.skipIf(!existsSync('/usr/sbin/apparmor_parser'))('compiles the named enforce profile without loading it', () => {
        const result = spawnSync('/usr/sbin/apparmor_parser', ['-Q', '-T', '-K',
            new URL('./security/runner.apparmor', import.meta.url).pathname], { encoding: 'utf8' })
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
    })
})
