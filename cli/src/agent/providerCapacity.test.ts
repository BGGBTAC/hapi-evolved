import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderCapacity } from '@hapi/protocol'
import { claudeCapacity, codexCapacity, CodexCapacityReporter, mergeCapacity } from './providerCapacity'

afterEach(() => vi.useRealTimers())
const limits = (usedPercent: unknown) => ({ rateLimits: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 300, resetsAt: 2_000_000_000 } } })

describe('subscription capacity normalization', () => {
    it('retains reported Claude utilization without interpreting allowed as zero usage', () => {
        const unknown = claudeCapacity({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 2_000_000_000 } }, 1000)!
        expect(unknown.status).toBe('unknown')
        expect(unknown.windows[0]).toEqual({ id: 'five_hour', observedAt: 1000, usedPercent: null, remainingPercent: null, resetsAt: 2_000_000_000_000, durationMinutes: 300, status: 'allowed' })
        const warning = claudeCapacity({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.85, rateLimitType: 'seven_day_opus' } })!
        expect(warning.windows[0]).toMatchObject({ usedPercent: 85, remainingPercent: 15, durationMinutes: 10080, status: 'warning' })
        expect(claudeCapacity({ type: 'assistant', message: 'usage limit reached' })).toBeNull()
    })
    it.each([undefined, null, -1, 101, Infinity, NaN, '20'])('does not manufacture remaining for invalid Codex usage %s', value => {
        expect(codexCapacity(limits(value)).windows[0]).toMatchObject({ usedPercent: null, remainingPercent: null, status: 'unknown' })
    })
    it('accepts a genuinely reported zero and keeps independent Codex buckets', () => {
        const result = codexCapacity({ ...limits(90), rateLimitsByLimitId: { codex: limits(0).rateLimits, other: { limitId: 'other', secondary: { usedPercent: 100, windowDurationMins: 10080 } } }, email: 'private@example.test', accountId: 'secret', credits: { balance: 'secret' } }, 1000)
        expect(result.windows).toHaveLength(2)
        expect(result.windows[0]).toMatchObject({ id: 'codex:primary', usedPercent: 0, remainingPercent: 100 })
        expect(result.windows[1]).toMatchObject({ id: 'other:secondary', remainingPercent: 0, resetsAt: null })
        expect(JSON.stringify(result)).not.toMatch(/private|secret|balance/)
    })
    it('bounds windows and sanitizes arbitrary provider identifiers', () => {
        const buckets = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), { limitId: 'bad/email@example.test', primary: { usedPercent: 42 } }]))
        const result = codexCapacity({ rateLimitsByLimitId: buckets })
        expect(result.windows).toHaveLength(16)
        expect(result.windows.map(window => window.id)).toEqual(Array.from({ length: 16 }, (_, index) => `${index}:primary`))
        expect(JSON.stringify(result)).not.toContain('example.test')
    })
    it('retains independent Claude windows without refreshing their old receipt times', () => {
        const five = claudeCapacity({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 0.2, rateLimitType: 'five_hour' } }, 1000)!
        const week = claudeCapacity({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.8, rateLimitType: 'seven_day' } }, 2000)!
        expect(mergeCapacity(five, week).windows.map(window => [window.id, window.observedAt, window.remainingPercent])).toEqual([['seven_day', 2000, 20], ['five_hour', 1000, 80]])
        expect(codexCapacity({ rateLimits: { primary: { usedPercent: 20, resetsAt: 0.00001 } } }).windows[0].resetsAt).toBeNull()
    })
})

describe('native Codex capacity lifecycle', () => {
    it('reads native account and limits without token refresh; polls and stops cleanly', async () => {
        vi.useFakeTimers()
        const publish = vi.fn(), read = vi.fn(async (method: string) => method === 'account/read' ? { account: { type: 'chatgpt', email: 'private@example.test' } } : limits(32))
        const reporter = new CodexCapacityReporter(read, publish)
        reporter.start(); await reporter.refresh()
        expect(read.mock.calls).toEqual([['account/read', { refreshToken: false }], ['account/rateLimits/read']])
        expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'available', windows: [{ remainingPercent: 68 }] })
        await vi.advanceTimersByTimeAsync(60_000)
        expect(read).toHaveBeenCalledTimes(4)
        reporter.stop(); await vi.advanceTimersByTimeAsync(120_000)
        expect(read).toHaveBeenCalledTimes(4)
    })
    it('marks API-key authentication unsupported without querying subscription limits', async () => {
        const results: ProviderCapacity[] = [], read = vi.fn(async (_method: string) => ({ account: { type: 'apiKey' } }))
        const reporter = new CodexCapacityReporter(read, value => results.push(value))
        reporter.start(); await reporter.refresh()
        reporter.notification('account/rateLimits/updated', limits(0)); await reporter.refresh(); reporter.stop()
        expect(read.mock.calls.every(([method]) => method !== 'account/rateLimits/read')).toBe(true)
        expect(results.at(-1)).toMatchObject({ status: 'unsupported', reason: 'subscription_auth_required', windows: [] })
    })
    it('a newer event wins over an in-flight native read and logout clears old quota', async () => {
        const results: ProviderCapacity[] = []
        let resolve!: (value: unknown) => void
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : new Promise(r => { resolve = r }), value => results.push(value))
        reporter.start(); await Promise.resolve(); await Promise.resolve()
        reporter.notification('account/rateLimits/updated', limits(77))
        resolve(limits(10)); await reporter.refresh()
        expect(results.at(-1)?.windows[0].usedPercent).toBe(77)
        reporter.notification('account/updated', { authMode: null })
        expect(results.at(-1)).toMatchObject({ reason: 'authentication_required', windows: [] })
        reporter.stop()
    })
    it('never exposes native error text or publishes after stopping', async () => {
        const results: ProviderCapacity[] = []
        const reporter = new CodexCapacityReporter(async () => { throw new Error('token=private') }, value => results.push(value))
        reporter.start(); await reporter.refresh()
        expect(results.at(-1)).toMatchObject({ status: 'unknown', reason: 'native_read_failed' })
        expect(JSON.stringify(results)).not.toContain('private')
        reporter.stop(); reporter.notification('account/rateLimits/updated', limits(10))
        expect(results).toHaveLength(2)
    })
    it('refreshes a new identity immediately while an old native read is still pending', async () => {
        const results: ProviderCapacity[] = []; let oldResolve!: (value: unknown) => void, reads = 0
        const reporter = new CodexCapacityReporter(async method => {
            if (method === 'account/read') return { account: { type: 'chatgpt' } }
            if (++reads === 1) return new Promise(resolve => { oldResolve = resolve })
            return limits(66)
        }, value => results.push(value))
        reporter.start(); await Promise.resolve(); await Promise.resolve()
        reporter.notification('account/updated', { authMode: 'chatgpt' }); await reporter.refresh()
        expect(results.at(-1)?.windows[0].usedPercent).toBe(66)
        oldResolve(limits(2)); await Promise.resolve(); await Promise.resolve()
        expect(results.at(-1)?.windows[0].usedPercent).toBe(66)
        reporter.stop()
    })
    it('a failed older read cannot erase a newer native event', async () => {
        const results: ProviderCapacity[] = []; let reject!: (error: Error) => void
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : new Promise((_resolve, fail) => { reject = fail }), value => results.push(value))
        reporter.start(); await Promise.resolve(); await Promise.resolve()
        reporter.notification('account/rateLimits/updated', limits(80))
        reject(new Error('old read failed')); await reporter.refresh()
        expect(results.at(-1)).toMatchObject({ status: 'available', windows: [{ usedPercent: 80 }] })
        reporter.stop()
    })
    it('partial Codex events preserve other buckets and explicit null windows remove the changed bucket', async () => {
        const results: ProviderCapacity[] = []
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : {
            rateLimitsByLimitId: { codex: limits(30).rateLimits, other: { limitId: 'other', primary: { usedPercent: 40 } } }
        }, value => results.push(value))
        reporter.start(); await reporter.refresh()
        reporter.notification('account/rateLimits/updated', limits(50))
        expect(results.at(-1)?.windows.map(window => window.usedPercent).sort()).toEqual([40, 50])
        reporter.notification('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: null, secondary: null } })
        expect(results.at(-1)?.windows.map(window => window.id)).toEqual(['other:primary'])
        reporter.stop()
    })
    it('a failing telemetry consumer cannot break native notification processing', async () => {
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : limits(4), () => { throw new Error('consumer closed') })
        expect(() => reporter.start()).not.toThrow(); await reporter.refresh()
        expect(() => reporter.notification('account/rateLimits/updated', limits(5))).not.toThrow()
        reporter.stop()
    })
    it('updating a short bucket ID does not remove a different bucket sharing its prefix', async () => {
        const results: ProviderCapacity[] = []
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : {
            rateLimitsByLimitId: { a: { primary: { usedPercent: 30 } }, 'a:b': { primary: { usedPercent: 40 } } }
        }, value => results.push(value))
        reporter.start(); await reporter.refresh()
        reporter.notification('account/rateLimits/updated', { rateLimits: { limitId: 'a', primary: { usedPercent: 50 } } })
        expect(results.at(-1)?.windows.map(window => window.id).sort()).toEqual(['a:b:primary', 'a:primary'])
        reporter.stop()
    })
    it.each([{}, null, { rateLimits: {} }, { rateLimits: 'invalid' }, { rateLimits: { primary: {} } },
        { rateLimits: { primary: 'invalid' } }, { rateLimits: { primary: { usedPercent: 'invalid', resetsAt: -1 } } },
        { rateLimitsByLimitId: { codex: {} } }, { rateLimitsByLimitId: { codex: null } }])('ignores empty or invalid updates without erasing windows or changing timestamps: %j', async payload => {
        vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000)
        const results: ProviderCapacity[] = []
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : limits(32), value => results.push(value))
        reporter.start(); await reporter.refresh()
        const previous = structuredClone(results.at(-1)), count = results.length
        vi.setSystemTime(2_000_000_030_000)
        reporter.notification('account/rateLimits/updated', payload)
        expect(results).toHaveLength(count)
        expect(results.at(-1)).toEqual(previous)
        reporter.stop()
    })
    it('changes only an explicitly reported window and only explicit null removes a window', async () => {
        vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000)
        const results: ProviderCapacity[] = []
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : {
            rateLimits: { primary: { usedPercent: 20 }, secondary: { usedPercent: 60 } }
        }, value => results.push(value))
        reporter.start(); await reporter.refresh()
        vi.setSystemTime(2_000_000_030_000)
        reporter.notification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 30 }, secondary: {} } })
        expect(results.at(-1)?.windows).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'codex:primary', usedPercent: 30, observedAt: 2_000_000_030_000 }),
            expect.objectContaining({ id: 'codex:secondary', usedPercent: 60, observedAt: 2_000_000_000_000 }),
        ]))
        reporter.notification('account/rateLimits/updated', { rateLimits: { primary: null } })
        expect(results.at(-1)?.windows.map(window => window.id)).toEqual(['codex:secondary'])
        reporter.stop()
    })
    it('an empty partial event does not discard the valid native read already in flight', async () => {
        const results: ProviderCapacity[] = []; let resolve!: (value: unknown) => void
        const reporter = new CodexCapacityReporter(async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : new Promise(done => { resolve = done }), value => results.push(value))
        reporter.start(); await Promise.resolve(); await Promise.resolve()
        reporter.notification('account/rateLimits/updated', { rateLimits: {} })
        resolve(limits(45)); await reporter.refresh()
        expect(results.at(-1)).toMatchObject({ status: 'available', windows: [{ usedPercent: 45 }] })
        reporter.stop()
    })
})
