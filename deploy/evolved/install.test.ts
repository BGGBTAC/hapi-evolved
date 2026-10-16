import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { runInstaller, parseOptions, type InstallerDependencies, type InstallerOptions } from './install'
import { initializeState, checkStatePath, CREDENTIAL_FILES, SOURCE_ROOT } from './init'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temp() { const path = mkdtempSync(join(tmpdir(), 'evolved-install-test-')); temporary.push(path); return path }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const compose = join(SOURCE_ROOT, 'deploy/evolved/compose.yml')
const services = ['hub', 'vault', 'codegraph', 'memory', 'neo4j']
function fixture() {
    const directory = temp(), state = join(directory, 'state')
    const project = `hapi-evolved-${digest(state).slice(0, 20)}`
    const calls: Parameters<InstallerDependencies['command']>[0][] = []
    const images = new Map<string, string>()
    const containers = new Map<string, any>(), networks = new Map<string, any>()
    let portFree = true, endpoint = 'unix:///var/run/docker.sock', composeVersion = '2.32.4'
    let daemon: unknown = { osType: 'linux', operatingSystem: 'Ubuntu 24.04', securityOptions: ['name=seccomp,profile=builtin'] }
    let failCommand: ((argv: string[]) => boolean) | undefined
    let beforeCommand: ((argv: string[]) => Promise<void>) | undefined
    function addImages() {
        for (const name of [`${project}:hub`, `${project}:codegraph`, `${project}:memory`, 'neo4j:2026.09.0']) images.set(name, `sha256:${digest(name)}`)
    }
    function addContainers() {
        for (const service of services) {
            const mounts: any[] = [
                { Type: 'bind', Source: join(state, service), Destination: '/data', RW: true },
                { Type: 'bind', Source: join(state, 'credentials', service), Destination: '/credentials', RW: false },
                { Type: 'tmpfs', Destination: '/tmp' },
            ]
            if (service === 'hub' || service === 'codegraph') mounts.push(
                { Type: 'bind', Source: join(state, 'workspaces'), Destination: '/workspaces', RW: false },
                { Type: 'bind', Source: join(state, 'managed-workspaces'), Destination: '/managed-workspaces', RW: service === 'hub' },
            )
            if (service === 'hub') mounts.push({ Type: 'bind', Source: join(state, 'control-placeholder'), Destination: '/runner-control', RW: false })
            if (service === 'neo4j') mounts.push({ Type: 'bind', Source: join(state, 'neo4j-logs'), Destination: '/logs', RW: true })
            containers.set(digest(service), { id: digest(service), labels: {
                'com.docker.compose.project': project, 'com.docker.compose.service': service,
                'com.docker.compose.project.working_dir': dirname(compose),
                'com.docker.compose.project.config_files': `${compose},${join(state, 'installer.compose.json')}`,
            }, image: images.get(service === 'neo4j' ? 'neo4j:2026.09.0' : `${project}:${service === 'vault' ? 'hub' : service}`), mounts, ports: service === 'hub' ? { '3006/tcp': [{ HostIp: '127.0.0.1', HostPort: '3006' }] } : {}, state: 'running', health: service === 'hub' ? 'healthy' : null })
        }
    }
    const deps: InstallerDependencies = {
        platform: 'linux', uid: process.getuid!(), gid: process.getgid!(), bunVersion: '1.3.14', memoryBytes: 16 * 1024 ** 3,
        environment: { PATH: '/synthetic/bin', HOME: directory, SECRET_NOT_FOR_DOCKER: 'synthetic-secret-value' },
        portAvailable: async () => portFree,
        command: async command => {
            calls.push(command)
            const a = command.argv
            await beforeCommand?.(a)
            if (failCommand?.(a)) return { code: 1, stdout: 'synthetic-secret-value' }
            let stdout = ''
            if (a[1] === '--version') stdout = 'Docker version 27.5.1'
            else if (a[1] === 'compose' && a[2] === 'version') stdout = composeVersion
            else if (a[1] === 'context') stdout = JSON.stringify(endpoint)
            else if (a[1] === 'info') stdout = JSON.stringify(daemon)
            else if (a[1] === 'buildx') stdout = 'github.com/docker/buildx v0.30.0 abcdef'
            else if (a[1] === 'ps') stdout = [...containers.keys()].join('\n')
            else if (a[1] === 'network' && a[2] === 'ls') stdout = [...networks.keys()].join('\n')
            else if (a[1] === 'network' && a[2] === 'inspect') stdout = JSON.stringify(networks.get(a[3]!))
            else if (a[1] === 'inspect') stdout = JSON.stringify(containers.get(a.at(-1)!))
            else if (a[1] === 'image' && a[2] === 'ls') stdout = images.get(a[4]!.slice('reference='.length)) ?? ''
            else if (a[1] === 'image' && a[2] === 'inspect') {
                if (!images.has(a[3]!)) return { code: 1, stdout: '' }
                stdout = images.get(a[3]!)!
            } else if (a[1] === 'pull') images.set(a[2]!, `sha256:${digest(a[2]!)}`)
            else if (a[1] === 'compose' && a.includes('build')) {
                for (const service of a.slice(a.indexOf('build') + 1)) images.set(`${project}:${service}`, `sha256:${digest(`${project}:${service}`)}`)
            } else if (a[1] === 'compose' && a.includes('up')) { addContainers(); portFree = false }
            else if (!(a[1] === 'compose' && a.includes('config'))) throw new Error(`Unexpected command: ${a.join(' ')}`)
            return { code: 0, stdout }
        },
    }
    const run = (action: InstallerOptions['action'], extra: Partial<InstallerOptions> = {}) => runInstaller({ action, state, ...extra }, deps)
    return { directory, state, project, deps, calls, images, containers, networks, run, addImages, addContainers,
        setDaemon: (value: unknown) => { daemon = value },
        setComposeVersion: (version: string) => { composeVersion = version },
        setPort: (free: boolean) => { portFree = free }, setEndpoint: (value: string) => { endpoint = value },
        fail: (fn?: typeof failCommand) => { failCommand = fn }, before: (fn?: typeof beforeCommand) => { beforeCommand = fn } }
}
function mutations(calls: ReturnType<typeof fixture>['calls']) {
    return calls.filter(({ argv }) => argv[1] === 'pull' || argv[1] === 'compose' && (argv.includes('build') || argv.includes('up')))
}
function credentialSnapshot(path: string) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected regular single-linked test credential')
        return { hash: digest(readFileSync(fd)), mode: stat.mode, inode: stat.ino, mtime: stat.mtimeMs }
    } finally { closeSync(fd) }
}
function credentials(state: string) {
    return Object.fromEntries(CREDENTIAL_FILES.map(name => [name, credentialSnapshot(join(state, 'credentials', name))]))
}
function errors(report: Awaited<ReturnType<typeof runInstaller>>) { return report.checks.filter(check => check.status === 'error').map(check => check.id) }

describe('fresh core installer boundaries', () => {
    test('check and status are read-only on absent state and give structured next steps', async () => {
        const f = fixture()
        for (const action of ['check', 'status'] as const) {
            const result = await f.run(action)
            expect(result.ok).toBe(true)
            expect(result.installation.initialized).toBe(false)
            expect(result.nextSteps.join(' ')).toContain('init')
            expect(result.hostControl.status).toBe('operator-setup-required')
            expect(existsSync(f.state)).toBe(false)
        }
        expect(mutations(f.calls)).toEqual([])
        expect(f.calls.every(call => !call.argv.includes('config'))).toBe(true)
    })
    test('root, wrong runtime, remote context and environment overrides fail before any mutation', async () => {
        for (const change of [{ uid: 0 }, { gid: 0 }, { platform: 'darwin' }, { bunVersion: '1.3.13' }]) {
            const f = fixture(); Object.assign(f.deps, change)
            expect((await f.run('init')).ok).toBe(false)
            expect(f.calls).toHaveLength(0)
            expect(existsSync(f.state)).toBe(false)
        }
        for (const key of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'EVOLVED_STATE_DIR', 'EVOLVED_MEMORY_MODEL', 'DOCKER_HOST', 'DOCKER_CONTEXT']) {
            const f = fixture(); f.deps.environment[key] = 'synthetic-secret-value'
            const result = await f.run('install', { yes: true })
            expect(errors(result)).toContain('environment_override')
            expect(JSON.stringify(result)).not.toContain('synthetic-secret-value')
            expect(f.calls).toHaveLength(0)
        }
        const f = fixture(); f.setEndpoint('ssh://elsewhere.example')
        expect(errors(await f.run('init'))).toContain('remote_docker')
        expect(existsSync(f.state)).toBe(false)
    })
    test('supports actual Compose plugins 2.x and 5.6 while rejecting legacy or malformed versions', async () => {
        for (const version of ['2.20.0', '2.32.4', 'v2.39.0', '5.6.0', '2.37.1+ds1-0ubuntu2~24.04.1']) {
            const f = fixture(); f.setComposeVersion(version)
            expect((await f.run('check')).ok).toBe(true)
            expect(existsSync(f.state)).toBe(false)
        }
        for (const version of ['1.29.2', 'v1.0.0', '2.19.9', 'unknown', '2.3.4 secret']) {
            const f = fixture(); f.setComposeVersion(version)
            expect(errors(await f.run('init'))).toContain('compose_version')
            expect(existsSync(f.state)).toBe(false)
        }
    })
    test('unsupported Docker identity mapping and missing Buildx fail before state creation', async () => {
        for (const daemon of [
            { osType: 'linux', operatingSystem: 'Ubuntu', securityOptions: ['name=rootless'] },
            { osType: 'linux', operatingSystem: 'Ubuntu', securityOptions: ['name=userns'] },
            { osType: 'linux', operatingSystem: 'Docker Desktop', securityOptions: [] },
        ]) {
            const f = fixture(); f.setDaemon(daemon)
            expect(errors(await f.run('install', { yes: true }))).toContain('docker_identity_mapping')
            expect(existsSync(f.state)).toBe(false); expect(mutations(f.calls)).toHaveLength(0)
        }
        const f = fixture(); f.fail(argv => argv[1] === 'buildx')
        const result = await f.run('init')
        expect(errors(result)).toContain('buildx_missing'); expect(existsSync(f.state)).toBe(false)
        expect(JSON.stringify(result)).not.toContain('synthetic-secret-value')
        expect(mutations(f.calls)).toHaveLength(0)
    })
    test('initialization repeats without rewriting any credential bytes, modes, inodes or timestamps', async () => {
        const f = fixture()
        expect((await f.run('init')).ok).toBe(true)
        const before = credentials(f.state), env = readFileSync(join(f.state, 'compose.env'))
        expect((await f.run('init')).ok).toBe(true)
        expect(initializeState(f.state).created).toBe(false)
        expect(credentials(f.state)).toEqual(before)
        expect(readFileSync(join(f.state, 'compose.env'))).toEqual(env)
        const privateKey = createPrivateKey(readFileSync(join(f.state, 'credentials/hub/vault-signing.pem')))
        const publicKey = createPublicKey(readFileSync(join(f.state, 'credentials/vault/hub-public.pem')))
        expect(verify(null, Buffer.from('fixture'), publicKey, sign(null, Buffer.from('fixture'), privateKey))).toBe(true)
        expect(readFileSync(join(f.state, 'credentials/vault/master.key'))).toHaveLength(32)
        expect(mutations(f.calls)).toEqual([])
        expect(JSON.stringify(await f.run('status'))).not.toContain(readFileSync(join(f.state, 'credentials/hub/service.token'), 'utf8'))
    })
    test('incomplete, foreign and permission-weakened state is preserved instead of regenerated', async () => {
        const f = fixture(); await f.run('init')
        const before = credentials(f.state)
        const key = join(f.state, 'credentials/memory/service.token')
        rmSync(key)
        expect((await f.run('init')).ok).toBe(false)
        expect(existsSync(key)).toBe(false)
        expect(credentialsWithoutMissing(f.state)).toEqual(Object.fromEntries(Object.entries(before).filter(([name]) => name !== 'memory/service.token')))
        const foreign = fixture(); mkdirSync(foreign.state, { mode: 0o700 }); writeFileSync(join(foreign.state, 'user.data'), 'keep')
        expect(errors(await foreign.run('init'))).toContain('unmanaged_state')
        expect(readdirSync(foreign.state)).toEqual(['user.data'])
        const permissive = fixture(); await permissive.run('init'); chmodSync(join(permissive.state, 'credentials'), 0o755)
        expect((await permissive.run('status')).ok).toBe(false)
        expect(lstatSync(join(permissive.state, 'credentials')).mode & 0o777).toBe(0o755)
    })
    test('source-root containment is independent of cwd; symlink, FIFO and hardlink state is refused', async () => {
        const oldCwd = process.cwd()
        try { process.chdir(tmpdir()); expect(() => checkStatePath(join(SOURCE_ROOT, 'private-state'))).toThrow('outside') }
        finally { process.chdir(oldCwd) }
        const f = fixture(), target = join(f.directory, 'target')
        mkdirSync(target, { mode: 0o700 }); symlinkSync(target, f.state)
        expect((await f.run('init')).ok).toBe(false)
        expect(readdirSync(target)).toEqual([])
        const linked = fixture(); await linked.run('init')
        const key = join(linked.state, 'credentials/vault/master.key')
        linkSync(key, join(linked.directory, 'hardlink'))
        expect((await linked.run('status')).ok).toBe(false)
        const fifo = fixture(); await fifo.run('init')
        const fifoPath = join(fifo.state, 'credentials/hub/service.token'); rmSync(fifoPath)
        expect(Bun.spawnSync(['mkfifo', '-m', '600', fifoPath]).exitCode).toBe(0)
        expect((await fifo.run('status')).ok).toBe(false)
    })
    test('private nested paths under root-owned sticky tmp work; writable ancestors fail before initialization', async () => {
        expect(() => checkStatePath(join(homedir(), '.hapi-evolved-private-path-check'))).not.toThrow()
        const root = temp(), state = join(root, 'new', 'nested', 'state')
        expect(initializeState(state).created).toBe(true)
        for (const path of [join(root, 'new'), join(root, 'new', 'nested'), state]) {
            expect(lstatSync(path).mode & 0o7777).toBe(0o700)
        }
        const before = credentials(state)
        expect(initializeState(state).created).toBe(false)
        expect(credentials(state)).toEqual(before)
        for (const mode of [0o770, 0o777, 0o1777]) {
            const writable = temp(), child = join(writable, 'state')
            chmodSync(writable, mode)
            expect(() => initializeState(child)).toThrow('group/world writable')
            expect(existsSync(child)).toBe(false)
        }
    })
    test('foreign-owned ancestor and competing directory creation are refused without adoption', () => {
        const parent = temp(), state = join(parent, 'state')
        const originalLstat = fs.lstatSync
        const foreign = spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
            const result = originalLstat(path, options as { bigint?: false })
            if (String(path) === parent) result.uid = process.getuid!() + 1
            return result
        }) as typeof fs.lstatSync)
        try {
            expect(() => initializeState(state)).toThrow('belong to root or the invoking user')
            expect(existsSync(state)).toBe(false)
        } finally { foreign.mockRestore() }

        const root = temp(), racedParent = join(root, 'competing'), racedState = join(racedParent, 'state')
        const originalMkdir = fs.mkdirSync
        const competing = spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            if (String(path) === racedParent) {
                originalMkdir(path, { mode: 0o700 })
                writeFileSync(join(racedParent, 'competitor.txt'), 'preserve this directory')
            }
            return originalMkdir(path, options)
        }) as typeof fs.mkdirSync)
        try {
            expect(() => initializeState(racedState)).toThrow('EEXIST')
            expect(existsSync(racedState)).toBe(false)
            expect(readFileSync(join(racedParent, 'competitor.txt'), 'utf8')).toBe('preserve this directory')
            expect(readdirSync(racedParent)).toEqual(['competitor.txt'])
        } finally { competing.mockRestore() }
    })
    test('an inserted symlink in a previously missing parent is rejected before creating target directories', () => {
        const root = temp(), parent = join(root, 'missing'), state = join(parent, 'state'), target = join(root, 'target')
        mkdirSync(target, { mode: 0o700 })
        const originalExists = fs.existsSync
        let stateChecks = 0
        const swapped = spyOn(fs, 'existsSync').mockImplementation(path => {
            if (String(path) === state && ++stateChecks === 2) symlinkSync(target, parent)
            return originalExists(path)
        })
        try {
            expect(() => initializeState(state)).toThrow('symbolic links')
            expect(readdirSync(target)).toEqual([])
            expect(lstatSync(parent).isSymbolicLink()).toBe(true)
        } finally { swapped.mockRestore() }
    })
    test('a source archive without .git initializes successfully without installed workspace dependencies', () => {
        const directory = temp(), source = join(directory, 'archive'), deployment = join(source, 'deploy/evolved'), state = join(directory, 'state')
        mkdirSync(deployment, { recursive: true })
        copyFileSync(join(SOURCE_ROOT, 'deploy/evolved/init.ts'), join(deployment, 'init.ts'))
        const result = Bun.spawnSync([process.execPath, join(deployment, 'init.ts'), state], { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' })
        expect(result.exitCode).toBe(0)
        expect(existsSync(join(source, '.git'))).toBe(false)
        expect(existsSync(join(state, 'credentials/vault/master.key'))).toBe(true)
        expect(result.stdout.toString()).not.toContain(readFileSync(join(state, 'credentials/hub/service.token'), 'utf8'))
    })
    test('origin/port changes, unsafe env syntax and busy ports do not touch prior state', async () => {
        const f = fixture(); await f.run('init')
        const before = credentials(f.state)
        for (const extra of [{ port: 3106 }, { origin: 'https://other.example.com' }]) expect(errors(await f.run('init', extra))).toContain('configuration_conflict')
        expect(credentials(f.state)).toEqual(before)
        writeFileSync(join(f.state, 'compose.env'), 'EVOLVED_STATE_DIR=$(synthetic-secret-value)\n', { mode: 0o600 })
        const invalid = await f.run('start')
        expect(invalid.ok).toBe(false); expect(JSON.stringify(invalid)).not.toContain('synthetic-secret-value')
        const busy = fixture(); busy.setPort(false)
        expect(errors(await busy.run('init'))).toContain('port_in_use')
        expect(existsSync(busy.state)).toBe(false)
        for (const origin of ['http://public.example.com', 'https://example.com/path', 'https://user:secret@example.com', 'http://localhost:9999']) {
            const fresh = fixture(); expect((await fresh.run('init', { origin })).ok).toBe(false); expect(existsSync(fresh.state)).toBe(false)
        }
    })
    test('duplicate or undeclared environment keys cannot influence configuration or mutate state', async () => {
        for (const extra of ['EVOLVED_UID=1234', 'EVOLVED_ORIGIN=https://other.example.com', '__PROTO__=injected', 'CONSTRUCTOR=injected']) {
            const f = fixture(); await f.run('init')
            const before = credentials(f.state), path = join(f.state, 'compose.env')
            const original = readFileSync(path, 'utf8')
            writeFileSync(path, `${original}${extra}\n`)
            expect(errors(await f.run('start'))).toContain('invalid_config')
            expect(credentials(f.state)).toEqual(before)
            expect(mutations(f.calls)).toHaveLength(0)
        }
    })
    test('fresh install has explicit consent, isolated tags, correct build order and controlled child environment', async () => {
        const f = fixture()
        expect(errors(await f.run('install'))).toContain('confirmation_required')
        expect(f.calls).toHaveLength(0)
        expect(errors(await f.run('check', { yes: true }))).toContain('unexpected_confirmation')
        const result = await f.run('install', { yes: true })
        expect(result.ok).toBe(true); expect(result.services).toHaveLength(5)
        const commands = mutations(f.calls).map(call => call.argv)
        expect(commands).toHaveLength(4)
        expect(commands[0]!.slice(-2)).toEqual(['build', 'hub'])
        expect(commands[1]!.slice(-3)).toEqual(['build', 'codegraph', 'memory'])
        expect(commands[2]).toEqual(['docker', 'pull', 'neo4j:2026.09.0'])
        expect(commands[3]!.slice(-6)).toEqual(['up', '-d', '--no-build', '--pull', 'never', '--no-recreate'])
        expect(f.calls.every(call => call.env.SECRET_NOT_FOR_DOCKER === undefined)).toBe(true)
        expect(commands.filter(a => a[1] === 'compose').every(a => a.includes(f.project) && a.includes('--project-directory'))).toBe(true)
        expect([...f.images.keys()].some(name => name === 'hapi-evolved:0.1.0')).toBe(false)
        const override = JSON.parse(readFileSync(join(f.state, 'installer.compose.json'), 'utf8'))
        expect(override.services.hub.volumes[0].source).toBe(join(f.state, 'control-placeholder'))
        expect(JSON.stringify(override)).not.toContain('/run/hapi-evolved-control')
        expect(errors(await f.run('install', { yes: true }))).toContain('not_fresh')
    })
    test('completed build/start repeat without mutation, shared Neo4j tag is not refreshed', async () => {
        const f = fixture(); f.images.set('neo4j:2026.09.0', `sha256:${'a'.repeat(64)}`)
        expect((await f.run('install', { yes: true })).ok).toBe(true)
        expect(f.calls.some(call => call.argv[1] === 'pull')).toBe(false)
        const count = mutations(f.calls).length
        expect((await f.run('build')).ok).toBe(true)
        expect((await f.run('start')).ok).toBe(true)
        expect((await f.run('status')).ok).toBe(true)
        expect(mutations(f.calls)).toHaveLength(count)
    })
    test('foreign container labels, mounts, images or stopped services prevent restart/recreation', async () => {
        for (const mutate of [
            (item: any) => { item.labels['com.docker.compose.project.working_dir'] = '/other' },
            (item: any) => { item.mounts[0].Source = '/other' },
            (item: any) => { item.image = `sha256:${'f'.repeat(64)}` },
            (item: any) => { item.state = 'exited' },
            (item: any) => { item.ports['3006/tcp'][0].HostIp = '0.0.0.0' },
        ]) {
            const f = fixture(); await f.run('install', { yes: true }); mutate(f.containers.values().next().value)
            const count = mutations(f.calls).length
            expect((await f.run('start')).ok).toBe(false)
            expect(mutations(f.calls)).toHaveLength(count)
        }
        const f = fixture(); f.addImages(); f.addContainers()
        expect(errors(await f.run('init'))).toContain('foreign_stack')
        expect(existsSync(f.state)).toBe(false)
    })
    test('existing Docker networks require exact ownership, internal isolation and no foreign endpoints', async () => {
        for (const change of ['owner', 'isolation', 'endpoint']) {
            const f = fixture(); await f.run('init'); await f.run('build')
            f.networks.set(`${f.project}_backend`, {
                labels: { 'com.docker.compose.project': change === 'owner' ? 'another-project' : f.project, 'com.docker.compose.network': 'backend' },
                internal: change !== 'isolation', containers: change === 'endpoint' ? { [digest('foreign')]: {} } : {},
            })
            const count = mutations(f.calls).length
            expect(errors(await f.run('start'))).toContain('foreign_network')
            expect(mutations(f.calls)).toHaveLength(count)
        }
        const f = fixture(); await f.run('init')
        f.networks.set(`${f.project}_backend`, { labels: { 'com.docker.compose.project': f.project, 'com.docker.compose.network': 'backend' }, internal: true, containers: {} })
        expect((await f.run('status')).ok).toBe(true)
        expect(mutations(f.calls)).toHaveLength(0)
    })
    test('changed image receipt and interrupted builds never rebuild or start automatically', async () => {
        const f = fixture(); await f.run('init'); await f.run('build')
        f.images.set(`${f.project}:hub`, `sha256:${'c'.repeat(64)}`)
        const count = mutations(f.calls).length
        expect(errors(await f.run('start'))).toContain('changed_image')
        expect(errors(await f.run('status'))).toContain('changed_image')
        expect(mutations(f.calls)).toHaveLength(count)
        const failed = fixture(); await failed.run('init')
        failed.fail(a => a.includes('build') && a.includes('codegraph'))
        const result = await failed.run('build')
        expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('synthetic-secret-value')
        expect(existsSync(join(failed.state, 'installer-images.json'))).toBe(false)
        expect(existsSync(join(failed.state, 'installer.operation.lock'))).toBe(true)
        failed.fail(); expect(errors(await failed.run('build'))).toContain('operation_busy')
    })
    test('uncertain mutating completion keeps the lock even when a command returns before its work ends', async () => {
        const f = fixture(); await f.run('init')
        const original = f.deps.command
        let finishWork!: () => void, stillRunning = false
        const background = new Promise<void>(resolve => { finishWork = resolve }).then(() => { stillRunning = false })
        f.deps.command = async command => {
            if (command.argv.includes('build') && command.argv.at(-1) === 'hub') {
                stillRunning = true
                // A timed-out CLI can report failure before the daemon or child stops.
                return { code: 1, stdout: 'synthetic-secret-value' }
            }
            return original(command)
        }
        try {
            const first = await f.run('build')
            expect(first.ok).toBe(false); expect(stillRunning).toBe(true)
            expect(existsSync(join(f.state, 'installer.operation.lock'))).toBe(true)
            expect(first.steps.join(' ')).toContain('Operation lock retained')
            expect(JSON.stringify(first)).not.toContain('synthetic-secret-value')
            expect(errors(await f.run('build'))).toContain('operation_busy')
            finishWork(); await background
            // Even delayed completion is not proof that the entire failed install completed.
            expect(errors(await f.run('start'))).toContain('operation_busy')
        } finally { finishWork(); await background }
    })
    test('a concurrent build is rejected before mutations, and releasing never deletes a replacement lock', async () => {
        const f = fixture(); await f.run('init')
        let entered!: () => void, release!: () => void
        const waiting = new Promise<void>(resolve => { entered = resolve }), resumed = new Promise<void>(resolve => { release = resolve })
        f.before(async a => { if (a.includes('build') && a.at(-1) === 'hub') { entered(); await resumed } })
        const first = f.run('build'); await waiting
        expect(errors(await f.run('build'))).toContain('operation_busy')
        const path = join(f.state, 'installer.operation.lock')
        renameSync(path, `${path}.previous`); writeFileSync(path, 'replacement', { mode: 0o600 })
        release(); expect((await first).ok).toBe(true)
        expect(readFileSync(path, 'utf8')).toBe('replacement')
        expect(mutations(f.calls).filter(call => call.argv.includes('hub'))).toHaveLength(1)
    })
    test('machine-readable CLI argument failures are redacted and default action is check', () => {
        expect(parseOptions([])).toEqual(expect.objectContaining({ action: 'check' }))
        expect(parseOptions(['--help'])).toBe('help')
        const child = Bun.spawnSync([process.execPath, join(SOURCE_ROOT, 'deploy/evolved/install.ts'), 'check', '--json', '--secret', 'synthetic-secret-value'], { stdout: 'pipe', stderr: 'pipe' })
        expect(child.exitCode).toBe(1)
        expect(JSON.parse(child.stdout.toString()).ok).toBe(false)
        expect(child.stdout.toString()).not.toContain('synthetic-secret-value')
        expect(child.stderr.toString()).toBe('')
    })
    test.skipIf(!Bun.which('docker'))('real Compose config preserves relative build roots and replaces the privileged socket mount without starting Docker', async () => {
        const f = fixture(); await f.run('init')
        const child = Bun.spawnSync(['docker', 'compose', '--project-directory', dirname(compose), '--project-name', f.project, '--env-file', join(f.state, 'compose.env'), '-f', compose, '-f', join(f.state, 'installer.compose.json'), 'config', '--format', 'json'], { cwd: SOURCE_ROOT, env: { PATH: process.env.PATH, HOME: f.directory }, stdout: 'pipe', stderr: 'pipe' })
        expect(child.exitCode).toBe(0)
        const config = JSON.parse(child.stdout.toString())
        expect(config.name).toBe(f.project)
        expect(Object.keys(config.services).sort()).toEqual([...services].sort())
        expect(config.volumes ?? {}).toEqual({})
        expect(Object.keys(config.networks).sort()).toEqual(['backend', 'broker-egress', 'frontend', 'model-egress'])
        for (const [role, network] of Object.entries(config.networks) as [string, any][]) expect(network.name).toBe(`${f.project}_${role}`)
        for (const service of Object.values(config.services) as any[]) {
            expect(service.user).toBe(`${process.getuid!()}:${process.getgid!()}`)
            expect(service.container_name).toBeUndefined()
        }
        expect(config.services.neo4j.image).toBe('neo4j:2026.09.0')
        expect(config.services.hub.build.context).toBe(SOURCE_ROOT)
        expect(config.services.hub.image).toBe(`${f.project}:hub`)
        expect(config.services.vault.image).toBe(`${f.project}:hub`)
        expect(config.services.hub.volumes.filter((mount: any) => mount.target === '/runner-control')).toEqual([expect.objectContaining({ source: join(f.state, 'control-placeholder'), read_only: true })])
        expect(config.services.hub.ports[0].host_ip).toBe('127.0.0.1')
        expect(config.services.hub.environment.EVOLVED_MEMORY_MODEL).toBeUndefined()
        expect(config.services.memory.environment.EVOLVED_MEMORY_MODEL).toBe('')
        expect(f.containers.size).toBe(0)
    })
})
function credentialsWithoutMissing(state: string) {
    return Object.fromEntries(CREDENTIAL_FILES.flatMap(name => {
        try { return [[name, credentialSnapshot(join(state, 'credentials', name))]] }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    }))
}
