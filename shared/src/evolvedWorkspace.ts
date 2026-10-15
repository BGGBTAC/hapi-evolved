import { z } from 'zod'

export const RepositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/)
export const RepoFileStatusSchema = z.object({
    path: z.string().max(4096), oldPath: z.string().max(4096).optional(),
    display: z.string().max(4096).optional(), pathRef: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    index: z.enum(['M', 'A', 'D', 'R', 'C', 'U', '?', ' ', 'T', '!']),
    worktree: z.enum(['M', 'A', 'D', 'R', 'C', 'U', '?', ' ', 'T', '!']),
    kind: z.enum(['file', 'symlink', 'submodule', 'unknown']),
    excluded: z.enum(['sensitive_path', 'unrepresentable']).optional(),
}).strict()
export const RepoWorktreeSchema = z.object({
    repositoryId: RepositoryIdSchema, state: z.enum(['ready', 'missing', 'blocked', 'syncing', 'unknown']),
    message: z.string().max(500).optional(), branch: z.string().max(1024).nullable(),
    detached: z.boolean(), head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
    upstream: z.object({ name: z.string().max(1024), ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative() }).strict().nullable().optional(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/).nullable(), observedAt: z.number().int().nonnegative(),
    files: z.array(RepoFileStatusSchema).max(2000), truncated: z.boolean(), totalFiles: z.number().int().nonnegative().optional(),
}).strict()
export const RepoDiffRequestSchema = z.object({ snapshotId: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1).max(1024), side: z.enum(['staged', 'unstaged']) }).strict()
export const RepoDiffSchema = z.object({
    path: z.string().max(1024), oldPath: z.string().max(1024).optional(), side: z.enum(['staged', 'unstaged']),
    patch: z.string().max(262144).nullable(), binary: z.boolean(), truncated: z.boolean(),
    withheld: z.enum(['sensitive_path', 'credential_pattern', 'untracked', 'unsupported']).optional(),
    observedAt: z.number().int().nonnegative(),
}).strict()
export const RepoImpactRequestSchema = z.object({ snapshotId: z.string().regex(/^[a-f0-9]{64}$/), paths: z.array(z.string().min(1).max(1024)).min(1).max(200) }).strict()
export type RepoFileStatus = z.infer<typeof RepoFileStatusSchema>
export type RepoWorktree = z.infer<typeof RepoWorktreeSchema>
export type RepoDiffRequest = z.infer<typeof RepoDiffRequestSchema>
export type RepoDiff = z.infer<typeof RepoDiffSchema>
export type RepoImpactRequest = z.infer<typeof RepoImpactRequestSchema>
export type RepoImpact = {
    snapshotId: string
    index: { state: string; lastIndexedAt: number | null; pendingFiles: number | null; stale: boolean }
    queried: string[]
    skipped: Array<{ path: string; reason: 'deleted' | 'sensitive' | 'not_indexed' | 'omitted' | 'unsupported' }>
    graph: { nodes: Array<{ id: string; name: string; kind: string; file: string; line: number; endLine?: number }>; edges: Array<{ source: string; target: string; kind: string }>; truncated?: boolean }
    candidateTests: Array<{ path: string; reason: 'filename_pattern' }>
}
export type ReadinessState = 'ok' | 'missing' | 'stale' | 'denied' | 'unknown'
export type ProjectReadiness = {
    projectId: string; checkedAt: number
    purposes: { plan: ReadinessState; code: ReadinessState }
    items: Array<{ key: string; label: string; state: ReadinessState; reasonCode: string; detail: string; action?: { kind: 'providers' | 'github' | 'runner' | 'codegraph' | 'memory' | 'projects'; label: string } }>
}

export const RepositoryCatalogSchema = z.object({
    connected: z.boolean(), rootPath: z.string().max(4096).nullable(), canSync: z.boolean(), canPush: z.boolean(),
    runner: z.object({ status: z.enum(['ready', 'offline', 'upgrade_required', 'ambiguous']) }),
    repositories: z.array(z.object({
        id: RepositoryIdSchema, owner: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/), name: z.string().regex(/^[a-z0-9_.-]{1,100}$/).refine(value => !['.', '..', '.git'].includes(value)), fullName: z.string().max(201), permission: z.enum(['read', 'write']),
        path: z.string().max(4096), cloneUrl: z.string().max(240),
        local: z.object({ state: z.enum(['ready', 'missing', 'blocked', 'unknown']), branch: z.string().max(1024).nullable(), dirty: z.boolean().nullable(), message: z.string().max(500).optional() }),
        job: z.object({ id: z.string().max(200), state: z.enum(['running', 'succeeded', 'failed']) }).optional(),
    })).max(200),
}).refine(value => value.repositories.every(repository => value.rootPath !== null
    && repository.fullName === `${repository.owner}/${repository.name}`
    && repository.path === `${value.rootPath}/repositories/${repository.fullName}`
    && repository.cloneUrl === `https://github.com/${repository.fullName}.git`), 'Invalid project repository identity')
export type RepositoryCatalog = z.infer<typeof RepositoryCatalogSchema>
