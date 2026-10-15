import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { configuration, prepareOutputDirectory, readPrivateFile } from './evolved-live-check.mjs';

const valid = { EVOLVED_TEST_URL: 'https://acceptance.example.test', EVOLVED_BOOTSTRAP_FILE: '/private/bootstrap' };
test('acceptance scope requires HTTPS origin, dedicated workspace, and explicit continuation output', () => {
    assert.equal(configuration(valid, 'seed').workspace, '/workspaces/acceptance');
    for (const url of ['http://localhost:3006', 'https://user:password@example.test', 'https://example.test/app', 'https://example.test/?secret=private', 'https://example.test/#test']) {
        assert.throws(() => configuration({ ...valid, EVOLVED_TEST_URL: url }, 'seed'), /https_origin_required/);
    }
    for (const workspace of ['/workspaces/production', '/workspaces/acceptance/../production', '/workspaces/acceptance/', '/workspaces/acceptance-two', '/workspaces/acceptance/a b']) {
        assert.throws(() => configuration({ ...valid, EVOLVED_TEST_WORKSPACE: workspace }, 'seed'), /acceptance_workspace_required/);
    }
    assert.throws(() => configuration(valid, 'persist'), /existing_output_directory_required/);
    assert.throws(() => configuration(valid, 'reset'), /invalid_phase/);
    assert.equal(configuration({ ...valid, EVOLVED_TEST_OUTPUT_DIR: '/private/test' }, 'revoke').phase, 'revoke');
});

test('private input rejects symlinks, hard links, directories, and nonprivate modes without changing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'evolved-live-files-test-'));
    try {
        const file = join(root, 'bootstrap');
        writeFileSync(file, 'synthetic-value', { mode: 0o600 });
        assert.equal(readPrivateFile(file), 'synthetic-value');
        chmodSync(file, 0o640);
        assert.throws(() => readPrivateFile(file), /private_file_permissions/);
        chmodSync(file, 0o600);
        symlinkSync(file, join(root, 'symlink'));
        assert.throws(() => readPrivateFile(join(root, 'symlink')), /private_file_symlink/);
        symlinkSync(root, join(root, 'indirect'));
        assert.throws(() => readPrivateFile(join(root, 'indirect/bootstrap')), /private_file_symlink/);
        linkSync(file, join(root, 'hardlink'));
        assert.throws(() => readPrivateFile(file), /private_file_permissions/);
        assert.throws(() => readPrivateFile(root), /private_file_permissions/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('seed never overwrites a previous identity and continuation requires owner-only directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'evolved-live-output-test-'));
    try {
        const directory = join(root, 'result');
        assert.equal(prepareOutputDirectory(directory, 'seed'), directory);
        writeFileSync(join(directory, 'operator-file'), 'must-survive', { mode: 0o600 });
        assert.throws(() => prepareOutputDirectory(directory, 'seed'), /seed_output_directory_not_empty/);
        assert.equal(prepareOutputDirectory(directory, 'persist'), directory);
        chmodSync(directory, 0o750);
        assert.throws(() => prepareOutputDirectory(directory, 'persist'), /private_directory_permissions/);
        chmodSync(directory, 0o700);
        symlinkSync(directory, join(root, 'linked'));
        assert.throws(() => prepareOutputDirectory(join(root, 'linked'), 'persist'), /private_directory_permissions/);
        mkdirSync(join(root, 'public'), { mode: 0o755 });
        assert.throws(() => prepareOutputDirectory(join(root, 'public'), 'seed'), /private_directory_permissions/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI configuration failures never print embedded URL credentials', () => {
    const result = spawnSync(process.execPath, ['web/scripts/evolved-live-check.mjs'], {
        cwd: new URL('../..', import.meta.url),
        env: { ...process.env, EVOLVED_TEST_URL: 'https://synthetic-user:DO-NOT-PRINT@example.test', EVOLVED_BOOTSTRAP_FILE: '/unused' },
        encoding: 'utf8',
    });
    // Resolve from the repository, independent of the caller's current working directory.
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('DO-NOT-PRINT') && !result.stderr.includes('DO-NOT-PRINT'));
    const output = JSON.parse(result.stdout);
    assert.equal(output.checks[0].code, 'https_origin_required');
});
