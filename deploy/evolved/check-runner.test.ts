import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, chownSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRunnerConfig, parseRunnerEnv } from './check-runner'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-runner-preflight-'))
    directories.push(directory)
    const uid = process.getuid?.() || 1000
    const home = join(directory, 'home'), workspace = join(directory, 'workspace'), lease = join(directory, 'lease')
    mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace); writeFileSync(lease, 'synthetic-test-lease', { mode: 0o600 })
    if (process.getuid?.() === 0) { chownSync(home, uid, uid); chownSync(lease, uid, uid) }
    const config = parseRunnerEnv([
        `EVOLVED_UID=${uid}`, `EVOLVED_GID=${process.getgid?.() || 1000}`,
        'EVOLVED_PROJECT_ID=86bd0f72-511d-4ad4-9464-e45bc1c45917', 'EVOLVED_PROJECT_DIRECTORY=project-1',
        'EVOLVED_RUNNER_PROFILE=restricted', 'EVOLVED_WORKSPACE_MODE=ro',
        `EVOLVED_RUNNER_WORKSPACE=${workspace}`, `EVOLVED_RUNNER_HOME=${home}`, `EVOLVED_RUNNER_LEASE_FILE=${lease}`,
    ].join('\n'))
    return { directory, home, workspace, lease, uid, config }
}
describe('runner operator preflight', () => {
    test('managed workspace mounts require the project UUID as their directory', () => {
        const { config } = fixture()
        expect(checkRunnerConfig({ ...config, EVOLVED_WORKSPACE_PREFIX: '/managed-workspaces', EVOLVED_PROJECT_DIRECTORY: config.EVOLVED_PROJECT_ID }).profile).toBe('restricted')
        for (const prefix of ['/managed-workspaces', '/arbitrary', '/workspaces/../managed-workspaces']) {
            expect(() => checkRunnerConfig({ ...config, EVOLVED_WORKSPACE_PREFIX: prefix })).toThrow()
        }
    })
    test('accepts a private, separated configuration and explicit writable workspace profile', () => {
        const { config } = fixture()
        expect(checkRunnerConfig(config).profile).toBe('restricted')
        expect(checkRunnerConfig({ ...config, EVOLVED_RUNNER_PROFILE: 'workspace', EVOLVED_WORKSPACE_MODE: 'rw' }).mode).toBe('rw')
    })
    test('rejects interpolation, shell syntax, quotes, duplicate and unknown keys without exposing values', () => {
        for (const source of ['EVOLVED_UID=$(secret-value)', 'EVOLVED_UID=`secret-value`', 'EVOLVED_UID="secret-value"', 'export EVOLVED_UID=secret-value', 'EVOLVED_UID=1;secret-value', 'SECRET=secret-value', 'EVOLVED_UID=1\nEVOLVED_UID=secret-value']) {
            expect(() => parseRunnerEnv(source)).toThrow()
            try { parseRunnerEnv(source) } catch (error) { expect(String(error)).not.toContain('secret-value') }
        }
        expect(parseRunnerEnv('# comment\r\n\nEVOLVED_UID=1000\r\n').EVOLVED_UID).toBe('1000')
    })
    test('rejects invalid identity, mount injection, root execution and unsafe profile combinations', () => {
        const { config } = fixture()
        for (const changes of [
            { EVOLVED_PROJECT_ID: 'project' }, { EVOLVED_PROJECT_DIRECTORY: '../other' }, { EVOLVED_PROJECT_DIRECTORY: 'a:rw' },
            { EVOLVED_UID: '0' }, { EVOLVED_GID: '0' }, { EVOLVED_UID: '1e3' },
            { EVOLVED_RUNNER_PROFILE: 'unknown' }, { EVOLVED_WORKSPACE_MODE: 'rw' }, { EVOLVED_RUNNER_WORKSPACE: '/tmp:/escape' },
        ]) expect(() => checkRunnerConfig({ ...config, ...changes })).toThrow()
    })
    test('rejects permissive or incorrectly owned homes and non-directory workspaces', () => {
        const { config, home, lease, uid } = fixture()
        chmodSync(home, 0o755)
        expect(() => checkRunnerConfig(config)).toThrow('0700')
        chmodSync(home, 0o700)
        expect(() => checkRunnerConfig({ ...config, EVOLVED_UID: String(uid + 1) })).toThrow('Besitzer')
        expect(() => checkRunnerConfig({ ...config, EVOLVED_RUNNER_WORKSPACE: lease })).toThrow('echte Verzeichnisse')
    })
    test('rejects readable leases, hard links and symbolic links', () => {
        const { config, lease, directory } = fixture()
        chmodSync(lease, 0o644)
        expect(() => checkRunnerConfig(config)).toThrow('0600')
        chmodSync(lease, 0o600)
        linkSync(lease, join(directory, 'hardlink'))
        expect(() => checkRunnerConfig(config)).toThrow('ohne Links')
        rmSync(join(directory, 'hardlink'))
        symlinkSync(lease, join(directory, 'symlink'))
        expect(() => checkRunnerConfig({ ...config, EVOLVED_RUNNER_LEASE_FILE: join(directory, 'symlink') })).toThrow('ohne Links')
    })
    test('rejects leases inside either agent-visible mount including symlinked parent directories', () => {
        const { config, directory, workspace, home, uid } = fixture()
        for (const visible of [workspace, home]) {
            const path = join(visible, 'lease')
            writeFileSync(path, 'synthetic', { mode: 0o600 })
            if (process.getuid?.() === 0) chownSync(path, uid, uid)
            expect(() => checkRunnerConfig({ ...config, EVOLVED_RUNNER_LEASE_FILE: path })).toThrow('außerhalb')
        }
        symlinkSync(home, join(directory, 'alias'))
        expect(() => checkRunnerConfig({ ...config, EVOLVED_RUNNER_LEASE_FILE: join(directory, 'alias/lease') })).toThrow('außerhalb')
    })
    test('uses path components for containment and rejects overlapping home/workspace trees', () => {
        const { config, workspace, uid } = fixture()
        mkdirSync(`${workspace}-other`)
        const leasePath = join(`${workspace}-other`, 'lease')
        writeFileSync(leasePath, 'synthetic', { mode: 0o600 })
        if (process.getuid?.() === 0) chownSync(leasePath, uid, uid)
        expect(checkRunnerConfig({ ...config, EVOLVED_RUNNER_LEASE_FILE: leasePath }).mode).toBe('ro')
        expect(() => checkRunnerConfig({ ...config, EVOLVED_RUNNER_WORKSPACE: config.EVOLVED_RUNNER_HOME })).toThrow('getrennte')
    })
    test('rejects directory symlinks even when a trailing slash would make lstat follow them', () => {
        const { config, directory, workspace } = fixture()
        const alias = join(directory, 'workspace-alias')
        symlinkSync(workspace, alias)
        expect(() => checkRunnerConfig({ ...config, EVOLVED_RUNNER_WORKSPACE: alias })).toThrow('echte Verzeichnisse')
        expect(() => checkRunnerConfig({ ...config, EVOLVED_RUNNER_WORKSPACE: `${alias}/` })).toThrow('Schrägstrich')
    })
    test('refuses exported variables that would override Compose env-file configuration', () => {
        const { config } = fixture()
        expect(() => checkRunnerConfig(config, { EVOLVED_RUNNER_LEASE_FILE: '/secret-value' })).toThrow('überschreibt')
        expect(() => checkRunnerConfig(config, { EVOLVED_EGRESS_HOSTS: 'unexpected.example' })).toThrow('überschreibt')
        expect(checkRunnerConfig(config, { EVOLVED_UID: config.EVOLVED_UID }).mode).toBe('ro')
    })
    test('CLI failure prints neither lease contents nor invalid values', async () => {
        const { config, directory } = fixture()
        const path = join(directory, 'runner.env')
        writeFileSync(path, Object.entries({ ...config, EVOLVED_PROJECT_ID: 'private-value-canary' }).map(([key, value]) => `${key}=${value}`).join('\n'))
        const child = Bun.spawn([process.execPath, join(import.meta.dir, 'check-runner.ts'), path], { stdout: 'pipe', stderr: 'pipe' })
        const output = await new Response(child.stderr).text()
        expect(await child.exited).toBe(1)
        expect(output).toContain('EVOLVED_PROJECT_ID')
        expect(output).not.toContain('private-value-canary')
        expect(output).not.toContain('synthetic-test-lease')
    })
})
