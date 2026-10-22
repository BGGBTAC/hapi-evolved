/** Built UI + real isolated Hub/Vault/WebAuthn: project browser card at 1440/390/320 px; no runner, browser or external calls. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = mkdtempSync('/tmp/hapi-evolved-ui-browser-'), output = mkdtempSync('/tmp/hapi-project-browser-check-');
const report = { fixture: 'Built UI, real isolated Hub/Vault/WebAuthn; no runner control, no browser sidecar, no external calls', checks: [], failures: [] };
const mark = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const check = (condition, message) => { if (!condition) throw Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    page = await context.newPage(); const pageErrors = [], external = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('request', request => { const url = new URL(request.url()); if (!['localhost', '127.0.0.1'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) external.push(url.hostname); });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin); await page.getByLabel('Benutzername', { exact: true }).fill('Browser card fixture');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await page.getByLabel('Ich habe die Codes sicher gespeichert.').check(); await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('heading', { name: 'Übersicht', exact: true }).waitFor();
    const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
        const response = await fetch(`/api/evolved${path}`, { method, credentials: 'same-origin', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        if (!response.ok) throw Error(`Fixture API ${method} ${path} ${response.status} ${(await response.text()).slice(0, 300)}`);
        return response.json();
    }, { path, method, body });
    const { team } = await api('/teams', 'POST', { name: 'Browser team' });
    const { project } = await api('/projects', 'POST', { teamId: team.id, name: 'Odoo project' });
    // Odoo development module and a remote MCP connection exist before the browser is touched.
    const before = (await api(`/projects/${project.id}/development/modules`)).config;
    await api(`/projects/${project.id}/development/modules`, 'PUT', { expectedRevision: before.revision, settings: { ...before.settings, activeModuleId: 'builtin:odoo', odoo: { major: 19, edition: 'community', hosting: 'local', addonsPaths: ['.'], modules: [], developmentBranch: null, enterpriseRepositoryId: null, testDatabaseSlug: 'dev', odooSh: { dashboardUrl: null, staging: { branch: null, buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: null }, production: { branch: null, buildId: null, buildHost: null, sshResourceId: null, applicationResourceId: null }, unassigned: null }, applicationResourceId: null } } });
    const development = (await api(`/projects/${project.id}/development/modules`)).config;
    check(development.settings.activeModuleId === 'builtin:odoo', 'Odoo module could not be activated');
    const mcpBefore = (await api(`/projects/${project.id}/mcp`)).connections;
    await page.goto(`${origin}/evolved?tab=mcp&project=${project.id}`);
    const card = page.locator('section, div').filter({ has: page.getByRole('heading', { name: 'Projektbrowser (Camofox)', exact: true }) }).last();
    await page.getByRole('heading', { name: 'Projektbrowser (Camofox)', exact: true }).waitFor();
    await card.getByText('Deaktiviert', { exact: true }).first().waitFor();
    check(await card.getByText(/teilen sich einen Browserzustand/).isVisible(), 'Shared-state explanation missing');
    check(!(await card.getByLabel('Freigeben: camofox_evaluate').isChecked()), 'evaluate granted by default');
    check(await card.getByLabel('Nur lesend: camofox_click').count() === 0, 'Browser action offered as read-only');
    mark('Card shows disabled state, shared ephemeral state and conservative default grants');
    await card.getByRole('checkbox', { name: 'Für Agenten dieses Projekts aktivieren' }).check();
    const saved = page.waitForResponse(r => new URL(r.url()).pathname === `/api/evolved/projects/${project.id}/browser` && r.request().method() === 'PUT');
    await card.getByRole('button', { name: 'Speichern', exact: true }).click();
    const response = await saved;
    check(response.status() === 200, `Browser save failed ${response.status()}`);
    const body = await response.json();
    check(body.config.enabled === true && body.lifecycle.ok === false, 'Lifecycle without runner must be reported, not claimed');
    await card.getByText('Projektdienst nicht verbunden', { exact: true }).waitFor();
    mark('Enabling without a managed runner is saved and truthfully reported as runner missing');
    const after = (await api(`/projects/${project.id}/development/modules`)).config;
    check(after.revision === development.revision && JSON.stringify(after.settings) === JSON.stringify(development.settings), 'Development module changed by browser activation');
    check(JSON.stringify((await api(`/projects/${project.id}/mcp`)).connections) === JSON.stringify(mcpBefore), 'Remote MCP connections changed');
    mark('Odoo module settings, revision and MCP connections unchanged by browser activation');
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.getByRole('heading', { name: 'Projektbrowser (Camofox)', exact: true }).scrollIntoViewIfNeeded();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(overflow <= 0, `Horizontal overflow ${overflow}px at ${width}px`);
        const box = await page.getByRole('heading', { name: 'Projektbrowser (Camofox)', exact: true }).boundingBox();
        check(box && box.x >= 0 && box.x + box.width <= width, `Heading clipped at ${width}px`);
        await page.screenshot({ path: join(output, `browser-card-${width}.png`), fullPage: false });
        mark(`No horizontal overflow at ${width}px`);
    }
    await card.getByRole('checkbox', { name: 'Für Agenten dieses Projekts aktivieren' }).uncheck();
    await card.getByRole('button', { name: 'Speichern', exact: true }).click();
    await card.getByText(/Der Browser wurde gestoppt|konnte nicht umgeschaltet|nicht erreichbar|sobald der verwaltete/).first().waitFor();
    check((await api(`/projects/${project.id}/browser`)).config.enabled === false, 'Disable not persisted');
    const final = (await api(`/projects/${project.id}/development/modules`)).config;
    check(final.revision === development.revision, 'Development revision changed by disable');
    mark('Disable persists; development revision still unchanged');
    check(pageErrors.length === 0, `Unhandled browser exception: ${pageErrors.join('; ')}`);
    check(external.length === 0, 'External request');
    report.result = 'PASS'; console.log(`PASS project browser card: ${report.checks.length} checks; ${output}`);
} catch (error) {
    report.result = 'FAIL'; report.failures.push(String(error));
    if (page) { writeFileSync(join(output, 'failure-body.txt'), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 }); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
    console.error(String(error)); process.exitCode = 1;
} finally {
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    if (report.result !== 'PASS') writeFileSync(join(output, 'fixture-errors.txt'), fixtureLog, { mode: 0o600 });
    await browser?.close(); child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(state, { recursive: true, force: true }); console.log(`Report: ${output}/report.json`);
}
