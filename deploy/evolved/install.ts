#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { createConnection } from 'node:net'
import { checkInitializedState, checkPrivateMetadata, checkStatePath, initializeState, SOURCE_ROOT, validateOrigin } from './init'

type Action = 'check' | 'status' | 'init' | 'build' | 'start' | 'install'
export type InstallerOptions = { action: Action; state: string; origin?: string; port?: number; yes?: boolean; json?: boolean }
type Command = { argv: string[]; cwd: string; env: NodeJS.ProcessEnv; capture: boolean; timeoutMs: number }
type CommandResult = { code: number; stdout: string }
export type InstallerDependencies = {
    command: (command: Command) => Promise<CommandResult>
    portAvailable: (port: number) => Promise<boolean>
    environment: NodeJS.ProcessEnv
    platform: string
    uid: number
    gid: number
    bunVersion: string
    memoryBytes: number
}
type Check = { id: string; status: 'ok' | 'warning' | 'error'; message: string }
type Service = { name: string; state: string; health: string | null }
export type InstallerReport = {
    ok: boolean; action: Action; checks: Check[]; steps: string[]; nextSteps: string[]
    installation: { state: string; projectName: string; initialized: boolean; origin?: string; port?: number }
    services: Service[]
    hostControl: { status: 'operator-setup-required'; message: string }
}
type Config = { state: string; uid: number; gid: number; port: number; origin: string }
type Receipt = { version: 1; state: string; source: string; projectName: string; configHash: string; composeHash: string; overrideHash: string }
type Built = { version: 1; images: Record<string, string> }
const SERVICES = ['hub', 'vault', 'codegraph', 'memory', 'neo4j'] as const
const ENV_KEYS = ['EVOLVED_STATE_DIR', 'EVOLVED_UID', 'EVOLVED_GID', 'EVOLVED_ORIGIN', 'EVOLVED_LISTEN_PORT']
const RECEIPT = 'installer.json', OVERRIDE = 'installer.compose.json', BUILT = 'installer-images.json'
const COMPOSE = join(SOURCE_ROOT, 'deploy/evolved/compose.yml')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const projectName = (state: string) => `hapi-evolved-${hash(state).slice(0, 20)}`
const imageNames = (project: string) => ({ hub: `${project}:hub`, codegraph: `${project}:codegraph`, memory: `${project}:memory`, neo4j: 'neo4j:2026.09.0' })
class InstallerError extends Error {
    constructor(readonly code: string, message: string) { super(message) }
}
function fail(code: string, message: string): never { throw new InstallerError(code, message) }

function privateText(path: string): string {
    checkPrivateMetadata(path, false)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.size > 65_536) fail('invalid_config', 'Private installation metadata is invalid or too large.')
        return readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
}
function createPrivate(path: string, value: unknown): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n') } finally { closeSync(fd) }
}
function parseConfig(state: string): Config {
    const parsed: Record<string, string> = {}
    for (const line of privateText(join(state, 'compose.env')).split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue
        const match = /^([A-Z_]+)=([A-Za-z0-9_./:@-]+)$/.exec(line)
        if (!match || !ENV_KEYS.includes(match[1]!) || parsed[match[1]!] !== undefined) {
            fail('invalid_config', 'compose.env must contain only the five generated settings, without interpolation, duplicates or shell syntax. Use the operator guide for custom installations.')
        }
        parsed[match[1]!] = match[2]!
    }
    if (ENV_KEYS.some(key => !parsed[key]) || parsed.EVOLVED_STATE_DIR !== state
        || !/^[1-9]\d*$/.test(parsed.EVOLVED_UID!) || !/^[1-9]\d*$/.test(parsed.EVOLVED_GID!)
        || !/^\d+$/.test(parsed.EVOLVED_LISTEN_PORT!)) fail('invalid_config', 'Installation identity is missing or does not match its state directory.')
    const port = Number(parsed.EVOLVED_LISTEN_PORT)
    if (port < 1024 || port > 65535) fail('invalid_port', 'Use a local port between 1024 and 65535.')
    return { state, uid: Number(parsed.EVOLVED_UID), gid: Number(parsed.EVOLVED_GID), port, origin: validateOrigin(parsed.EVOLVED_ORIGIN!, port) }
}
function override(config: Config, project: string): object {
    const images = imageNames(project)
    return { services: {
        hub: { image: images.hub, volumes: [{ type: 'bind', source: join(config.state, 'control-placeholder'), target: '/runner-control', read_only: true }] },
        vault: { image: images.hub }, codegraph: { image: images.codegraph }, memory: { image: images.memory },
    } }
}
function loadState(options: InstallerOptions, deps: InstallerDependencies): { config: Config; receipt: Receipt } | null {
    if (!existsSync(options.state)) return null
    checkPrivateMetadata(options.state, true)
    if (!readdirSync(options.state).length) return null
    if (!existsSync(join(options.state, RECEIPT))) fail('unmanaged_state', 'Existing state is incomplete or belongs to another installation. It is preserved; inspect the original operation or use its operator procedure before choosing a new empty directory.')
    checkInitializedState(options.state)
    checkPrivateMetadata(join(options.state, 'control-placeholder'), true)
    const receipt = JSON.parse(privateText(join(options.state, RECEIPT))) as Receipt
    const config = parseConfig(options.state)
    if (receipt.version !== 1 || receipt.state !== options.state || receipt.source !== SOURCE_ROOT || receipt.projectName !== projectName(options.state)
        || receipt.configHash !== hash(privateText(join(options.state, 'compose.env')))
        || receipt.composeHash !== hash(readFileSync(COMPOSE, 'utf8'))
        || receipt.overrideHash !== hash(privateText(join(options.state, OVERRIDE)))
        || JSON.stringify(JSON.parse(privateText(join(options.state, OVERRIDE)))) !== JSON.stringify(override(config, receipt.projectName))) {
        fail('installation_changed', 'Installation metadata changed. This assistant does not upgrade, relocate or adopt existing installations.')
    }
    if (config.uid !== deps.uid || config.gid !== deps.gid) fail('wrong_owner', 'Run the assistant as the same unprivileged user who initialized this state.')
    if (options.origin !== undefined && options.origin !== config.origin || options.port !== undefined && options.port !== config.port) {
        fail('configuration_conflict', 'The existing origin and port are preserved. Changing them requires an explicit operator procedure, especially after passkey enrollment.')
    }
    return { config, receipt }
}

function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (Object.keys(source).some(key => (key.startsWith('COMPOSE_') || key.startsWith('EVOLVED_') || ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key)) && source[key] !== undefined)) {
        fail('environment_override', 'Remove exported COMPOSE_*, EVOLVED_* and Docker endpoint overrides before running the assistant. No environment values were printed.')
    }
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DOCKER_CONFIG']) if (source[key] !== undefined) env[key] = source[key]
    return env
}
const composeArgs = (state: string) => ['docker', 'compose', '--project-directory', dirname(COMPOSE), '--project-name', projectName(state), '--env-file', join(state, 'compose.env'), '-f', COMPOSE, '-f', join(state, OVERRIDE)]
const metadataFormat = '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"image":{{json .Image}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"state":{{json .State.Status}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}}'
function expectedMounts(service: string, state: string): Record<string, { source: string; rw: boolean }> {
    const result: Record<string, { source: string; rw: boolean }> = {
        '/data': { source: join(state, service === 'hub' ? 'hub' : service), rw: true },
        '/credentials': { source: join(state, 'credentials', service), rw: false },
    }
    if (service === 'neo4j') result['/logs'] = { source: join(state, 'neo4j-logs'), rw: true }
    if (service === 'hub' || service === 'codegraph') {
        result['/workspaces'] = { source: join(state, 'workspaces'), rw: false }
        result['/managed-workspaces'] = { source: join(state, 'managed-workspaces'), rw: service === 'hub' }
    }
    if (service === 'hub') result['/runner-control'] = { source: join(state, 'control-placeholder'), rw: false }
    return result
}

/** No automatic stale-lock removal: an interrupted operation needs explicit operator inspection. */
function acquireOperationLock(state: string): (remove: boolean) => void {
    const path = join(state, 'installer.operation.lock')
    let fd: number
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch { return fail('operation_busy', 'Another operation or an interrupted installation holds the private operation lock. Inspect it before retrying; it was not removed.') }
    const owner = fstatSync(fd)
    return (remove: boolean) => {
        try {
            if (!remove) return
            const current = lstatSync(path)
            if (current.dev === owner.dev && current.ino === owner.ino && current.isFile() && current.nlink === 1) unlinkSync(path)
        } catch { /* Missing or replaced locks are never removed. */ }
        finally { closeSync(fd) }
    }
}

export async function runInstaller(options: InstallerOptions, deps: InstallerDependencies): Promise<InstallerReport> {
    const report: InstallerReport = { ok: false, action: options.action, checks: [], steps: [], nextSteps: [], services: [],
        installation: { state: options.state, projectName: projectName(options.state), initialized: false },
        hostControl: { status: 'operator-setup-required', message: 'Core services only. Native runner images and the privileged host control service require separate operator setup in a protected layout. Browser provider login is not provisioned by this assistant.' } }
    const check = (id: string, message: string, status: Check['status'] = 'ok') => report.checks.push({ id, status, message })
    try {
        if (deps.platform !== 'linux') fail('unsupported_platform', 'This preview installer supports Linux only.')
        if (deps.uid <= 0 || deps.gid <= 0) fail('root_not_supported', 'Run as an unprivileged user, not root or sudo. Host-control installation is a separate operator task.')
        if (deps.bunVersion !== '1.3.14') fail('bun_version', 'Install Bun 1.3.14 explicitly before continuing; the assistant does not install system packages.')
        const environment = commandEnvironment(deps.environment)
        checkStatePath(options.state)
        if (!/^\/[A-Za-z0-9_./-]+$/.test(SOURCE_ROOT)) fail('unsupported_source_path', 'Use a source path without spaces or Compose interpolation characters.')
        if (options.yes && options.action !== 'install') fail('unexpected_confirmation', '--yes applies only to an explicitly requested fresh install.')
        if (options.action === 'install' && !options.yes) fail('confirmation_required', 'Fresh install builds images and starts core containers. Add --yes, or run check, init, build and start separately.')
        let mutationStarted = false
        const exec = async (argv: string[], capture = true): Promise<string> => {
            if (!capture) mutationStarted = true
            const result = await deps.command({ argv, cwd: SOURCE_ROOT, env: environment, capture, timeoutMs: capture ? 30_000 : 1_800_000 })
            if (result.code !== 0) fail('command_failed', 'A prerequisite or Docker operation failed. Check Docker access, available space and the requested local port; no command output or secrets were printed.')
            return result.stdout.trim()
        }
        const dockerVersion = await exec(['docker', '--version'])
        if (!dockerVersion.startsWith('Docker version ')) fail('docker_missing', 'Docker Engine is required; install it explicitly using your operator procedure.')
        const composeVersion = await exec(['docker', 'compose', 'version', '--short'])
        // 2.20 is a conservative source-verified floor for --pull never, --no-build,
        // --no-recreate and --project-directory; v5 retains these CLI semantics.
        const composeParts = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+~][0-9A-Za-z.+~:-]+)?$/.exec(composeVersion)
        if (!composeParts || Number(composeParts[1]) < 2 || Number(composeParts[1]) === 2 && Number(composeParts[2]) < 20) fail('compose_version', 'Docker Compose plugin 2.20 or later is required (including v5); legacy docker-compose v1 is unsupported.')
        const endpoint = JSON.parse(await exec(['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])) as unknown
        if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///')) fail('remote_docker', 'Use a local Unix-socket Docker context. Remote Docker hosts are not supported by this installer.')
        const daemon = JSON.parse(await exec(['docker', 'info', '--format', '{"osType":{{json .OSType}},"operatingSystem":{{json .OperatingSystem}},"securityOptions":{{json .SecurityOptions}}}']))
        if (daemon.osType !== 'linux' || typeof daemon.operatingSystem !== 'string' || !Array.isArray(daemon.securityOptions) || !daemon.securityOptions.every((value: unknown) => typeof value === 'string')) fail('docker_platform', 'A reachable Linux Docker Engine with verifiable identity mapping is required.')
        if (/docker desktop/i.test(daemon.operatingSystem) || daemon.securityOptions.some((value: string) => /(?:^|[=,])(rootless|userns)(?:$|[=,])/i.test(value))) fail('docker_identity_mapping', 'Rootless Docker, userns-remap and Docker Desktop are unsupported: private bind mounts require unchanged host UID/GID mapping. No state was initialized.')
        const buildx = await deps.command({ argv: ['docker', 'buildx', 'version'], cwd: SOURCE_ROOT, env: environment, capture: true, timeoutMs: 30_000 })
        if (buildx.code !== 0 || !/^github\.com\/docker\/buildx\s+v?\d+\./.test(buildx.stdout.trim())) fail('buildx_missing', 'Install the Docker Buildx plugin explicitly before continuing. No image build or builder initialization was attempted.')
        check('prerequisites', 'Linux, Bun 1.3.14, local rootful Docker Engine, Buildx and Compose plugin 2.20+ are available.')
        check('memory', 'Plan about 12 GiB RAM for the core stack and one future runner.', deps.memoryBytes < 12 * 1024 ** 3 ? 'warning' : 'ok')
        let parent = options.state
        while (!existsSync(parent)) parent = dirname(parent)
        const disk = statfsSync(parent)
        check('disk', 'Keep at least 20 GiB free for image builds, then additional space for repositories and backups.', disk.bavail * disk.bsize < 20 * 1024 ** 3 ? 'warning' : 'ok')
        let state = loadState(options, deps)
        if (state && options.action === 'install') fail('not_fresh', 'install --yes is only for a fresh empty state directory. Existing state is preserved; use status instead.')
        const config: Config = state?.config ?? { state: options.state, uid: deps.uid, gid: deps.gid, port: options.port ?? 3006, origin: options.origin ?? `http://localhost:${options.port ?? 3006}` }
        if (!Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535) fail('invalid_port', 'Use a local port between 1024 and 65535.')
        validateOrigin(config.origin, config.port)
        report.installation.origin = config.origin; report.installation.port = config.port; report.installation.initialized = Boolean(state)
        const images = imageNames(report.installation.projectName)
        const knownContainerIds = new Set<string>()
        const listContainers = async (built?: Built): Promise<Service[]> => {
            const ids = (await exec(['docker', 'ps', '-a', '--no-trunc', '--filter', `label=com.docker.compose.project=${report.installation.projectName}`, '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean)
            const services: Service[] = []
            knownContainerIds.clear()
            for (const id of ids) {
                if (!/^[0-9a-f]{12,64}$/.test(id)) fail('invalid_inventory', 'Docker inventory could not be verified.')
                const item = JSON.parse(await exec(['docker', 'inspect', '--format', metadataFormat, id]))
                const service = item.labels?.['com.docker.compose.service']
                if (item.id !== id || !state || !SERVICES.includes(service) || services.some(value => value.name === service)
                    || item.labels['com.docker.compose.project'] !== report.installation.projectName
                    || item.labels['com.docker.compose.project.working_dir'] !== dirname(COMPOSE)
                    || item.labels['com.docker.compose.project.config_files'] !== `${COMPOSE},${join(options.state, OVERRIDE)}`) {
                    fail('foreign_stack', 'Existing containers do not belong to this exact installation. They were not changed.')
                }
                if (service === 'hub' && JSON.stringify(item.ports?.['3006/tcp']) !== JSON.stringify([{ HostIp: '127.0.0.1', HostPort: String(config.port) }])) {
                    fail('foreign_port', 'The existing hub does not have this installation’s loopback port binding. No containers were changed.')
                }
                const expected = expectedMounts(service, options.state)
                for (const mount of item.mounts ?? []) {
                    if (mount.Type === 'tmpfs' && mount.Destination === '/tmp') continue
                    const target = expected[mount.Destination]
                    if (mount.Type !== 'bind' || !target || target.source !== mount.Source || target.rw !== mount.RW) fail('foreign_mounts', 'Existing container mounts differ from this installation. No containers were changed.')
                    delete expected[mount.Destination]
                }
                if (Object.keys(expected).length) fail('foreign_mounts', 'Expected private container mounts are missing. No containers were changed.')
                if (built && item.image !== built.images[service === 'vault' ? 'hub' : service]) fail('changed_image', 'Existing containers use different images; upgrades are outside this installer.')
                knownContainerIds.add(id)
                services.push({ name: service, state: String(item.state), health: typeof item.health === 'string' ? item.health : null })
            }
            return services
        }
        const verifyNetworks = async () => {
            const names = (await exec(['docker', 'network', 'ls', '--filter', `name=^${report.installation.projectName}_`, '--format', '{{.Name}}'])).split(/\s+/).filter(Boolean)
            for (const name of names) {
                const role = name.slice(report.installation.projectName.length + 1)
                if (!state || !['backend', 'frontend', 'broker-egress', 'model-egress'].includes(role)) fail('foreign_network', 'A conflicting Docker network exists. No network or container was changed.')
                const network = JSON.parse(await exec(['docker', 'network', 'inspect', name, '--format', '{"labels":{{json .Labels}},"internal":{{json .Internal}},"containers":{{json .Containers}}}']))
                if (network.labels?.['com.docker.compose.project'] !== report.installation.projectName
                    || network.labels?.['com.docker.compose.network'] !== role || network.internal !== (role === 'backend')
                    || Object.keys(network.containers ?? {}).some(id => !knownContainerIds.has(id))) {
                    fail('foreign_network', 'A network has different ownership, isolation or attached containers. It was not changed or reused.')
                }
            }
        }
        report.services = await listContainers()
        await verifyNetworks()
        const portFree = await deps.portAvailable(config.port)
        if (!portFree && !report.services.some(value => value.name === 'hub' && value.state === 'running')) {
            fail('port_in_use', 'The requested loopback port is already in use by another service. Choose another --port before initialization; nothing was stopped.')
        }
        check('port', portFree ? 'Requested loopback port is currently available; Docker verifies it again at start.' : 'The port belongs to this installation’s running hub.')
        const initialize = () => {
            if (state) { report.steps.push('Existing initialization preserved; credentials were not read or rewritten.'); return }
            initializeState(options.state, { origin: config.origin, port: config.port })
            mkdirSync(join(options.state, 'control-placeholder'), { mode: 0o700 })
            createPrivate(join(options.state, OVERRIDE), override(config, report.installation.projectName))
            const receipt: Receipt = { version: 1, state: options.state, source: SOURCE_ROOT, projectName: report.installation.projectName, configHash: hash(privateText(join(options.state, 'compose.env'))), composeHash: hash(readFileSync(COMPOSE, 'utf8')), overrideHash: hash(privateText(join(options.state, OVERRIDE))) }
            createPrivate(join(options.state, RECEIPT), receipt)
            state = { config, receipt }; report.installation.initialized = true
            report.steps.push('Private core state initialized; existing installations and global image tags were not changed.')
        }
        const requireState = async () => {
            state = loadState(options, deps)
            if (!state) fail('not_initialized', 'Initialize a new private state directory before build or start.')
            await exec([...composeArgs(options.state), 'config', '--quiet'])
        }
        const inspectImages = async (): Promise<Built> => {
            const built = JSON.parse(privateText(join(options.state, BUILT))) as Built
            if (built.version !== 1 || Object.keys(built.images ?? {}).sort().join(',') !== Object.keys(images).sort().join(',')) fail('invalid_images', 'Build metadata is incomplete. No images or containers were replaced.')
            for (const [service, name] of Object.entries(images)) {
                if (!/^sha256:[0-9a-f]{64}$/.test(built.images[service] ?? '') || await exec(['docker', 'image', 'inspect', name, '--format', '{{.Id}}']) !== built.images[service]) fail('changed_image', 'A recorded image is missing or changed. Use the operator update procedure; existing data is preserved.')
            }
            return built
        }
        const build = async () => {
            await requireState()
            if (existsSync(join(options.state, BUILT))) { await inspectImages(); report.steps.push('Previously built images verified; no rebuild or retag.'); return }
            if ((await listContainers()).length) fail('existing_stack', 'Image builds for existing containers are an operator update task.')
            for (const name of [images.hub, images.codegraph, images.memory]) {
                if (await exec(['docker', 'image', 'ls', '--filter', `reference=${name}`, '--format', '{{.ID}}'])) fail('existing_images', 'Installation image tags already exist without a completed build receipt. Preserve them and inspect the interrupted build manually.')
            }
            await exec([...composeArgs(options.state), 'build', 'hub'], false)
            await exec([...composeArgs(options.state), 'build', 'codegraph', 'memory'], false)
            // Do not move an already installed shared third-party tag. Pin its actual ID in the receipt.
            if (!await exec(['docker', 'image', 'ls', '--filter', `reference=${images.neo4j}`, '--format', '{{.ID}}'])) await exec(['docker', 'pull', images.neo4j], false)
            const ids: Record<string, string> = {}
            for (const [service, name] of Object.entries(images)) {
                ids[service] = await exec(['docker', 'image', 'inspect', name, '--format', '{{.Id}}'])
                if (!/^sha256:[0-9a-f]{64}$/.test(ids[service]!)) fail('invalid_images', 'The built image identity could not be verified.')
            }
            createPrivate(join(options.state, BUILT), { version: 1, images: ids })
            report.steps.push('Core images built in this installation’s image namespace; native runner images remain an operator task.')
        }
        const start = async () => {
            await requireState()
            const built = await inspectImages()
            report.services = await listContainers(built)
            await verifyNetworks()
            if (report.services.length) {
                if (report.services.length !== SERVICES.length || report.services.some(value => value.state !== 'running')) fail('existing_stack', 'Existing containers are stopped or incomplete. This first-install assistant will not recreate or restart them; use the operator procedure.')
                report.steps.push('All existing core containers are running; no restart or recreate.'); return
            }
            if (!await deps.portAvailable(config.port)) fail('port_in_use', 'The loopback port became busy. Nothing was stopped; resolve the port conflict before retrying.')
            await exec([...composeArgs(options.state), 'up', '-d', '--no-build', '--pull', 'never', '--no-recreate'], false)
            report.services = await listContainers(built)
            await verifyNetworks()
            if (report.services.length !== SERVICES.length || report.services.some(value => value.state !== 'running')) fail('start_incomplete', 'Docker did not report all core containers running. Existing state is retained; inspect status before any recovery.')
            report.steps.push('Core containers started on loopback. Native provider login is not configured by this step.')
        }
        if (options.action === 'init' || options.action === 'install') initialize()
        if (['build', 'start', 'install'].includes(options.action)) {
            if (!state) fail('not_initialized', 'Initialize private state before build or start.')
            const unlock = acquireOperationLock(options.state)
            let completed = false
            try {
                if (options.action === 'build' || options.action === 'install') await build()
                if (options.action === 'start' || options.action === 'install') await start()
                completed = true
            } finally {
                // Docker/BuildKit can still be working after a CLI failure or timeout.
                // Retain the gate rather than inferring daemon completion from a signal.
                unlock(completed || !mutationStarted)
                if (!completed && mutationStarted) report.steps.push('Operation lock retained: a mutating step failed or its completion is uncertain. Inspect Docker before any recovery; no automatic retry is allowed.')
            }
        }
        if (state && (options.action === 'check' || options.action === 'status') && existsSync(join(options.state, BUILT))) report.services = await listContainers(await inspectImages())
        if (state) check('state', 'Private installation metadata and permissions verified; secret values were not inspected.')
        else check('state', 'No initialized state found; check/status created no files.', 'warning')
        for (const service of report.services) check(`service_${service.name}`, `${service.name}: ${service.state}${service.health ? ` (${service.health})` : ''}.`, service.state !== 'running' || service.health === 'unhealthy' ? 'warning' : 'ok')
        report.nextSteps = state
            ? [...(!existsSync(join(options.state, BUILT)) ? ['Next: run build, then start with the same --state.'] : !report.services.length ? ['Next: run start with the same --state.'] : []), `Open ${config.origin}/evolved after the hub is healthy. Read hub/bootstrap.token privately on the host; the assistant never prints it.`, 'Native runner images and browser-managed provider login require the separate protected host-control operator procedure in docs/evolved/HOST_CONTROL.md.']
            : ['Run init, then build, then start with the same --state and chosen --origin/--port; or explicitly request install --yes.', 'Choose the final HTTPS hostname before enrolling passkeys. No DNS, firewall or system packages are configured automatically.']
        report.ok = true
    } catch (error) {
        check(error instanceof InstallerError ? error.code : 'unsafe_or_unavailable_state', error instanceof InstallerError ? error.message : 'Private state, configuration or a prerequisite could not be validated. Existing files were preserved; inspect ownership and the operator instructions.', 'error')
        report.nextSteps = ['Resolve the reported prerequisite without deleting existing state. No automatic reset, upgrade, permission changes or rollback is attempted.', 'Use --help for the supported fresh core-installation steps and the separate host-control boundary.']
    }
    return report
}

async function command(command: Command): Promise<CommandResult> {
    return new Promise(resolve => {
        let stdout = '', oversized = false, completed = false
        const child = spawn(command.argv[0]!, command.argv.slice(1), { cwd: command.cwd, env: command.env, stdio: ['ignore', command.capture ? 'pipe' : 'ignore', 'ignore'] })
        const timer = setTimeout(() => { child.kill('SIGTERM'); finish(1) }, command.timeoutMs)
        const finish = (code: number) => { if (!completed) { completed = true; clearTimeout(timer); resolve({ code, stdout: oversized ? '' : stdout }) } }
        child.stdout?.on('data', chunk => { if (stdout.length + chunk.length > 1_048_576) { oversized = true; child.kill('SIGTERM'); finish(1) } else stdout += chunk.toString() })
        child.once('error', () => finish(1)); child.once('close', code => finish(code ?? 1))
    })
}
async function portAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port })
        const finish = (free: boolean) => { socket.destroy(); resolve(free) }
        socket.setTimeout(1_000)
        socket.once('connect', () => finish(false)); socket.once('timeout', () => finish(false))
        socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'))
    })
}
export function parseOptions(args: string[]): InstallerOptions | 'help' {
    if (args.includes('--help') || args.includes('-h')) return 'help'
    const action = args[0] && !args[0].startsWith('-') ? args.shift()! : 'check'
    if (!['check', 'status', 'init', 'build', 'start', 'install'].includes(action)) fail('invalid_arguments', 'Unknown step. Use --help; no operation was performed.')
    const options: InstallerOptions = { action: action as Action, state: join(homedir(), '.local/share/hapi-evolved') }
    const seen = new Set<string>()
    for (let index = 0; index < args.length; index++) {
        const key = args[index]!
        if (seen.has(key)) fail('invalid_arguments', 'Duplicate option. Use --help; no operation was performed.')
        seen.add(key)
        if (key === '--json') options.json = true
        else if (key === '--yes') options.yes = true
        else if (['--state', '--origin', '--port'].includes(key)) {
            const value = args[++index]
            if (!value || value.startsWith('--')) fail('invalid_arguments', 'Missing option value. Use --help; no operation was performed.')
            if (key === '--state') options.state = value
            else if (key === '--origin') options.origin = value
            else { if (!/^\d+$/.test(value)) fail('invalid_port', 'Port must be an integer between 1024 and 65535.'); options.port = Number(value) }
        } else fail('invalid_arguments', 'Unknown option. Use --help; no operation was performed.')
    }
    return options
}
const HELP = `HAPI-eVolved fresh core-installation assistant (Linux, Bun 1.3.14, Compose 2.20+/v5, Buildx)

Usage: bun deploy/evolved/install.ts [check|status|init|build|start|install] [options]
  --state /absolute/private/path   Private state outside the actual source tree
  --origin https://agents.example.com   Final browser origin; default HTTP localhost
  --port 3006                      Loopback port, 1024–65535
  --json                           Machine-readable checks, errors and next steps
  --yes                            Required only for an explicit fresh install

No step: read-only check. check/status never initialize, build, pull or start.
init creates private state; build builds isolated core images; start starts only
this new core stack. install --yes runs these steps in order for empty state only.
Repeated init/build/start preserve completed state; this is not an upgrade tool.
Choose another state path/port for a separate installation. Root/sudo, remote Docker,
rootless/userns-remapped Docker, Docker Desktop,
environment overrides and adoption of existing operator installations are refused.
No system packages, DNS, firewall, host services or provider accounts are configured.
Native runner images and browser provider login require separate protected host-control
setup: docs/evolved/HOST_CONTROL.md. No credentials or setup tokens are printed.
`

if (import.meta.main) {
    try {
        const options = parseOptions(process.argv.slice(2))
        if (options === 'help') console.log(HELP)
        else {
            const report = await runInstaller(options, { command, portAvailable, environment: process.env, platform: platform(), uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, bunVersion: Bun.version, memoryBytes: totalmem() })
            if (options.json) console.log(JSON.stringify(report, null, 2))
            else { for (const item of report.checks) console.log(`[${item.status}] ${item.message}`); for (const item of report.steps) console.log(item); for (const item of report.nextSteps) console.log(item); console.log(report.hostControl.message) }
            process.exitCode = report.ok ? 0 : 1
        }
    } catch (error) {
        const message = error instanceof InstallerError ? error.message : 'Invalid arguments. Use --help; no operation was performed.'
        if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, checks: [{ id: error instanceof InstallerError ? error.code : 'invalid_arguments', status: 'error', message }], nextSteps: ['Use --help.'] }))
        else console.error(message)
        process.exitCode = 1
    }
}
