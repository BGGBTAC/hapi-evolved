import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

test('real Codegraph indexes calls, excludes secret source, and updates incrementally', { timeout: 45_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolved-codegraph-real-'));
    const indexRoot = await mkdtemp(join(tmpdir(), 'evolved-codegraph-index-'));
    let worker;
    try {
        await writeFile(join(root, 'example.ts'), 'export function square(x: number) { return x * x }\nexport function calculate(x: number) { return square(x) }\n');
        // A workspace-controlled SQLite directory must never be opened by the SDK.
        const foreign = await mkdtemp(join(tmpdir(), 'evolved-codegraph-foreign-'));
        await writeFile(join(foreign, 'sentinel'), 'foreign data must survive');
        await symlink(foreign, join(root, '.codegraph-evolved-test'));
        await writeFile(join(indexRoot, 'stale.ts'), 'export function stalePrivateFact() { return true }');
        await mkdir(join(root, 'secrets'));
        await writeFile(join(root, 'secrets', 'hidden.ts'), 'export function privateCredentialSymbol() { return "synthetic" }');
        worker = new Worker(new URL('../worker.mjs', import.meta.url), { workerData: { root, indexRoot }, resourceLimits: { maxOldGenerationSizeMb: 512 }, env: {
            ...process.env, DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_DIR: '.codegraph-evolved-test', CODEGRAPH_PARSE_WORKERS: '1', CODEGRAPH_RESOLVE_WORKERS: '0', CODEGRAPH_NO_FAST_INIT: '1'
        } });
        let serial = 0;
        const pending = new Map();
        worker.on('message', message => {
            const job = pending.get(message.id); if (!job) return;
            pending.delete(message.id);
            message.error ? job.reject(new Error(message.error)) : job.resolve(message.result);
        });
        worker.on('error', error => { for (const job of pending.values()) job.reject(error); });
        const call = (operation, params = {}) => new Promise((resolve, reject) => {
            const id = ++serial; pending.set(id, { resolve, reject }); worker.postMessage({ id, operation, params });
        });
        async function waitForReady() {
            for (let attempt = 0; attempt < 100; attempt++) {
                const status = await call('status');
                if (status.state === 'error') throw new Error(status.error);
                if (status.state === 'ready') return status;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Index did not become ready');
        }
        const status = await waitForReady();
        assert.equal(status.watching, true);
        assert.equal(await readFile(join(foreign, 'sentinel'), 'utf8'), 'foreign data must survive');
        await assert.rejects(readFile(join(indexRoot, 'stale.ts')));
        await rm(foreign, { recursive: true, force: true });
        const found = await call('search', { q: 'square' });
        assert.ok(found.nodes.some(node => node.name === 'square'));
        const node = found.nodes.find(node => node.name === 'square');
        const graph = await call('impact', { nodeId: node.id });
        assert.ok(graph.nodes.some(node => node.name === 'calculate'));
        assert.ok(graph.edges.length > 0);
        const affected = await call('affected', { files: ['deleted.ts', 'secrets/hidden.ts', 'example.ts'] });
        assert.ok(affected.nodes.some(node => node.name === 'square'));
        assert.deepEqual(affected.files, ['example.ts']);
        assert.deepEqual(affected.skipped.map(item => item.file), ['deleted.ts', 'secrets/hidden.ts']);
        const onlyMissing = await call('affected', { files: ['deleted.ts'] });
        assert.equal(onlyMissing.nodes.length, 0);
        assert.equal(onlyMissing.skipped.length, 1);
        const secret = await call('search', { q: 'privateCredentialSymbol' });
        assert.equal(secret.nodes.length, 0);
        const preview = await call('node', { nodeId: node.id });
        assert.match(preview.source, /return x \* x/);
        await writeFile(join(root, 'example.ts'), 'export function replacement() { return 42 }\n');
        let updated = false;
        for (let attempt = 0; attempt < 60; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 150));
            const results = await call('search', { q: 'replacement' }).catch(error => {
                if (error.message === 'Code index is not ready') return { nodes: [] };
                throw error;
            });
            if (results.nodes.some(node => node.name === 'replacement')) { updated = true; break; }
        }
        assert.equal(updated, true);
        assert.equal((await call('search', { q: 'square' })).nodes.length, 0);
    } finally { if (worker) await worker.terminate(); await rm(root, { recursive: true, force: true }); await rm(indexRoot, { recursive: true, force: true }); }
});

test('empty workspaces return a usable empty graph and acquire a default seed after code is added', { timeout: 45_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolved-codegraph-empty-'));
    const indexRoot = await mkdtemp(join(tmpdir(), 'evolved-codegraph-empty-index-'));
    const worker = new Worker(new URL('../worker.mjs', import.meta.url), { workerData: { root, indexRoot }, resourceLimits: { maxOldGenerationSizeMb: 512 }, env: {
        ...process.env, DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_DIR: '.codegraph-evolved-test', CODEGRAPH_PARSE_WORKERS: '1', CODEGRAPH_RESOLVE_WORKERS: '0', CODEGRAPH_NO_FAST_INIT: '1'
    } });
    let serial = 0;
    const pending = new Map();
    worker.on('message', message => {
        const job = pending.get(message.id); if (!job) return;
        pending.delete(message.id);
        message.error ? job.reject(new Error(message.error)) : job.resolve(message.result);
    });
    worker.on('error', error => { for (const job of pending.values()) job.reject(error); });
    const call = (operation, params = {}) => new Promise((resolve, reject) => {
        const id = ++serial; pending.set(id, { resolve, reject }); worker.postMessage({ id, operation, params });
    });
    async function waitFor(predicate) {
        for (let attempt = 0; attempt < 150; attempt++) {
            const status = await call('status');
            if (status.state === 'error') throw new Error(status.error);
            if (status.state === 'ready' && predicate(status)) return status;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Expected index state was not reached');
    }
    try {
        const empty = await waitFor(() => true);
        assert.deepEqual(empty.stats, { nodeCount: 0, edgeCount: 0, fileCount: 0 });
        assert.equal(empty.watching, true);
        assert.deepEqual(await call('graph'), { nodes: [], edges: [], truncated: false });
        await assert.rejects(call('node', { nodeId: 'missing' }), /Node not found/);
        await writeFile(join(root, 'names.ts'), 'export const orbitalMarker = 42;\nexport class Satellite {}\n');
        const indexed = await waitFor(status => status.stats.nodeCount > 0 && status.pendingFiles === 0);
        assert.ok(indexed.lastIndexedAt > 0);
        assert.ok(Object.values(indexed.stats).every(value => typeof value === 'number'));
        const graph = await call('graph');
        assert.ok(graph.nodes.length > 0, 'default graph must not depend on a symbol named function');
        await assert.rejects(call('graph', { nodeId: 'missing' }), /Node not found/);
        assert.deepEqual(await call('graph', { q: 'nonexistentSymbolXYZ' }), { nodes: [], edges: [], truncated: false });
    } finally { await worker.terminate(); await rm(root, { recursive: true, force: true }); await rm(indexRoot, { recursive: true, force: true }); }
});
