export type ProjectRole = 'admin' | 'member' | 'viewer'
export type ExecutionProfile = 'restricted' | 'workspace' | 'extended'
export type EvolvedProject = {
    id: string
    teamId: string
    name: string
    role: ProjectRole
    profile: ExecutionProfile
    rootPath?: string | null
}
export type EvolvedMe = {
    user: { id: string; displayName: string; isAdmin: boolean }
    accessibleProjects: EvolvedProject[]
}
export type Team = { id: string; name: string; role: ProjectRole }
export type TeamMember = { userId: string; displayName: string; role: ProjectRole; override?: ProjectRole | null }
export type SecretMetadata = { id: string; name: string; version: number; createdAt: number | string; updatedAt: number | string }
export type Resource = { id: string; name: string; type: string; actions: string[] }
export type MemorySource = { kind: 'chat' | 'code' | 'attachment' | 'manual'; path?: string; commit?: string; hash?: string; sessionId?: string; messageId?: string; origin?: string }
export type MemoryItem = { id: string; projectId: string; title: string; body: string; status: 'proposed' | 'verified'; createdAt: number | string; sources: MemorySource[]; score?: number }
export type MemorySettings = { enabled: boolean; cloudAllowed: boolean; monthlyBudgetMicros: number; jobBudgetMicros: number }
export type MemoryResponse = {
    items: MemoryItem[]
    settings: MemorySettings
    budget: { spentMicros: number; reservedMicros: number; limitMicros: number; period: string }
    backend: { available: boolean; error?: string }
}
export type CodeNode = { id: string; name: string; kind: string; file: string; line: number; endLine?: number }
export type CodeEdge = { source: string; target: string; kind: string }
export type CodeGraph = { nodes: CodeNode[]; edges: CodeEdge[]; truncated?: boolean }
export type CodeStatus = {
    available: boolean
    state: 'unconfigured' | 'indexing' | 'ready' | 'error'
    watching: boolean
    pendingFiles: number
    stats?: Record<string, number>
    version?: string
    error?: string
}
export type CodeDetail = { node: CodeNode; source: string; callers: CodeNode[]; callees: CodeNode[] }

export class EvolvedApiError extends Error {
    constructor(message: string, public readonly status: number, public readonly code?: string) {
        super(message)
        this.name = 'EvolvedApiError'
    }
}

export function hubUrl(baseUrl: string, path: string): string {
    return baseUrl ? new URL(path, baseUrl).toString() : path
}

export class EvolvedApi {
    private stepUp: (() => Promise<void>) | null = null
    setStepUpHandler(handler: (() => Promise<void>) | null): void { this.stepUp = handler }
    constructor(public readonly baseUrl: string) {}

    async request<T>(path: string, options: {
        method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
        body?: unknown
        signal?: AbortSignal
        idempotencyKey?: string
    } = {}, retryAfterStepUp = true): Promise<T> {
        const headers = new Headers({ Accept: 'application/json' })
        if (options.body !== undefined) headers.set('Content-Type', 'application/json')
        if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey)
        const response = await fetch(hubUrl(this.baseUrl, `/api/evolved${path}`), {
            method: options.method ?? 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: options.signal,
        })
        const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
        if (!response.ok) {
            const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {}
            if (payload.code === 'step_up_required' && retryAfterStepUp && this.stepUp) {
                await this.stepUp()
                return this.request<T>(path, options, false)
            }
            throw new EvolvedApiError(
                typeof payload.error === 'string' ? payload.error : `Anfrage fehlgeschlagen (${response.status}).`,
                response.status,
                typeof payload.code === 'string' ? payload.code : undefined,
            )
        }
        return body as T
    }
}

export function projectPath(id: string): string {
    return `/projects/${encodeURIComponent(id)}`
}
export function isProjectAdmin(role?: ProjectRole): boolean {
    return role === 'admin'
}
export function canWriteProject(role?: ProjectRole): boolean {
    return !!role && role !== 'viewer'
}
