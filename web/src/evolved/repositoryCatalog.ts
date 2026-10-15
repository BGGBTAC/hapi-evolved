import { useQuery } from '@tanstack/react-query'
import { RepositoryCatalogSchema, type RepositoryCatalog } from '@hapi/protocol/evolvedWorkspace'
export type { RepositoryCatalog } from '@hapi/protocol/evolvedWorkspace'
import type { EvolvedSession } from './auth'
import { projectPath } from './api'


export function useProjectRepositories(evolved: Pick<EvolvedSession, 'api' | 'me' | 'project'> | null, enabled = true) {
    const project = evolved?.project
    const query = useQuery({
        queryKey: ['evolved', 'repository-choices', evolved?.api.baseUrl, evolved?.me.user.id, project?.id, project?.role, project?.profile],
        enabled: enabled && !!project,
        retry: false, gcTime: 0,
        queryFn: async ({ signal }) => RepositoryCatalogSchema.parse(await evolved!.api.request(`${projectPath(project!.id)}/repositories`, { signal })),
    })
    return { ...query, current: !query.error && enabled ? query.data : undefined }
}
export type RepositoryChoices = ReturnType<typeof useProjectRepositories>
