import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { usePwaUpdate } from '@/hooks/usePwaUpdate'

type PwaUpdateContextValue = ReturnType<typeof usePwaUpdate> & {
    hasTopStatusBanner: boolean
    setHasTopStatusBanner: (visible: boolean) => void
}

const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null)

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
    const update = usePwaUpdate()
    const [hasTopStatusBanner, setHasTopStatusBanner] = useState(false)
    const value = useMemo(() => ({ ...update, hasTopStatusBanner, setHasTopStatusBanner }), [update.needRefresh, update.reload, hasTopStatusBanner])

    return (
        <PwaUpdateContext.Provider value={value}>
            {children}
        </PwaUpdateContext.Provider>
    )
}

export function usePwaUpdateContext() {
    const value = useContext(PwaUpdateContext)
    if (!value) {
        throw new Error('usePwaUpdateContext must be used within PwaUpdateProvider')
    }
    return value
}
