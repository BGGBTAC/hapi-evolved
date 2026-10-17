import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { AdapterError, within } from './policy.mjs';

export const lifecycleDefaults = Object.freeze({
    rpcTimeoutMs: 30_000, progressTimeoutMs: 300_000, readyTimeoutMs: 90_000,
    indexTimeoutMs: 3_600_000, backoffMs: 60_000, maxBackoffMs: 900_000, maxPending: 16,
});
const failures = Object.freeze({
    codegraph_worker_out_of_memory: 'Codegraph worker exceeded its memory limit',
    codegraph_worker_failed: 'Codegraph worker stopped unexpectedly',
    codegraph_worker_timeout: 'Codegraph worker stopped responding',
    codegraph_index_timeout: 'Codegraph indexing exceeded its progress deadline',
    codegraph_index_locked: 'Code index is locked; retry indexing shortly',
    codegraph_index_failed: 'Code indexing failed',
});
const phases = new Set(['initializing', 'scanning', 'copying', 'parsing', 'storing', 'resolving', 'linking', 'synchronizing', 'ready', 'error']);
const safeStatusErrors = new Set(['Code index initialization failed', 'Code indexing failed', 'Codegraph workspace synchronization failed']);
const safeReplyErrors = new Set([
    'Code index is not ready', 'Codegraph operation failed', 'Search query must contain 1–500 characters',
    'Provide between 1 and 20 changed files', 'A node is required', 'Node not found', 'File is excluded',
    'File outside project', 'Source file unavailable', 'File outside project or excluded', 'Source changed during read',
    'Source file exceeds preview limit', 'File outside project or excluded', 'Limit must be between 1 and 200', 'Limit must be between 1 and 3',
]);
const count = value => Number.isSafeInteger(value) && value >= 0;
const initialStatus = () => ({ available: false, state: 'indexing', version: '1.6.0', watching: false,
    pendingFiles: 0, lastIndexedAt: null, indexState: 'indexing', watcherDegraded: false, phase: 'initializing' });
function failureCode(error) {
    return error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'codegraph_worker_out_of_memory' : 'codegraph_worker_failed';
}
function failureError(code, status = 503) {
    const error = new AdapterError(failures[code], status); error.code = code; return error;
}
function normalizeStatus(value) {
    if (!value || !['indexing', 'ready', 'error'].includes(value.state) || !phases.has(value.phase)
        || !count(value.pendingFiles) || typeof value.watching !== 'boolean') return null;
    const stats = value.stats && ['nodeCount', 'edgeCount', 'fileCount'].every(key => count(value.stats[key]))
        ? { nodeCount: value.stats.nodeCount, edgeCount: value.stats.edgeCount, fileCount: value.stats.fileCount } : undefined;
    // A ready snapshot must affirm availability and contain actual numeric stats.
    const state = value.state === 'ready' && (value.available !== true || !stats || value.error) ? 'error' : value.state;
    return {
        available: state === 'ready', state, version: '1.6.0', watching: state === 'ready' && value.watching,
        pendingFiles: value.pendingFiles, lastIndexedAt: count(value.lastIndexedAt) ? value.lastIndexedAt : null,
        indexState: state, watcherDegraded: state === 'error' || value.watcherDegraded === true,
        phase: state === 'error' ? 'error' : value.phase,
        ...(stats ? { stats } : {}),
        ...(value.progress && count(value.progress.current) && count(value.progress.total)
            ? { progress: { current: value.progress.current, total: value.progress.total } } : {}),
        ...(state === 'error' ? {
            code: ['codegraph_index_locked', 'codegraph_index_failed'].includes(value.code) ? value.code : 'codegraph_worker_failed',
            error: ['codegraph_index_locked', 'codegraph_index_failed'].includes(value.code) ? failures[value.code]
                : safeStatusErrors.has(value.error) ? value.error : failures.codegraph_worker_failed,
        } : {}),
    };
}

/** Call only while this single-owner service has no live worker for the private index. */
export function reclaimOwnedLock(stateRoot, indexRoot, codegraphDir) {
    if (!within(stateRoot, indexRoot) || !/^\.codegraph-evolved-[A-Za-z0-9_-]{1,80}$/.test(codegraphDir)) throw new AdapterError('Codegraph index directory is not private', 503);
    const directory = join(indexRoot, codegraphDir);
    let path = stateRoot;
    for (const part of relative(stateRoot, directory).split(sep)) {
        path = join(path, part);
        let info;
        try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        if (info.isSymbolicLink() || !info.isDirectory() || !within(stateRoot, realpathSync(path))) throw new AdapterError('Codegraph index directory is not private', 503);
    }
    const lock = join(directory, 'codegraph.lock');
    let descriptor;
    try { descriptor = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    try {
        const before = fstatSync(descriptor);
        if (!before.isFile() || before.nlink !== 1 || before.size > 32) return false;
        const contents = Buffer.alloc(33), bytes = readSync(descriptor, contents, 0, contents.length, 0);
        if (contents.subarray(0, bytes).toString('utf8') !== String(process.pid)) return false;
        const current = lstatSync(lock), after = fstatSync(descriptor);
        if (current.isSymbolicLink() || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev
            || after.size !== bytes || current.size !== bytes || current.nlink !== 1) return false;
        unlinkSync(lock); return true;
    } finally { closeSync(descriptor); }
}

/** Main-thread state and deadlines; factory injection is programmatic, never an HTTP/env worker path. */
export class WorkerLifecycle {
    constructor({ createWorker, maxWorkers = 4, log = record => console.error(JSON.stringify(record)), ...timing }) {
        this.createWorker = createWorker; this.maxWorkers = maxWorkers; this.log = log;
        this.options = { ...lifecycleDefaults, ...timing }; this.entries = new Map(); this.generation = 0; this.closed = false;
        for (const value of [maxWorkers, ...Object.values(this.options)]) {
            if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid Codegraph lifecycle limit');
        }
    }
    diagnostic(entry, code, exitCode) {
        // Never serialize an Error or worker-provided message, path, source, or params.
        this.log({ event: 'codegraph_worker_failure', projectId: entry.projectId, generation: entry.generation, code,
            ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}) });
    }
    current(entry) { return this.entries.get(entry.projectId) === entry && entry.lifecycle === 'running'; }
    rejectPending(entry, error) {
        for (const job of entry.pending.values()) { clearTimeout(job.timer); if (!job.settled) job.reject(error); }
        entry.pending.clear();
    }
    terminate(entry) {
        if (entry.termination) return entry.termination;
        clearTimeout(entry.watchdog);
        entry.termination = Promise.resolve().then(() => entry.worker?.terminate())
            .then(() => { entry.stopped = true; }, () => { entry.termination = null; });
        return entry.termination;
    }
    fail(entry, code, exitCode) {
        if (!this.current(entry)) return;
        entry.lifecycle = 'failed'; entry.failures++;
        entry.retryAt = Date.now() + Math.min(this.options.maxBackoffMs, this.options.backoffMs * 2 ** Math.min(entry.failures - 1, 20));
        entry.snapshot = { ...entry.snapshot, available: false, state: 'error', indexState: 'error', phase: 'error',
            watching: false, watcherDegraded: true, code, error: failures[code] };
        this.diagnostic(entry, code, exitCode);
        this.rejectPending(entry, failureError(code));
        void this.terminate(entry);
    }
    schedule(entry) {
        clearTimeout(entry.watchdog);
        if (!this.current(entry)) return;
        const indexing = entry.snapshot.state === 'indexing';
        const deadline = indexing
            ? Math.min(entry.lastProgress + this.options.progressTimeoutMs, entry.indexStarted + this.options.indexTimeoutMs)
            : entry.lastMessage + this.options.readyTimeoutMs;
        entry.watchdog = setTimeout(() => this.fail(entry, indexing ? 'codegraph_index_timeout' : 'codegraph_worker_timeout'), Math.max(1, deadline - Date.now()));
        entry.watchdog.unref?.();
    }
    start(projectId, root, previous) {
        const now = Date.now();
        const entry = { projectId, root, generation: ++this.generation, lifecycle: 'running', pending: new Map(),
            snapshot: initialStatus(), failures: previous?.failures ?? 0, stopped: false,
            lastMessage: now, lastProgress: now, indexStarted: now };
        this.entries.set(projectId, entry);
        try {
            entry.worker = this.createWorker({ projectId, root, generation: entry.generation });
            entry.worker.on('message', message => {
                if (!this.current(entry) || !message || typeof message !== 'object') return;
                if (message.type === 'status') {
                    const snapshot = normalizeStatus(message.status);
                    if (!snapshot) { this.fail(entry, 'codegraph_worker_failed'); return; }
                    const before = entry.snapshot;
                    entry.lastMessage = Date.now();
                    if (snapshot.state === 'indexing' && before.state !== 'indexing') entry.indexStarted = entry.lastMessage;
                    if (before.state !== snapshot.state || before.phase !== snapshot.phase
                        || before.progress?.current !== snapshot.progress?.current || before.progress?.total !== snapshot.progress?.total) entry.lastProgress = entry.lastMessage;
                    entry.snapshot = snapshot;
                    if (snapshot.state === 'error' && before.state !== 'error') this.diagnostic(entry, snapshot.code);
                    this.schedule(entry); return;
                }
                const job = entry.pending.get(message.id); if (!job) return;
                entry.lastMessage = Date.now(); this.schedule(entry);
                clearTimeout(job.timer); entry.pending.delete(message.id);
                if (job.settled) return;
                if (message.error) job.reject(new AdapterError(safeReplyErrors.has(message.error) ? message.error : 'Codegraph operation failed',
                    [400, 403, 404, 409, 413, 429, 500, 503].includes(message.status) ? message.status : 500));
                else job.resolve(message.result);
            });
            entry.worker.on('error', error => this.fail(entry, failureCode(error)));
            entry.worker.on('exit', code => { entry.stopped = true; this.fail(entry, 'codegraph_worker_failed', code); });
            this.schedule(entry);
        } catch (error) { this.fail(entry, failureCode(error)); }
        return entry;
    }
    async query(projectId, root, operation, params) {
        if (this.closed) throw new AdapterError('Codegraph service is stopping', 503);
        let entry = this.entries.get(projectId), created = false;
        if (entry && entry.root !== root) throw new AdapterError('Project root changed; restart adapter to switch it', 409);
        if (!entry) {
            if (this.entries.size >= this.maxWorkers) throw new AdapterError('Codegraph project capacity reached', 503);
            entry = this.start(projectId, root); created = true;
        }
        if (entry.lifecycle === 'failed' && operation === 'reindex' && entry.stopped && Date.now() >= entry.retryAt) {
            entry = this.start(projectId, root, entry); created = true;
        }
        if (operation === 'status') return { ...entry.snapshot,
            ...(entry.lifecycle === 'failed' ? { retryAfterMs: Math.max(0, entry.retryAt - Date.now()) } : {}) };
        if (entry.lifecycle !== 'running') {
            const error = failureError(entry.snapshot.code ?? 'codegraph_worker_failed');
            error.retryAfterMs = Math.max(0, (entry.retryAt ?? Date.now()) - Date.now());
            if (operation === 'reindex') error.message = error.retryAfterMs > 0
                ? `Codegraph restart is temporarily blocked; retry indexing in ${Math.ceil(error.retryAfterMs / 1000)} seconds`
                : 'Codegraph worker is still stopping; retry indexing shortly';
            throw error;
        }
        // A fresh worker is already initializing. Do not dispatch a duplicate mutation.
        if (created && operation === 'reindex') return { accepted: true, state: 'indexing' };
        if (entry.pending.size >= this.options.maxPending) throw new AdapterError('Codegraph busy', 429);
        return new Promise((resolve, reject) => {
            const id = randomUUID(); const job = { resolve, reject, settled: false };
            job.timer = setTimeout(() => {
                job.settled = true;
                const error = failureError('codegraph_worker_timeout', 504);
                this.diagnostic(entry, error.code); reject(error);
                // Keep the occupied slot until its late reply or worker termination.
                // Dropping it would permit an unbounded queue behind a blocked worker.
            }, this.options.rpcTimeoutMs);
            entry.pending.set(id, job);
            try { entry.worker.postMessage({ id, operation, params }); }
            catch (error) { this.fail(entry, failureCode(error)); }
        });
    }
    async drop(projectId) {
        const entry = this.entries.get(projectId); if (!entry) return;
        entry.lifecycle = 'stopping'; this.rejectPending(entry, new AdapterError('Project was deleted', 410));
        await this.terminate(entry);
        if (!entry.stopped) throw failureError('codegraph_worker_failed');
        if (this.entries.get(projectId) === entry) this.entries.delete(projectId);
    }
    async close() {
        this.closed = true;
        await Promise.all([...this.entries.keys()].map(projectId => this.drop(projectId)));
    }
}
