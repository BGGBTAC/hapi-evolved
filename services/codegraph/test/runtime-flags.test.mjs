import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('..', import.meta.url));
const sdkFlags = require.resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/lib/dist/extraction/wasm-runtime-flags.js`);
const sdk = require(sdkFlags);
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const dockerCommand = JSON.parse(dockerfile.match(/^CMD (\[.*\])$/m)[1]);

// Exercise the actual configured Node arguments, without starting a server or
// using any service credentials. The two worker levels match adapter → parser.
for (const [entry, command] of [['Docker', dockerCommand], ['npm start', packageJson.scripts.start.split(' ')]]) {
    test(`${entry} supplies the SDK-required WASM flags to the process and nested workers`, { timeout: 10_000 }, () => {
        assert.equal(command[0], 'node');
        assert.equal(command.at(-1), 'server.mjs');
        const flags = command.slice(1, -1);
        assert.equal(sdk.processHasWasmRuntimeFlags(flags), true);
        const nested = `
            const { parentPort } = require('node:worker_threads');
            const sdk = require(${JSON.stringify(sdkFlags)});
            parentPort.postMessage(sdk.processHasWasmRuntimeFlags());
        `;
        const adapter = `
            const { Worker, parentPort } = require('node:worker_threads');
            const sdk = require(${JSON.stringify(sdkFlags)});
            const worker = new Worker(${JSON.stringify(nested)}, { eval: true });
            worker.once('error', error => { throw error; });
            worker.once('message', nested => parentPort.postMessage({ adapter: sdk.processHasWasmRuntimeFlags(), nested }));
        `;
        const main = `
            const { Worker } = require('node:worker_threads');
            const sdk = require(${JSON.stringify(sdkFlags)});
            const worker = new Worker(${JSON.stringify(adapter)}, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 512 } });
            worker.once('error', error => { throw error; });
            worker.once('message', result => console.log(JSON.stringify({ main: sdk.processHasWasmRuntimeFlags(), ...result })));
        `;
        const result = execFileSync(process.execPath, [...flags, '-e', main], { cwd: directory, encoding: 'utf8', timeout: 8_000 });
        assert.deepEqual(JSON.parse(result), { main: true, adapter: true, nested: true });
    });
}
