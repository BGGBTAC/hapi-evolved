import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalRoot, sourcePath, sourceText, normalizeGraph } from '../policy.mjs';

test('canonical allowlist rejects sibling paths and escaping symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapi-codegraph-'));
    try {
        await mkdir(join(root, 'workspace')); await mkdir(join(root, 'workspace-evil'));
        await writeFile(join(root, 'workspace-evil', 'secret.ts'), 'private');
        await symlink(join(root, 'workspace-evil', 'secret.ts'), join(root, 'workspace', 'link.ts'));
        await assert.rejects(canonicalRoot(join(root, 'workspace-evil'), [join(root, 'workspace')]));
        await assert.rejects(sourcePath(join(root, 'workspace'), 'link.ts'));
        await assert.rejects(sourceText(join(root, 'workspace'), 'link.ts'));
        await writeFile(join(root, 'workspace', 'safe.ts'), 'export const safe = true');
        assert.equal(await sourceText(join(root, 'workspace'), 'safe.ts'), 'export const safe = true');
        await assert.rejects(sourcePath(join(root, 'workspace'), '../workspace-evil/secret.ts'));
        await assert.rejects(sourcePath(join(root, 'workspace'), '.env'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded graph never leaves dangling edges or emits secret paths', () => {
    const graph = normalizeGraph({ nodes: [
        { id: 'a', name: 'A', filePath: 'a.ts' }, { id: 's', name: 'SECRET', filePath: 'secrets/key.ts' },
        { id: 'b', name: 'B', filePath: 'b.ts' }
    ], edges: [{ sourceId: 'a', targetId: 's' }, { sourceId: 'a', targetId: 'b' }] }, 1);
    assert.deepEqual(graph.nodes.map(n => n.id), ['a']); assert.equal(graph.edges.length, 0); assert.equal(graph.truncated, true);
});

test('sourceText rejects a FIFO without waiting for a writer', async (t) => {
    if (process.platform !== 'linux') { t.skip('Linux FIFO regression'); return; }
    const root = await mkdtemp(join(tmpdir(), 'hapi-codegraph-fifo-'));
    try {
        await promisify(execFile)('mkfifo', [join(root, 'pipe.ts')]);
        const moduleUrl = new URL('../policy.mjs', import.meta.url).href;
        const script = `const {sourceText}=await import(process.argv[1]);try{await sourceText(process.argv[2],'pipe.ts');process.exitCode=1}catch(error){if(error.status!==413)throw error}`;
        // Separate process: a future regression fails within the timeout, without a stuck test worker.
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, moduleUrl, root], { timeout: 2000 });
    } finally { await rm(root, { recursive: true, force: true }); }
});
