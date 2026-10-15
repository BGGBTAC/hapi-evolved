import { createContext, useContext, useState, type ReactNode } from 'react'

export type RepositoryReview = { repositoryId: string; snapshotId: string; paths: string[] }
type Workflow = {
    repositoryId: string | null
    setRepositoryId: (id: string | null) => void
    review: RepositoryReview | null
    setReview: (review: RepositoryReview | null) => void
    nodeId: string | null
    setNodeId: (id: string | null) => void
}
const Context = createContext<Workflow | null>(null)
export const useProjectWorkflow = () => useContext(Context)
// Mounted above tab changes, keyed by the complete human/project authority scope.
// Contains only a temporary selection; never serializes paths, source or prompts.
export function ProjectWorkflowProvider({ children }: { children: ReactNode }) {
    const [repositoryId, setRepositoryId] = useState<string | null>(null)
    const [review, setReview] = useState<RepositoryReview | null>(null)
    const [nodeId, setNodeId] = useState<string | null>(null)
    return <Context.Provider value={{ repositoryId, setRepositoryId, review, setReview, nodeId, setNodeId }}>{children}</Context.Provider>
}
