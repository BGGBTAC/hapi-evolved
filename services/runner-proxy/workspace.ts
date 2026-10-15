/** Container paths are fixed mounts, never user-selected host paths. */
export function validRunnerRoot(root: string, projectId: string): boolean {
    return /^\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(root)
        || (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId)
            && root === `/managed-workspaces/${projectId}`)
}
