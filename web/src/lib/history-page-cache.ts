import type { MessagesResponse } from '@/types/api'

/** Memory-only, bounded and owned by the current authenticated API instance. */
export class HistoryPageCache {
    private entries = new Map<string, { sessionId: string; owner: object; response: MessagesResponse; bytes: number }>()
    private bytes = 0
    constructor(private maxPages = 24, private maxBytes = 8 * 1024 * 1024) {}
    private key(sessionId: string, epoch: number, at: number, seq: number): string {
        return JSON.stringify([sessionId, epoch, at, seq])
    }
    get(owner: object, sessionId: string, epoch: number | null, at: number, seq: number): MessagesResponse | undefined {
        if (epoch === null) return undefined
        const key = this.key(sessionId, epoch, at, seq)
        const entry = this.entries.get(key)
        if (!entry || entry.owner !== owner) return undefined
        this.entries.delete(key); this.entries.set(key, entry)
        return entry.response
    }
    put(owner: object, sessionId: string, epoch: number | null, at: number, seq: number, response: MessagesResponse): void {
        if (epoch === null || response.page.epoch !== epoch) return
        const bytes = JSON.stringify(response).length * 2
        if (bytes > this.maxBytes) return
        const key = this.key(sessionId, epoch, at, seq)
        const old = this.entries.get(key)
        if (old) { this.bytes -= old.bytes; this.entries.delete(key) }
        this.entries.set(key, { sessionId, owner, response, bytes }); this.bytes += bytes
        while (this.entries.size > this.maxPages || this.bytes > this.maxBytes) {
            const first = this.entries.keys().next().value!
            this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first)
        }
    }
    clear(sessionId?: string): void {
        for (const [key, entry] of this.entries) {
            if (sessionId === undefined || entry.sessionId === sessionId) {
                this.bytes -= entry.bytes; this.entries.delete(key)
            }
        }
    }
}
