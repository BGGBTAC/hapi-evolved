import { createServer } from 'node:http';
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { mkdir, realpath, writeFile, access, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AdapterError, canonicalRoot, within } from './policy.mjs';
import { reclaimOwnedLock, WorkerLifecycle } from './lifecycle.mjs';

// Set before starting workers/loading Codegraph. No telemetry or update/download traffic.
Object.assign(process.env, { DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1',
    CODEGRAPH_PARSE_WORKERS: '1', CODEGRAPH_RESOLVE_WORKERS: '0', CODEGRAPH_NO_FAST_INIT: '1' });

function containedPath(directory, name) {
    const path = resolve(directory, name);
    if (path === directory || !path.startsWith(join(directory, sep))) throw new Error('Configured path escapes its directory');
    return path;
}

/** Operator configuration only; HTTP input cannot replace the state or credential directory. */
function canonicalConfigurationPath(value) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.includes('\\')
        || value.split('/').some(part => part === '.' || part === '..')) throw new Error('Configured paths must be absolute without traversal components');
    let existing = resolve(value);
    if (existing === sep) throw new Error('Configured path must not be the filesystem root');
    const missing = [];
    let canonical;
    for (;;) {
        try { canonical = realpathSync(existing); break; }
        catch (error) {
            if (error.code !== 'ENOENT' || dirname(existing) === existing) throw error;
            if (lstatSync(containedPath(dirname(existing), basename(existing)), { throwIfNoEntry: false })?.isSymbolicLink()) {
                throw new Error('Configured paths must not contain unresolved symbolic links');
            }
            missing.unshift(basename(existing)); existing = dirname(existing);
        }
    }
    for (const part of missing) canonical = containedPath(canonical, part);
    // The existing ancestor may itself be a configured symlink. Bind subsequent
    // accesses to its canonical parent, retaining custom absolute operator paths.
    return containedPath(dirname(canonical), basename(canonical));
}

export function readServiceTokenFile(configuredPath) {
    const path = canonicalConfigurationPath(configuredPath);
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.size > 4096) throw new Error('Service token file must be a regular file of at most 4096 bytes');
        const buffer = Buffer.alloc(4097);
        let size = 0;
        while (size < buffer.length) {
            const bytes = readSync(descriptor, buffer, size, buffer.length - size, size);
            if (!bytes) break;
            size += bytes;
        }
        if (size > 4096) throw new Error('Service token file exceeds 4096 bytes');
        return buffer.subarray(0, size).toString('utf8').trim();
    } finally { closeSync(descriptor); }
}

export async function createCodegraphService({ token, roots, stateRoot, maxWorkers = 4, createWorker, log, lifecycle = {} }) {
    if (!token || token.length < 32) throw new Error('EVOLVED_SERVICE_TOKEN must contain at least 32 characters');
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new Error('EVOLVED_CODE_ROOTS must be a JSON string array');
    const canonicalState = canonicalConfigurationPath(stateRoot);
    for (const root of roots) {
        const canonicalSource = await realpath(root);
        if (within(canonicalSource, canonicalState) || within(canonicalState, canonicalSource)) {
            throw new Error('Codegraph state must be separate from source workspaces');
        }
    }
    // Reject overlap and escaped private subdirectories before creating anything.
    const directories = ['projects', 'deleted'].map(name => canonicalConfigurationPath(containedPath(canonicalState, name)));
    for (const directory of directories) {
        if (!directory.startsWith(join(canonicalState, sep))) throw new Error('Codegraph private directories must remain inside its state directory');
    }
    for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
    const workers = new WorkerLifecycle({ maxWorkers, log, ...lifecycle,
        createWorker: ({ projectId, root, generation }) => {
            const indexRoot = join(canonicalState, 'projects', projectId, 'workspace'), codegraphDir = `.codegraph-evolved-${projectId}`;
            reclaimOwnedLock(canonicalState, indexRoot, codegraphDir);
            const options = { workerData: { root, indexRoot }, env: { ...process.env, CODEGRAPH_DIR: codegraphDir },
                resourceLimits: { maxOldGenerationSizeMb: 512 }, stdout: true, stderr: true };
            const worker = createWorker ? createWorker({ projectId, root, generation, indexRoot, codegraphDir, options })
                : new Worker(new URL('./worker.mjs', import.meta.url), options);
            // SDK diagnostics can contain private paths or source fragments. Only
            // the supervisor's allowlisted diagnostics reach the operator log.
            worker.stdout?.resume(); worker.stderr?.resume();
            return worker;
        },
    });
    const deletedProjects = new Set();
    function authenticated(request) {
        const actual = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
        try {
            if (!authenticated(request)) throw new AdapterError('Unauthorized', 401);
            if (request.url === '/health') { response.end(JSON.stringify({ ok: true, version: '1.6.0', projects: workers.entries.size })); return; }
            if (request.method !== 'POST' || request.url !== '/query') throw new AdapterError('Not found', 404);
            let size = 0; const chunks = [];
            for await (const chunk of request) { size += chunk.length; if (size > 32_768) throw new AdapterError('Request too large', 413); chunks.push(chunk); }
            let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AdapterError('Invalid JSON'); }
            if (!input || typeof input !== 'object') throw new AdapterError('Invalid request');
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.projectId ?? '')) throw new AdapterError('Invalid project ID');
            if (!['status', 'reindex', 'search', 'node', 'graph', 'impact', 'affected', 'drop'].includes(input.operation)) throw new AdapterError('Unknown operation');
            const marker = join(canonicalState, 'deleted', input.projectId);
            if (input.operation === 'drop') {
                deletedProjects.add(input.projectId);
                await writeFile(marker, 'deleted\n', { mode: 0o600 });
                await workers.drop(input.projectId);
                await rm(join(canonicalState, 'projects', input.projectId), { recursive: true, force: true });
                response.end(JSON.stringify({ deleted: true })); return;
            }
            if (deletedProjects.has(input.projectId) || await access(marker).then(() => true, () => false)) throw new AdapterError('Project was deleted', 410);
            const root = await canonicalRoot(input.root, roots);
            // A deletion can complete while canonicalization yields. Never recreate its worker.
            if (deletedProjects.has(input.projectId)) throw new AdapterError('Project was deleted', 410);
            const result = await workers.query(input.projectId, root, input.operation, input.params ?? {});
            response.end(JSON.stringify(result));
        } catch (error) {
            response.statusCode = error instanceof AdapterError ? error.status : 500;
            response.end(JSON.stringify({ error: error instanceof AdapterError ? error.message : 'Codegraph adapter failed',
                ...(error instanceof AdapterError && error.code ? { code: error.code } : {}),
                ...(error instanceof AdapterError && Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) }));
        }
    });
    server.requestTimeout = 35_000;
    const close = async () => {
        const stopped = new Promise(resolve => server.close(resolve));
        await workers.close(); server.closeIdleConnections(); await stopped;
    };
    return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const token = process.env.EVOLVED_SERVICE_TOKEN_FILE ? readServiceTokenFile(process.env.EVOLVED_SERVICE_TOKEN_FILE) : process.env.EVOLVED_SERVICE_TOKEN;
    const service = await createCodegraphService({ token, roots: JSON.parse(process.env.EVOLVED_CODE_ROOTS ?? '[]'),
        stateRoot: process.env.EVOLVED_CODEGRAPH_STATE_DIR ?? '/data', maxWorkers: Number(process.env.EVOLVED_CODEGRAPH_MAX_PROJECTS ?? 4) });
    service.server.listen(Number(process.env.EVOLVED_CODEGRAPH_PORT ?? 8011), process.env.EVOLVED_CODEGRAPH_HOST ?? '127.0.0.1');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close(); });
}
