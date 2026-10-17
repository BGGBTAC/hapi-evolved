import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, stat, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodegraphService, readServiceTokenFile } from '../server.mjs';

const token = 'synthetic-codegraph-service-token-0000000000';
async function fixture(t) {
    const base = await mkdtemp(join(tmpdir(), 'codegraph-config-')), source = join(base, 'source');
    await mkdir(source);
    t.after(() => rm(base, { recursive: true, force: true }));
    return { base, source, start: stateRoot => createCodegraphService({ token, roots: [source], stateRoot }) };
}

test('custom absolute state paths support missing parents, spaces and canonical operator aliases', async t => {
    const f = await fixture(t), parent = join(f.base, 'operator data'), alias = join(f.base, 'alias');
    await mkdir(parent); await symlink(parent, alias);
    const stateRoot = join(alias, 'neue Daten', 'privat-ä');
    const service = await f.start(stateRoot);
    try {
        assert.ok((await stat(join(parent, 'neue Daten', 'privat-ä', 'projects'))).isDirectory());
        assert.ok((await stat(join(stateRoot, 'deleted'))).isDirectory());
        assert.deepEqual(await readdir(f.source), []);
    } finally { await service.close(); }
});

test('invalid state configuration is rejected before creating files', async t => {
    const f = await fixture(t);
    for (const stateRoot of ['relative/state', '/', `${f.base}/../escape`, `${f.base}/./state`, `${f.base}/state\0bad`, `${f.base}/state\\bad`]) {
        await assert.rejects(f.start(stateRoot), /Configured path/);
    }
    assert.deepEqual(await readdir(f.base), ['source']);
});

for (const existing of [false, true]) {
    test(`state inside a workspace is rejected before writes (${existing ? 'existing' : 'missing'} directory)`, async t => {
        const f = await fixture(t), stateRoot = join(f.source, 'private');
        if (existing) await mkdir(stateRoot);
        await assert.rejects(f.start(stateRoot), /separate from source/);
        assert.deepEqual(await readdir(f.source), existing ? ['private'] : []);
        if (existing) assert.deepEqual(await readdir(stateRoot), []);
    });
}

test('state containing an allowed workspace is rejected before creating private subdirectories', async t => {
    const f = await fixture(t);
    await assert.rejects(f.start(f.base), /separate from source/);
    assert.deepEqual(await readdir(f.base), ['source']);
});

test('workspace aliases and unresolved symlink parents cannot redirect state creation into source', async t => {
    const f = await fixture(t), alias = join(f.base, 'alias'), dangling = join(f.base, 'dangling');
    await symlink(f.source, alias); await symlink(join(f.source, 'missing'), dangling);
    await assert.rejects(f.start(join(alias, 'private')), /separate from source/);
    await assert.rejects(f.start(join(dangling, 'private')), /unresolved symbolic links/);
    assert.deepEqual(await readdir(f.source), []);
});

for (const name of ['projects', 'deleted']) {
    test(`an escaped ${name} directory is rejected before any private directory is created`, async t => {
        const f = await fixture(t), stateRoot = join(f.base, 'state');
        await mkdir(stateRoot); await symlink(f.source, join(stateRoot, name));
        await assert.rejects(f.start(stateRoot), /remain inside/);
        assert.deepEqual(await readdir(stateRoot), [name]);
        assert.deepEqual(await readdir(f.source), []);
    });
}

test('synthetic token files support custom absolute paths and canonical operator aliases', async t => {
    const f = await fixture(t), path = join(f.base, 'token file'), alias = join(f.base, 'token alias');
    await writeFile(path, `${token}\n`); await symlink(path, alias);
    assert.equal(readServiceTokenFile(path), token);
    assert.equal(readServiceTokenFile(alias), token);
});

test('token file reads reject traversal, directories, oversized files and FIFOs without blocking', async t => {
    const f = await fixture(t), large = join(f.base, 'large'), fifo = join(f.base, 'fifo');
    await writeFile(large, 'x'.repeat(4097)); execFileSync('mkfifo', [fifo]);
    for (const path of ['relative/token', '/', `${f.base}/../token`, `${f.base}/./token`, `${f.base}/token\0bad`, `${f.base}/token\\bad`]) {
        assert.throws(() => readServiceTokenFile(path), /Configured path/);
    }
    for (const path of [f.source, large, fifo]) assert.throws(() => readServiceTokenFile(path), /regular file/);
});
