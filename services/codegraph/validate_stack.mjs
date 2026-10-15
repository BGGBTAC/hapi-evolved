// Run on the host against the isolated validation container; synthetic source only.
// The container sees these fixtures through its read-only /workspaces mount.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, stat, chown } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const state = process.env.EVOLVED_VALIDATION_STATE ?? '/tmp/hapi-evolved-stack-validation';
const container = process.env.EVOLVED_VALIDATION_CONTAINER ?? 'hapi-evolved-check-codegraph-1';
const projectId = randomUUID();
const root = await mkdtemp(join(state, 'workspaces/adapter-validation-'));
// The Docker operator may be root while the service runs under a dedicated UID.
// Keep the synthetic private fixture readable by that service, without opening it.
if (process.getuid?.() === 0) {
    const owner = await stat(join(state, 'workspaces'));
    await chown(root, owner.uid, owner.gid);
}
const containerRoot = '/workspaces/' + basename(root);
const remote = `import { readFile } from 'node:fs/promises';
let data=''; for await (const chunk of process.stdin) data+=chunk;
const input=JSON.parse(data);
const token=(await readFile(process.env.EVOLVED_SERVICE_TOKEN_FILE,'utf8')).trim();
const response=await fetch('http://127.0.0.1:8011/query',{method:'POST',headers:{authorization:input.invalidAuth?'invalid':'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input.body)});
console.log(JSON.stringify({status:response.status,body:await response.json(),node:process.version}));`;
const call = (operation, params = {}, invalidAuth = false, projectRoot = containerRoot) => new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', container, 'node', '--input-type=module', '-e', remote], { timeout: 40_000 }, (error, stdout) => {
        if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
    child.stdin.end(JSON.stringify({ invalidAuth, body: { projectId, root: projectRoot, operation, params } }));
});
try {
    await writeFile(join(root, 'example.ts'), 'export function square(x: number) { return x * x }\nexport function calculate(x: number) { return square(x) }\n');
    await mkdir(join(root, 'secrets'));
    await writeFile(join(root, 'secrets/private.ts'), 'export function privateCredentialSymbol() { return "synthetic" }');
    assert.equal((await call('status', {}, true)).status, 401);
    assert.equal((await call('status', {}, false, '/credentials')).status, 403);
    let status;
    for (let i = 0; i < 100; i++) {
        status = await call('status');
        if (status.body.state === 'ready') break;
        if (status.body.state === 'error') throw new Error(status.body.error);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.body.state, 'ready');
    const found = await call('search', { q: 'square' });
    const node = found.body.nodes.find(node => node.name === 'square');
    assert.ok(node);
    const impact = await call('impact', { nodeId: node.id });
    assert.ok(impact.body.nodes.some(node => node.name === 'calculate'));
    assert.ok(impact.body.edges.length);
    assert.equal((await call('search', { q: 'privateCredentialSymbol' })).body.nodes.length, 0);
    assert.match((await call('node', { nodeId: node.id })).body.source, /return x \* x/);
    await rm(join(root, 'example.ts'));
    let deleted = false;
    for (let i = 0; i < 80; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if ((await call('search', { q: 'square' })).body.nodes.length === 0) { deleted = true; break; }
    }
    assert.equal(deleted, true);
    assert.equal((await call('drop')).status, 200);
    assert.equal((await call('status')).status, 410);
    await assert.rejects(access(join(state, 'codegraph', 'projects', projectId)));
    await access(join(state, 'codegraph', 'deleted', projectId));
    await access(join(root, 'secrets/private.ts'));
    // Report only observations made above; image version and mount/network isolation
    // require separate operator inspection and are not established by API success.
    console.log(JSON.stringify({ codegraph: 'passed', node: status.node, calls: true,
        sourceExclusion: true, automaticDeletion: true, durableDropContract: true }));
} finally { await call('drop').catch(() => {}); await rm(root, { recursive: true, force: true }); }
