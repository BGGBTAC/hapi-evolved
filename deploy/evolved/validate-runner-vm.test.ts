import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error The JavaScript operator harness has no TypeScript declaration.
import { containerProbe, inspectAcceptanceBackend, inspectProviderCredentialAbsence, inspectTestContainer, observeRunnerStart, validationPlan } from './validate-runner-vm.mjs'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'evolved-runner-validation-'))
    directories.push(directory)
    const uid = process.getuid?.() || 1000, gid = process.getgid?.() || 1000
    const home = join(directory, 'home'), workspace = join(directory, 'workspace'), lease = join(directory, 'lease')
    mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace)
    writeFileSync(lease, 'synthetic-lease-never-print', { mode: 0o600 })
    if (process.getuid?.() === 0) { chownSync(home, uid, gid); chownSync(lease, uid, gid) }
    const projectId = '86bd0f72-511d-4ad4-9464-e45bc1c45917'
    const source = [
        `# HAPI_EVOLVED_RUNNER_VALIDATION=${projectId}`, `EVOLVED_UID=${uid}`, `EVOLVED_GID=${gid}`,
        `EVOLVED_PROJECT_ID=${projectId}`, 'EVOLVED_PROJECT_DIRECTORY=acceptance',
        'EVOLVED_RUNNER_PROFILE=restricted', 'EVOLVED_WORKSPACE_MODE=ro',
        `EVOLVED_RUNNER_WORKSPACE=${workspace}`, `EVOLVED_RUNNER_HOME=${home}`, `EVOLVED_RUNNER_LEASE_FILE=${lease}`,
        'EVOLVED_BACKEND_NETWORK=hapi-evolved-acceptance_backend',
    ].join('\n')
    return { directory, source, plan: validationPlan(source) }
}
function container(plan: ReturnType<typeof validationPlan>, service: string) {
    const runner = service === 'runner', proxy = service === 'runner-proxy'
    return {
        Config: { Labels: { 'com.docker.compose.project': plan.stack, 'com.docker.compose.service': service,
            'io.hapi.evolved.runner-validation': plan.projectId }, User: runner ? '0:0' : `${plan.config.EVOLVED_UID}:${plan.config.EVOLVED_GID}` },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: `${plan.stack}_project`, PidMode: '',
            CapDrop: ['ALL'], CapAdd: runner ? ['SETUID', 'SETGID', 'SETPCAP'] : [], SecurityOpt: ['no-new-privileges:true'], PortBindings: {}, Devices: [], DeviceRequests: [] },
        NetworkSettings: { Networks: Object.fromEntries([`${plan.stack}_project`, ...(proxy ? [plan.backend] : runner ? [] : [`${plan.stack}_provider-egress`])].map(name => [name, {}])) },
        Mounts: runner ? [
            { Type: 'bind', Source: plan.config.EVOLVED_RUNNER_HOME, Destination: '/runner', RW: true },
            { Type: 'bind', Source: plan.config.EVOLVED_RUNNER_WORKSPACE, Destination: plan.root, RW: false, Propagation: 'rprivate' },
        ] : proxy ? [{ Type: 'bind', Source: plan.config.EVOLVED_RUNNER_LEASE_FILE, Destination: '/credentials/lease', RW: false }] : [],
        State: { Running: true },
    }
}

describe('isolated runner VM acceptance guard', () => {
    test('rejects propagation of later host mounts into a checked project namespace', () => {
        const { plan } = fixture()
        for (const propagation of ['rshared', 'rslave', 'shared', 'slave', '']) {
            const value = container(plan, 'runner')
            value.Mounts[1].Propagation = propagation
            expect(() => inspectTestContainer(value, plan, 'runner')).toThrow('Mount')
        }
        expect(() => inspectTestContainer(container(plan, 'runner'), plan, 'runner')).not.toThrow()
    })
    test('never permits exec during startup or a short crash loop, even with a reused PID', () => {
        const state = { Running: true, Restarting: false, Pid: 17, StartedAt: '2026-10-15T07:00:00Z' }
        let result = observeRunnerStart(null, state, 0)
        expect(result.ready).toBe(false)
        result = observeRunnerStart(result.observation, state, 4999)
        expect(result.ready).toBe(false)
        expect(observeRunnerStart(result.observation, state, 5000).ready).toBe(true)
        for (let restart = 1; restart < 10; restart++) {
            const restarted = { ...state, StartedAt: `2026-10-15T07:00:${String(restart).padStart(2, '0')}Z` }
            result = observeRunnerStart(result.observation, restarted, 5000 + restart * 2000)
            expect(result.ready).toBe(false)
            expect(observeRunnerStart(result.observation, restarted, 6999 + restart * 2000).ready).toBe(false)
        }
    })
    test('resets the passive observation after stop, restarting state, invalid PID, or generation change', () => {
        const state = { Running: true, Restarting: false, Pid: 17, StartedAt: '2026-10-15T07:00:00Z' }
        const original = observeRunnerStart(null, state, 0).observation
        for (const invalid of [undefined, { ...state, Running: false }, { ...state, Restarting: true }, { ...state, Pid: 0 }, { ...state, Pid: 1.5 }, { ...state, StartedAt: '' }]) {
            const reset = observeRunnerStart(original, invalid, 6000)
            expect(reset).toEqual({ observation: null, ready: false })
            expect(observeRunnerStart(reset.observation, state, 6001).ready).toBe(false)
        }
        expect(observeRunnerStart(original, { ...state, Pid: 18 }, 6000).ready).toBe(false)
    })
    test('requires the exact UUID marker and fixes the stack name independently of production', () => {
        const { source, plan } = fixture()
        expect(plan.stack).toBe(`hapi-evolved-validation-${plan.projectId}`)
        expect(plan.backend).toBe('hapi-evolved-acceptance_backend')
        expect(plan.root).toBe('/workspaces/acceptance')
        for (const invalid of [source.split('\n').slice(1).join('\n'), source.replace('# HAPI_EVOLVED_RUNNER_VALIDATION=', '# HAPI_EVOLVED_RUNNER_VALIDATION=wrong-'), `${source}\n${source.split('\n')[0]}`]) {
            expect(() => validationPlan(invalid)).toThrow('Testmarkierung')
        }
    })
    test('refuses target overrides and an otherwise valid writable project', () => {
        const { source } = fixture()
        for (const key of ['COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'DOCKER_CONTEXT', 'DOCKER_HOST']) {
            expect(() => validationPlan(source, { [key]: 'unrelated-production' })).toThrow('Zieloverrides')
        }
        expect(() => validationPlan(source.replace('PROFILE=restricted', 'PROFILE=workspace').replace('MODE=ro', 'MODE=rw'))).toThrow('restricted und ro')
    })
    test('never falls back to a production backend and verifies actual network ownership', () => {
        const { source, plan } = fixture()
        expect(() => validationPlan(source.replace('EVOLVED_BACKEND_NETWORK=hapi-evolved-acceptance_backend', ''))).toThrow('ausdrücklich')
        expect(() => validationPlan(source.replace('EVOLVED_BACKEND_NETWORK=hapi-evolved-acceptance_backend', 'EVOLVED_BACKEND_NETWORK=hapi-evolved_backend'))).toThrow('ausdrücklich')
        const network = { Name: plan.backend, Internal: true, Labels: { 'com.docker.compose.project': 'hapi-evolved-acceptance', 'com.docker.compose.network': 'backend' } }
        expect(() => inspectAcceptanceBackend(network, plan)).not.toThrow()
        for (const invalid of [{ ...network, Name: 'hapi-evolved_backend' }, { ...network, Internal: false },
            { ...network, Labels: {} }, { ...network, Labels: { ...network.Labels, 'com.docker.compose.project': 'hapi-evolved' } }]) {
            expect(() => inspectAcceptanceBackend(invalid, plan)).toThrow('Abnahmestack')
        }
    })
    test('accepts only the three expected containers and can inspect stopped configuration before starting', () => {
        const { plan } = fixture()
        for (const service of ['runner', 'runner-proxy', 'egress']) {
            const value = container(plan, service)
            expect(() => inspectTestContainer(value, plan, service)).not.toThrow()
            value.State.Running = false
            expect(() => inspectTestContainer(value, plan, service, false)).not.toThrow()
            expect(() => inspectTestContainer(value, plan, service)).toThrow('läuft nicht')
        }
        expect(() => inspectTestContainer(container(plan, 'hub'), plan, 'hub')).toThrow('Unbekannter')
    })
    test('checks provider metadata without reading values and rejects inaccessible or linked paths', () => {
        const { directory, plan } = fixture(), home = plan.config.EVOLVED_RUNNER_HOME
        expect(() => inspectProviderCredentialAbsence(home)).not.toThrow()
        expect(() => inspectProviderCredentialAbsence(join(directory, 'missing'))).toThrow('nicht zugänglich')
        const nativeHome = join(home, 'codex'); mkdirSync(nativeHome)
        symlinkSync('/nonexistent/synthetic-target', join(nativeHome, 'auth.json'))
        expect(() => inspectProviderCredentialAbsence(home)).toThrow('Provideranmeldung')
        rmSync(join(nativeHome, 'auth.json'))
        if (process.getuid?.() !== 0) {
            chmodSync(nativeHome, 0)
            expect(() => inspectProviderCredentialAbsence(home)).toThrow('nicht sicher prüfbar')
            chmodSync(nativeHome, 0o700)
        }
        writeFileSync(join(nativeHome, 'auth.json'), 'synthetic-provider-value', { mode: 0o600 })
        try { inspectProviderCredentialAbsence(home) } catch (error) {
            expect(String(error)).not.toContain('synthetic-provider-value')
        }
    })
    test('rejects a marked container that escapes a security boundary, even while stopped', () => {
        const { plan } = fixture()
        const mutations = [
            (value: any) => { delete value.Config.Labels['io.hapi.evolved.runner-validation'] },
            (value: any) => { value.Config.Labels['com.docker.compose.project'] = 'hapi-evolved-acceptance' },
            (value: any) => { value.Config.User = '1000:1000' },
            (value: any) => { value.HostConfig.Privileged = true },
            (value: any) => { value.HostConfig.ReadonlyRootfs = false },
            (value: any) => { value.HostConfig.NetworkMode = 'host' },
            (value: any) => { value.HostConfig.PidMode = 'host' },
            (value: any) => { value.HostConfig.CapAdd.push('SYS_ADMIN') },
            (value: any) => { value.HostConfig.CapDrop = [] },
            (value: any) => { value.HostConfig.SecurityOpt = [] },
            (value: any) => { value.HostConfig.PortBindings = { '3010/tcp': [{ HostPort: '3010' }] } },
            (value: any) => { value.NetworkSettings.Networks.production = {} },
            (value: any) => { value.Mounts[1].RW = true },
            (value: any) => { value.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }) },
        ]
        for (const mutate of mutations) {
            const value = container(plan, 'runner'); value.State.Running = false; mutate(value)
            expect(() => inspectTestContainer(value, plan, 'runner', false)).toThrow()
        }
    })
    test('compiles both embedded probes without executing them or embedding lease paths/values', () => {
        const { plan } = fixture()
        for (const onlyRegistration of [true, false]) {
            const script = containerProbe(plan, onlyRegistration)
            expect(() => new Bun.Transpiler({ loader: 'js', target: 'bun' }).transformSync(script)).not.toThrow()
            expect(script).not.toContain(plan.config.EVOLVED_RUNNER_LEASE_FILE)
            expect(script).not.toContain('synthetic-lease-never-print')
            expect(script).toContain("writeError==='EROFS'")
            expect(script).toContain('169.254.169.254:443')
            expect(script).toContain('CapBnd')
        }
    })
    test('CLI refuses an unmarked env before Docker and never prints the synthetic lease', async () => {
        const { directory, source } = fixture(), envFile = join(directory, 'runner.env')
        writeFileSync(envFile, source.split('\n').slice(1).join('\n'), { mode: 0o600 })
        const child = Bun.spawn([process.execPath, join(import.meta.dir, 'validate-runner-vm.mjs'), envFile, '--start'], { stdout: 'pipe', stderr: 'pipe' })
        const output = await new Response(child.stderr).text()
        expect(await child.exited).toBe(1)
        expect(output).toContain('Testmarkierung')
        expect(output).not.toContain('synthetic-lease-never-print')
        expect(await new Response(child.stdout).text()).toBe('')
    })
})
