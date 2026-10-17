import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertRootOwnedPath } from './workspaceAnchor'

const setupHelp = 'Install and load deploy/evolved/security/runner.apparmor as hapi-evolved-runner before starting managed runners; see docs/evolved/HOST_CONTROL.md.'

export function requireRunnerAppArmor(profiles: string): void {
    if (!profiles.split('\n').includes('hapi-evolved-runner (enforce)')) {
        throw new Error(`The hapi-evolved-runner AppArmor profile is not loaded in enforce mode. ${setupHelp}`)
    }
}

/** Operator startup checks public policy files and kernel metadata, never credentials. */
export function requireRunnerSandbox(source: string): void {
    for (const policy of ['runner.apparmor', 'runner-seccomp.json']) {
        const path = join(source, 'deploy/evolved/security', policy)
        assertRootOwnedPath(path)
        if (!lstatSync(path).isFile()) throw new Error('Runner security policy must be a root-owned regular file')
    }
    let profiles: string
    try { profiles = readFileSync('/sys/kernel/security/apparmor/profiles', 'utf8') }
    catch { throw new Error(`AppArmor enforce profiles cannot be verified on this host. ${setupHelp}`) }
    requireRunnerAppArmor(profiles)
}
