import { io } from 'socket.io-client';
import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

export async function checkMarkdownFiles(page, origin, { sessionId }, workspace) {
    const directory = join(workspace, 'markdown-browser-check');
    mkdirSync(directory, { recursive: true });
    const main = join(directory, 'README.md'), linked = join(directory, 'linked.md'), image = join(directory, 'pixel.png');
    writeFileSync(main, '# SYNTHETIC_MARKDOWN_PREVIEW\n\n![Synthetic local pixel](./pixel.png)\n\n[Open linked document](./linked.md)\n\n[Rejected outside path](../../outside.md)\n');
    writeFileSync(linked, '# SYNTHETIC_RELATIVE_LINK\n\nThe authenticated local link works.\n');
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6l9sAAAAASUVORK5CYII=', 'base64'));
    let lease, socket, timer;
    const reads = [];
    try {
        lease = await page.evaluate(async () => {
            const me = await (await fetch('/api/evolved/me')).json();
            const projectId = me.accessibleProjects.find(project => project.name === 'Browsercheck').id;
            const response = await fetch(`/api/evolved/projects/${projectId}/runner-leases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic markdown RPC', scopes: ['runner:connect'], expiresInSeconds: 300 }) });
            const result = await response.json(); if (!response.ok) throw Error(`Markdown lease: ${response.status} ${result.code ?? ''}`);
            return { ...result, projectId };
        });
        const exchange = await fetch(`${origin}/api/evolved/runner/token`, { method: 'POST', headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' }, body: '{}' });
        if (!exchange.ok) throw Error(`Markdown capability exchange: ${exchange.status}`);
        const cap = await exchange.json();
        socket = io(`${origin}/cli`, { transports: ['websocket'], reconnection: false, auth: { token: cap.token, clientType: 'session-scoped', sessionId } });
        socket.on('rpc-request', (request, acknowledge) => {
            try {
                if (request.method === `${sessionId}:git-diff-file`) return acknowledge(JSON.stringify({ success: true, stdout: '', stderr: '', exitCode: 0 }));
                if (request.method !== `${sessionId}:readFile`) return acknowledge(JSON.stringify({ success: false, error: 'Synthetic method unavailable' }));
                const { path } = JSON.parse(request.params);
                const actual = realpathSync(resolve(workspace, path));
                if (relative(directory, actual).startsWith('..') || ![main, linked, image].includes(actual)) throw Error('Synthetic file denied');
                const bytes = readFileSync(actual); reads.push(actual);
                acknowledge(JSON.stringify({ success: true, content: bytes.toString('base64'), size: bytes.length }));
            } catch { acknowledge(JSON.stringify({ success: false, error: 'Synthetic file unavailable' })); }
        });
        await new Promise((resolveConnect, reject) => {
            const timeout = setTimeout(() => reject(Error('Markdown synthetic CLI socket timeout')), 10_000);
            socket.once('connect', () => { clearTimeout(timeout); resolveConnect(); });
            socket.once('connect_error', error => { clearTimeout(timeout); reject(error); });
        });
        socket.emit('rpc-register', { method: `${sessionId}:readFile` });
        socket.emit('rpc-register', { method: `${sessionId}:git-diff-file` });
        const alive = () => socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false });
        alive(); timer = setInterval(alive, 3000);
        await page.goto(`${origin}/sessions/${sessionId}/file?${new URLSearchParams({ path: Buffer.from(main).toString('base64') })}`);
        await page.getByRole('heading', { name: 'SYNTHETIC_MARKDOWN_PREVIEW', exact: true }).waitFor();
        const picture = page.getByRole('img', { name: 'Synthetic local pixel', exact: true });
        await picture.waitFor();
        await picture.evaluate(element => new Promise((resolveImage, reject) => {
            if (element.complete) return element.naturalWidth > 0 ? resolveImage() : reject(Error('Local PNG did not decode'));
            element.onload = () => resolveImage(); element.onerror = () => reject(Error('Local PNG failed'));
        }));
        if (await picture.getAttribute('src') === null || !(await picture.getAttribute('src')).startsWith('blob:')) throw Error('Local image did not use authenticated file bytes');
        if (await page.getByRole('link', { name: 'Rejected outside path', exact: true }).count()) throw Error('Escaping Markdown link remained active');
        await page.getByRole('link', { name: 'Open linked document', exact: true }).click();
        await page.getByRole('heading', { name: 'SYNTHETIC_RELATIVE_LINK', exact: true }).waitFor();
        if (!reads.includes(main) || !reads.includes(image) || !reads.includes(linked)) throw Error('Markdown assets bypassed the real authenticated file RPC');
        console.log('PASS real Markdown file preview, authenticated local PNG bytes, relative document navigation and traversal-link refusal');
    } finally {
        if (timer) clearInterval(timer);
        socket?.disconnect();
        if (lease) await page.evaluate(async ({ id, projectId }) => { const response = await fetch(`/api/evolved/projects/${projectId}/runner-leases/${id}`, { method: 'DELETE' }); if (!response.ok) throw Error(`Markdown lease revoke: ${response.status}`); }, lease);
        rmSync(directory, { recursive: true, force: true });
        await page.goto(`${origin}/sessions/${sessionId}`);
    }
}
