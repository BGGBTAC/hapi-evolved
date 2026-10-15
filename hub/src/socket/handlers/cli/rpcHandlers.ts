import { z } from 'zod'
import type { RpcRegistry, RpcTargetKind } from '../../rpcRegistry'
import type { CliSocketWithData } from '../../socketTypes'

const rpcRegisterSchema = z.object({
    method: z.string().min(1).max(512).refine(value => Buffer.byteLength(value) <= 512 && !/[\s\p{C}]/u.test(value))
})

const rpcUnregisterSchema = z.object({
    method: z.string().min(1).max(512).refine(value => Buffer.byteLength(value) <= 512 && !/[\s\p{C}]/u.test(value))
})

export function registerRpcHandlers(socket: CliSocketWithData, rpcRegistry: RpcRegistry, deps: {
    authorizeTarget: (kind: RpcTargetKind, id: string) => boolean
}): void {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const kind = auth?.clientType === 'machine-scoped' ? 'machine' : auth?.clientType === 'session-scoped' ? 'session' : null
    const id = kind === 'machine' ? auth?.machineId : kind === 'session' ? auth?.sessionId : null
    const prefix = typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 128 && !/[:\s\p{C}]/u.test(id) ? `${id}:` : null
    const inScope = (method: string) => !!kind && !!prefix && method.startsWith(prefix) && method.length > prefix.length
    const valid = () => {
        try { return !!kind && typeof id === 'string' && deps.authorizeTarget(kind, id) } catch { return false }
    }

    socket.on('rpc-register', (data: unknown) => {
        const parsed = rpcRegisterSchema.safeParse(data)
        if (!parsed.success || !kind || typeof id !== 'string' || !inScope(parsed.data.method) || !valid()) {
            return
        }
        rpcRegistry.register(socket, parsed.data.method, { kind, id, valid })
    })

    socket.on('rpc-unregister', (data: unknown) => {
        const parsed = rpcUnregisterSchema.safeParse(data)
        if (!parsed.success || !kind || typeof id !== 'string' || !inScope(parsed.data.method)) {
            return
        }
        rpcRegistry.unregister(socket, parsed.data.method, kind, id)
    })
}
