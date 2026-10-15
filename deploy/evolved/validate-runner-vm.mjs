import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRunnerConfig, parseRunnerEnv } from './check-runner.ts'

const markerLabel = 'io.hapi.evolved.runner-validation'
const services = ['runner', 'runner-proxy', 'egress']
function requireCheck(value, message) { if (!value) throw new Error(message) }

/** The marker is an explicit operator assertion that this is a disposable test project. */
export function validationPlan(source, environment = {}) {
    requireCheck(!environment.COMPOSE_PROJECT_NAME && !environment.COMPOSE_FILE && !environment.DOCKER_HOST && !environment.DOCKER_CONTEXT,
        'Compose-/Docker-Zieloverrides entfernen; die Abnahme gilt ausschließlich für den lokalen Teststack.')
    const config = parseRunnerEnv(source)
    const checked = checkRunnerConfig(config, environment)
    const markers = source.split(/\r?\n/).filter(line => line.startsWith('# HAPI_EVOLVED_RUNNER_VALIDATION='))
    requireCheck(markers.length === 1 && markers[0] === `# HAPI_EVOLVED_RUNNER_VALIDATION=${checked.projectId}`,
        'Explizite Testmarkierung fehlt oder passt nicht zur Projekt-UUID.')
    requireCheck(checked.profile === 'restricted' && checked.mode === 'ro', 'Diese Abnahme verlangt restricted und ro.')
    requireCheck(config.EVOLVED_BACKEND_NETWORK === 'hapi-evolved-acceptance_backend',
        'EVOLVED_BACKEND_NETWORK muss ausdrücklich hapi-evolved-acceptance_backend sein.')
    return { config, projectId: checked.projectId, stack: `hapi-evolved-validation-${checked.projectId}`,
        root: `${config.EVOLVED_WORKSPACE_PREFIX ?? '/workspaces'}/${config.EVOLVED_PROJECT_DIRECTORY}`, backend: config.EVOLVED_BACKEND_NETWORK }
}

export function inspectAcceptanceBackend(network, plan) {
    requireCheck(network.Name === plan.backend && network.Internal === true
        && network.Labels?.['com.docker.compose.project'] === 'hapi-evolved-acceptance'
        && network.Labels?.['com.docker.compose.network'] === 'backend',
    'Backend gehört nicht zum internen Abnahmestack hapi-evolved-acceptance.')
}

export function inspectProviderCredentialAbsence(home) {
    // Metadata only. Permission errors are not evidence that credentials are absent.
    try { readdirSync(home) } catch { throw new Error('Test-Runnerhome ist für die Prüfung nicht zugänglich.') }
    for (const path of ['claude/.credentials.json', 'codex/auth.json', '.claude/.credentials.json', '.codex/auth.json']) {
        try { lstatSync(join(home, path)) } catch (error) {
            if (error.code === 'ENOENT') continue
            throw new Error('Providerdatei-Metadaten sind nicht sicher prüfbar.')
        }
        throw new Error('Native Provideranmeldung im Test-Runnerhome erkannt; Abnahme verweigert.')
    }
}

/** Observe from the host before exec can consume a PID and hide startup PID reuse. */
export function observeRunnerStart(previous, state, now) {
    if (state?.Running !== true || state.Restarting !== false || !Number.isSafeInteger(state.Pid) || state.Pid < 1
        || typeof state.StartedAt !== 'string' || !Number.isFinite(Date.parse(state.StartedAt))) {
        return { observation: null, ready: false }
    }
    const observation = previous?.startedAt === state.StartedAt && previous.pid === state.Pid
        ? previous : { startedAt: state.StartedAt, pid: state.Pid, observedAt: now }
    return { observation, ready: now - observation.observedAt >= 5000 }
}

export function inspectTestContainer(container, plan, expectedService, requireRunning = true) {
    requireCheck(services.includes(expectedService), 'Unbekannter Testservice.')
    const labels = container.Config?.Labels ?? {}, host = container.HostConfig ?? {}
    requireCheck(labels['com.docker.compose.project'] === plan.stack && labels['com.docker.compose.service'] === expectedService
        && labels[markerLabel] === plan.projectId, 'Container gehört nicht zum ausdrücklich markierten Teststack.')
    requireCheck(!host.Privileged && host.ReadonlyRootfs && host.NetworkMode !== 'host' && !host.PidMode,
        'Containerisolation stimmt nicht mit dem Testvertrag überein.')
    requireCheck(host.CapDrop?.includes('ALL') && host.SecurityOpt?.some(value => value.startsWith('no-new-privileges')),
        'Capability-Drop oder no-new-privileges fehlt.')
    const expectedCaps = expectedService === 'runner' ? ['SETGID', 'SETPCAP', 'SETUID'] : []
    requireCheck(JSON.stringify((host.CapAdd ?? []).map(value => value.replace(/^CAP_/, '')).sort()) === JSON.stringify(expectedCaps), 'Unerwartete Linux-Capabilities.')
    requireCheck(!Object.keys(host.PortBindings ?? {}).length && !host.Devices?.length && !host.DeviceRequests?.length,
        'Testcontainer veröffentlicht Ports oder zusätzliche Geräte.')
    const expectedUser = expectedService === 'runner' ? '0:0' : `${plan.config.EVOLVED_UID}:${plan.config.EVOLVED_GID}`
    requireCheck(container.Config.User === expectedUser, 'Unerwartete Container-UID.')
    const expectedNetworks = [ `${plan.stack}_project`, ...(expectedService === 'runner-proxy' ? [plan.backend]
        : expectedService === 'egress' ? [`${plan.stack}_provider-egress`] : []) ].sort()
    requireCheck(JSON.stringify(Object.keys(container.NetworkSettings?.Networks ?? {}).sort()) === JSON.stringify(expectedNetworks), 'Unerwartete Container-Netzwerke.')
    const expectedMounts = expectedService === 'runner'
        ? [{ source: plan.config.EVOLVED_RUNNER_HOME, target: '/runner', rw: true }, { source: plan.config.EVOLVED_RUNNER_WORKSPACE, target: plan.root, rw: false }]
        : expectedService === 'runner-proxy' ? [{ source: plan.config.EVOLVED_RUNNER_LEASE_FILE, target: '/credentials/lease', rw: false }] : []
    const mounts = (container.Mounts ?? []).filter(mount => mount.Type !== 'tmpfs')
    requireCheck(mounts.length === expectedMounts.length && expectedMounts.every(expected => mounts.some(mount =>
        mount.Type === 'bind' && mount.Source === expected.source && mount.Destination === expected.target && mount.RW === expected.rw
        && (expected.target !== plan.root || mount.Propagation === 'rprivate'))),
        'Fremder Mount, Docker-Socket, sichtbare Lease oder beschreibbarer Workspace erkannt.')
    if (requireRunning) requireCheck(container.State?.Running === true, 'Testcontainer läuft nicht.')
}

// Executed as the configured unprivileged UID. Only synthetic runner state is read,
// never the lease or native provider credentials. Only selected non-secret facts leave it.
export function containerProbe({ root, projectId, config }, registrationOnly = false) {
    return `
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
const root=${JSON.stringify(root)}, projectId=${JSON.stringify(projectId)}, uid=${Number(config.EVOLVED_UID)}, gid=${Number(config.EVOLVED_GID)};
function check(ok, message) { if (!ok) throw Error(message) }
async function get(path) { const r=await fetch('http://runner-proxy:3010'+path,{signal:AbortSignal.timeout(4000)}); check(r.ok,'Proxy request refused'); return r.json() }
try {
    const authority=await get('/evolved-runner-authority');
    check(authority.projectId===projectId && authority.profile==='restricted' && authority.rootPath===root && (authority.expiresAt===null || (typeof authority.expiresAt==='number' && Number.isFinite(authority.expiresAt) && authority.expiresAt>Date.now())),'Authority mismatch');
    const state=JSON.parse(readFileSync('/runner/hapi/runner.state.json','utf8'));
    check(Number.isSafeInteger(state.pid)&&state.pid>1&&Number.isSafeInteger(state.httpPort)&&state.httpPort>0&&state.httpPort<65536,'Invalid runner state');
    const machineId=state.startedWithMachineId;
    check(typeof machineId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(machineId),'Machine registration missing');
    const {machine}=await get('/cli/machines/'+encodeURIComponent(machineId));
    check(machine.id===machineId && machine.active===true && machine.namespace==='evolved-'+projectId && machine.runnerState?.status==='running','Hub machine is not actively registered');
    const r=await fetch('http://127.0.0.1:'+state.httpPort+'/list',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(4000)});
    const sessions=await r.json();check(r.ok&&Array.isArray(sessions.children)&&sessions.children.length===0,'Test runner has unexpected agent sessions');
    if (${registrationOnly}) { console.log(JSON.stringify({machineId,registered:true})); process.exit(0) }
    check(process.getuid()===uid && process.getgid()===gid,'Probe UID mismatch');
    const fields=new Map(readFileSync('/proc/'+state.pid+'/status','utf8').split('\\n').map(line=>{const p=line.indexOf(':');return [line.slice(0,p),line.slice(p+1).trim()]}));
    check(fields.get('Uid')?.split(/\\s+/).every(v=>Number(v)===uid)&&fields.get('Gid')?.split(/\\s+/).every(v=>Number(v)===gid)&&fields.get('Groups')==='','Runner retained privileges');
    check(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(key=>/^0+$/.test(fields.get(key)??'')),'Runner capability set is not empty');
    check(!existsSync('/var/run/docker.sock')&&!existsSync('/run/docker.sock')&&!existsSync('/credentials/lease'),'Operator credential or Docker socket is exposed');
    const canary=root+'/.hapi-validation-write-'+randomUUID();let writeError;
    try { writeFileSync(canary,'synthetic validation',{flag:'wx',mode:0o600}) } catch(error) { writeError=error.code }
    if (!writeError) { unlinkSync(canary); throw Error('Workspace unexpectedly writable') }
    check(writeError==='EROFS','Workspace probe did not prove a read-only mount');
    async function denied(target) { return new Promise((resolve,reject)=>{
        let result=''; const socket=connect({host:'egress',port:3128});
        socket.setTimeout(3000,()=>socket.destroy(Error('CONNECT timeout')));
        socket.on('connect',()=>socket.write('CONNECT '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n'));
        socket.on('data',chunk=>{result+=chunk.toString();if(result.includes('\\r\\n')){socket.destroy(); /^HTTP\\/1\\.1 403 /.test(result)?resolve():reject(Error('CONNECT was not denied'))}});
        socket.on('error',reject);socket.on('close',()=>{if(!result.includes('\\r\\n'))reject(Error('Incomplete CONNECT response'))});
    }) }
    const deniedTargets=['10.0.0.1:443','169.254.169.254:443','100.64.0.1:443','unlisted.hapi-validation.invalid:443'];
    for (const target of deniedTargets) await denied(target);
    const browser=await fetch('http://runner-proxy:3010/health',{headers:{origin:'https://invalid.test'},signal:AbortSignal.timeout(3000)});
    const admin=await fetch('http://runner-proxy:3010/api/evolved/me',{signal:AbortSignal.timeout(3000)});
    check(browser.status===403&&admin.status===403,'Proxy browser/admin boundary failed');
    console.log(JSON.stringify({machineId,registered:true,uid,gid,workspaceReadOnly:true,runnerCapabilitiesEmpty:true,operatorCredentialsAbsent:true,testedEgressTargetsDenied:deniedTargets,proxyAdminDenied:true}));
} catch { console.error('Isolierte Runnerprüfung fehlgeschlagen; nur Teststackzustand untersuchen.'); process.exit(1) }
`
}

export async function main(args = process.argv.slice(2)) {
    requireCheck(args.length >= 1 && args.length <= 2 && (args.length === 1 || args[1] === '--start'),
        'Aufruf: bun deploy/evolved/validate-runner-vm.mjs /absolut/runner.env [--start]')
    const envFile = resolve(args[0]), stat = lstatSync(envFile)
    requireCheck(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size <= 65536, 'runner.env muss eine reguläre private Datei (0600) sein.')
    const source = readFileSync(envFile, 'utf8'), plan = validationPlan(source, process.env)
    inspectProviderCredentialAbsence(plan.config.EVOLVED_RUNNER_HOME)
    const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'))
    const childEnv = { ...process.env }; delete childEnv.COMPOSE_PROJECT_NAME; delete childEnv.COMPOSE_FILE
    const run = (command, argv, options = {}) => spawnSync(command, argv, { cwd: repo, env: childEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, ...options })
    let docker = ['docker']
    for (const candidate of [['docker'], ['sudo', '-n', 'docker']]) {
        const context = run(candidate[0], [...candidate.slice(1), 'context', 'show'])
        const endpoint = run(candidate[0], [...candidate.slice(1), 'context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}'])
        if (context.status === 0 && context.stdout.trim() === 'default' && endpoint.status === 0 && /^unix:\/\/\//.test(endpoint.stdout.trim())
            && run(candidate[0], [...candidate.slice(1), 'info', '--format', '{{.ServerVersion}}']).status === 0) { docker = candidate; break }
        if (candidate[0] === 'sudo') throw Error('Lokaler Dockerzugriff fehlt; als Dockeradministrator starten oder sudo -n einrichten.')
    }
    const invoke = (argv, options = {}) => {
        const result = run(docker[0], [...docker.slice(1), ...argv], options)
        requireCheck(result.status === 0, `Docker-Testschritt ${argv[0]} fehlgeschlagen; keine Containerlogs oder Geheimnisse werden ausgegeben.`)
        return result.stdout.trim()
    }
    const ids = () => invoke(['ps', '-a', '--filter', `label=com.docker.compose.project=${plan.stack}`, '--format', '{{.ID}}']).split('\n').filter(Boolean)
    const inspect = id => JSON.parse(invoke(['inspect', id]))[0]
    inspectAcceptanceBackend(JSON.parse(invoke(['network', 'inspect', plan.backend]))[0], plan)
    let containers = ids().map(inspect)
    for (const c of containers) {
        const label = c.Config?.Labels ?? {}
        requireCheck(label[markerLabel] === plan.projectId && services.includes(label['com.docker.compose.service']), 'Vorhandener Stack ist nicht exklusiv für diese Abnahme markiert.')
        // --no-recreate preserves existing configuration, so inspect before starting it.
        inspectTestContainer(c, plan, label['com.docker.compose.service'], false)
    }
    requireCheck(containers.length <= services.length && services.every(service => containers.filter(c => c.Config.Labels['com.docker.compose.service'] === service).length <= 1), 'Doppelte oder zusätzliche Testcontainer.')
    if (args[1] !== '--start') requireCheck(containers.length === services.length, 'Teststack fehlt; zuerst mit --start ausdrücklich starten.')
    if (args[1] === '--start') {
        if (!containers.length) requireCheck(readdirSync(plan.config.EVOLVED_RUNNER_HOME).length === 0, 'Erster Teststart verlangt ein leeres Runnerhome.')
        invoke(['image', 'inspect', 'hapi-evolved:0.1.0', 'hapi-evolved-runner:0.1.0'])
        const temporary = mkdtempSync(join(tmpdir(), 'hapi-runner-validation-'))
        try {
            const override = join(temporary, 'compose.json')
            writeFileSync(override, JSON.stringify({ services: Object.fromEntries(services.map(service => [service, {
                labels: { [markerLabel]: plan.projectId }, ...(service === 'runner' ? { environment: { HAPI_TEST_MARKER: `evolved-validation-${plan.projectId}` } } : {})
            }])) }), { mode: 0o600 })
            console.log(`Starte ausschließlich Teststack ${plan.stack}; vorhandene Images, kein Build.`)
            invoke(['compose', '--project-name', plan.stack, '--env-file', envFile, '-f', 'deploy/evolved/runner.compose.yml', '-f', override,
                'up', '-d', '--no-build', '--pull', 'never', '--no-recreate'], { timeout: 90_000 })
        } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    console.log(`Prüfe Teststack ${plan.stack}; kein Providerlogin, Stop oder Widerruf.`)
    let runnerId, registration, runnerGeneration
    const registrationDeadline = Date.now() + 60_000
    while (Date.now() < registrationDeadline) {
        containers = ids().map(inspect)
        requireCheck(containers.length <= services.length, 'Zusätzliche Container im Teststack.')
        const candidate = containers.find(c => c.Config?.Labels?.['com.docker.compose.service'] === 'runner')
        for (const c of containers) inspectTestContainer(c, plan, c.Config.Labels['com.docker.compose.service'], false)
        const observed = observeRunnerStart(runnerGeneration, candidate?.State, performance.now())
        runnerGeneration = observed.observation
        if (containers.length === services.length && containers.every(c => c.State?.Running) && candidate && observed.ready) {
            runnerId = candidate.Id
            const probe = run(docker[0], [...docker.slice(1), 'exec', '-i', '--user', `${plan.config.EVOLVED_UID}:${plan.config.EVOLVED_GID}`, runnerId, 'bun', '-'], { input: containerProbe(plan, true), timeout: 12_000 })
            if (probe.status === 0) { registration = JSON.parse(probe.stdout); break }
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
    requireCheck(runnerId && registration && containers.length === services.length, 'Runner wurde nicht rechtzeitig aktiv im Hub registriert.')
    for (const service of services) {
        const matching = containers.filter(c => c.Config.Labels['com.docker.compose.service'] === service)
        requireCheck(matching.length === 1, 'Testservice fehlt oder wurde dupliziert.')
        inspectTestContainer(matching[0], plan, service)
    }
    const network = JSON.parse(invoke(['network', 'inspect', `${plan.stack}_project`]))[0]
    requireCheck(network.Internal === true, 'Runner-Projektnetz ist nicht intern.')
    const facts = JSON.parse(invoke(['exec', '-i', '--user', `${plan.config.EVOLVED_UID}:${plan.config.EVOLVED_GID}`, runnerId, 'bun', '-'], { input: containerProbe(plan), timeout: 25_000 }))
    console.log(JSON.stringify({ ok: true, stack: plan.stack, projectId: plan.projectId, ...facts, providerLogin: 'not-performed', stopAndRevocation: 'operator-controlled' }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`Runner-Abnahme: ${error instanceof Error ? error.message : 'fehlgeschlagen'}`); process.exitCode = 1 })
}
