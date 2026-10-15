import { archiveEvolvedPeer, isEvolvedPeerMode, spawnEvolvedPeer } from '@/modules/pingPeer/evolvedPeer'
import type { CommandDefinition } from './types'

export const spawnPeerCommand: CommandDefinition = {
    name: 'spawn-peer', requiresRuntimeAssets: false,
    run: async ({ commandArgs: args }) => {
        if (!isEvolvedPeerMode()) throw new Error('spawn-peer requires a configured Evolved project runner.')
        const idIndex = args.indexOf('--operation-id')
        const operationId = idIndex >= 0 ? args[idIndex + 1] : undefined
        if (!operationId) throw new Error('A stable --operation-id ID is required. Reuse the same ID and arguments on retries.')
        const remit = args.filter((_, index) => index !== idIndex && index !== idIndex + 1).join(' ').trim()
        if (!remit) throw new Error('Usage: hapi spawn-peer --operation-id ID <remit>. Use MCP spawn_peer for agent/directory/operationId options.')
        console.log(JSON.stringify(await spawnEvolvedPeer({ remit, operationId })))
    }
}
export const archivePeerCommand: CommandDefinition = {
    name: 'archive-peer', requiresRuntimeAssets: false,
    run: async ({ commandArgs: args }) => {
        if (!isEvolvedPeerMode()) throw new Error('archive-peer requires a configured Evolved project runner.')
        const idIndex = args.indexOf('--operation-id')
        const operationId = idIndex >= 0 ? args[idIndex + 1] : undefined
        const targets = args.filter((_, index) => index !== idIndex && index !== idIndex + 1)
        if (!operationId || targets.length !== 1) throw new Error('Usage: hapi archive-peer --operation-id ID <peer-worker-session-id>; reuse the ID on retries.')
        console.log(JSON.stringify(await archiveEvolvedPeer({ sessionId: targets[0]!, operationId })))
    }
}
