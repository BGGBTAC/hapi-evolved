import { ProviderCapacitySchema, type CapacityWindow, type ProviderCapacity } from '@hapi/protocol'

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const number = (value: unknown, max: number): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null
const reset = (value: unknown): number | null => { const seconds = number(value, 8_640_000_000_000), ms = seconds === null ? 0 : Math.round(seconds * 1000); return ms > 0 ? ms : null }
const identifier = (value: unknown, fallback: string): string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : fallback
const remaining = (used: number | null) => used === null ? null : Math.round((100 - used) * 10000) / 10000

export function unknownCapacity(provider: ProviderCapacity['provider'], reason: ProviderCapacity['reason'], now = Date.now(), status: ProviderCapacity['status'] = 'unknown'): ProviderCapacity {
    return { provider, source: provider === 'codex' ? 'codex-app-server' : 'claude-sdk', scope: 'account', observedAt: now, status, reason, windows: [] }
}

/** Official SDK rate_limit_info: utilization is a fraction, resetsAt is Unix seconds. */
export function claudeCapacity(message: unknown, now = Date.now()): ProviderCapacity | null {
    const event = record(message)
    if (event.type !== 'rate_limit_event') return null
    const info = record(event.rate_limit_info)
    const status = info.status === 'allowed' ? 'allowed' : info.status === 'allowed_warning' ? 'warning' : info.status === 'rejected' ? 'rejected' : 'unknown'
    const utilization = number(info.utilization, 1)
    const usedPercent = utilization === null ? null : Math.round(utilization * 1_000_000) / 10_000
    // A missing/invalid utilization is not zero, even for status="allowed".
    const id = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'].includes(String(info.rateLimitType)) ? String(info.rateLimitType) : 'reported'
    return { ...unknownCapacity('claude', usedPercent === null ? 'utilization_not_reported' : null, now),
        status: usedPercent === null ? 'unknown' : 'available',
        windows: [{ id, observedAt: now, usedPercent, remainingPercent: remaining(usedPercent), resetsAt: reset(info.resetsAt),
            durationMinutes: id === 'five_hour' ? 300 : id.startsWith('seven_day') ? 10080 : null, status }] }
}

/** Official account/rateLimits/read and account/rateLimits/updated payloads. */
function codexBuckets(payload: unknown): Array<{ id: string; bucket: Record<string, unknown> }> {
    const response = record(payload), buckets = record(response.rateLimitsByLimitId)
    const entries = Object.keys(buckets).length ? Object.entries(buckets).slice(0, 16) : [['codex', response.rateLimits]] as Array<[string, unknown]>
    const result: Array<{ id: string; bucket: Record<string, unknown> }> = [], seen = new Set<string>()
    for (const [index, [key, raw]] of entries.entries()) {
        const bucket = record(raw), id = identifier(bucket.limitId, identifier(key, `bucket-${index}`))
        if (!seen.has(id)) { seen.add(id); result.push({ id, bucket }) }
    }
    return result
}
export function codexCapacity(payload: unknown, now = Date.now()): ProviderCapacity {
    const windows: CapacityWindow[] = []
    for (const { id, bucket } of codexBuckets(payload)) {
        for (const kind of ['primary', 'secondary'] as const) {
            const value = record(bucket[kind])
            if (!Object.keys(value).length) continue
            const usedPercent = number(value.usedPercent, 100), duration = number(value.windowDurationMins, 527040)
            windows.push({ id: `${id}:${kind}`, observedAt: now, usedPercent, remainingPercent: remaining(usedPercent), resetsAt: reset(value.resetsAt),
                durationMinutes: duration && duration > 0 ? duration : null,
                status: usedPercent === null ? 'unknown' : usedPercent >= 100 ? 'rejected' : 'allowed' })
        }
    }
    const available = windows.some(window => window.usedPercent !== null)
    return { ...unknownCapacity('codex', available ? null : 'utilization_not_reported', now), status: available ? 'available' : 'unknown', windows }
}

/** Partial native events retain other windows with their ORIGINAL receipt times. */
export function mergeCapacity(previous: ProviderCapacity | null | undefined, next: ProviderCapacity): ProviderCapacity {
    if (!previous || previous.provider !== next.provider) return next
    const windows = new Map(previous.windows.map(window => [window.id, { ...window, observedAt: window.observedAt ?? previous.observedAt }]))
    for (const window of next.windows) windows.set(window.id, { ...window, observedAt: window.observedAt ?? next.observedAt })
    const combined = [...windows.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, 32)
    const available = combined.some(window => window.usedPercent !== null)
    return { ...next, status: available ? 'available' : next.status, reason: available ? null : next.reason, windows: combined }
}

function codexUpdate(previous: ProviderCapacity | undefined, payload: unknown): ProviderCapacity | null {
    const next = codexCapacity(payload), changed = new Set<string>()
    for (const { id, bucket } of codexBuckets(payload)) {
        for (const kind of ['primary', 'secondary'] as const) {
            if (!Object.hasOwn(bucket, kind)) continue
            const windowId = `${id}:${kind}`, window = next.windows.find(value => value.id === windowId)
            if (bucket[kind] === null || (window && [window.usedPercent, window.resetsAt, window.durationMinutes].some(value => value !== null))) changed.add(windowId)
        }
    }
    // An absent/empty/malformed window reports nothing: neither erase an older
    // observation nor advance its receipt time (or invalidate an in-flight read).
    if (!changed.size) return null
    return mergeCapacity(previous ? { ...previous, windows: previous.windows.filter(window => !changed.has(window.id)) } : undefined,
        { ...next, windows: next.windows.filter(window => changed.has(window.id)) })
}

/** Reads only the existing native app-server; no credential files or private HTTP API. */
export class CodexCapacityReporter {
    private revision = 0
    private dataRevision = 0
    private subscription = false
    private snapshot?: ProviderCapacity
    private stopped = true
    private pending?: { revision: number; promise: Promise<void> }
    private timer?: ReturnType<typeof setInterval>
    constructor(private readonly read: (method: string, params?: unknown) => Promise<unknown>, private readonly publish: (value: ProviderCapacity) => void) {}
    private emit(value: ProviderCapacity): void {
        const parsed = ProviderCapacitySchema.safeParse(value)
        this.snapshot = parsed.success ? parsed.data : unknownCapacity('codex', 'invalid_report')
        // Telemetry must never interrupt the agent's notification/turn path.
        try { this.publish(this.snapshot) } catch { /* The next native update can retry. */ }
    }
    start(): void {
        this.stop(); this.stopped = false
        this.emit(unknownCapacity('codex', 'not_reported'))
        void this.refresh()
        this.timer = setInterval(() => { void this.refresh() }, 60_000)
        this.timer.unref?.()
    }
    stop(): void { this.stopped = true; this.revision++; this.subscription = false; this.snapshot = undefined; clearInterval(this.timer); this.timer = undefined; this.pending = undefined }
    notification(method: string, params: unknown): void {
        if (this.stopped) return
        if (method === 'account/rateLimits/updated') {
            if (!this.subscription) { void this.refresh(); return }
            const update = codexUpdate(this.snapshot, params)
            if (!update) return
            this.dataRevision++ // A slow read must not overwrite a newer notification.
            this.emit(update)
        } else if (method === 'account/updated') {
            this.revision++; this.subscription = false; this.snapshot = undefined
            const mode = record(params).authMode
            this.emit(unknownCapacity('codex', mode === null ? 'authentication_required' : 'not_reported'))
            // Never keep limits from the previous identity across a login change.
            void this.refresh()
        }
    }
    refresh(): Promise<void> {
        if (this.stopped) return Promise.resolve()
        if (this.pending?.revision === this.revision) return this.pending.promise
        const revision = this.revision
        let dataRevision = this.dataRevision
        const current = () => !this.stopped && revision === this.revision
        const task = (async () => {
            try {
                const account = record(record(await this.read('account/read', { refreshToken: false })).account)
                if (!current()) return
                this.subscription = account.type === 'chatgpt'
                if (!account.type) { this.emit(unknownCapacity('codex', 'authentication_required')); return }
                if (!this.subscription) {
                    this.emit(unknownCapacity('codex', 'subscription_auth_required', Date.now(), 'unsupported')); return
                }
                dataRevision = this.dataRevision
                const response = await this.read('account/rateLimits/read')
                if (current() && dataRevision === this.dataRevision) this.emit(codexCapacity(response))
            } catch {
                if (current() && dataRevision === this.dataRevision) { this.subscription = false; this.emit(unknownCapacity('codex', 'native_read_failed')) }
            }
        })()
        this.pending = { revision, promise: task }
        void task.finally(() => { if (this.pending?.promise === task) this.pending = undefined })
        return task
    }
}
