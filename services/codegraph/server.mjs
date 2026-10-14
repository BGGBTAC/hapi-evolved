import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AdapterError, canonicalRoot, within } from './policy.mjs';

// Set before starting workers/loading Codegraph. No telemetry or update/download traffic.
Object.assign(process.env, { DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1' });
const token = process.env.EVOLVED_SERVICE_TOKEN_FILE ? readFileSync(process.env.EVOLVED_SERVICE_TOKEN_FILE, 'utf8').trim() : process.env.EVOLVED_SERVICE_TOKEN;
if (!token || token.length < 32) throw new Error('EVOLVED_SERVICE_TOKEN must contain at least 32 characters');
const roots = JSON.parse(process.env.EVOLVED_CODE_ROOTS ?? '[]');
if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new Error('EVOLVED_CODE_ROOTS must be a JSON string array');
const stateRoot = process.env.EVOLVED_CODEGRAPH_STATE_DIR ?? '/data';
await mkdir(join(stateRoot, 'projects'), { recursive: true, mode: 0o700 });
await mkdir(join(stateRoot, 'deleted'), { recursive: true, mode: 0o700 });
const canonicalState = await realpath(stateRoot);
for (const root of roots) {
    if (within(await realpath(root), canonicalState)) throw new Error('Codegraph state must be outside source workspaces');
}
const workers = new Map();
const deletedProjects = new Set();
const maxWorkers = Number(process.env.EVOLVED_CODEGRAPH_MAX_PROJECTS ?? 4);
function authenticated(request) {
    const actual = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function workerFor(projectId, root) {
    const existing = workers.get(projectId);
    if (existing) {
        if (existing.root !== root) throw new AdapterError('Project root changed; restart adapter to switch it', 409);
        return existing;
    }
    if (workers.size >= maxWorkers) throw new AdapterError('Codegraph project capacity reached', 503);
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
        workerData: { root, indexRoot: join(canonicalState, 'projects', projectId, 'workspace') }, env: { ...process.env, CODEGRAPH_DIR: `.codegraph-evolved-${projectId}` },
        resourceLimits: { maxOldGenerationSizeMb: 512 }
    });
    const pending = new Map();
    const entry = { root, worker, pending };
    worker.on('message', message => {
        const job = pending.get(message.id); if (!job) return;
        clearTimeout(job.timer); pending.delete(message.id);
        if (message.error) job.reject(new AdapterError(message.error, message.status)); else job.resolve(message.result);
    });
    const failed = () => {
        if (workers.get(projectId) === entry) workers.delete(projectId);
        for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new AdapterError('Codegraph worker stopped', 503)); }
        pending.clear();
    };
    worker.on('error', failed); worker.on('exit', failed);
    workers.set(projectId, entry);
    return entry;
}
async function callWorker(entry, operation, params) {
    if (entry.pending.size >= 16) throw new AdapterError('Codegraph busy', 429);
    return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { entry.pending.delete(id); reject(new AdapterError('Codegraph timed out', 504)); void entry.worker.terminate(); }, 30_000);
        entry.pending.set(id, { resolve, reject, timer }); entry.worker.postMessage({ id, operation, params });
    });
}
const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    try {
        if (!authenticated(request)) throw new AdapterError('Unauthorized', 401);
        if (request.url === '/health') { response.end(JSON.stringify({ ok: true, version: '1.6.0', projects: workers.size })); return; }
        if (request.method !== 'POST' || request.url !== '/query') throw new AdapterError('Not found', 404);
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 32_768) throw new AdapterError('Request too large', 413); chunks.push(chunk); }
        let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AdapterError('Invalid JSON'); }
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.projectId ?? '')) throw new AdapterError('Invalid project ID');
        if (!['status', 'reindex', 'search', 'node', 'graph', 'impact', 'affected', 'drop'].includes(input.operation)) throw new AdapterError('Unknown operation');
        const marker = join(canonicalState, 'deleted', input.projectId);
        if (input.operation === 'drop') {
            deletedProjects.add(input.projectId);
            await writeFile(marker, 'deleted\n', { mode: 0o600 });
            const existing = workers.get(input.projectId);
            if (existing) { await existing.worker.terminate(); workers.delete(input.projectId); }
            await rm(join(canonicalState, 'projects', input.projectId), { recursive: true, force: true });
            response.end(JSON.stringify({ deleted: true })); return;
        }
        if (deletedProjects.has(input.projectId) || await access(marker).then(() => true, () => false)) throw new AdapterError('Project was deleted', 410);
        const root = await canonicalRoot(input.root, roots);
        // A deletion can complete while canonicalization yields. Never recreate its worker.
        if (deletedProjects.has(input.projectId)) throw new AdapterError('Project was deleted', 410);
        const result = await callWorker(workerFor(input.projectId, root), input.operation, input.params ?? {});
        response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = error instanceof AdapterError ? error.status : 500; response.end(JSON.stringify({ error: error instanceof AdapterError ? error.message : 'Codegraph adapter failed' })); }
});
server.requestTimeout = 35_000;
server.listen(Number(process.env.EVOLVED_CODEGRAPH_PORT ?? 8011), process.env.EVOLVED_CODEGRAPH_HOST ?? '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); for (const entry of workers.values()) void entry.worker.terminate(); });
