import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const dataDirectory = '.codegraph-evolved-recovery-test';
Object.assign(process.env, {
    DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1',
    CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_DIR: dataDirectory,
    CODEGRAPH_PARSE_WORKERS: '1', CODEGRAPH_RESOLVE_WORKERS: '0', CODEGRAPH_NO_FAST_INIT: '1'
});
const { default: codegraphPackage } = await import('@colbymchenry/codegraph');
const { CodeGraph } = codegraphPackage;

function startWorker(root, indexRoot) {
    const worker = new Worker(new URL('../worker.mjs', import.meta.url), {
        workerData: { root, indexRoot }, env: { ...process.env },
        resourceLimits: { maxOldGenerationSizeMb: 512 }
    });
    const pending = new Map();
    const statuses = [];
    let sequence = 0;
    let stopped;
    function fail(error) {
        stopped = error;
        for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
        pending.clear();
    }
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`Fixture worker exited (${code})`)));
    worker.on('message', message => {
        // Progress/status notifications are not replies to an RPC.
        if (message.type === 'status') statuses.push(message.status);
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id); clearTimeout(job.timer);
        if (message.error) job.reject(new Error(message.error)); else job.resolve(message.result);
    });
    const call = (operation, params = {}) => new Promise((resolve, reject) => {
        if (stopped) { reject(stopped); return; }
        const id = ++sequence;
        const timer = setTimeout(() => {
            pending.delete(id); reject(new Error(`Fixture ${operation} RPC timed out`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, operation, params });
    });
    return { worker, call, statuses };
}

async function waitForState(client, expected, predicate = () => true) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const status = await client.call('status');
        if (status.state === expected && predicate(status)) return status;
        if (status.state === 'error' && expected !== 'error') {
            assert.fail(`Unexpected worker error: ${status.code ?? status.error}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`Worker did not reach ${expected}`);
}

async function seedIndex(indexRoot) {
    const graph = await CodeGraph.init(indexRoot, { index: false });
    try {
        const result = await graph.indexAll();
        assert.equal(result.success, true);
        assert.ok(graph.getStats().nodeCount > 0);
    } finally { graph.close(); }
}

async function databaseDigest(indexRoot) {
    return createHash('sha256').update(await readFile(join(indexRoot, dataDirectory, 'codegraph.db'))).digest('hex');
}

test('fresh live-PID lock preserves an existing index and explicit reindex recovers after release', { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evolved-codegraph-lock-recovery-'));
    const root = join(directory, 'source');
    const indexRoot = join(directory, 'mirror');
    let client;
    try {
        await mkdir(root); await mkdir(indexRoot);
        const content = 'export function retainedRecoverySymbol() { return 17; }\n';
        await writeFile(join(root, 'example.ts'), content);
        await writeFile(join(indexRoot, 'example.ts'), content);
        await seedIndex(indexRoot);
        const before = await databaseDigest(indexRoot);
        const lockPath = join(indexRoot, dataDirectory, 'codegraph.lock');
        // Worker threads share this live PID. A terminated predecessor can leave
        // precisely this lock behind while its enclosing server remains alive.
        await writeFile(lockPath, String(process.pid));
        client = startWorker(root, indexRoot);
        const blocked = await waitForState(client, 'error');
        assert.equal(blocked.code, 'codegraph_index_locked');
        assert.equal(blocked.available, false);
        assert.equal(typeof blocked.error, 'string');
        assert.ok(blocked.error.length > 0);
        assert.equal(blocked.error.includes(directory), false);
        assert.equal(await databaseDigest(indexRoot), before, 'lock denial must precede clearing or opening the existing index for writes');
        assert.equal(await readFile(lockPath, 'utf8'), String(process.pid));

        await rm(lockPath);
        assert.equal((await client.call('status')).state, 'error', 'status must not silently restart a failed initialization');
        const accepted = await client.call('reindex');
        assert.equal(accepted.accepted, true);
        const recovered = await waitForState(client, 'ready');
        assert.equal(recovered.available, true);
        assert.equal(recovered.code, undefined);
        assert.equal(recovered.stats.fileCount, 1);
        assert.ok(recovered.stats.nodeCount > 0);
        assert.ok((await client.call('search', { q: 'retainedRecoverySymbol' })).nodes.some(node => node.name === 'retainedRecoverySymbol'));
    } finally {
        if (client) await client.worker.terminate();
        await rm(directory, { recursive: true, force: true });
    }
});

test('more than 100 changed paths use bulk indexing and remove deleted symbols', { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evolved-codegraph-bulk-recovery-'));
    const root = join(directory, 'source');
    const indexRoot = join(directory, 'mirror');
    let client;
    try {
        await mkdir(root); await mkdir(indexRoot);
        await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(root, `example-${index}.ts`),
            `export function originalBulkSymbol${index}() { return ${index}; }\n`)));
        client = startWorker(root, indexRoot);
        const initial = await waitForState(client, 'ready');
        assert.equal(initial.stats.fileCount, 101);
        client.statuses.length = 0;
        // 100 modifications plus one deletion cross the incremental limit.
        // Let the real watcher discover them; explicit reindex always forces a
        // full rebuild and would not exercise the changed-path boundary.
        await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(root, `example-${index}.ts`),
            `export function updatedBulkSymbol${index}() { return ${index + 1}; }\n`)));
        await rm(join(root, 'example-100.ts'));
        const updated = await waitForState(client, 'ready', status => status.lastIndexedAt > initial.lastIndexedAt);
        assert.equal(updated.stats.fileCount, 100);
        assert.equal(updated.pendingFiles, 0);
        assert.ok(client.statuses.some(status => status.state === 'indexing' && status.phase === 'initializing'),
            'large watcher batches must enter the bounded bulk SDK path');
        assert.equal(client.statuses.some(status => status.phase === 'synchronizing'), false);
        assert.ok((await client.call('search', { q: 'updatedBulkSymbol99' })).nodes.some(node => node.name === 'updatedBulkSymbol99'));
        assert.equal((await client.call('search', { q: 'originalBulkSymbol' })).nodes.length, 0);
        await assert.rejects(readFile(join(indexRoot, 'example-100.ts')), { code: 'ENOENT' });
    } finally {
        if (client) await client.worker.terminate();
        await rm(directory, { recursive: true, force: true });
    }
});

test('unsafe lock entries fail promptly without touching an existing index or their targets', { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evolved-codegraph-unsafe-lock-'));
    const root = join(directory, 'source');
    const indexRoot = join(directory, 'mirror');
    const lockPath = join(indexRoot, dataDirectory, 'codegraph.lock');
    const external = join(directory, 'external');
    let client;
    try {
        await mkdir(root); await mkdir(indexRoot);
        const content = 'export const preservedLockSymbol = 1;\n';
        await writeFile(join(root, 'example.ts'), content);
        await writeFile(join(indexRoot, 'example.ts'), content);
        await seedIndex(indexRoot);
        const before = await databaseDigest(indexRoot);
        await writeFile(external, 'synthetic-sensitive-content');
        const fixtures = [
            () => symlink(external, lockPath),
            () => link(external, lockPath),
            () => writeFile(lockPath, '9'.repeat(4096)),
            () => mkdir(lockPath),
            ...(process.platform === 'linux' ? [() => execFileSync('mkfifo', [lockPath])] : []),
        ];
        for (const fixture of fixtures) {
            await fixture();
            client = startWorker(root, indexRoot);
            const blocked = await waitForState(client, 'error');
            assert.equal(blocked.code, 'codegraph_index_locked');
            assert.equal(await databaseDigest(indexRoot), before);
            assert.equal(await readFile(external, 'utf8'), 'synthetic-sensitive-content');
            assert.equal(JSON.stringify(blocked).includes('synthetic-sensitive-content'), false);
            await client.worker.terminate(); client = undefined;
            await rm(lockPath, { recursive: true, force: true });
        }
    } finally {
        if (client) await client.worker.terminate();
        await rm(directory, { recursive: true, force: true });
    }
});

test('full indexing removes private, stale, oversized and linked mirror entries before the SDK scans them', { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evolved-codegraph-mirror-recovery-'));
    const root = join(directory, 'source');
    const indexRoot = join(directory, 'mirror');
    let client;
    try {
        await mkdir(root); await mkdir(indexRoot);
        await writeFile(join(root, 'example.ts'), 'export function publicRecoverySymbol() { return 23; }\n');
        await writeFile(join(indexRoot, 'stale.ts'), 'export function staleRecoverySymbol() { return 1; }\n');
        await mkdir(join(indexRoot, 'secrets'));
        await writeFile(join(indexRoot, 'secrets', 'hidden.ts'), 'export function privateRecoverySymbol() { return "synthetic"; }\n');
        await seedIndex(indexRoot);
        const marker = join(indexRoot, dataDirectory, 'preserved-marker');
        await writeFile(marker, 'owned SDK directory survives mirror cleanup');
        await writeFile(join(indexRoot, 'oversized.ts'), 'export const oversizedRecoverySymbol = 1;\n' + ' '.repeat(1_048_576));
        const external = join(directory, 'external.ts');
        const externalContent = 'export const linkedRecoverySymbol = "synthetic";\n';
        await writeFile(external, externalContent);
        await symlink(external, join(indexRoot, 'linked.ts'));
        client = startWorker(root, indexRoot);
        const ready = await waitForState(client, 'ready');
        assert.equal(ready.stats.fileCount, 1);
        assert.ok((await client.call('search', { q: 'publicRecoverySymbol' })).nodes.some(node => node.name === 'publicRecoverySymbol'));
        for (const path of ['stale.ts', 'secrets/hidden.ts', 'oversized.ts', 'linked.ts']) {
            await assert.rejects(readFile(join(indexRoot, path)), { code: 'ENOENT' });
        }
        assert.equal(await readFile(external, 'utf8'), externalContent, 'cleanup must not follow a mirror symlink');
        assert.equal(await readFile(marker, 'utf8'), 'owned SDK directory survives mirror cleanup');
        const database = new DatabaseSync(join(indexRoot, dataDirectory, 'codegraph.db'), { readOnly: true });
        try {
            database.exec('PRAGMA query_only = ON');
            assert.deepEqual(database.prepare('SELECT path FROM files ORDER BY path').all().map(row => row.path), ['example.ts']);
            assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE name IN ('privateRecoverySymbol', 'staleRecoverySymbol', 'oversizedRecoverySymbol', 'linkedRecoverySymbol')").get().count, 0);
        } finally { database.close(); }
    } finally {
        if (client) await client.worker.terminate();
        await rm(directory, { recursive: true, force: true });
    }
});
