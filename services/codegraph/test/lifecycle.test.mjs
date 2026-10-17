import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createCodegraphService } from '../server.mjs';

const token = 'synthetic-codegraph-service-token-0000000000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await sleep(5); }
    assert.fail('Expected lifecycle condition was not reached');
}
const status = (state = 'ready', extra = {}) => ({ available: state === 'ready', state, version: '1.6.0', phase: state === 'indexing' ? 'parsing' : state,
    watching: state === 'ready', pendingFiles: 0, lastIndexedAt: state === 'ready' ? 123 : null, indexState: state,
    watcherDegraded: state === 'error', ...(state === 'ready' ? { stats: { nodeCount: 7, edgeCount: 4, fileCount: 2 } } : {}), ...extra });
class FakeWorker extends EventEmitter {
    messages = []; terminations = 0; holdTermination = false;
    postMessage(message) { this.messages.push(message); this.onRequest?.(message); }
    terminate() {
        this.terminations++;
        return new Promise(resolve => {
            this.finishTermination = () => { this.emit('exit', 1); resolve(1); };
            if (!this.holdTermination) this.finishTermination();
        });
    }
    snapshot(value = status()) { this.emit('message', { type: 'status', status: value }); }
    reply(message, result = { nodes: [], edges: [], truncated: false }) { this.emit('message', { id: message.id, result }); }
}
async function fixture(t, options = {}) {
    const base = await mkdtemp(join(tmpdir(), 'codegraph-lifecycle-')), root = join(base, 'source'), stateRoot = join(base, 'state');
    await mkdir(root); const workers = [], logs = [];
    const service = await createCodegraphService({ token, roots: [root], stateRoot, maxWorkers: options.maxWorkers ?? 4,
        lifecycle: { rpcTimeoutMs: 50, progressTimeoutMs: 2000, readyTimeoutMs: 2000, indexTimeoutMs: 5000, backoffMs: 80, ...options.lifecycle },
        log: record => logs.push(record), createWorker: data => {
            const worker = options.factory ? options.factory(data) : new FakeWorker(); workers.push(worker); return worker;
        } });
    service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    const origin = `http://127.0.0.1:${service.server.address().port}`;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; for (const worker of workers) worker.finishTermination?.(); await service.close(); } };
    t.after(async () => { await close(); await rm(base, { recursive: true, force: true }); });
    const query = async (operation = 'status', extra = {}, authorization = `Bearer ${token}`) => {
        const response = await fetch(`${origin}/query`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: 'project', root, operation, ...extra }), signal: AbortSignal.timeout(3000) });
        return { status: response.status, body: await response.json() };
    };
    return { query, workers, logs, root, stateRoot, base, close };
}

test('HTTP status is immediate even while a real worker blocks its event loop', async t => {
    const f = await fixture(t, { factory: () => new Worker('while (true) {}', { eval: true }), lifecycle: { rpcTimeoutMs: 10 } });
    const started = Date.now(), initial = await f.query();
    assert.equal(initial.status, 200); assert.equal(initial.body.state, 'indexing'); assert.equal(initial.body.available, false);
    assert.equal(initial.body.stats, undefined); assert.ok(Date.now() - started < 500);
    await sleep(40);
    const results = await Promise.all(Array.from({ length: 12 }, () => f.query()));
    assert.ok(results.every(result => result.status === 200 && result.body.state === 'indexing'));
    assert.equal(f.workers.length, 1); assert.deepEqual(f.logs, []);
});

test('real worker stdout and stderr are drained without leaking synthetic source into service logs', async t => {
    const marker = 'SYNTHETIC_PRIVATE_CODEGRAPH_SOURCE'; let emitted = false, leaked = false;
    for (const stream of [process.stdout, process.stderr]) {
        const original = stream.write;
        stream.write = function (chunk, ...args) { leaked ||= String(chunk).includes(marker); return original.call(this, chunk, ...args); };
        t.after(() => { stream.write = original; });
    }
    const f = await fixture(t, { factory: ({ options }) => {
        const worker = new Worker(`const {parentPort}=require('node:worker_threads');
            console.log(${JSON.stringify(marker)}); console.error(${JSON.stringify(marker)});
            parentPort.postMessage({type:'status',status:${JSON.stringify(status())}});
            parentPort.postMessage({type:'emitted'}); setInterval(()=>{},1000);`, { ...options, eval: true });
        worker.on('message', message => { if (message.type === 'emitted') emitted = true; }); return worker;
    } });
    await f.query(); await until(() => emitted); await sleep(20);
    assert.equal((await f.query()).body.state, 'ready'); assert.equal(leaked, false); assert.deepEqual(f.logs, []);
});

for (const [workerCode, expected] of [['ERR_WORKER_OUT_OF_MEMORY', 'codegraph_worker_out_of_memory'], ['SECRET_SOURCE_VALUE', 'codegraph_worker_failed']]) {
    test(`HTTP retains sanitized ${expected}, backs off, and ignores old-generation events`, async t => {
        const f = await fixture(t); await f.query(); const old = f.workers[0];
        const error = new Error('SECRET_SOURCE_VALUE source/file.ts api-key'); error.code = workerCode; old.emit('error', error); old.emit('exit', 9);
        const failed = await f.query(); assert.equal(failed.status, 200); assert.equal(failed.body.state, 'error');
        assert.equal(failed.body.code, expected); assert.equal(failed.body.available, false); assert.equal(failed.body.watching, false);
        assert.ok(failed.body.retryAfterMs > 0); assert.equal(f.logs.length, 1);
        await Promise.all(Array.from({ length: 12 }, () => f.query()));
        assert.equal((await f.query('search', { params: { q: 'anything' } })).status, 503);
        const retry = await f.query('reindex'); assert.equal(retry.status, 503); assert.equal(retry.body.code, expected);
        assert.ok(retry.body.retryAfterMs > 0); assert.match(retry.body.error, /retry indexing in 1 seconds/); assert.equal(f.workers.length, 1);
        assert.ok(!JSON.stringify({ failed, logs: f.logs }).includes('SECRET_SOURCE_VALUE'));
        await sleep(90); assert.equal((await f.query('reindex')).body.accepted, true); assert.equal(f.workers.length, 2);
        f.workers[1].snapshot(); old.snapshot(status('error')); old.emit('error', error); old.emit('exit', 9);
        assert.equal((await f.query()).body.state, 'ready'); assert.equal(f.logs.length, 1);
    });
}

test('an unexpected numeric exit is retained once and differs from intentional teardown', async t => {
    const f = await fixture(t); await f.query(); f.workers[0].emit('exit', 7);
    const result = await f.query(); assert.equal(result.body.code, 'codegraph_worker_failed');
    assert.deepEqual(f.logs.map(({ code, exitCode }) => ({ code, exitCode })), [{ code: 'codegraph_worker_failed', exitCode: 7 }]);
    await f.query('drop'); assert.equal(f.logs.length, 1);
});

test('an RPC timeout retains the healthy index and bounds queue slots until late replies', async t => {
    const f = await fixture(t, { lifecycle: { maxPending: 1, rpcTimeoutMs: 25 } }); await f.query(); const worker = f.workers[0]; worker.snapshot();
    const timedOut = await f.query('search', { params: { q: 'example' } });
    assert.equal(timedOut.status, 504); assert.equal(timedOut.body.code, 'codegraph_worker_timeout');
    assert.equal(worker.terminations, 0); assert.equal((await f.query()).body.stats.nodeCount, 7);
    assert.equal((await f.query('search')).status, 429); assert.equal(worker.messages.length, 1);
    worker.reply(worker.messages[0]); worker.onRequest = message => worker.reply(message);
    assert.equal((await f.query('search')).status, 200); assert.equal(worker.messages.length, 2);
    assert.equal((await f.query()).body.state, 'ready'); assert.equal(worker.terminations, 0);
});

test('restart waits for confirmed worker termination before reopening the same index', async t => {
    const f = await fixture(t, { lifecycle: { backoffMs: 15 } }); await f.query(); const worker = f.workers[0]; worker.holdTermination = true;
    const directory = join(f.stateRoot, 'projects', 'project', 'workspace', '.codegraph-evolved-project'), lock = join(directory, 'codegraph.lock');
    await mkdir(directory, { recursive: true }); await writeFile(lock, String(process.pid));
    worker.emit('error', new Error('private')); await until(() => worker.terminations === 1); await sleep(25);
    assert.equal((await f.query('reindex')).status, 503); assert.equal(f.workers.length, 1);
    assert.equal(await readFile(lock, 'utf8'), String(process.pid));
    worker.finishTermination(); await sleep(0);
    assert.equal((await f.query('reindex')).status, 200); assert.equal(f.workers.length, 2);
    await assert.rejects(readFile(lock));
});

test('failed termination never authorizes restart or derived-index deletion', async t => {
    const f = await fixture(t, { lifecycle: { backoffMs: 10 } }); await f.query(); const worker = f.workers[0];
    const directory = join(f.stateRoot, 'projects', 'project'), file = join(directory, 'sentinel');
    await mkdir(directory, { recursive: true }); await writeFile(file, 'derived data');
    worker.terminate = () => { worker.terminations++; return Promise.reject(new Error('SECRET_SOURCE_VALUE')); };
    worker.emit('error', new Error('private')); await sleep(20);
    assert.equal((await f.query('reindex')).status, 503); assert.equal(f.workers.length, 1);
    assert.equal((await f.query('drop')).status, 503); assert.equal(await readFile(file, 'utf8'), 'derived data');
    assert.ok(!JSON.stringify(f.logs).includes('SECRET_SOURCE_VALUE'));
    worker.terminate = FakeWorker.prototype.terminate;
});

test('drop rejects an outstanding mutation, waits for termination, and leaves a persistent tombstone', async t => {
    const f = await fixture(t); await f.query(); const worker = f.workers[0]; worker.snapshot(); worker.holdTermination = true;
    const privateFile = join(f.stateRoot, 'projects', 'project', 'sentinel'); await mkdir(join(f.stateRoot, 'projects', 'project'), { recursive: true }); await writeFile(privateFile, 'derived data');
    const reindex = f.query('reindex'); await until(() => worker.messages.length === 1);
    const drop = f.query('drop'); await until(() => worker.terminations === 1);
    assert.equal((await reindex).status, 410); assert.equal((await f.query()).status, 410);
    assert.equal(await readFile(privateFile, 'utf8'), 'derived data');
    worker.snapshot(); worker.reply(worker.messages[0], { accepted: true }); worker.emit('error', new Error('private'));
    worker.finishTermination(); assert.equal((await drop).body.deleted, true);
    await assert.rejects(readFile(privateFile)); assert.equal(await readFile(join(f.stateRoot, 'deleted', 'project'), 'utf8'), 'deleted\n');
    assert.equal((await f.query('reindex')).status, 410); assert.equal(f.workers.length, 1); assert.deepEqual(f.logs, []);
});

test('indexing heartbeats without progress cannot keep a stuck index alive forever', async t => {
    const f = await fixture(t, { lifecycle: { progressTimeoutMs: 50 } }); await f.query(); const worker = f.workers[0];
    worker.snapshot(status('indexing', { progress: { current: 1, total: 10 } }));
    const heartbeat = setInterval(() => worker.snapshot(status('indexing', { progress: { current: 1, total: 10 } })), 10); t.after(() => clearInterval(heartbeat));
    await until(() => worker.terminations === 1);
    const result = await f.query(); assert.equal(result.body.code, 'codegraph_index_timeout'); assert.equal(result.status, 200);
    assert.equal(f.workers.length, 1); assert.equal(f.logs.length, 1);
});

test('absolute indexing deadline applies even when progress keeps arriving', async t => {
    const f = await fixture(t, { lifecycle: { progressTimeoutMs: 60, indexTimeoutMs: 100 } }); await f.query(); const worker = f.workers[0]; let current = 0;
    const progress = setInterval(() => worker.snapshot(status('indexing', { progress: { current: ++current, total: 1000 } })), 10); t.after(() => clearInterval(progress));
    await until(() => worker.terminations === 1); assert.equal((await f.query()).body.code, 'codegraph_index_timeout');
});

test('a previously ready worker becomes unavailable after missing heartbeats', async t => {
    const f = await fixture(t, { lifecycle: { readyTimeoutMs: 40 } }); await f.query(); const worker = f.workers[0]; worker.snapshot();
    await until(() => worker.terminations === 1); const result = await f.query();
    assert.equal(result.body.code, 'codegraph_worker_timeout'); assert.equal(result.body.available, false); assert.equal(result.body.state, 'error');
});

test('unknown and inconsistent snapshots never advertise ready or disclose worker error text', async t => {
    const f = await fixture(t); await f.query(); const worker = f.workers[0];
    worker.snapshot(status('ready', { error: 'SECRET_SOURCE_VALUE' }));
    const inconsistent = await f.query(); assert.equal(inconsistent.body.state, 'error'); assert.equal(inconsistent.body.available, false);
    assert.ok(!JSON.stringify(inconsistent).includes('SECRET_SOURCE_VALUE'));
    worker.snapshot(status('future-state')); assert.equal((await f.query()).body.state, 'error');
    assert.equal(worker.terminations, 1);
});

test('known index-lock and indexing failure snapshots retain their safe diagnosis', async t => {
    const f = await fixture(t); await f.query();
    for (const code of ['codegraph_index_locked', 'codegraph_index_failed']) {
        f.workers[0].snapshot(status('error', { code, error: 'SECRET_SOURCE_VALUE' }));
        const result = await f.query(); assert.equal(result.status, 200); assert.equal(result.body.code, code);
        assert.equal(result.body.available, false); assert.ok(!JSON.stringify(result).includes('SECRET_SOURCE_VALUE'));
    }
});

test('authentication, root binding, and retained failed-worker capacity stay enforced', async t => {
    const f = await fixture(t, { maxWorkers: 1 });
    assert.equal((await f.query('status', {}, 'Bearer wrong')).status, 401); assert.equal(f.workers.length, 0);
    assert.equal((await f.query('status', { root: f.base })).status, 403); assert.equal(f.workers.length, 0);
    await f.query(); f.workers[0].emit('error', new Error('private'));
    assert.equal((await f.query('status', { projectId: 'second' })).status, 503);
    const child = join(f.root, 'child'); await mkdir(child);
    assert.equal((await f.query('status', { root: child })).status, 409); assert.equal(f.workers.length, 1);
});

test('an owned stale PID lock is removed before first spawn, while foreign locks are preserved', async t => {
    const f = await fixture(t);
    const index = join(f.stateRoot, 'projects', 'project', 'workspace', '.codegraph-evolved-project'), lock = join(index, 'codegraph.lock');
    await mkdir(index, { recursive: true }); await writeFile(lock, String(process.pid));
    await f.query(); await assert.rejects(readFile(lock));
    f.workers[0].emit('error', new Error('private')); await sleep(90);
    await writeFile(lock, '424242'); await f.query('reindex'); assert.equal(await readFile(lock, 'utf8'), '424242');
});

test('owned-index lock cleanup refuses symlinked directories', async t => {
    const f = await fixture(t); const outside = join(f.base, 'foreign'); await mkdir(outside);
    await writeFile(join(outside, 'codegraph.lock'), String(process.pid));
    const workspace = join(f.stateRoot, 'projects', 'project', 'workspace'); await mkdir(workspace, { recursive: true });
    await symlink(outside, join(workspace, '.codegraph-evolved-project'));
    const result = await f.query(); assert.equal(result.body.state, 'error'); assert.equal(f.workers.length, 0);
    assert.equal(await readFile(join(outside, 'codegraph.lock'), 'utf8'), String(process.pid));
});

test('owned-index lock cleanup refuses a symlinked lock file', async t => {
    const f = await fixture(t), outside = join(f.base, 'foreign-lock'); await writeFile(outside, String(process.pid));
    const directory = join(f.stateRoot, 'projects', 'project', 'workspace', '.codegraph-evolved-project');
    await mkdir(directory, { recursive: true }); await symlink(outside, join(directory, 'codegraph.lock'));
    const result = await f.query(); assert.equal(result.body.state, 'error'); assert.equal(f.workers.length, 0);
    assert.equal(await readFile(outside, 'utf8'), String(process.pid));
});
