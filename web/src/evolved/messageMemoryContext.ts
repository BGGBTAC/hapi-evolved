import { createContext, useContext } from 'react'

export const MessageMemoryContext = createContext<((sourceMessageIds: readonly string[]) => void) | null>(null)
export const useMessageMemoryAction = () => useContext(MessageMemoryContext)
