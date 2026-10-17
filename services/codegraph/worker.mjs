import { mkdir, writeFile, rename, rm, readdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import codegraphPackage from '@colbymchenry/codegraph';
import { AdapterError, limitValue, normalizeGraph, normalizeNode, sourcePath, sourceText, isSensitivePath, scanCodeFiles } from './policy.mjs';
const { CodeGraph } = codegraphPackage;

if (!workerData.indexRoot || workerData.indexRoot === workerData.root) throw new Error('An isolated index workspace is required');
let graph;
let state = 'indexing';
let error;
let indexPromise;
let snapshot = new Map();
let synchronization;
let pendingFiles = 0;
let watching = false;
let lastIndexedAt = null;
let stats;
let code;
let phase = 'initializing';
let progress = { current: 0, total: 0 };
let lastPublished = 0;
let watchTimer;
const indexDirectory = process.env.CODEGRAPH_DIR ?? '.codegraph';
if (!/^\.codegraph(?:-[A-Za-z0-9_-]+)?$/.test(indexDirectory) || indexDirectory.trim() !== indexDirectory) throw new Error('Invalid private index directory');

function status() {
    return { available: state === 'ready', state, version: '1.6.0', error, code,
        watching, pendingFiles, lastIndexedAt, indexState: state, stats,
        watcherDegraded: state === 'error', phase, progress };
}
function publish(force = false) {
    if (!force && Date.now() - lastPublished < 250) return;
    lastPublished = Date.now();
    parentPort.postMessage({ type: 'status', status: status() });
}
function advance(nextPhase, current = 0, total = 0) {
    const changed = phase !== nextPhase;
    phase = nextPhase; progress = { current, total }; publish(changed);
}
function sdkProgress(value) {
    // SDK progress also contains source paths; never forward or log them.
    if (['scanning', 'parsing', 'storing', 'resolving', 'linking'].includes(value.phase)) {
        advance(value.phase, Number.isSafeInteger(value.current) ? value.current : 0,
            Number.isSafeInteger(value.total) ? value.total : 0);
    }
}
function fail(caught, message) {
    state = 'error'; phase = 'error';
    code = caught?.code === 'codegraph_index_locked' ? caught.code : 'codegraph_index_failed';
    error = code === 'codegraph_index_locked' ? 'Code index is locked; retry indexing shortly' : message;
    publish(true);
}
function ready() {
    const value = graph.getStats();
    stats = { nodeCount: value.nodeCount, edgeCount: value.edgeCount, fileCount: value.fileCount };
    watching = true;
    if (!watchTimer) watchTimer = setInterval(() => { void synchronize().catch(caught => fail(caught, 'Codegraph workspace synchronization failed')); }, 3000).unref();
    state = 'ready'; phase = 'ready'; error = undefined; code = undefined;
    progress = { current: 0, total: 0 }; publish(true);
}

async function checkIndexLock() {
    // clear() does not acquire the SDK lock. Check before any destructive rebuild;
    // a terminated thread's PID can still belong to the live HTTP process.
    const blocked = () => { const caught = new AdapterError('Code index is locked; retry indexing shortly', 503); caught.code = 'codegraph_index_locked'; return caught; };
    const root = resolve(workerData.indexRoot);
    const path = resolve(root, indexDirectory, 'codegraph.lock');
    if (!path.startsWith(root + sep)) throw blocked();
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (caught) { if (caught.code === 'ENOENT') return; throw blocked(); }
    try {
        // Validate and read the same descriptor: replaced links/FIFOs must never
        // redirect a read or block the worker. The bounded read also handles a
        // regular file growing after fstat without allocating arbitrary memory.
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 32) throw blocked();
        const opened = await realpath(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path);
        if (opened !== path) throw blocked();
        const buffer = Buffer.alloc(33);
        let total = 0;
        while (total < buffer.length) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
            if (!bytesRead) break;
            total += bytesRead;
        }
        if (total > 32) throw blocked();
        const owner = buffer.subarray(0, total).toString('utf8').trim();
        if (!/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(Number(owner))) throw blocked();
        // Match the pinned SDK's two-minute stale-lock contract. Do not delete locks.
        if (Date.now() - info.mtimeMs >= 120_000) return;
        try { process.kill(Number(owner), 0); }
        catch (caught) { if (caught.code === 'ESRCH') return; throw blocked(); }
        throw blocked();
    } finally { await handle.close(); }
}

async function scrubMirror(allowed) {
    // indexAll uses the SDK's scanner. Remove every non-manifest entry first,
    // including formerly allowed secrets/large files and symlinks. Only the
    // service-owned SDK directory is retained; source workspaces are never edited.
    const directories = new Set();
    for (const path of allowed) {
        let parent = dirname(path);
        while (parent !== '.') { directories.add(parent); parent = dirname(parent); }
    }
    async function walk(directory, prefix = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = prefix ? join(prefix, entry.name) : entry.name;
            if (!prefix && entry.name === indexDirectory && entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const target = join(directory, entry.name);
            if (entry.isDirectory() && !entry.isSymbolicLink() && directories.has(path)) await walk(target, path);
            else if (!entry.isFile() || !allowed.has(path)) await rm(target, { recursive: true, force: true });
        }
    }
    await walk(workerData.indexRoot);
}
function synchronize(force = false) {
    if (synchronization) {
        return force ? synchronization.catch(() => {}).then(() => synchronize(true)) : Promise.resolve(false);
    }
    const operation = synchronizeOnce(force);
    synchronization = operation;
    void operation.finally(() => { if (synchronization === operation) synchronization = undefined; }).catch(() => {});
    return operation;
}
async function synchronizeOnce(force) {
    advance('scanning');
    const current = await scanCodeFiles(workerData.root);
    const paths = [...current.keys()].filter(path => force || snapshot.get(path) !== current.get(path));
    paths.push(...[...snapshot.keys()].filter(path => !current.has(path)));
    if (!force && !paths.length) { if (state === 'ready') advance('ready'); return false; }
    await checkIndexLock();
    // Remove legacy symlinks before copying, so a mirror directory cannot
    // redirect writes outside this service-owned workspace.
    await scrubMirror(new Set(current.keys()));
    state = 'indexing'; error = undefined; code = undefined;
    pendingFiles = paths.length;
    advance('copying', 0, paths.length); publish(true);
    let copied = 0;
    let changedBytes = 0;
    for (const path of paths) {
        const target = join(workerData.indexRoot, path);
        if (current.has(path)) {
            try {
                // The SDK never sees source paths. Copy from a checked open
                // descriptor into adapter-owned storage, then index there.
                const content = await sourceText(workerData.root, path);
                changedBytes += Buffer.byteLength(content);
                await mkdir(dirname(target), { recursive: true, mode: 0o700 });
                const temporary = target + `.stage-${randomUUID()}`;
                await writeFile(temporary, content, { mode: 0o600 });
                await rename(temporary, target);
            } catch (error) {
                if (!(error instanceof AdapterError) && error.code !== 'ENOENT' && error.code !== 'ELOOP') throw error;
                current.delete(path);
                await rm(target, { force: true });
            }
        } else await rm(target, { force: true });
        advance('copying', ++copied, paths.length);
    }
    if (force || paths.length) {
        const full = force || paths.length > 100 || changedBytes > 4 * 1024 * 1024;
        let result;
        if (full) {
            await scrubMirror(new Set(current.keys()));
            await checkIndexLock();
            advance('initializing');
            graph.clear();
            // Bulk indexing resolves references in bounded, yielding batches.
            // sync(allPaths) instead materializes the entire reference set.
            result = await graph.indexAll({ onProgress: sdkProgress });
            if (result.success !== true || result.filesErrored > 0) throw new AdapterError('Code indexing failed', 503);
        } else {
            advance('synchronizing');
            result = await graph.sync({ paths, onProgress: sdkProgress });
            // The SDK's lock rejection is a zero-work result, not success:false.
            if (result.success === false || result.filesChecked === 0 && result.durationMs === 0) {
                const caught = new AdapterError('Code indexing failed', 503); caught.code = 'codegraph_index_locked'; throw caught;
            }
        }
        if (current.size > 0 && graph.getStats().fileCount === 0) throw new AdapterError('Code indexing failed', 503);
        lastIndexedAt = Date.now();
    }
    snapshot = current; pendingFiles = 0;
    ready();
    return true;
}
async function initialize() {
    await mkdir(workerData.indexRoot, { recursive: true, mode: 0o700 });
    await checkIndexLock();
    graph = CodeGraph.isInitialized(workerData.indexRoot)
        ? await CodeGraph.open(workerData.indexRoot, { sync: false })
        : await CodeGraph.init(workerData.indexRoot, { index: false });
    // Include stale mirror paths after restart so deleted original files are also erased locally.
    snapshot = await scanCodeFiles(workerData.indexRoot);
    await synchronize(true);
    publish(true);
}
publish(true);
setInterval(() => publish(true), 5000).unref();
indexPromise = initialize().catch(caught => fail(caught, 'Code index initialization failed'));

async function execute(operation, params) {
    if (operation === 'status') {
        return status();
    }
    if (operation === 'reindex') {
        if (state !== 'indexing') {
            state = 'indexing'; error = undefined;
            phase = 'initializing'; code = undefined; publish(true);
            indexPromise = (graph ? synchronize(true) : initialize())
                .catch(caught => fail(caught, 'Code indexing failed'));
        }
        return { accepted: true, state };
    }
    if (state !== 'ready' || !graph) throw new AdapterError('Code index is not ready', 503);
    graph.reopenIfReplaced();
    const limit = limitValue(params.limit);
    if (operation === 'search') {
        const query = String(params.q ?? '').trim();
        if (!query || query.length > 500) throw new AdapterError('Search query must contain 1–500 characters');
        return normalizeGraph({ nodes: graph.searchNodes(query, { limit }).map(result => result.node), edges: [] }, limit);
    }
    if (operation === 'affected') {
        const files = Array.isArray(params.files) ? params.files : String(params.files ?? '').split(',').filter(Boolean);
        if (!files.length || files.length > 20) throw new AdapterError('Provide between 1 and 20 changed files');
        const nodes = new Map(); const edges = new Map(); const skipped = []; const accepted = [];
        for (const file of files) {
            try { await sourcePath(workerData.root, file); }
            catch { skipped.push({ file, reason: 'unavailable' }); continue; }
            accepted.push(file);
            for (const node of graph.getNodesInFile(file).slice(0, 20)) {
                const sub = graph.traverse(node.id, { direction: 'incoming', maxDepth: 2, limit });
                for (const n of sub.nodes.values()) { if (nodes.size < limit) nodes.set(n.id, n); }
                for (const e of sub.edges) { if (edges.size < limit * 4) edges.set(`${e.source}:${e.target}:${e.kind}`, e); }
            }
        }
        return { ...normalizeGraph({ nodes, edges }, limit), files: accepted, skipped, lastIndexedAt, pendingFiles };
    }
    let nodeId = String(params.nodeId ?? '');
    if (!nodeId && operation === 'graph') {
        nodeId = graph.searchNodes(String(params.q ?? ''), { limit: 1 })[0]?.node.id ?? '';
        // A fresh or empty workspace is a valid graph, not a missing-symbol error.
        if (!nodeId) return normalizeGraph({ nodes: [], edges: [] }, limit);
    }
    if (!nodeId || nodeId.length > 1024) throw new AdapterError('A node is required', 404);
    const node = graph.getNode(nodeId);
    if (!node || isSensitivePath(node.filePath)) throw new AdapterError('Node not found', 404);
    await sourcePath(workerData.root, node.filePath);
    if (operation === 'node') {
        const lines = (await sourceText(workerData.root, node.filePath)).split('\n');
        const startLine = Math.max(1, node.startLine - 3);
        const endLine = Math.min(lines.length, node.endLine + 3, startLine + 300);
        return { node: normalizeNode(node), source: lines.slice(startLine - 1, endLine).join('\n'), startLine, endLine,
            callers: graph.getCallers(nodeId, 1).slice(0, limit).filter(x => !isSensitivePath(x.node.filePath)).map(x => normalizeNode(x.node)),
            callees: graph.getCallees(nodeId, 1).slice(0, limit).filter(x => !isSensitivePath(x.node.filePath)).map(x => normalizeNode(x.node)) };
    }
    const depth = limitValue(params.depth, 2, 3);
    const subgraph = graph.traverse(nodeId, { direction: operation === 'impact' ? 'incoming' : 'both', maxDepth: depth, limit });
    return normalizeGraph(subgraph, limit);
}
parentPort.on('message', async ({ id, operation, params }) => {
    try { parentPort.postMessage({ id, result: await execute(operation, params) }); }
    catch (caught) { parentPort.postMessage({ id, error: caught instanceof AdapterError ? caught.message : 'Codegraph operation failed', status: caught.status ?? 500 }); }
});
