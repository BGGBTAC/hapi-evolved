import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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
let polling = false;
let pendingFiles = 0;
let watching = false;
let lastIndexedAt = null;
async function synchronize(force = false) {
    if (polling) return;
    polling = true;
    try {
        const current = await scanCodeFiles(workerData.root);
        const paths = [...current.keys()].filter(path => force || snapshot.get(path) !== current.get(path));
        paths.push(...[...snapshot.keys()].filter(path => !current.has(path)));
        pendingFiles = paths.length;
        for (const path of paths) {
            const target = join(workerData.indexRoot, path);
            if (current.has(path)) {
                try {
                    // The SDK never sees source paths. Copy from a checked open
                    // descriptor into adapter-owned storage, then index there.
                    const content = await sourceText(workerData.root, path);
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
        }
        if (paths.length) {
            const result = await graph.sync({ paths });
            if (result.success === false) throw new AdapterError('Code indexing failed', 503);
            lastIndexedAt = Date.now();
        }
        snapshot = current; pendingFiles = 0;
    } finally { polling = false; }
}
async function initialize() {
    await mkdir(workerData.indexRoot, { recursive: true, mode: 0o700 });
    graph = CodeGraph.isInitialized(workerData.indexRoot)
        ? await CodeGraph.open(workerData.indexRoot, { sync: false })
        : await CodeGraph.init(workerData.indexRoot, { index: false });
    // This service owns its project-specific derived index. Remove any stale entries from older exclusion policies.
    graph.clear();
    // Include stale mirror paths after restart so deleted original files are also erased locally.
    snapshot = await scanCodeFiles(workerData.indexRoot);
    await synchronize(true);
    watching = true;
    setInterval(() => { void synchronize().then(() => { if (state === 'error') { state = 'ready'; error = undefined; } }).catch(() => { state = 'error'; error = 'Codegraph workspace synchronization failed'; }); }, 3000).unref();
    state = 'ready';
}
indexPromise = initialize().catch(() => { state = 'error'; error = 'Code index initialization failed'; });

async function execute(operation, params) {
    if (operation === 'status') {
        const stats = graph?.getStats();
        return {
            available: state === 'ready', state, version: '1.6.0', error,
            watching, pendingFiles, lastIndexedAt, indexState: state,
            // SDK stats also contain nested kind/language maps. Expose only the UI contract.
            stats: stats && { nodeCount: stats.nodeCount, edgeCount: stats.edgeCount, fileCount: stats.fileCount },
            watcherDegraded: state === 'error'
        };
    }
    if (operation === 'reindex') {
        if (state !== 'indexing') {
            state = 'indexing'; error = undefined;
            indexPromise = (graph ? synchronize(true) : initialize()).then(() => { state = 'ready'; })
                .catch(() => { state = 'error'; error = 'Code indexing failed'; });
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
        const nodes = new Map(); const edges = new Map();
        for (const file of files) {
            await sourcePath(workerData.root, file);
            for (const node of graph.getNodesInFile(file).slice(0, 20)) {
                const sub = graph.traverse(node.id, { direction: 'incoming', maxDepth: 2, limit });
                for (const n of sub.nodes.values()) { if (nodes.size < limit) nodes.set(n.id, n); }
                for (const e of sub.edges) { if (edges.size < limit * 4) edges.set(`${e.source}:${e.target}:${e.kind}`, e); }
            }
        }
        return { ...normalizeGraph({ nodes, edges }, limit), files };
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
