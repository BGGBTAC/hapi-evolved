import { z } from 'zod'
import { evolvedClientFromEnvironment } from './client'
import { inspectRepositories, syncRepository, readRepositoryWorktree, readRepositoryDiff, RepositoryWorkspaceError } from './repositoryWorkspace'
import { RepoDiffRequestSchema } from '@hapi/protocol/evolvedWorkspace'

const owner = z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/)
const name = z.string().regex(/^[a-z0-9_.-]{1,100}$/).refine(value => !['.', '..', '.git'].includes(value))
const repo = z.object({ id: z.string().regex(/^[1-9][0-9]{0,19}$/), owner, name,
    fullName: z.string().max(201), cloneUrl: z.string().max(240), path: z.string().max(4096), permission: z.enum(['read', 'write']) }).strict()
const input = z.discriminatedUnion('action', [
    z.object({ action: z.literal('status'), projectId: z.string().uuid(), repositories: z.array(repo).max(200) }).strict(),
    z.object({ action: z.enum(['clone', 'pull']), projectId: z.string().uuid(), jobId: z.string().uuid(), repository: repo }).strict(),
    z.object({ action: z.literal('worktree'), projectId: z.string().uuid(), repository: repo }).strict(),
    RepoDiffRequestSchema.extend({ action: z.literal('diff'), projectId: z.string().uuid(), repository: repo }).strict(),
])

/** The daemon runs as the project user; this RPC never starts a host/root process. */
export async function repositoryRpc(raw: unknown, machineId: string) {
    const params = input.parse(raw), root = process.env.EVOLVED_RUNNER_ROOT
    if (!root || params.projectId !== process.env.EVOLVED_PROJECT_ID || process.env.HAPI_EVOLVED_PROXY !== '1'
        || root !== `/managed-workspaces/${params.projectId}` && !/^\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(root)
        || process.getuid?.() === 0) throw new Error('Repository operation unavailable in this runner')
    const checked = (repository: z.infer<typeof repo>) => {
        if (repository.fullName !== `${repository.owner}/${repository.name}` || repository.cloneUrl !== `https://github.com/${repository.fullName}.git`
            || repository.path !== `${root}/repositories/${repository.fullName}`) throw new Error('Invalid project repository')
        return repository
    }
    if (params.action === 'status') return inspectRepositories(root, params.repositories.map(checked))
    if (params.action === 'worktree' || params.action === 'diff') {
        const repository = checked(params.repository)
        try {
            return params.action === 'worktree' ? await readRepositoryWorktree(root, repository)
                : await readRepositoryDiff(root, repository, { path: params.path, side: params.side, snapshotId: params.snapshotId })
        } catch (error) {
            const code = error instanceof RepositoryWorkspaceError ? error.code : 'unavailable'
            const codes: Record<string, string> = { changed: 'worktree_changed', busy: 'repository_read_busy', timeout: 'runner_timeout', limit: 'worktree_too_large', invalid_repository: 'invalid_repository', unsafe_path: 'unsafe_path' }
            return { error: { code: codes[code] ?? 'repository_unavailable', message: error instanceof RepositoryWorkspaceError ? error.message : 'Der Repository-Arbeitsstand ist nicht verfügbar.' } }
        }
    }
    if (!['workspace', 'extended'].includes(process.env.EVOLVED_RUNNER_PROFILE ?? '')) throw new Error('Project workspace is read-only')
    const repository = checked(params.repository), client = evolvedClientFromEnvironment()
    const authorize = async () => {
        const reply = await client.request(client.projectPath(`/repositories/${repository.id}/authorization?jobId=${params.jobId}`), 'GET', undefined, {}, { timeoutMs: 10_000 }) as Record<string, unknown>
        const granted = repo.safeParse(reply.repository)
        if (reply.authorized !== true || reply.machineId !== machineId || reply.rootPath !== root || !granted.success
            || granted.data.id !== repository.id || granted.data.fullName !== repository.fullName || granted.data.path !== repository.path || granted.data.cloneUrl !== repository.cloneUrl) throw new Error('Repository authorization changed')
    }
    await authorize()
    try { return { local: await syncRepository(root, repository, params.action, authorize) } }
    catch (error) {
        if (error instanceof RepositoryWorkspaceError) return { local: { state: 'blocked', branch: null, dirty: null, message: error.message } }
        throw error
    }
}
