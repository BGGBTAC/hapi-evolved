import { Hono } from 'hono'
import { CAPACITY_STALE_AFTER_MS, ProviderCapacitySchema, type CapacityReport, type ProjectCapacity, type Session } from '@hapi/protocol'
import type { SyncEngine } from '../sync/syncEngine'
import { EvolvedError, type EvolvedStore } from './store'
import { authenticateEvolvedRequest, createEvolvedRequestGuard, requireHuman, type EvolvedEnv } from './security'

/** Namespace filtering is done before projection; no account correlation across projects. */
export function projectCapacity(projectId: string, sessions: Session[], now: number): ProjectCapacity {
    return { projectId, generatedAt: now, providers: (['claude', 'codex'] as const).map(provider => {
        const reports: CapacityReport[] = []
        for (const session of sessions) {
            if (session.metadata?.flavor !== provider) continue
            const parsed = ProviderCapacitySchema.safeParse(session.agentState?.providerCapacity)
            if (!parsed.success || parsed.data.provider !== provider || parsed.data.source !== (provider === 'claude' ? 'claude-sdk' : 'codex-app-server')) continue
            const value = parsed.data
            // Clock skew must never make an indefinitely fresh snapshot.
            if (value.observedAt > now + 30_000) continue
            const baseStale = !session.active || now - value.observedAt >= CAPACITY_STALE_AFTER_MS
            const windows = value.windows.map(window => ({ ...window,
                // Derived remaining cannot disagree with the reported usage.
                remainingPercent: window.usedPercent === null ? null : Math.round((100 - window.usedPercent) * 10000) / 10000,
                observedAt: window.observedAt ?? value.observedAt,
                stale: baseStale || (window.observedAt ?? value.observedAt) > now + 30_000 || now - (window.observedAt ?? value.observedAt) >= CAPACITY_STALE_AFTER_MS || (window.resetsAt !== null && window.resetsAt <= now),
            }))
            const status = value.status === 'unsupported' ? 'unsupported' : windows.some(window => window.usedPercent !== null) ? 'available' : 'unknown'
            reports.push({ ...value, status, windows, sessionId: session.id,
                stale: baseStale || (windows.length > 0 && windows.every(window => window.stale)),
            })
        }
        reports.sort((a, b) => b.observedAt - a.observedAt)
        return { provider, status: reports.some(report => !report.stale && report.windows.some(window => !window.stale && window.usedPercent !== null)) ? 'available' : reports.length && reports.every(report => report.status === 'unsupported' && !report.stale) ? 'unsupported' : 'unknown', reports }
    }) }
}

export function createCapacityRoutes(store: EvolvedStore, getEngine: () => Pick<SyncEngine, 'getSessionsByNamespace'> | null, origin: string): Hono<EvolvedEnv> {
    const app = new Hono<EvolvedEnv>(), path = '/projects/:id/capacity'
    app.use(path, createEvolvedRequestGuard(origin))
    app.get(path, async c => {
        c.header('cache-control', 'private, no-store')
        const principal = await authenticateEvolvedRequest(c.req.raw, store)
        if (!principal) throw new EvolvedError('unauthorized', 'Sign in required.', 401)
        requireHuman(principal)
        const project = store.requireProject(principal.user.id, c.req.param('id'), 'viewer')
        return c.json(projectCapacity(project.id, getEngine()?.getSessionsByNamespace(project.namespace) ?? [], store.now()))
    })
    return app
}
