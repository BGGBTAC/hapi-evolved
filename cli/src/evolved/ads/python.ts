/**
 * Python runtime for the vendored claude_ads_core. Upstream supports only CPython 3.11 and 3.12, so a 3.13 system
 * Python (Debian 13 development image, Odoo toolchain) never counts as ready. The interpreter is a fixed system
 * path (or an operator's absolute HAPI_ADS_PYTHON), started in isolated mode without site packages or bytecode
 * writes, with a minimal environment and a private working directory. No credentials or ambient variables reach it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { ADS_BRIDGE } from './assets'

/** Preferred first: the separately versioned runtime of the development image (see docs), then distribution builds. */
export const ADS_PYTHON_CANDIDATES = Object.freeze([
    '/opt/hapi-ads-python/bin/hapi-ads-python', '/usr/local/bin/python3.12', '/usr/bin/python3.12', '/usr/local/bin/python3.11', '/usr/bin/python3.11',
])
const OTHER_PYTHONS = ['/usr/bin/python3', '/usr/local/bin/python3']
export const ADS_SUPPORTED_PYTHON = /^3\.(11|12)\.\d+$/
const VERSION_SNIPPET = 'import sys; print("%d.%d.%d" % sys.version_info[:3])'
export const ADS_BRIDGE_TIMEOUT_MS = 120_000
const MAX_STDOUT = 64 * 1024 * 1024

export type AdsPython = { path: string; version: string }
export type AdsPythonProbe = { ready: AdsPython | null; unsupported: AdsPython[] }

function childEnv(home: string): NodeJS.ProcessEnv {
    return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: home, TMPDIR: home, PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' }
}

function version(path: string): string | null {
    try { if (!statSync(path).isFile()) return null } catch { return null }
    const result = spawnSync(path, ['-I', '-S', '-B', '-c', VERSION_SNIPPET], { encoding: 'utf8', timeout: 5000, env: childEnv(tmpdir()), cwd: '/', maxBuffer: 4096 })
    const text = result.status === 0 ? result.stdout.trim() : ''
    return /^\d+\.\d+\.\d+$/.test(text) ? text : null
}

export function probeAdsPython(env: NodeJS.ProcessEnv = process.env): AdsPythonProbe {
    const override = env.HAPI_ADS_PYTHON
    const candidates = override && isAbsolute(override) && normalize(override) === override ? [override] : [...ADS_PYTHON_CANDIDATES]
    const unsupported: AdsPython[] = []
    for (const path of candidates) {
        const found = version(path)
        if (!found) continue
        if (ADS_SUPPORTED_PYTHON.test(found)) return { ready: { path, version: found }, unsupported }
        unsupported.push({ path, version: found })
    }
    if (!override) for (const path of OTHER_PYTHONS) {
        if (!existsSync(path)) continue
        const found = version(path)
        if (found && !unsupported.some(item => item.version === found)) unsupported.push({ path, version: found })
    }
    return { ready: null, unsupported }
}

export function requireAdsPython(env?: NodeJS.ProcessEnv): AdsPython {
    const probe = probeAdsPython(env)
    if (probe.ready) return probe.ready
    const seen = probe.unsupported.map(item => `${item.path} ${item.version}`).join(', ')
    throw new Error(`No supported Python for Claude Ads (needs CPython 3.11 or 3.12${seen ? `; found ${seen}` : ''}). Use a runner image that provides /opt/hapi-ads-python or python3.12/3.11.`)
}

export type BridgeResult = { status: number; stdout: string; stderr: string }

/** Runs the fixed bridge with argv data only (no shell). `work` is a private directory that becomes the cwd. */
export function runBridge(python: AdsPython, upstreamRoot: string, args: readonly string[], work: string): BridgeResult {
    const result = spawnSync(python.path, ['-I', '-S', '-B', ADS_BRIDGE, upstreamRoot, ...args], {
        encoding: 'utf8', cwd: work, env: childEnv(work), timeout: ADS_BRIDGE_TIMEOUT_MS, maxBuffer: MAX_STDOUT, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error) throw new Error(`Claude Ads core did not complete: ${result.error.message.slice(0, 200)}`)
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.slice(0, 64 * 1024) }
}

/** Bounded error text from the core's JSON error line (or a generic message). */
export function bridgeError(result: BridgeResult): string {
    for (const line of result.stderr.split('\n').reverse()) {
        try { const parsed = JSON.parse(line) as { error?: unknown }; if (typeof parsed.error === 'string') return parsed.error.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000) } catch { /* next */ }
    }
    return `Claude Ads core failed (exit ${result.status})`
}

export function withWorkDirectory<T>(run: (work: string) => T): T {
    // Canonical path: the file boundary opens every component without following symbolic links.
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'hapi-ads-')))
    try { return run(work) } finally { rmSync(work, { recursive: true, force: true }) }
}
