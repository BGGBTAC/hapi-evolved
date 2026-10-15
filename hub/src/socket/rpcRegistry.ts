import type { Socket } from 'socket.io'

export type RpcTargetKind = 'session' | 'machine'
export type RpcRegistrationAuthority = { kind: RpcTargetKind; id: string; valid: () => boolean }
export type RpcRegistration = { readonly socketId: string; readonly authority: RpcRegistrationAuthority }
const MAX_METHODS_PER_SOCKET = 256

export class RpcRegistry {
    private readonly methodToSocketId: Map<string, RpcRegistration> = new Map()
    private readonly socketIdToMethods: Map<string, Set<string>> = new Map()

    register(socket: Socket, method: string, authority: RpcRegistrationAuthority): void {
        if (!method || !this.authorized(authority)) {
            return
        }

        const key = JSON.stringify([authority.kind, authority.id, method])
        const existing = this.socketIdToMethods.get(socket.id)
        if (!existing?.has(key) && (existing?.size ?? 0) >= MAX_METHODS_PER_SOCKET) return
        const previous = this.methodToSocketId.get(key)
        // A declarative duplicate is not a new connection/generation. Keep
        // pending replies valid; explicit unregister/register still replaces it.
        if (previous?.socketId === socket.id && previous.authority.id === authority.id) return
        if (previous && previous.socketId !== socket.id) {
            const previousMethods = this.socketIdToMethods.get(previous.socketId)
            previousMethods?.delete(key)
            if (previousMethods?.size === 0) this.socketIdToMethods.delete(previous.socketId)
        }
        this.methodToSocketId.set(key, { socketId: socket.id, authority })

        if (existing) {
            existing.add(key)
        } else {
            this.socketIdToMethods.set(socket.id, new Set([key]))
        }
    }

    unregister(socket: Socket, method: string, kind: RpcTargetKind, targetId = method.slice(0, method.indexOf(':'))): void {
        const key = JSON.stringify([kind, targetId, method])
        const entry = this.methodToSocketId.get(key)
        if (entry?.socketId === socket.id) {
            this.methodToSocketId.delete(key)
        }

        const methods = this.socketIdToMethods.get(socket.id)
        if (methods) {
            methods.delete(key)
            if (methods.size === 0) {
                this.socketIdToMethods.delete(socket.id)
            }
        }
    }

    unregisterAll(socket: Socket): void {
        const methods = this.socketIdToMethods.get(socket.id)
        if (!methods) {
            return
        }
        for (const method of methods) {
            const entry = this.methodToSocketId.get(method)
            if (entry?.socketId === socket.id) {
                this.methodToSocketId.delete(method)
            }
        }
        this.socketIdToMethods.delete(socket.id)
    }

    getSocketIdForMethod(method: string, kind: RpcTargetKind): string | null {
        return this.getRegistration(method, kind, method.slice(0, method.indexOf(':')))?.socketId ?? null
    }

    getRegistration(method: string, kind: RpcTargetKind, targetId: string): RpcRegistration | null {
        const key = JSON.stringify([kind, targetId, method])
        const entry = this.methodToSocketId.get(key)
        if (!entry) return null
        // RPC method names may contain colons; concatenation must never turn an
        // authorized target "a" into authority for a different target "a:b".
        if (entry.authority.id !== targetId) return null
        if (this.authorized(entry.authority)) return entry
        this.methodToSocketId.delete(key)
        const methods = this.socketIdToMethods.get(entry.socketId)
        methods?.delete(key)
        if (methods?.size === 0) this.socketIdToMethods.delete(entry.socketId)
        return null
    }

    private authorized(authority: RpcRegistrationAuthority): boolean {
        try { return authority.valid() } catch { return false }
    }
}
