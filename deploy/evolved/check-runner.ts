import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const keys = [
    'EVOLVED_UID', 'EVOLVED_GID', 'EVOLVED_PROJECT_ID', 'EVOLVED_PROJECT_DIRECTORY',
    'EVOLVED_RUNNER_PROFILE', 'EVOLVED_WORKSPACE_MODE', 'EVOLVED_RUNNER_WORKSPACE',
    'EVOLVED_RUNNER_HOME', 'EVOLVED_RUNNER_LEASE_FILE', 'EVOLVED_BACKEND_NETWORK', 'EVOLVED_EGRESS_HOSTS',
] as const
type RunnerKey = typeof keys[number]
type RunnerConfig = Partial<Record<RunnerKey, string>>

/** Deliberately narrower than dotenv: no quoting, interpolation, exports or shell evaluation. */
export function parseRunnerEnv(source: string): RunnerConfig {
    if (source.length > 65_536) throw new Error('runner.env ist zu groß.')
    const config: RunnerConfig = {}
    for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue
        const match = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./,@:-]+)$/.exec(line)
        if (!match || !keys.includes(match[1] as RunnerKey)) {
            throw new Error(`runner.env Zeile ${index + 1}: nur bekannte KEY=VALUE-Einträge ohne Quotes, Leerzeichen oder Shellsyntax erlaubt.`)
        }
        const key = match[1] as RunnerKey
        if (config[key] !== undefined) throw new Error(`runner.env Zeile ${index + 1}: doppelter Schlüssel ${key}.`)
        config[key] = match[2]
    }
    return config
}

function required(config: RunnerConfig, key: RunnerKey): string {
    const value = config[key]
    if (!value) throw new Error(`${key} fehlt.`)
    return value
}

function identifier(config: RunnerConfig, key: 'EVOLVED_UID' | 'EVOLVED_GID'): number {
    const value = required(config, key)
    if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 4_294_967_294) {
        throw new Error(`${key} muss eine gültige numerische ID größer als 0 sein.`)
    }
    return Number(value)
}

function absolutePath(config: RunnerConfig, key: RunnerKey): string {
    const value = required(config, key)
    if (!isAbsolute(value) || value.includes(':') || resolve(value) === '/' || resolve(value) !== value) {
        throw new Error(`${key} muss ein absoluter Unix-Pfad unterhalb des Wurzelverzeichnisses sein, ohne Doppelpunkt, Punktsegmente oder abschließenden Schrägstrich.`)
    }
    return value
}

function inside(path: string, directory: string): boolean {
    const part = relative(directory, path)
    return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function metadata(path: string, key: RunnerKey) {
    try { return { info: lstatSync(path), canonical: realpathSync(path) } }
    catch { throw new Error(`${key}: Pfad existiert nicht oder seine Metadaten sind nicht zugänglich.`) }
}

/** Checks metadata only. The lease is never opened or read. */
export function checkRunnerConfig(config: RunnerConfig, environment: NodeJS.ProcessEnv = {}) {
    for (const key of keys) {
        if (environment[key] !== undefined && environment[key] !== config[key]) {
            throw new Error(`${key}: exportierte Umgebungsvariable überschreibt runner.env; vor Prüfung und Compose-Aufruf entfernen.`)
        }
    }
    const uid = identifier(config, 'EVOLVED_UID')
    identifier(config, 'EVOLVED_GID')
    const projectId = required(config, 'EVOLVED_PROJECT_ID')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId)) {
        throw new Error('EVOLVED_PROJECT_ID muss eine UUID in Kleinbuchstaben sein.')
    }
    const directory = required(config, 'EVOLVED_PROJECT_DIRECTORY')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(directory)) {
        throw new Error('EVOLVED_PROJECT_DIRECTORY muss ein einzelner sicherer Verzeichnisname sein.')
    }
    const profile = required(config, 'EVOLVED_RUNNER_PROFILE')
    const mode = required(config, 'EVOLVED_WORKSPACE_MODE')
    if (!['restricted', 'workspace', 'extended'].includes(profile)) throw new Error('EVOLVED_RUNNER_PROFILE ist ungültig.')
    if (!['ro', 'rw'].includes(mode) || (profile === 'restricted' && mode !== 'ro')) {
        throw new Error('EVOLVED_WORKSPACE_MODE muss ro oder rw sein; restricted verlangt ro.')
    }
    if (config.EVOLVED_BACKEND_NETWORK && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.EVOLVED_BACKEND_NETWORK)) {
        throw new Error('EVOLVED_BACKEND_NETWORK ist kein gültiger Netzwerkname.')
    }
    const workspacePath = absolutePath(config, 'EVOLVED_RUNNER_WORKSPACE')
    const homePath = absolutePath(config, 'EVOLVED_RUNNER_HOME')
    const leasePath = absolutePath(config, 'EVOLVED_RUNNER_LEASE_FILE')
    const workspace = metadata(workspacePath, 'EVOLVED_RUNNER_WORKSPACE')
    const home = metadata(homePath, 'EVOLVED_RUNNER_HOME')
    const lease = metadata(leasePath, 'EVOLVED_RUNNER_LEASE_FILE')
    if (!workspace.info.isDirectory() || !home.info.isDirectory()) {
        throw new Error('Workspace und Runner-Home müssen echte Verzeichnisse sein, keine Symlinks.')
    }
    if (home.info.uid !== uid || (home.info.mode & 0o7777) !== 0o700) {
        throw new Error('EVOLVED_RUNNER_HOME verlangt Modus 0700 und EVOLVED_UID als Besitzer.')
    }
    if (inside(home.canonical, workspace.canonical) || inside(workspace.canonical, home.canonical)) {
        throw new Error('Workspace und Runner-Home müssen getrennte Verzeichnisbäume sein.')
    }
    if (!lease.info.isFile() || lease.info.nlink !== 1 || lease.info.uid !== uid || (lease.info.mode & 0o7777) !== 0o600) {
        throw new Error('EVOLVED_RUNNER_LEASE_FILE verlangt eine reguläre Datei ohne Links, Modus 0600 und EVOLVED_UID als Besitzer.')
    }
    if (lease.info.size === 0 || lease.info.size > 4096) throw new Error('EVOLVED_RUNNER_LEASE_FILE hat eine ungültige Dateigröße.')
    if (inside(lease.canonical, workspace.canonical) || inside(lease.canonical, home.canonical)
        || inside(resolve(leasePath), resolve(workspacePath)) || inside(resolve(leasePath), resolve(homePath))) {
        throw new Error('EVOLVED_RUNNER_LEASE_FILE muss außerhalb von Workspace und Runner-Home liegen, auch nach Auflösung von Symlinks.')
    }
    return { projectId, profile, mode }
}

if (import.meta.main) {
    try {
        if (process.argv.length !== 3) throw new Error('Aufruf: bun deploy/evolved/check-runner.ts /absolut/zu/runner.env')
        let source: string
        try { source = readFileSync(process.argv[2], 'utf8') }
        catch { throw new Error('runner.env konnte nicht gelesen werden.') }
        const result = checkRunnerConfig(parseRunnerEnv(source), process.env)
        console.log(`Runner-Konfiguration geprüft: ${result.projectId}, ${result.profile}, ${result.mode}. Keine Lease-Werte gelesen.`)
    } catch (error) {
        console.error(`Runner-Vorprüfung fehlgeschlagen: ${error instanceof Error ? error.message : 'Ungültige Konfiguration.'}`)
        process.exitCode = 1
    }
}
