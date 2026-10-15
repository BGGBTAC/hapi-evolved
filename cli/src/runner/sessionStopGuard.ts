/** Stops may outlive a native root's re-registration in the same wrapper PID. */
export class SessionReboundDuringStop extends Error {
    constructor() { super('Session registered again during stop'); }
}

export class SessionStopGuard {
    constructor(readonly generation?: string) {}
    private invalidated = false;

    invalidate(): void { this.invalidated = true; }

    check(): void {
        if (this.invalidated) throw new SessionReboundDuringStop();
    }

    async run<T>(work: () => Promise<T>): Promise<T> {
        this.check();
        const result = await work();
        this.check();
        return result;
    }
}

/** Only holds active stop requests, not a permanent map of historical roots. */
export class SessionStopGuards {
    private readonly active = new Map<string, Set<SessionStopGuard>>();

    isStoppingGeneration(sessionId: string, generation: string | undefined): boolean {
        return Boolean(generation && [...this.active.get(sessionId) ?? []].some(guard => guard.generation === generation));
    }

    registered(sessionId: string): void {
        for (const guard of this.active.get(sessionId) ?? []) guard.invalidate();
    }

    async during<T>(sessionId: string, work: (guard: SessionStopGuard) => Promise<T>, generation?: string): Promise<T> {
        const guard = new SessionStopGuard(generation);
        const guards = this.active.get(sessionId) ?? new Set<SessionStopGuard>();
        guards.add(guard);
        this.active.set(sessionId, guards);
        try { return await work(guard); }
        finally {
            guards.delete(guard);
            if (guards.size === 0) this.active.delete(sessionId);
        }
    }
}
