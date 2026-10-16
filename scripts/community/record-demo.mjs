/** Real built UI and existing isolated workflow fixture; never a live account. */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = join(repo, 'assets/community');
const names = ['desktop.png', 'mobile.png', 'codegraph.png', 'walkthrough.webm', 'recording.json'];
if (names.some(name => existsSync(join(assets, name)))) throw Error('Generated media already exists; preserve it before recording again.');
if (!existsSync(join(repo, 'web/dist/index.html'))) throw Error('Run bun run build:web first.');
const state = mkdtempSync('/tmp/hapi-evolved-ui-community-');
const output = mkdtempSync('/tmp/hapi-evolved-community-recording-');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const check = (value, message) => { if (!value) throw Error(message); };
const report = { result: 'FAIL', recordedAt: new Date().toISOString(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceNote: 'Recorded from the working tree; input hashes identify the exact fixture, dependency and build inputs. The base commit is not a release-validation claim.',
    viewports: { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 }, deviceScaleFactor: 1 },
    provenance: 'Scripted demo: real local Hub, Vault, WebAuthn, Git diff, Codegraph and Memory ledger. Synthetic GitHub/account/runner fixtures. No model calls, remote Git transfers, provider credentials or production services.',
    files: {}, checks: [], chapters: [], externalRequests: [], pageErrors: [], httpErrors: [] };
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result; }
const [hub, vault, graph] = await Promise.all([freePort(), freePort(), freePort()]);
const origin = `http://localhost:${hub}`;
mkdirSync(join(state, 'home'), { mode: 0o700 });
// Inherit executable lookup, never personal account/provider/configuration variables.
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: repo, detached: true,
    env: { PATH: process.env.PATH, HOME: join(state, 'home'), LANG: 'C.UTF-8', EVOLVED_TEST_STATE: state,
        EVOLVED_TEST_HUB_PORT: String(hub), EVOLVED_TEST_VAULT_PORT: String(vault), EVOLVED_TEST_CODEGRAPH_PORT: String(graph),
        EVOLVED_TEST_WORKFLOW: '1', EVOLVED_TEST_CODEGRAPH: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '', browser, page, recording, recordingStarted;
child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-20000); });
const api = (page, path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(`/api/evolved${path}`, { method, credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) throw Error(`Demo API ${method}: ${response.status}`);
    return response.json();
}, { path, method, body });

async function guard(context) {
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        report.externalRequests.push({ host: url.hostname, path: url.pathname });
        return route.abort();
    });
    await context.routeWebSocket(/.*/, socket => {
        const url = new URL(socket.url());
        if (url.hostname === 'localhost' && url.port === String(hub)) socket.connectToServer();
        else { report.externalRequests.push({ host: url.hostname, path: url.pathname }); socket.close(); }
    });
}

async function caption(context) {
    await context.addInitScript(() => {
        const add = () => {
            const style = document.createElement('style');
            // The only presentation adjustment reserves an explicitly labelled
            // caption strip. No product text, status, controls or errors are hidden.
            style.textContent = `#root{height:calc(100% - 78px)!important}#community-caption{position:fixed;bottom:0;left:0;right:0;height:78px;box-sizing:border-box;background:#09232a;color:#f1fcfa;padding:10px 24px;font:13px/1.45 system-ui,sans-serif;z-index:2147483647;border-top:2px solid #58d9b4}#community-caption strong{display:block;font-size:18px;color:#fff}#community-caption small{display:block;color:#aee7d7;font-size:12px}@media(max-width:500px){#community-caption{padding:8px 12px;font-size:10px}#community-caption strong{font-size:14px}#community-caption small{font-size:10px}}`;
            document.head.append(style);
            const box = document.createElement('aside'); box.id = 'community-caption';
            const title = document.createElement('strong'); title.id = 'community-chapter'; title.textContent = 'HAPI-eVolved · Project workflow';
            const note = document.createElement('div'); note.textContent = 'SCRIPTED DEMO · Synthetic project · GitHub & agent fixtures';
            const limit = document.createElement('small'); limit.textContent = 'Real local Git + Codegraph + Memory · No model calls';
            box.append(title, note, limit); document.body.append(box);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add, { once: true }); else add();
    });
}

async function chapter(title) {
    await page.locator('#community-chapter').evaluate((element, text) => { element.textContent = text; }, title);
    report.chapters.push({ title, seconds: Math.round((Date.now() - recordingStarted) / 100) / 10 });
    console.log(`Demo: ${title}`);
}
async function focus(locator) {
    await locator.scrollIntoViewIfNeeded();
    await locator.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await delay(700);
}
async function screenshot(target, name) {
    await target.locator('#community-caption').waitFor();
    await target.evaluate(() => document.fonts.ready);
    check(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
    await target.screenshot({ path: join(output, name), fullPage: false, animations: 'disabled' });
}

try {
    for (let attempt = 0; attempt < 300; attempt++) {
        check(child.exitCode === null, 'Isolated fixture stopped during startup');
        try { if ((await fetch(`${origin}/health`)).ok) break; } catch {}
        check(attempt < 299, 'Isolated fixture startup deadline exceeded'); await delay(100);
    }
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    report.runtime = { node: process.version, chromium: browser.version() };
    const setup = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await guard(setup); const enrollment = await setup.newPage();
    const cdp = await setup.newCDPSession(enrollment); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await enrollment.goto(origin);
    await enrollment.getByLabel('Benutzername', { exact: true }).fill('Community demo');
    await enrollment.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await enrollment.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await enrollment.getByLabel('Ich habe die Codes sicher gespeichert.').check();
    await enrollment.getByRole('button', { name: 'Weiter', exact: true }).click();
    await enrollment.getByRole('heading', { name: 'Übersicht', exact: true }).waitFor();
    const { team } = await api(enrollment, '/teams', 'POST', { name: 'Community demo team' });
    const { project } = await api(enrollment, '/projects', 'POST', { teamId: team.id, name: 'Community demo' });
    await api(enrollment, `/projects/${project.id}/profile`, 'PUT', { profile: 'workspace' });
    await api(enrollment, `/projects/${project.id}/github`, 'POST', { token: 'github_pat_synthetic_browser_credential_only' });
    await api(enrollment, `/projects/${project.id}/github/repositories`, 'PUT', { repository: 'synthetic/workflow', permission: 'read' });
    writeFileSync(join(state, 'workflow-request.json'), JSON.stringify({ projectId: project.id, rootPath: project.rootPath, namespace: project.namespace }), { mode: 0o600 });
    for (let attempt = 0; attempt < 300 && !existsSync(join(state, 'workflow-ready.json')); attempt++) await delay(100);
    check(existsSync(join(state, 'workflow-ready.json')), 'Local Git fixture was not ready');
    const fixture = JSON.parse(readFileSync(join(state, 'workflow-ready.json'), 'utf8'));
    // Fixed synthetic formula exercises the real chat renderer after dependency
    // updates. Its own ephemeral capability never leaves the helper process.
    execFileSync('bun', [join(repo, 'scripts/community/seed-math.ts'), state, origin], { cwd: repo, env: { PATH: process.env.PATH, HOME: join(state, 'home') }, stdio: 'pipe', timeout: 15000 });
    await enrollment.goto(`${origin}/evolved?${new URLSearchParams({ project: project.id, tab: 'overview' })}`);
    await enrollment.locator('.ew-content').waitFor();
    await enrollment.goto(`${origin}/sessions/${fixture.sessionId}`);
    await enrollment.locator('.katex-display .katex').first().waitFor();
    check(await enrollment.locator('.katex-error').count() === 0, 'Math renderer reported an error');
    await enrollment.screenshot({ path: join(output, 'math-check-private.png') });
    report.checks.push('Real chat KaTeX display formula rendered without .katex-error');
    await api(enrollment, `/projects/${project.id}/codegraph/reindex`, 'POST', {});
    for (let attempt = 0; attempt < 150; attempt++) {
        const status = await api(enrollment, `/projects/${project.id}/codegraph/status`);
        if (status.state === 'ready' && status.pendingFiles === 0) break;
        check(attempt < 149, 'Real Codegraph did not finish indexing'); await delay(200);
    }
    // Enrollment/recovery screens are never recorded or saved to disk.
    const storageState = await setup.storageState(); await setup.close();
    recording = await browser.newContext({ storageState, viewport: { width: 1440, height: 1000 }, colorScheme: 'light', serviceWorkers: 'block', recordVideo: { dir: output, size: { width: 1440, height: 1000 } } });
    await guard(recording); await caption(recording); page = await recording.newPage();
    page.on('pageerror', () => report.pageErrors.push('Browser page error'));
    page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    recordingStarted = Date.now();
    const navigate = async (tab, repository) => {
        await page.goto(`${origin}/evolved?${new URLSearchParams({ project: project.id, tab, ...(repository ? { repository } : {}) })}`);
        await page.locator('.ew-content').waitFor();
    };
    await navigate('overview'); await page.getByRole('heading', { name: 'Bereit für den nächsten Schritt?' }).waitFor();
    await chapter('01 · One home for your project'); await delay(7000); await screenshot(page, 'desktop.png');
    await navigate('github'); await page.getByRole('link', { name: 'Sitzung in diesem Repo starten', exact: true }).waitFor();
    await chapter('02 · An explicitly approved repository'); await delay(6500);
    await navigate('github', '101'); await page.getByRole('button', { name: 'Arbeitskopie-Diff: src/math.ts', exact: true }).click();
    const diff = page.getByRole('heading', { name: 'Diff · src/math.ts', exact: true });
    await page.getByText('+export function add(a: number, b: number) { return Number(a) + Number(b) + 0 }', { exact: true }).waitFor();
    await focus(diff); await chapter('03 · Inspect the real local Git diff'); await delay(9500);
    report.checks.push('Real Git unstaged diff rendered; no remote clone or transfer');
    await page.getByRole('checkbox', { name: 'Auswählen: src/math.ts' }).check();
    const impactResult = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/repositories/101/impact') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Auswirkungen prüfen (1/200)' }).click();
    const impact = await (await impactResult).json();
    check(impact.queried?.includes('src/math.ts') && impact.graph?.nodes?.length > 0 && !impact.skipped?.some(item => item.path === 'src/math.ts'), 'Real graph evidence missing');
    report.impact = { files: impact.queried, nodes: impact.graph.nodes.length, edges: impact.graph.edges.length };
    const graphHeading = page.getByRole('heading', { name: 'Auswirkungen der ausgewählten Änderungen', exact: true });
    await graphHeading.evaluate(element => element.closest('section').scrollIntoView({ block: 'start', behavior: 'smooth' }));
    await delay(700); await chapter('04 · Explore Codegraph impact hints'); await delay(10000); await screenshot(page, 'codegraph.png');
    report.checks.push('Real indexed Codegraph returned nodes for the selected source file');
    await page.getByRole('link', { name: 'Review vorbereiten', exact: true }).click();
    await page.getByLabel('Aufgabe', { exact: true }).waitFor();
    check(await page.getByLabel(/^Arbeitsort/).inputValue() === '101', 'Review lost its explicit repository');
    await focus(page.getByLabel('Aufgabe', { exact: true })); await chapter('05 · Prepare a scoped review — no agent started'); await delay(10000);
    await navigate('github', '101');
    const memoryRow = page.locator('li').filter({ has: page.getByRole('checkbox', { name: 'Auswählen: docs/decision.md' }) });
    await focus(memoryRow); await chapter('06 · Keep a source-linked knowledge proposal');
    await memoryRow.getByRole('button', { name: 'Als Wissen vorschlagen', exact: true }).click(); await delay(2500);
    await memoryRow.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    await page.getByRole('link', { name: 'Wissensvorschlag im Projektgedächtnis prüfen', exact: true }).click();
    await page.locator('.ev-memory-card').first().getByText('Vorgeschlagen', { exact: true }).waitFor();
    await focus(page.locator('.ev-memory-card').first()); await delay(6500);
    const memory = await api(page, `/projects/${project.id}/memory`);
    check(memory.items.some(item => item.status === 'proposed' && item.body.includes('keeps reviewed changes')) && !memory.settings.enabled && !memory.settings.cloudAllowed, 'Memory proposal provenance/paused state mismatch');
    report.checks.push('File stored as proposed; no verification or cloud processing enabled');
    check(!existsSync(join(state, 'workflow-rpc.json')), 'Demo unexpectedly started a synthetic agent');
    await chapter('HAPI-eVolved · Independent HAPI fork · Source preview');
    await delay(Math.max(0, 76000 - (Date.now() - recordingStarted)));
    report.videoSeconds = Math.round((Date.now() - recordingStarted) / 100) / 10;
    check(report.videoSeconds >= 60 && report.videoSeconds <= 90, 'Recording outside 60–90 seconds');
    const video = page.video(); await recording.close(); recording = null;
    await video.saveAs(join(output, 'walkthrough.webm'));
    const mobile = await browser.newContext({ storageState, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
    await guard(mobile); await caption(mobile); const phone = await mobile.newPage();
    await phone.goto(`${origin}/evolved?${new URLSearchParams({ project: project.id, tab: 'overview' })}`);
    await phone.getByRole('heading', { name: 'Bereit für den nächsten Schritt?' }).waitFor();
    await phone.locator('#community-chapter').evaluate(element => { element.textContent = 'Your project, on mobile'; });
    await screenshot(phone, 'mobile.png'); await mobile.close();
    check(report.pageErrors.length === 0 && report.externalRequests.length === 0, 'Browser error or attempted external request');
    const unexpected = report.httpErrors.filter(item => !(item.status === 503 && /\/providers\/(claude|codex)\/models\/refresh$/.test(item.path)));
    check(unexpected.length === 0, 'Unexpected HTTP failure');
    report.httpErrors = report.httpErrors.map(item => ({ path: item.path.replace(project.id, ':synthetic-project'), status: item.status }));
    report.limits = 'No external provider, remote Git transfer, mobile-device hardware, user enrollment video, security certification or performance claim. Native model refresh is unavailable without a real provider/control service. Demo captions are an added presentation strip; all product status text is unchanged.';
    for (const name of names.filter(name => name !== 'recording.json')) {
        const file = join(output, name); check(statSync(file).size < 90 * 1024 * 1024, 'Media exceeds repository size limit');
        report.files[name] = { sha256: hash(file), bytes: statSync(file).size };
    }
    report.inputs = Object.fromEntries(['scripts/community/record-demo.mjs', 'scripts/community/seed-math.ts', 'web/scripts/evolved-browser-hub.ts', 'web/scripts/evolved-workflow-fixture.ts', 'bun.lock', 'services/codegraph/package-lock.json', 'web/dist/index.html'].map(name => [name, hash(join(repo, name))]));
    report.result = 'PASS'; mkdirSync(assets, { recursive: true });
    for (const name of names.filter(name => name !== 'recording.json')) copyFileSync(join(output, name), join(assets, name), constants.COPYFILE_EXCL);
    writeFileSync(join(assets, 'recording.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`PASS: ${report.videoSeconds}s walkthrough and three labelled screenshots in assets/community/`);
} catch (error) {
    process.exitCode = 1;
    // Errors may contain random local fixture URLs, so retain them privately.
    writeFileSync(join(output, 'failure.txt'), String(error) + '\n' + diagnostic, { mode: 0o600 });
    if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    console.error(`Demo failed; private diagnostics: ${output}`);
} finally {
    await recording?.close().catch(() => {}); await browser?.close();
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    rmSync(state, { recursive: true, force: true });
}
