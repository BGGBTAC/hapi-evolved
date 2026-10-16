/** Built UI + real isolated Hub/Vault/WebAuthn; synthetic internal Memory service, no inference. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = mkdtempSync('/tmp/hapi-evolved-ui-memory-'), output = mkdtempSync('/tmp/hapi-memory-browser-');
const report = { fixture: 'Built UI, real isolated Hub/Vault/WebAuthn; synthetic internal Memory catalog/check and empty-graph binding, no inference', checks: [], views: [], failures: [] };
const mark = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const check = (condition, message) => { if (!condition) throw Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const initialKey = 'synthetic-memory-browser-initial-key', reconnectedKey = 'synthetic-memory-browser-reconnected-key';
const dynamicModel = `synthetic-browser-model-${state.split('-').at(-1).toLowerCase()}`;
writeFileSync(join(state, 'memory-catalog.json'), JSON.stringify(['gpt-4.1-mini', 'text-embedding-3-small', 'text-embedding-3-large', dynamicModel]), { mode: 0o600 });
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
const hub = await port(), vault = await port(), origin = `http://localhost:${hub}`;
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: repo,
    env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hub), EVOLVED_TEST_VAULT_PORT: String(vault), EVOLVED_TEST_MEMORY: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', browser, page;
child.stderr.on('data', data => { stderr = (stderr + data).slice(-20000); });
try {
    let ready = false;
    for (let n = 0; n < 200; n++) { if (child.exitCode !== null) throw Error('Fixture stopped'); try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch {} await delay(100); }
    check(ready, 'Hub fixture startup timeout');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    page = await context.newPage(); const pageErrors = [], consoleErrors = [], failedResponses = [], projectIds = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ message: message.text().split('\n')[0], path: message.location().url ? new URL(message.location().url).pathname : null }); });
    page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin); await page.getByLabel('Benutzername', { exact: true }).fill('Memory browser fixture');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await page.getByLabel('Ich habe die Codes sicher gespeichert.').check(); await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('heading', { name: 'Übersicht', exact: true }).waitFor();
    const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
        const response = await fetch(`/api/evolved${path}`, { method, credentials: 'same-origin', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        if (!response.ok) throw Error(`Fixture API ${method} ${path} ${response.status}`);
        return response.json();
    }, { path, method, body });
    const { team } = await api('/teams', 'POST', { name: 'Memory browser team' });
    const { project } = await api('/projects', 'POST', { teamId: team.id, name: 'Configured memory project' });
    const { project: second } = await api('/projects', 'POST', { teamId: team.id, name: 'Independent memory project' });
    projectIds.push(project.id, second.id);
    writeFileSync(join(state, 'memory-projects.json'), JSON.stringify(projectIds), { mode: 0o600 });
    const observations = () => JSON.parse(readFileSync(join(state, 'memory-observed.json'), 'utf8'));
    mark('Real Passkey registration, team and independent projects');
    const provider = () => page.locator('#memory-provider');
    const keyField = () => provider().getByLabel('OpenAI-API-Key', { exact: true });
    async function navigate(id) {
        await page.goto(`${origin}/evolved?tab=memory&project=${id}`);
        await keyField().waitFor();
    }
    async function assertNoStoredKey() {
        const browserStorage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
        check(!browserStorage.includes(initialKey) && !browserStorage.includes(reconnectedKey), 'API key appeared in browser storage');
        check(await keyField().inputValue() === '', 'API key remained in input');
    }
    async function capture(name, width) {
        await assertNoStoredKey();
        await page.setViewportSize({ width, height: 1600 });
        const details = provider().locator('details');
        if (await details.evaluate(element => element.open)) await details.locator('summary').click();
        await provider().evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest' })); await delay(100);
        const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
        check(layout.scrollWidth <= layout.width + 1, `${name}/${width}: horizontal overflow`);
        const path = join(output, `${name}-${width}.png`); await provider().screenshot({ path });
        report.views.push({ name, width, path, ...layout });
    }
    async function loadAndSelect(key) {
        await keyField().fill(key);
        await provider().getByRole('button', { name: 'Modelle vom Anbieter laden', exact: true }).click();
        await provider().getByText('4 Modelle direkt vom Anbieter geladen.', { exact: false }).waitFor();
        await provider().getByLabel('Sprachmodell', { exact: true }).selectOption(dynamicModel);
        await provider().getByLabel('Embedding-Modell', { exact: true }).selectOption('text-embedding-3-small');
        await provider().getByLabel('Sprachmodell: Eingabe', { exact: true }).fill('0.12');
        await provider().getByLabel('Sprachmodell: Ausgabe', { exact: true }).fill('0.34');
        await provider().getByLabel('Embeddings: Eingabe', { exact: true }).fill('0.02');
    }
    async function save() {
        const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/evolved/projects/${project.id}/memory/provider` && value.request().method() === 'PUT');
        await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).click();
        const saved = await response; check(saved.ok(), 'Memory setup save failed');
        const body = await saved.text(); check(!body.includes(initialKey) && !body.includes(reconnectedKey) && !Object.hasOwn(JSON.parse(body), 'apiKey'), 'Save response disclosed a key');
        await provider().getByText('Einrichtung verschlüsselt gespeichert.', { exact: false }).waitFor();
        await assertNoStoredKey();
    }
    await navigate(project.id);
    check(await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).isDisabled(), 'Unconfigured provider can be tested');
    const providerWindowStarted = Date.now();
    await loadAndSelect(initialKey); await save();
    const configured = await api(`/projects/${project.id}/memory/provider`);
    check(configured.configured && configured.apiKeyConfigured && configured.config.model === dynamicModel, 'Dynamic provider model was not persisted');
    check(!Object.hasOwn(configured.config, 'apiKey'), 'Status returned a plaintext API key');
    check(observations().bindings.length === 1 && observations().bindings[0].projectId === project.id
        && observations().bindings[0].embeddingModel === 'text-embedding-3-small', 'First setup skipped the project embedding binding');
    mark('Dynamic provider catalog, explicit model/prices, encrypted Vault save and cleared key input');
    for (const width of [1440, 390, 320]) await capture('memory-setup-compact', width);
    for (const embeddingModel of ['text-embedding-3-large', 'text-embedding-3-small']) {
        const previousBindings = observations().bindings.length;
        await provider().getByLabel('Embedding-Modell', { exact: true }).selectOption(embeddingModel);
        check(await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).isDisabled(), 'Unsaved embedding change can be tested');
        await save();
        const changed = await api(`/projects/${project.id}/memory/provider`);
        check(changed.config.embeddingModel === embeddingModel && changed.boundEmbeddingModel === embeddingModel, 'Embedding switch was not persisted');
        const observed = observations(), binding = observed.bindings.at(-1);
        check(observed.bindings.length === previousBindings + 1 && binding.projectId === project.id
            && binding.embeddingModel === embeddingModel && binding.embeddingDimensions === 1536
            && observed.inferenceRequests === 0, 'Embedding switch skipped the scoped empty-graph binding or attempted inference');
    }
    mark('Explicit embedding changes use the empty-graph binding for each model and retain the stored key without inference');
    await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).click();
    await provider().getByText('Eine kostenpflichtige KI-Anfrage wurde nicht ausgeführt;', { exact: false }).waitFor();
    const memory = await api(`/projects/${project.id}/memory`);
    check(memory.settings.enabled === false && memory.settings.cloudAllowed === false, 'Connection setup implicitly enabled cloud processing');
    check(observations().configurationChecks > 0 && observations().inferenceRequests === 0, 'Connection test attempted inference');
    mark('Connection test checks catalog/database without inference; cloud processing stays disabled');
    await navigate(second.id);
    const untouched = await api(`/projects/${second.id}/memory/provider`);
    check(!untouched.configured && !untouched.apiKeyConfigured && untouched.config === null, 'Configuration crossed project boundary');
    await assertNoStoredKey();
    check(await provider().getByLabel('Sprachmodell', { exact: true }).inputValue() === '', 'Previous project model remained in form');
    await keyField().fill('synthetic-unsaved-key-discarded');
    await navigate(project.id); await assertNoStoredKey();
    mark('Second project remains unconfigured; project navigation clears unsaved credentials');
    await provider().getByRole('button', { name: 'Verbindung entfernen', exact: true }).click();
    await provider().getByRole('button', { name: 'Bestätigen', exact: true }).click();
    await provider().getByText('Projektverbindung entfernt.', { exact: false }).waitFor();
    const removed = await api(`/projects/${project.id}/memory/provider`);
    check(!removed.configured && !removed.apiKeyConfigured && removed.source === 'disabled', 'Deleted project connection fell back to operator credentials');
    for (const width of [1440, 390, 320]) await capture('memory-removed', width);
    // Exercise the real six-checks/minute limit without bypassing it or retrying
    // mutations. Setup plus both model changes used five checks in this window.
    if (Date.now() < providerWindowStarted + 61_000) console.log('Waiting for the real provider-check rate window before reconnecting');
    while (Date.now() < providerWindowStarted + 61_000) await delay(Math.min(30_000, providerWindowStarted + 61_000 - Date.now()));
    await loadAndSelect(reconnectedKey); await save();
    await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).click();
    await provider().getByText('Eine kostenpflichtige KI-Anfrage wurde nicht ausgeführt;', { exact: false }).waitFor();
    await assertNoStoredKey();
    const reconnected = await api(`/projects/${project.id}/memory/provider`);
    check(reconnected.configured && reconnected.version > removed.version, 'Reconnection did not replace the disabled configuration');
    check(observations().keyLabels.includes('reconnected') && observations().inferenceRequests === 0, 'Reconnection did not use the new synthetic credential');
    mark('Remove and reconnect use a new credential, preserve project scope and perform no inference');
    report.memoryService = observations();
    check(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);
    report.pageErrors = pageErrors; report.consoleErrors = consoleErrors; report.failedResponses = failedResponses;
    const knownUnavailable = (path, status) => status === 403 && ['/api/hub-settings', '/api/voice/transcription/providers', '/api/voice/backend'].includes(path)
        || status === 503 && projectIds.some(id => ['claude', 'codex'].some(agent => path === `/api/evolved/projects/${id}/providers/${agent}/models/refresh`));
    const knownConsole = item => [
        "SW registration error: TypeError: Cannot read properties of undefined (reading 'waiting')",
        'Failed to update visibility: TypeError: Failed to fetch',
        'Failed to reconcile queued state after SSE connect: TypeError: Failed to fetch',
        'Could not detect voice backend: ApiError: HTTP 403 Forbidden: {"error":"Endpoint unavailable in Evolved."}',
    ].includes(item.message) || /^Failed to load resource: the server responded with a status of (403|503) /.test(item.message)
        && knownUnavailable(item.path, Number(item.message.match(/status of (\d+)/)?.[1]));
    report.unexpectedConsole = consoleErrors.filter(item => !knownConsole(item));
    report.unexpectedResponses = failedResponses.filter(item => !knownUnavailable(item.path, item.status));
    check(report.unexpectedConsole.length === 0, 'Unexpected browser console errors; inspect report');
    check(report.unexpectedResponses.length === 0, 'Unexpected HTTP errors; inspect report');
    report.result = 'PASS'; console.log(`PASS Memory browser setup: ${report.checks.length} checks; ${output}`);
} catch (error) {
    report.result = 'FAIL'; report.failures.push(String(error));
    if (page) {
        // Never capture a key, even synthetic, in a diagnostic screenshot.
        await page.locator('input[type=password]').fill('').catch(() => {});
        writeFileSync(join(output, 'failure-body.txt'), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 });
        await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    }
    console.error(String(error)); process.exitCode = 1;
} finally {
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    if (report.result !== 'PASS') writeFileSync(join(output, 'fixture-errors.txt'), stderr, { mode: 0o600 });
    await browser?.close(); child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(state, { recursive: true, force: true }); console.log(`Report: ${output}/report.json`);
}
