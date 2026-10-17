/** Built UI + real isolated Hub/Vault/WebAuthn; synthetic internal Memory service, no inference. */
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
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
const embeddingKey = 'synthetic-memory-browser-embedding-key', openaiEmbeddingKey = 'synthetic-memory-browser-openai-embedding-key';
const reconnectedEmbeddingKey = 'synthetic-memory-browser-reconnected-embedding-key', rerankerKey = 'synthetic-memory-browser-reranker-key';
const allKeys = [initialKey, reconnectedKey, embeddingKey, openaiEmbeddingKey, reconnectedEmbeddingKey, rerankerKey];
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
    page = await context.newPage(); const pageErrors = [], consoleErrors = [], failedResponses = [], projectIds = [], requests = [];
    page.on('request', request => requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() }));
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ message: message.text().split('\n')[0], path: message.location().url ? new URL(message.location().url).pathname : null }); });
    page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
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
    const keyField = () => provider().getByLabel('Sprachmodell: API-Key', { exact: true });
    async function navigate(id) {
        await page.goto(`${origin}/evolved?tab=memory&project=${id}`);
        await keyField().waitFor();
    }
    async function assertNoStoredKey(allowDraft = false) {
        const browserStorage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
        check(allKeys.every(key => !browserStorage.includes(key)), 'API key appeared in browser storage');
        if (!allowDraft) for (const field of await provider().locator('input[type=password]').all()) check(await field.inputValue() === '', 'API key remained in input');
    }
    async function capture(name, width, allowDraft = false) {
        await assertNoStoredKey(allowDraft);
        await page.setViewportSize({ width, height: 1600 });
        for (const details of await provider().locator('details').all()) {
            if (await details.evaluate(element => element.open)) await details.locator('summary').click();
        }
        await provider().evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest' })); await delay(100);
        const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
        check(layout.scrollWidth <= layout.width + 1, `${name}/${width}: horizontal overflow`);
        // The workspace scrolls inside its own pane. An element screenshot would
        // include a large blank area beneath the clipped pane on mobile screens.
        const path = join(output, `${name}-${width}.png`); await page.screenshot({ path });
        report.views.push({ name, width, path, ...layout });
    }
    async function loadAndSelect(key, vectorKey, vectorProvider) {
        await keyField().fill(key);
        await provider().getByRole('button', { name: 'Sprachmodell: Modelle laden', exact: true }).click();
        await provider().getByText('4 Modelle direkt vom Anbieter geladen.', { exact: false }).waitFor();
        await provider().getByLabel('Sprachmodell: Modell', { exact: true }).fill(dynamicModel);
        await provider().getByLabel('Embeddings: Anbieter', { exact: true }).selectOption(vectorProvider);
        await provider().getByLabel('Embeddings: API-Key', { exact: true }).fill(vectorKey);
        await provider().getByLabel('Embeddings: Modell', { exact: true }).fill(vectorProvider === 'voyage' ? 'synthetic-voyage-embedding' : 'text-embedding-3-small');
        await provider().getByLabel('Embeddings: Dimensionen', { exact: true }).fill(vectorProvider === 'voyage' ? '1024' : '1536');
        await provider().getByLabel('Sprachmodell: Eingabe', { exact: true }).fill('0.12');
        await provider().getByLabel('Sprachmodell: Ausgabe', { exact: true }).fill('0.34');
        await provider().getByLabel('Embeddings: Eingabe', { exact: true }).fill('0.02');
    }
    async function save() {
        const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/evolved/projects/${project.id}/memory/provider` && value.request().method() === 'PUT');
        await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).click();
        const saved = await response; check(saved.ok(), 'Memory setup save failed');
        const body = await saved.text(); check(allKeys.every(key => !body.includes(key)) && !body.includes('"apiKey"'), 'Save response disclosed a key');
        await provider().getByText('Einrichtung verschlüsselt gespeichert.', { exact: false }).waitFor();
        await assertNoStoredKey();
    }
    await navigate(project.id);
    check(await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).isDisabled(), 'Unconfigured provider can be tested');
    const providerPath = `/api/evolved/projects/${project.id}/memory/provider`;
    const providerWrites = () => requests.filter(request => request.path === providerPath && request.method === 'PUT');
    const assertDraft = async () => {
        check(await keyField().inputValue() === initialKey && await provider().getByLabel('Embeddings: API-Key', { exact: true }).inputValue() === embeddingKey, 'Unsaved keys were discarded');
        await assertNoStoredKey(true);
    };
    await keyField().fill(initialKey); await provider().getByLabel('Embeddings: API-Key', { exact: true }).fill(embeddingKey);
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        check(await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).isEnabled(), 'Dirty incomplete setup hides its validation behind a disabled button');
        await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).click();
        check(await provider().getByLabel('Sprachmodell: Modell', { exact: true }).evaluate(element => element === document.activeElement), 'Invalid save did not focus the first missing model');
        await page.locator('#memory-setup-validation a[href="#memory-embedding-input-price"]').click();
        check(await provider().getByLabel('Embeddings: Eingabe', { exact: true }).evaluate(element => element === document.activeElement && element.closest('details').open), 'Validation link did not reveal and focus the missing embedding price');
        await assertDraft(); await capture('memory-missing-fields', width, true);
    }
    check(providerWrites().length === 0, 'Incomplete setup attempted a provider request');
    mark('Mobile incomplete setup explains missing fields, focuses models/prices and makes no provider request at 390/320 px');
    const providerWindowStarted = Date.now();
    await loadAndSelect(initialKey, embeddingKey, 'voyage');
    // Age only this disposable fixture session to exercise the real fresh-passkey
    // requirement. Budget changes have a separate permission boundary.
    execFileSync('bun', ['-e', `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]); db.prepare('UPDATE evolved_sessions SET created_at=?').run(Date.now()-6*60_000); db.close()`, join(state, 'evolved.db')]);
    const loginCount = requests.filter(request => request.path.endsWith('/auth/login/options')).length;
    await page.getByLabel('Monatslimit (USD)', { exact: true }).fill('17');
    await page.getByRole('button', { name: 'Cloud und Budget speichern', exact: true }).click();
    await page.getByText('Cloud-Freigabe und Budget gespeichert.', { exact: true }).waitFor();
    await assertDraft();
    check(await provider().getByLabel('Sprachmodell: Modell', { exact: true }).inputValue() === dynamicModel && await provider().getByLabel('Sprachmodell: Eingabe', { exact: true }).inputValue() === '0.12', 'Budget save changed the provider draft');
    const settingsWrites = requests.filter(request => request.path.endsWith('/memory/settings') && request.method === 'PATCH');
    check(settingsWrites.length === 1 && Object.keys(settingsWrites[0].body).sort().join(',') === 'cloudAllowed,enabled,jobBudgetMicros,monthlyBudgetMicros' && settingsWrites[0].body.monthlyBudgetMicros === 17_000_000 && providerWrites().length === 0, 'Budget save wrote provider credentials or unexpected fields');
    check(requests.filter(request => request.path.endsWith('/auth/login/options')).length === loginCount, 'Budget save unexpectedly required a fresh passkey');
    mark('Cloud/budget save changes only budget settings and preserves complete unsaved provider credentials with an aged session');
    // Cancel a real browser credential request without waiting for its timeout.
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    await page.evaluate(() => {
        const original = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = options => {
            navigator.credentials.get = original;
            const controller = new AbortController(); window.memoryCredentialCancellation = controller;
            return original({ ...options, signal: controller.signal });
        };
    });
    await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).click();
    await page.waitForFunction(() => !!window.memoryCredentialCancellation);
    await page.evaluate(() => { window.memoryCredentialCancellation.abort(); delete window.memoryCredentialCancellation; });
    await provider().getByText('Speichern oder Prüfen der Einrichtung konnte nicht bestätigt werden.', { exact: false }).waitFor();
    await assertDraft(); check(providerWrites().length === 1, 'Canceled passkey retried the provider mutation');
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
    mark('Canceling the browser passkey confirmation preserves provider keys and does not retry its rejected mutation');
    let mutationAttempts = 0;
    const failedMutation = async route => {
        if (route.request().method() !== 'PUT' || ++mutationAttempts === 1) return route.continue();
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic save outage' }) });
    };
    const failedRenewal = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic renewal outage' }) });
    await page.route(`${origin}${providerPath}`, failedMutation);
    await page.route(`${origin}/api/evolved/session-token?*`, failedRenewal);
    await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).click();
    await page.getByText('Die Verbindung konnte gerade nicht erneuert werden.', { exact: false }).waitFor();
    await provider().getByText('Speichern oder Prüfen der Einrichtung konnte nicht bestätigt werden.', { exact: false }).waitFor();
    await assertDraft(); check(providerWrites().length === 3, 'Real step-up did not retry exactly once before the synthetic save failure');
    await page.unroute(`${origin}${providerPath}`, failedMutation); await page.unroute(`${origin}/api/evolved/session-token?*`, failedRenewal);
    await page.getByRole('button', { name: 'Verbindung erneut prüfen', exact: true }).click();
    await page.getByText('Die Verbindung konnte gerade nicht erneuert werden.', { exact: false }).waitFor({ state: 'hidden' });
    await assertDraft(); await save();
    check(providerWrites().length === 4 && providerWrites().every(request => request.body.version === 0 && request.body.llm.apiKey === initialKey && request.body.embedding.apiKey === embeddingKey), 'Retry changed or lost unsaved credentials or their CAS version');
    mark('Same-user passkey step-up plus temporary bridge/save failures preserve the mounted draft; explicit retry saves it and only then clears keys');
    const configured = await api(`/projects/${project.id}/memory/provider`);
    check(configured.configured && configured.apiKeyConfigured && configured.config.llm.model === dynamicModel && configured.config.llm.provider === 'anthropic' && configured.config.embedding.provider === 'voyage' && configured.config.reranker.provider === 'rrf', 'Dynamic provider model was not persisted');
    check(!JSON.stringify(configured).includes('"apiKey"'), 'Status returned a plaintext API key');
    check(observations().bindings.length === 1 && observations().bindings[0].projectId === project.id
        && observations().bindings[0].embeddingProvider === 'voyage' && observations().bindings[0].embeddingModel === 'synthetic-voyage-embedding' && observations().bindings[0].embeddingDimensions === 1024, 'First setup skipped the project embedding binding');
    mark('Claude + Voyage + local RRF without OpenAI: dynamic LLM catalog, manual embeddings, explicit prices, encrypted Vault save and separate cleared keys');
    await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).click();
    await provider().getByText('Für Embeddings gibt es keinen Modellkatalog: API-Key und Modell bleiben ungeprüft.', { exact: false }).waitFor();
    check(await provider().getByText('Verbindung prüfen', { exact: false }).getAttribute('data-complete') === 'false', 'Partial connection check incorrectly marked all keys verified');
    mark('Voyage connection check reports the unverified credential/model and keeps step three incomplete');
    for (const width of [1440, 390, 320]) await capture('memory-setup-compact', width);
    for (const [embeddingProvider, embeddingModel, dimensions] of [
        ['voyage', 'synthetic-voyage-alternative', 1024], ['openai', 'text-embedding-3-small', 1536],
    ]) {
        const previousBindings = observations().bindings.length;
        if (embeddingProvider === 'openai') {
            await provider().getByLabel('Embeddings: Anbieter', { exact: true }).selectOption('openai');
            check(await provider().getByLabel('Embeddings: API-Key', { exact: true }).inputValue() === '', 'Embedding provider switch reused its previous key');
            const writes = providerWrites().length;
            await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).click();
            check(await provider().getByLabel('Embeddings: API-Key', { exact: true }).evaluate(element => element === document.activeElement) && providerWrites().length === writes, 'New embedding provider accepted a missing key instead of explaining it');
            await provider().getByLabel('Embeddings: API-Key', { exact: true }).fill(openaiEmbeddingKey);
        }
        await provider().getByLabel('Embeddings: Modell', { exact: true }).fill(embeddingModel);
        await provider().getByLabel('Embeddings: Eingabe', { exact: true }).fill('0.02');
        check(await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).isDisabled(), 'Unsaved embedding change can be tested');
        await save();
        const changed = await api(`/projects/${project.id}/memory/provider`);
        check(changed.config.embedding.model === embeddingModel && changed.boundEmbeddingModel === embeddingModel
            && changed.boundEmbeddingProvider === embeddingProvider && changed.boundEmbeddingDimensions === dimensions, 'Embedding switch was not persisted');
        const observed = observations(), binding = observed.bindings.at(-1);
        check(observed.bindings.length === previousBindings + 1 && binding.projectId === project.id
            && binding.embeddingProvider === embeddingProvider && binding.embeddingModel === embeddingModel && binding.embeddingDimensions === dimensions
            && observed.inferenceRequests === 0, 'Embedding switch skipped the scoped empty-graph binding or attempted inference');
    }
    mark('Embedding model/provider/dimension changes use the empty-graph binding and require a separate key for a new provider');
    await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).click();
    await provider().getByText('API-Keys akzeptiert, Modelle im Katalog gefunden', { exact: false }).waitFor();
    const memory = await api(`/projects/${project.id}/memory`);
    check(memory.settings.enabled === false && memory.settings.cloudAllowed === false, 'Connection setup implicitly enabled cloud processing');
    check(observations().configurationChecks > 0 && observations().inferenceRequests === 0, 'Connection test attempted inference');
    mark('Connection test checks catalog/database without inference; cloud processing stays disabled');
    await navigate(second.id);
    const untouched = await api(`/projects/${second.id}/memory/provider`);
    check(!untouched.configured && !untouched.apiKeyConfigured && untouched.config === null, 'Configuration crossed project boundary');
    await assertNoStoredKey();
    check(await provider().getByLabel('Sprachmodell: Modell', { exact: true }).inputValue() === '', 'Previous project model remained in form');
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
    // mutations. Setup, partial/full tests and both embedding changes used six checks.
    if (Date.now() < providerWindowStarted + 61_000) console.log('Waiting for the real provider-check rate window before reconnecting');
    while (Date.now() < providerWindowStarted + 61_000) await delay(Math.min(30_000, providerWindowStarted + 61_000 - Date.now()));
    await loadAndSelect(reconnectedKey, reconnectedEmbeddingKey, 'openai'); await save();
    await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).click();
    await provider().getByText('Keine kostenpflichtige KI-Anfrage ausgeführt;', { exact: false }).waitFor();
    await assertNoStoredKey();
    const reconnected = await api(`/projects/${project.id}/memory/provider`);
    check(reconnected.configured && reconnected.version > removed.version, 'Reconnection did not replace the disabled configuration');
    check(observations().keyLabels.includes('reconnected') && observations().inferenceRequests === 0, 'Reconnection did not use the new synthetic credential');
    mark('Remove and reconnect use a new credential, preserve project scope and perform no inference');
    await provider().getByLabel('Suchtrefferbewertung: Anbieter', { exact: true }).selectOption('voyage');
    await provider().getByLabel('Suchtrefferbewertung: Modell', { exact: true }).fill('synthetic-voyage-reranker');
    await provider().getByLabel('Suchtrefferbewertung: Eingabe', { exact: true }).fill('0.05');
    const writesBeforeReranker = providerWrites().length;
    await provider().getByRole('button', { name: 'Einrichtung speichern', exact: true }).click();
    check(await provider().getByLabel('Suchtrefferbewertung: API-Key', { exact: true }).evaluate(element => element === document.activeElement) && providerWrites().length === writesBeforeReranker, 'Paid reranker reused another component key instead of explaining the missing key');
    await provider().getByLabel('Suchtrefferbewertung: API-Key', { exact: true }).fill(rerankerKey);
    await save();
    await provider().getByRole('button', { name: 'Verbindung testen', exact: true }).click();
    await provider().getByText('Für Suchtrefferbewertung gibt es keinen Modellkatalog: API-Key und Modell bleiben ungeprüft.', { exact: false }).waitFor();
    await provider().getByLabel('Suchtrefferbewertung: Anbieter', { exact: true }).selectOption('rrf');
    await save();
    const localRanking = await api(`/projects/${project.id}/memory/provider`);
    check(JSON.stringify(localRanking.config.reranker) === JSON.stringify({ provider: 'rrf' }) && localRanking.keyConfigured.reranker === false, 'Local ranking retained paid provider fields');
    check(observations().inferenceRequests === 0, 'Reranker setup invoked inference');
    mark('Voyage reranking requires its own key, reports partial verification, and can return to local RRF without paid parameters');
    report.memoryService = observations();
    check(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);
    report.pageErrors = pageErrors; report.consoleErrors = consoleErrors; report.failedResponses = failedResponses;
    for (const [path, status, count] of [[providerPath, 403, 2], [providerPath, 503, 1], ['/api/evolved/session-token', 503, 1]]) {
        check(failedResponses.filter(response => response.path === path && response.status === status).length === count, `Unexpected count for deliberate ${status} scenario: ${path}`);
    }
    const knownUnavailable = (path, status) => path === providerPath && [403, 503].includes(status) || path === '/api/evolved/session-token' && status === 503
        || status === 403 && ['/api/hub-settings', '/api/voice/transcription/providers', '/api/voice/backend'].includes(path)
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
        for (const field of await page.locator('input[type=password]').all()) await field.fill('').catch(() => {});
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
