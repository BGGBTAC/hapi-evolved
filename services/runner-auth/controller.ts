import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export type Provider = 'codex' | 'claude'
export type ProviderSummary = {
    provider: Provider
    status: 'connected' | 'disconnected' | 'unavailable'
    method: 'subscription' | 'api-key' | null
    checkedAt: number | null
}
export type AuthOperation = {
    id: string
    provider: Provider
    state: 'starting' | 'waiting' | 'connected' | 'failed' | 'cancelled' | 'expired'
    flow: 'device' | 'code' | null
    verificationUrl?: string
    userCode?: string
    expiresAt: number
    message?: string
}
export class AuthError extends Error {
    constructor(public readonly code: string, message: string) { super(message) }
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
type NativeResult = { code: number | null; output: string; stdout: string; stderr: string; limited: boolean }
type Running = { done: Promise<NativeResult>; stop: () => Promise<void>; write: (text: string) => void }
type Job = { operation: AuthOperation; child?: Running; timer?: ReturnType<typeof setTimeout>; expectedState?: string; submitted: boolean }
type Options = {
    home: string
    codexPath: string
    claudePath: string
    spawn?: Spawn
    /** A shorter duration is useful in tests; production cannot exceed fifteen minutes. */
    loginTimeoutMs?: number
    commandTimeoutMs?: number
    /** Server-owned container egress endpoint, never supplied through IPC. */
    proxyUrl?: 'http://egress:3128'
}
const PROVIDERS: Provider[] = ['codex', 'claude']
const TERMINAL = new Set<AuthOperation['state']>(['connected', 'failed', 'cancelled', 'expired'])
const CODEX_DEVICE = 'https://auth.openai.com/codex/device'
const CLAUDE_CLIENT = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_KEYS = ['code', 'client_id', 'response_type', 'redirect_uri', 'scope', 'code_challenge', 'code_challenge_method', 'state']

function plain(output: string): string {
    return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

/** Parse only the pinned native CLIs' public challenges. Never pass terminal text through. */
export function parseChallenge(provider: Provider, output: string): { url: string; userCode?: string; state?: string } | null {
    const clean = plain(output)
    const candidates = clean.match(/https:\/\/[^\s<>"'\x00-\x1f]+/g) ?? []
    for (const candidate of candidates) {
        let url: URL
        try { url = new URL(candidate) } catch { continue }
        if (url.username || url.password || url.hash || url.port) continue
        if (provider === 'codex') {
            if (url.href !== CODEX_DEVICE) continue
            const code = clean.match(/(?:^|\s)([A-Z0-9]{4}-[A-Z0-9]{5})(?=\s|$)/)?.[1]
            if (code) return { url: CODEX_DEVICE, userCode: code }
            continue
        }
        if (url.origin !== 'https://claude.com' || url.pathname !== '/cai/oauth/authorize') continue
        const entries = [...url.searchParams.keys()]
        if (entries.length !== CLAUDE_KEYS.length || CLAUDE_KEYS.some(key => url.searchParams.getAll(key).length !== 1)) continue
        if (url.searchParams.get('client_id') !== CLAUDE_CLIENT || url.searchParams.get('response_type') !== 'code'
            || url.searchParams.get('code') !== 'true' || url.searchParams.get('code_challenge_method') !== 'S256'
            || url.searchParams.get('redirect_uri') !== 'https://platform.claude.com/oauth/code/callback') continue
        const state = url.searchParams.get('state') ?? ''
        if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '')) continue
        const scopes = url.searchParams.get('scope')?.split(' ') ?? []
        const expectedScopes = ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload', 'user:plugins']
        if (scopes.length !== expectedScopes.length || expectedScopes.some(scope => !scopes.includes(scope))) continue
        return { url: url.href, state }
    }
    return null
}

/** Runs inside the runner's PID namespace, as its unprivileged native-agent user. */
export class NativeAuthController {
    private readonly jobs = new Map<Provider, Job>()
    private readonly queues = new Map<Provider, Promise<unknown>>()
    private readonly commands = new Set<Running>()
    private readonly summaries = new Map<Provider, ProviderSummary>()
    private readonly spawnChild: Spawn
    private readonly environment: NodeJS.ProcessEnv
    private readonly loginTimeout: number
    private readonly commandTimeout: number
    private closed = false

    constructor(private readonly options: Options) {
        for (const path of [options.home, options.codexPath, options.claudePath]) {
            if (!path.startsWith('/') || resolve(path) !== path) throw new Error('Native authentication paths must be absolute and normalized')
        }
        this.spawnChild = options.spawn ?? (spawn as Spawn)
        this.loginTimeout = Math.max(1, Math.min(options.loginTimeoutMs ?? 900_000, 900_000))
        this.commandTimeout = Math.max(1, Math.min(options.commandTimeoutMs ?? 5_000, 5_000))
        // No inherited API keys, OAuth tokens, executable hooks, loaders or shell configuration.
        this.environment = {
            HOME: options.home, CODEX_HOME: join(options.home, 'codex'), CLAUDE_CONFIG_DIR: join(options.home, 'claude'),
            XDG_CONFIG_HOME: join(options.home, '.config'), XDG_CACHE_HOME: join(options.home, '.cache'),
            PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'dumb', NO_COLOR: '1', BROWSER: '/usr/bin/true',
            DISABLE_AUTOUPDATER: '1', DISABLE_NONESSENTIAL_TRAFFIC: '1',
            ...(options.proxyUrl ? { HTTPS_PROXY: options.proxyUrl, HTTP_PROXY: options.proxyUrl, NO_PROXY: 'localhost,127.0.0.1' } : {}),
        }
    }

    async initialize(): Promise<void> {
        for (const path of [this.options.home, this.environment.CODEX_HOME!, this.environment.CLAUDE_CONFIG_DIR!, this.environment.XDG_CONFIG_HOME!, this.environment.XDG_CACHE_HOME!]) {
            await mkdir(path, { recursive: true, mode: 0o700 })
            const info = await lstat(path)
            if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
                || (process.getuid && info.uid !== process.getuid())) throw new Error('Native authentication directory is not private')
        }
    }

    private serial<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
        const prior = this.queues.get(provider) ?? Promise.resolve()
        const result = prior.catch(() => undefined).then(() => {
            if (this.closed) throw new AuthError('closed', 'Anmeldedienst wurde beendet.')
            return fn()
        })
        this.queues.set(provider, result.catch(() => undefined))
        return result
    }

    private run(provider: Provider, args: string[], timeout: number, onOutput?: (text: string) => void): Running {
        const executable = provider === 'codex' ? this.options.codexPath : this.options.claudePath
        const child = this.spawnChild(executable, args, { cwd: this.options.home, env: this.environment, detached: true, stdio: 'pipe' })
        let output = ''
        let stdout = '', stderr = ''
        let total = 0
        let limited = false
        let finished = false
        let stopping: Promise<void> | undefined
        let escalation: ReturnType<typeof setTimeout> | undefined
        let hardStop: ReturnType<typeof setTimeout> | undefined
        let complete!: (result: NativeResult) => void
        const done = new Promise<NativeResult>(resolve => { complete = resolve })
        const kill = (signal: NodeJS.Signals) => {
            if (finished || !child.pid) return
            try { process.kill(-child.pid, signal) } catch { /* Already exited; never kill a PID supplied by a caller. */ }
        }
        const stop = (): Promise<void> => {
            if (finished) return Promise.resolve()
            if (!stopping) {
                kill('SIGTERM')
                escalation = setTimeout(() => kill('SIGKILL'), 750)
                escalation.unref?.()
                // A setsid descendant can inherit pipes without belonging to the
                // native process group. Do not let those pipes pin this service forever.
                hardStop = setTimeout(() => {
                    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
                    finish(null)
                }, 1_000)
                hardStop.unref?.()
                stopping = done.then(() => undefined)
            }
            return stopping
        }
        const timer = setTimeout(() => { limited = true; void stop() }, timeout)
        timer.unref?.()
        const finish = (code: number | null) => {
            if (finished) return
            // A parent can exit before a detached-stdio descendant. Finish the
            // owned process group before clearing escalation or acknowledging cancellation.
            if (stopping) kill('SIGKILL')
            finished = true
            clearTimeout(timer)
            if (escalation) clearTimeout(escalation)
            if (hardStop) clearTimeout(hardStop)
            this.commands.delete(running)
            complete({ code, output, stdout, stderr, limited })
        }
        const append = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
            total += Buffer.byteLength(chunk)
            if (total > 65_536) { limited = true; void stop(); return }
            output += chunk.toString()
            if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString()
            if (!limited) onOutput?.(output)
        }
        const running: Running = { done, stop, write: text => { if (!finished && !stopping) child.stdin.write(text) } }
        child.stdout.on('data', chunk => append(chunk, 'stdout'))
        child.stderr.on('data', chunk => append(chunk, 'stderr'))
        child.stdin.on('error', () => { /* Native process may close its input before its exit event. */ })
        child.once('error', () => finish(null))
        child.once('close', code => finish(code))
        this.commands.add(running)
        return running
    }

    private async inspect(provider: Provider): Promise<ProviderSummary> {
        const summary = await this.inspectNative(provider)
        this.summaries.set(provider, summary)
        return summary
    }

    private async inspectNative(provider: Provider): Promise<ProviderSummary> {
        const args = provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'] : ['auth', 'status', '--json']
        let result: Awaited<Running['done']>
        try { result = await this.run(provider, args, this.commandTimeout).done } catch {
            return { provider, status: 'unavailable', method: null, checkedAt: Date.now() }
        }
        const summary: ProviderSummary = { provider, status: 'unavailable', method: null, checkedAt: Date.now() }
        if (result.limited) return summary
        if (provider === 'codex') {
            const output = plain(result.output)
            if (result.code === 0 && /^Logged in using ChatGPT\s*$/m.test(output)) return { ...summary, status: 'connected', method: 'subscription' }
            if (result.code === 0 && /^Logged in using an API key\b/m.test(output)) return { ...summary, status: 'connected', method: 'api-key' }
            if (result.code === 1 && /^Not logged in\s*$/m.test(output)) return { ...summary, status: 'disconnected' }
        } else {
            try {
                const status = JSON.parse(result.stdout)
                if (result.code === 1 && status.loggedIn === false && status.authMethod === 'none') return { ...summary, status: 'disconnected' }
                if (result.code === 0 && status.loggedIn === true) {
                    if (status.authMethod === 'claude.ai' || status.authMethod === 'oauth_token') return { ...summary, status: 'connected', method: 'subscription' }
                    if (['api_key', 'api_key_helper', 'third_party'].includes(status.authMethod)) return { ...summary, status: 'connected', method: 'api-key' }
                }
            } catch { /* Never expose malformed/native diagnostics or credential values. */ }
        }
        return summary
    }

    async status(): Promise<{ providers: ProviderSummary[] }> {
        return { providers: await Promise.all(PROVIDERS.map(provider => this.serial(provider, () => this.inspect(provider)))) }
    }

    private snapshot(job: Job): AuthOperation {
        return { ...job.operation }
    }

    private terminal(job: Job, state: AuthOperation['state'], message: string): void {
        if (job.timer) clearTimeout(job.timer)
        job.operation = { id: job.operation.id, provider: job.operation.provider, expiresAt: job.operation.expiresAt, flow: null, state, message }
        job.expectedState = undefined
    }

    async start(provider: Provider): Promise<{ operation: AuthOperation }> {
        return this.serial(provider, async () => {
            const existing = this.jobs.get(provider)
            if (existing && !TERMINAL.has(existing.operation.state)) return { operation: this.snapshot(existing) }
            if (existing?.child) await existing.child.stop()
            const summary = await this.inspect(provider)
            const job: Job = { operation: { id: randomUUID(), provider, state: 'starting', flow: provider === 'codex' ? 'device' : 'code', expiresAt: Date.now() + this.loginTimeout }, submitted: false }
            this.jobs.set(provider, job)
            if (this.closed) throw new AuthError('closed', 'Anmeldedienst wurde beendet.')
            if (summary.status === 'connected') {
                this.terminal(job, 'connected', summary.method === 'subscription' ? 'Abo-Anmeldung ist bereits aktiv.' : 'Vorhandene API-Anmeldung bleibt erhalten. Zum Wechsel zuerst ausdrücklich abmelden.')
                return { operation: this.snapshot(job) }
            }
            if (summary.status === 'unavailable') {
                this.terminal(job, 'failed', 'Anmeldestatus konnte nicht sicher geprüft werden. Bestehende Anmeldung bleibt erhalten.')
                return { operation: this.snapshot(job) }
            }
            job.timer = setTimeout(() => { void this.finishCancelled(job, 'expired') }, this.loginTimeout)
            job.timer.unref?.()
            try {
                job.child = this.run(provider, provider === 'codex'
                    ? ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']
                    : ['auth', 'login', '--claudeai'], this.loginTimeout + 1_000, output => {
                    if (TERMINAL.has(job.operation.state) || job.submitted) return
                    const challenge = parseChallenge(provider, output)
                    if (!challenge) return
                    job.expectedState = challenge.state
                    job.operation = { ...job.operation, state: 'waiting', verificationUrl: challenge.url, ...(challenge.userCode ? { userCode: challenge.userCode } : {}) }
                })
            } catch {
                this.terminal(job, 'failed', 'Anmeldeprogramm konnte nicht gestartet werden.')
                return { operation: this.snapshot(job) }
            }
            void this.completeLogin(job)
            return { operation: this.snapshot(job) }
        })
    }

    private async completeLogin(job: Job): Promise<void> {
        const result = await job.child!.done
        if (TERMINAL.has(job.operation.state) || this.closed) return
        if (result.code !== 0 || result.limited) {
            this.terminal(job, 'failed', 'Anmeldung wurde nicht abgeschlossen. Bitte erneut versuchen.')
            return
        }
        const summary = await this.inspect(job.operation.provider)
        if (TERMINAL.has(job.operation.state) || this.closed) return
        this.terminal(job, summary.status === 'connected' && summary.method === 'subscription' ? 'connected' : 'failed',
            summary.status === 'connected' && summary.method === 'subscription' ? 'Abo-Anmeldung wurde bestätigt.' : 'Abo-Anmeldung konnte nicht bestätigt werden.')
    }

    get(provider: Provider, operationId: string): { operation: AuthOperation } {
        return { operation: this.snapshot(this.find(provider, operationId)) }
    }

    private find(provider: Provider, operationId: string): Job {
        const job = this.jobs.get(provider)
        if (!job || job.operation.id !== operationId) throw new AuthError('not_found', 'Anmeldevorgang wurde nicht gefunden.')
        return job
    }

    async code(provider: Provider, operationId: string, code: string): Promise<{ operation: AuthOperation }> {
        return this.serial(provider, async () => {
            const job = this.find(provider, operationId)
            if (provider !== 'claude' || job.operation.state !== 'waiting' || job.submitted || Date.now() >= job.operation.expiresAt) throw new AuthError('invalid_state', 'Dieser Vorgang erwartet keinen Anmeldecode.')
            const match = /^([A-Za-z0-9_-]{8,2048})#([A-Za-z0-9_-]{43})$/.exec(code)
            if (!match || match[2] !== job.expectedState) throw new AuthError('invalid_code', 'Bitte den vollständigen Code dieses Anmeldevorgangs übernehmen.')
            job.submitted = true
            job.operation = { id: job.operation.id, provider, state: 'starting', flow: 'code', expiresAt: job.operation.expiresAt, message: 'Anmeldecode wird vom Anbieter geprüft.' }
            job.child!.write(`${code}\n`)
            return { operation: this.snapshot(job) }
        })
    }

    private async finishCancelled(job: Job, state: 'cancelled' | 'expired'): Promise<void> {
        if (TERMINAL.has(job.operation.state)) return
        this.terminal(job, state, state === 'expired' ? 'Anmeldevorgang ist abgelaufen.' : 'Anmeldevorgang wurde abgebrochen.')
        await job.child?.stop()
    }

    async cancel(provider: Provider, operationId: string): Promise<{ operation: AuthOperation }> {
        return this.serial(provider, async () => {
            const job = this.find(provider, operationId)
            await this.finishCancelled(job, 'cancelled')
            return { operation: this.snapshot(job) }
        })
    }

    async logout(provider: Provider): Promise<{ providers: ProviderSummary[] }> {
        await this.serial(provider, async () => {
            const job = this.jobs.get(provider)
            if (job) await this.finishCancelled(job, 'cancelled')
            const result = await this.run(provider, provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', 'logout'] : ['auth', 'logout'], this.commandTimeout).done
            if (result.code !== 0 || result.limited) throw new AuthError('logout_failed', 'Abmeldung konnte nicht bestätigt werden.')
            const status = await this.inspect(provider)
            if (status.status !== 'disconnected') throw new AuthError('logout_failed', 'Abmeldung konnte nicht bestätigt werden.')
        })
        return { providers: PROVIDERS.map(item => this.summaries.get(item) ?? { provider: item, status: 'unavailable', method: null, checkedAt: null }) }
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        for (const job of this.jobs.values()) this.terminal(job, 'cancelled', 'Anmeldedienst wurde beendet.')
        await Promise.all([...this.commands].map(child => child.stop()))
    }
}
