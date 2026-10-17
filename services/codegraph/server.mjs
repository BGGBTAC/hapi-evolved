import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AdapterError, canonicalRoot, within } from './policy.mjs';
import { reclaimOwnedLock, WorkerLifecycle } from './lifecycle.mjs';

// Set before starting workers/loading Codegraph. No telemetry or update/download traffic.
Object.assign(process.env, { DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1',
    CODEGRAPH_PARSE_WORKERS: '1', CODEGRAPH_RESOLVE_WORKERS: '0', CODEGRAPH_NO_FAST_INIT: '1' });

export async function createCodegraphService({ token, roots, stateRoot, maxWorkers = 4, createWorker, log, lifecycle = {} }) {
    if (!token || token.length < 32) throw new Error('EVOLVED_SERVICE_TOKEN must contain at least 32 characters');
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new Error('EVOLVED_CODE_ROOTS must be a JSON string array');
    await mkdir(join(stateRoot, 'projects'), { recursive: true, mode: 0o700 });
    await mkdir(join(stateRoot, 'deleted'), { recursive: true, mode: 0o700 });
    const canonicalState = await realpath(stateRoot);
    for (const root of roots) {
        if (within(await realpath(root), canonicalState)) throw new Error('Codegraph state must be outside source workspaces');
    }
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
    const token = process.env.EVOLVED_SERVICE_TOKEN_FILE ? readFileSync(process.env.EVOLVED_SERVICE_TOKEN_FILE, 'utf8').trim() : process.env.EVOLVED_SERVICE_TOKEN;
    const service = await createCodegraphService({ token, roots: JSON.parse(process.env.EVOLVED_CODE_ROOTS ?? '[]'),
        stateRoot: process.env.EVOLVED_CODEGRAPH_STATE_DIR ?? '/data', maxWorkers: Number(process.env.EVOLVED_CODEGRAPH_MAX_PROJECTS ?? 4) });
    service.server.listen(Number(process.env.EVOLVED_CODEGRAPH_PORT ?? 8011), process.env.EVOLVED_CODEGRAPH_HOST ?? '127.0.0.1');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close(); });
}
