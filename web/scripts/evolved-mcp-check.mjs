/** Built UI + real isolated Hub/Vault/WebAuthn; synthetic remote discovery, no external calls. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = mkdtempSync('/tmp/hapi-evolved-ui-mcp-'), output = mkdtempSync('/tmp/hapi-mcp-browser-');
const report = { fixture: 'Built UI, real isolated Hub/Vault/WebAuthn, injected synthetic remote discovery; no external MCP calls', checks: [], views: [], failures: [] };
const mark = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const check = (condition, message) => { if (!condition) throw Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const syntheticKey = 'synthetic-mcp-browser-private-key';
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
const hub = await port(), vault = await port(), origin = `http://localhost:${hub}`;
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: repo,
    env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hub), EVOLVED_TEST_VAULT_PORT: String(vault), EVOLVED_TEST_MCP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let fixtureLog = '', browser, page;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { fixtureLog = (fixtureLog + data).slice(-80000); });
try {
    let ready = false;
    for (let n = 0; n < 200; n++) { if (child.exitCode !== null) throw Error('Fixture stopped'); try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch {} await delay(100); }
    check(ready, 'Hub fixture startup timeout');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
    page = await context.newPage(); const pageErrors = [], consoleErrors = [], failedResponses = [], requests = [], responseChecks = [], external = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => { if (message.text().includes(syntheticKey)) throw Error('Synthetic credential leaked to console'); if (message.type() === 'error') consoleErrors.push({ message: message.text().split('\n')[0], path: message.location().url ? new URL(message.location().url).pathname : null }); });
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname.includes('/mcp')) requests.push({ path: url.pathname, method: request.method() }); if (!['localhost', '127.0.0.1'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) external.push(url.hostname); });
    page.on('response', response => {
        if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
        if (new URL(response.url()).pathname.includes('/mcp')) responseChecks.push(response.text().then(body => check(!body.includes(syntheticKey), 'MCP response disclosed credential')).catch(error => { if (!/No resource|Protocol error|aborted/i.test(String(error))) throw error; }));
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin); await page.getByLabel('Benutzername', { exact: true }).fill('MCP browser fixture');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await page.getByLabel('Ich habe die Codes sicher gespeichert.').check(); await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('heading', { name: 'Übersicht', exact: true }).waitFor();
    const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
        const response = await fetch(`/api/evolved${path}`, { method, credentials: 'same-origin', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        if (!response.ok) throw Error(`Fixture API ${method} ${path} ${response.status}`);
        return response.json();
    }, { path, method, body });
    const { team } = await api('/teams', 'POST', { name: 'MCP browser team' });
    const { project } = await api('/projects', 'POST', { teamId: team.id, name: 'Documentation project' });
    const { project: second } = await api('/projects', 'POST', { teamId: team.id, name: 'Independent project' });
    const observations = () => JSON.parse(readFileSync(join(state, 'mcp-observed.json'), 'utf8'));
    const card = () => page.getByRole('article', { name: 'Context7', exact: true });
    async function navigate(id) {
        await page.goto(`${origin}/evolved?tab=mcp&project=${id}`);
        await page.getByRole('button', { name: 'Context7 einrichten', exact: true }).waitFor();
    }
    async function assertNoStoredKey() {
        const browserData = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, dom: document.body.innerHTML }));
        check(!browserData.includes(syntheticKey), 'Credential appeared in DOM or browser storage');
        check(!fixtureLog.includes(syntheticKey), 'Credential appeared in fixture logs');
    }
    async function capture(name, width) {
        await assertNoStoredKey(); await page.setViewportSize({ width, height: 1100 }); await page.mouse.move(width - 10, 5);
        await (name === 'mcp-grants' ? card().locator('.ev-mcp-tools') : name === 'mcp-tools' ? card() : page.locator('.ev-mcp-shop')).evaluate(element => element.scrollIntoView({ block: 'start' })); await delay(100);
        const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, contentWidth: document.querySelector('#workspace-content').clientWidth, contentScrollWidth: document.querySelector('#workspace-content').scrollWidth }));
        check(layout.scrollWidth <= layout.width + 1 && layout.contentScrollWidth <= layout.contentWidth + 1, `${name}/${width}: horizontal overflow`);
        const path = join(output, `${name}-${width}.png`); await page.screenshot({ path }); report.views.push({ name, width, path, ...layout });
    }
    await navigate(project.id);
    check(observations().discoveries === 0 && observations().calls === 0, 'Page load contacted remote server');
    await page.getByRole('button', { name: 'Context7 einrichten', exact: true }).click();
    await page.getByLabel('Authentifizierung', { exact: true }).selectOption('bearer');
    await page.getByLabel('Zugangsschlüssel', { exact: true }).fill(syntheticKey);
    await page.getByRole('button', { name: 'Deaktiviert speichern', exact: true }).click();
    await card().getByText('Deaktiviert', { exact: true }).waitFor(); await assertNoStoredKey();
    const saved = (await api(`/projects/${project.id}/mcp`)).connections[0];
    check(saved.auth.configured && !saved.enabled && !saved.tools.length && observations().discoveries === 0, 'Creation was not inert and disabled');
    for (const file of ['vault.db', 'vault.db-wal']) if (existsSync(join(state, file))) check(!readFileSync(join(state, file)).includes(Buffer.from(syntheticKey)), 'Vault database contains a plaintext synthetic key');
    mark('Real Passkey, project-scoped encrypted creation, disabled until explicit discovery and grants');
    await card().getByRole('button', { name: 'Verbindung prüfen & Werkzeuge laden', exact: true }).click();
    await card().getByLabel('Freigeben: query-docs', { exact: true }).waitFor();
    check(observations().discoveries === 1 && observations().credentialAccepted && observations().calls === 0, 'Discovery did not use the synthetic credential or executed a tool');
    check(await card().getByLabel('Freigeben: query-docs', { exact: true }).isChecked() === false, 'Discovered tool was granted automatically');
    await card().getByLabel('Freigeben: query-docs', { exact: true }).check();
    check(await card().getByLabel('Nur lesend: query-docs', { exact: true }).isChecked(), 'Known Context7 read-only preset missing');
    await card().getByLabel('Für Agenten dieses Projekts aktivieren', { exact: true }).check();
    await card().getByRole('button', { name: 'Konfiguration speichern', exact: true }).click();
    await card().getByText('Verbindung und Werkzeugfreigaben gespeichert.', { exact: true }).waitFor();
    const enabled = (await api(`/projects/${project.id}/mcp`)).connections[0];
    check(enabled.enabled && enabled.enabledTools.join(',') === 'query-docs' && enabled.tools.find(tool => tool.name === 'query-docs').readOnly, 'Exact grants were not persisted');
    check(await page.locator('img[src="https://tracking.invalid/pixel"]').count() === 0, 'Untrusted remote description became HTML');
    mark('Explicit discovery, selected tool approval, read-only classification, untrusted descriptions as text');
    for (const width of [1440, 390, 320]) { await capture('mcp-tools', width); await capture('mcp-grants', width); }
    check(!requests.some(request => request.path.endsWith('/history')), 'History loaded before expansion');
    await card().getByText('Letzte Aufrufe', { exact: true }).click();
    await card().getByText('Noch keine Aufrufe für diese Verbindung.', { exact: true }).waitFor();
    check(requests.filter(request => request.path.endsWith('/history')).length === 1, 'History was not lazy');
    mark('History loads on expansion and contains metadata only');
    await card().getByRole('button', { name: 'Verwaltung schließen', exact: true }).click();
    for (const width of [1440, 390, 320]) await capture('mcp-overview', width);
    writeFileSync(join(state, 'mcp-control.json'), JSON.stringify({ delayMs: 1800 }));
    await card().getByRole('button', { name: 'Verbindung prüfen & Werkzeuge laden', exact: true }).click();
    for (let n = 0; n < 100 && observations().discoveries < 2; n++) await delay(20);
    check(observations().discoveries === 2, 'Slow discovery did not start');
    await card().getByRole('button', { name: 'Jetzt deaktivieren', exact: true }).click();
    await card().getByText('Deaktiviert', { exact: true }).waitFor(); await delay(2100);
    check(!(await api(`/projects/${project.id}/mcp`)).connections[0].enabled && observations().staleRejected === 1, 'Late discovery re-enabled or overwrote the disabled server');
    mark('Immediate disable during discovery wins both UI state and Hub/Vault CAS race');
    await card().getByRole('button', { name: 'Verwalten', exact: true }).click();
    await card().getByLabel('Zugang ändern', { exact: true }).check();
    await card().getByLabel('Neuer Zugangsschlüssel', { exact: true }).fill('synthetic-unsaved-project-draft');
    // Select in the existing SPA, preserving the account and router lifecycle.
    await page.getByRole('combobox', { name: 'Aktives Projekt', exact: true }).selectOption(second.id);
    await page.getByText(/Noch keine MCP-Verbindung eingerichtet/).waitFor();
    check(!(await api(`/projects/${second.id}/mcp`)).connections.length, 'MCP connection crossed project boundary');
    check(!(await page.locator('body').innerHTML()).includes('synthetic-unsaved-project-draft'), 'Draft survived project switch');
    await page.getByRole('combobox', { name: 'Aktives Projekt', exact: true }).selectOption(project.id);
    await card().waitFor(); check(await card().getByLabel('Neuer Zugangsschlüssel', { exact: true }).count() === 0, 'Old secret editor survived project roundtrip');
    await assertNoStoredKey(); mark('SPA project switching clears unsaved credentials and isolates connections');
    await card().getByRole('button', { name: 'Verwalten', exact: true }).click();
    await card().getByRole('button', { name: 'Verbindung entfernen', exact: true }).click();
    check((await api(`/projects/${project.id}/mcp`)).connections.length === 1, 'Delete happened without confirmation');
    await card().getByRole('button', { name: 'Bestätigen', exact: true }).click();
    await page.getByText(/Noch keine MCP-Verbindung eingerichtet/).waitFor();
    check(!(await api(`/projects/${project.id}/mcp`)).connections.length, 'Confirmed deletion did not remove connection');
    check(await page.getByRole('button', { name: 'Context7 einrichten', exact: true }).isVisible(), 'Empty catalog did not reopen after deletion');
    mark('Deletion requires explicit confirmation and removes the connection');
    await Promise.all(responseChecks); await assertNoStoredKey();
    check(observations().calls === 0 && external.length === 0, 'Browser check performed an external request or tool call');
    check(pageErrors.length === 0, 'Unhandled browser exception');
    const expectedUnavailable = (path, status) => status === 403 && ['/api/hub-settings', '/api/voice/transcription/providers', '/api/voice/backend'].includes(path)
        || status === 503 && [project.id, second.id].some(id => ['claude', 'codex'].some(agent => path === `/api/evolved/projects/${id}/providers/${agent}/models/refresh`));
    const expectedConsole = item => ["SW registration error: TypeError: Cannot read properties of undefined (reading 'waiting')", 'Failed to update visibility: TypeError: Failed to fetch', 'Failed to reconcile queued state after SSE connect: TypeError: Failed to fetch', 'Could not detect voice backend: ApiError: HTTP 403 Forbidden: {"error":"Endpoint unavailable in Evolved."}'].includes(item.message)
        || /^Failed to load resource: the server responded with a status of (403|503) /.test(item.message) && expectedUnavailable(item.path, Number(item.message.match(/status of (\d+)/)?.[1]));
    Object.assign(report, { observations: observations(), pageErrors, consoleErrors, failedResponses, unexpectedConsole: consoleErrors.filter(item => !expectedConsole(item)), unexpectedResponses: failedResponses.filter(item => !expectedUnavailable(item.path, item.status)), externalRequests: external.length });
    check(report.unexpectedConsole.length === 0 && report.unexpectedResponses.length === 0, 'Unexpected console or HTTP errors');
    report.result = 'PASS'; console.log(`PASS MCP browser setup: ${report.checks.length} checks; ${output}`);
} catch (error) {
    report.result = 'FAIL'; report.failures.push(String(error));
    if (page) { for (const field of await page.locator('input[type=password]').all()) await field.fill('').catch(() => {}); writeFileSync(join(output, 'failure-body.txt'), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 }); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
    console.error(String(error)); process.exitCode = 1;
} finally {
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    if (report.result !== 'PASS') writeFileSync(join(output, 'fixture-errors.txt'), fixtureLog.replaceAll(syntheticKey, '[redacted]'), { mode: 0o600 });
    await browser?.close(); child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(state, { recursive: true, force: true }); console.log(`Report: ${output}/report.json`);
}
