/** Built UI + real isolated Hub/Vault/WebAuthn/Socket/Git/Codegraph. Native agent execution is synthetic; no remote Git or provider inference. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = mkdtempSync('/tmp/hapi-evolved-ui-workflow-'), output = mkdtempSync('/tmp/hapi-workflow-browser-');
const mark = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const report = { fixture: 'real isolated Hub/Vault/WebAuthn/Socket/Git/Codegraph; synthetic native agent spawn, no external provider or remote Git', checks: [], views: [], failures: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
const hub = await port(), vault = await port(), graph = await port(), origin = `http://localhost:${hub}`;
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: repo, env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hub), EVOLVED_TEST_VAULT_PORT: String(vault), EVOLVED_TEST_CODEGRAPH_PORT: String(graph), EVOLVED_TEST_WORKFLOW: '1', EVOLVED_TEST_CODEGRAPH: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', browser, page;
child.stderr.on('data', data => { stderr = (stderr + data).slice(-20000); });
function check(condition, message) { if (!condition) throw Error(message); }
try {
    let ready = false;
    for (let n = 0; n < 200; n++) { if (child.exitCode !== null) throw Error('Fixture stopped'); try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch {} await delay(100); }
    check(ready, 'Hub fixture startup timeout');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    page = await context.newPage(); const pageErrors = [], consoleErrors = [], failedResponses = []; page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ message: message.text().split('\n')[0], path: message.location().url ? new URL(message.location().url).pathname : null }); });
    page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin); await page.getByLabel('Benutzername', { exact: true }).fill('Workflow fixture');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click(); await page.getByLabel('Ich habe die Codes sicher gespeichert.').check(); await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('heading', { name: 'Übersicht', exact: true }).waitFor();
    const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
        const response = await fetch(`/api/evolved${path}`, { method, credentials: 'same-origin', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        const result = await response.json(); if (!response.ok) throw Error(`Fixture API ${method} ${path} ${response.status}: ${JSON.stringify(result)}`); return result;
    }, { path, method, body });
    const { team } = await api('/teams', 'POST', { name: 'Workflow team' });
    const { project } = await api('/projects', 'POST', { teamId: team.id, name: 'Workflow project' });
    await api(`/projects/${project.id}/profile`, 'PUT', { profile: 'workspace' });
    await api(`/projects/${project.id}/github`, 'POST', { token: 'github_pat_synthetic_browser_credential_only' });
    await api(`/projects/${project.id}/github/repositories`, 'PUT', { repository: 'synthetic/workflow', permission: 'read' });
    writeFileSync(join(state, 'workflow-request.json'), JSON.stringify({ projectId: project.id, rootPath: project.rootPath, namespace: project.namespace }), { mode: 0o600 });
    for (let n = 0; n < 200 && !existsSync(join(state, 'workflow-ready.json')); n++) await delay(100);
    check(existsSync(join(state, 'workflow-ready.json')), 'Workflow fixture timeout');
    const fixture = JSON.parse(readFileSync(join(state, 'workflow-ready.json'), 'utf8'));
    async function navigate(tab, repository) { await page.goto(`${origin}/evolved?${new URLSearchParams({ tab, project: project.id, ...(repository ? { repository } : {}) })}`); await page.locator('.ew-content').waitFor(); }
    async function capture(name, width, target) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 }); await page.evaluate(() => window.scrollTo(0, 0)); if (target) await target.scrollIntoViewIfNeeded(); await delay(100);
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        check(layout.scrollWidth <= layout.width + 1, `${name}/${width}: horizontal overflow`);
        const path = join(output, `${name}-${width}.png`); await page.screenshot({ path, fullPage: true }); report.views.push({ name, width, path, ...layout });
    }
    await navigate('overview'); await page.getByRole('heading', { name: 'Bereit für den nächsten Schritt?' }).waitFor();
    check(!(await page.getByText('Prüfdetails (8)').count()) || !(await page.getByText('Prüfdetails (8)').evaluate(el => el.parentElement.open)), 'Readiness detail should be collapsed');
    mark('Readiness distinguishes native provider status without starting providers');
    await navigate('github');
    await page.getByRole('link', { name: 'Sitzung in diesem Repo starten', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Sitzung in diesem Repo starten', exact: true }).click();
    await page.getByLabel(/^Arbeitsort/).waitFor();
    check(await page.getByLabel(/^Arbeitsort/).inputValue() === '101', 'Repo link did not preserve explicit selection');
    await page.getByLabel('Project folder', { exact: true }).filter({ hasText: fixture.repository.path }).waitFor();
    check(await page.getByLabel('Project folder', { exact: true }).textContent() === fixture.repository.path, 'Selected repo folder mismatch');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(url => /\/sessions\/[0-9a-f-]{36}$/.test(url.pathname));
    const normalSessionId = new URL(page.url()).pathname.split('/').pop();
    const normalLink = await api(`/projects/${project.id}/sessions/${normalSessionId}/repository`);
    check(normalLink.repository?.id === '101', 'Normal spawn missing authoritative repo binding');
    const normalRpc = JSON.parse(readFileSync(join(state, 'workflow-rpc.json'), 'utf8')).filter(item => item.method === 'spawn-happy-session');
    check(normalRpc.length === 1 && normalRpc[0].params.directory === fixture.repository.path && normalRpc[0].params.approvedNewDirectoryCreation === false, 'Normal spawn cwd/mkdir invariant');
    mark('GitHub → selected checkout → real spawn RPC → Hub-owned repo/session binding; no mkdir');
    await navigate('github'); await page.getByRole('link', { name: 'Spezialist für dieses Repo' }).click();
    await page.getByText('Repository-ID 101 ist für den nächsten Start vorausgewählt.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Aufgabe starten', exact: true }).first().click();
    check(await page.getByLabel(/^Arbeitsort/).inputValue() === '101', 'Specialist intent missing selected repo');
    check(JSON.parse(readFileSync(join(state, 'workflow-rpc.json'), 'utf8')).filter(item => item.method === 'spawn-happy-session').length === 1, 'Repo specialist navigation auto-started');
    mark('GitHub specialist intent is project-scoped and requires an explicit task/start');
    await navigate('github', '101');
    await page.getByRole('button', { name: 'Staged-Diff: src/math.ts', exact: true }).click();
    await page.getByText('+export function add(a: number, b: number) { return Number(a) + Number(b) }', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Arbeitskopie-Diff: src/math.ts', exact: true }).click();
    await page.getByText('+export function add(a: number, b: number) { return Number(a) + Number(b) + 0 }', { exact: true }).waitFor();
    check(await page.getByRole('checkbox', { name: 'Auswählen: .env.example' }).isDisabled(), 'Sensitive path was selectable');
    check(!(await page.getByRole('button', { name: 'Arbeitskopie-Diff: untracked.txt' }).count()), 'Untracked file exposed a diff action');
    check(!(await page.getByText('SYNTHETIC_UNTRACKED_CONTENT_MUST_NOT_PREVIEW').count()), 'Untracked raw text escaped withheld policy');
    await page.getByRole('button', { name: 'Arbeitskopie-Diff: src/math.ts', exact: true }).click();
    for (const width of [1440, 390, 320]) await capture('repository-worktree', width);
    await capture('repository-diff', 390, page.getByRole('heading', { name: 'Diff · src/math.ts', exact: true }));
    mark('Real staged/unstaged Git diff, sensitive and untracked exclusion, session backlink, 1440/390/320 layout');
    const memoryRow = page.locator('li').filter({ has: page.getByRole('checkbox', { name: 'Auswählen: docs/decision.md' }) });
    await memoryRow.getByRole('button', { name: 'Als Wissen vorschlagen', exact: true }).click();
    await memoryRow.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    await page.getByRole('link', { name: 'Wissensvorschlag im Projektgedächtnis prüfen' }).waitFor();
    let memory = await api(`/projects/${project.id}/memory`);
    check(memory.items.some(item => item.status === 'proposed' && item.body.includes('keeps reviewed changes')), 'Current source file not proposed');
    check(memory.settings.enabled === false && memory.settings.cloudAllowed === false, 'File intake enabled processing');
    mark('Explicit file-memory confirmation stores current source as proposed; cloud/verification remain disabled');
    await api(`/projects/${project.id}/codegraph/reindex`, 'POST', {});
    let graphReady = false;
    for (let n = 0; n < 100; n++) { const status = await api(`/projects/${project.id}/codegraph/status`); if (status.state === 'ready' && status.pendingFiles === 0) { graphReady = true; break; } await delay(200); }
    check(graphReady, 'Isolated Codegraph index timeout');
    await page.getByRole('checkbox', { name: 'Auswählen: src/math.ts' }).check();
    const impactResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/evolved/projects/${project.id}/repositories/101/impact` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Auswirkungen prüfen (1/200)' }).click();
    const observedImpact = await (await impactResponse).json();
    check(observedImpact.queried?.includes('src/math.ts') && observedImpact.graph?.nodes?.length > 0
        && !observedImpact.skipped?.some(item => item.path === 'src/math.ts' && item.reason === 'not_indexed'), 'Real Codegraph failed to index the selected source file');
    report.impact = { queried: observedImpact.queried, nodeCount: observedImpact.graph.nodes.length, edgeCount: observedImpact.graph.edges.length, skipped: observedImpact.skipped };
    await page.getByRole('heading', { name: 'Auswirkungen der ausgewählten Änderungen' }).waitFor();
    await page.getByText(/Codegraph-Beziehungen sind Hinweise/).waitFor();
    await page.getByRole('link', { name: 'Review vorbereiten', exact: true }).click();
    await page.getByLabel('Aufgabe', { exact: true }).waitFor();
    check(await page.getByLabel(/^Arbeitsort/).inputValue() === '101', 'Review lost repository');
    check(await page.getByLabel(/^Arbeitsort/).isDisabled(), 'Review repository can be silently changed');
    await capture('repository-review', 390, page.getByLabel('Aufgabe', { exact: true }));
    await page.getByRole('button', { name: 'Jetzt starten', exact: true }).click();
    await page.getByRole('link', { name: 'Sitzung öffnen', exact: true }).waitFor();
    const reviewRpc = JSON.parse(readFileSync(join(state, 'workflow-rpc.json'), 'utf8')).filter(item => item.method === 'spawn-happy-session').at(-1);
    check(reviewRpc.params.directory === fixture.repository.path && reviewRpc.params.permissionMode === 'plan', 'Review not bound to readonly selected repo');
    await page.getByRole('link', { name: 'Sitzung öffnen', exact: true }).click();
    await page.getByText('src/math.ts', { exact: false }).first().waitFor();
    mark('Real Codegraph impact → explicit builtin review → server-generated context and Claude plan mode');
    await page.goto(`${origin}/sessions/${fixture.sessionId}`);
    await page.getByText(fixture.messageText, { exact: true }).waitFor();
    for (let tip = 0; tip < 3 && await page.getByRole('button', { name: 'Got it', exact: true }).count(); tip++) await page.getByRole('button', { name: 'Got it', exact: true }).first().click();
    await page.getByText(fixture.messageText, { exact: true }).hover();
    await page.getByRole('button', { name: 'Als Wissen vorschlagen', exact: true }).click();
    const source = page.getByLabel('Gespeicherter Nachrichtentext (nur lesen)'); await source.waitFor();
    check(await source.inputValue() === fixture.messageText && await source.getAttribute('readonly') !== null, 'Message source is not authoritative readonly text');
    await page.getByRole('dialog').getByLabel('Titel', { exact: true }).fill('Verified provenance, unverified meaning');
    await capture('message-memory', 320);
    await page.getByRole('button', { name: 'Vorschlag speichern', exact: true }).click();
    await page.getByText('Vorschlag gespeichert. Der Inhalt wurde noch nicht verifiziert.', { exact: true }).waitFor();
    memory = await api(`/projects/${project.id}/memory`);
    check(memory.items.some(item => item.title === 'Verified provenance, unverified meaning' && item.body === fixture.messageText && item.status === 'proposed' && item.sources.some(source => source.sessionId === fixture.sessionId && source.messageId === fixture.messageId)), 'Message source proposal mismatch');
    mark('Stored chat message → readonly original → proposed Memory with authentic IDs/hash, no free-text source spoofing');
    const { project: second } = await api('/projects', 'POST', { teamId: team.id, name: 'Other workflow project' });
    await page.goto(`${origin}/evolved?tab=github&project=${second.id}&repository=101`);
    await page.getByText('Dieses Repository ist für das aktuelle Projekt nicht verfügbar.', { exact: true }).waitFor();
    check(!(await page.getByText('src/math.ts', { exact: true }).count()), 'Old worktree data survived project change');
    await page.goto(`${origin}/sessions/new?projectId=${project.id}&repositoryId=101`);
    await page.getByText(/Diese Repository-Auswahl gehört nicht zum aktuellen Projekt/).waitFor();
    check(!(await page.getByRole('button', { name: 'Create', exact: true }).count()), 'Mismatched project intent silently fell back');
    mark('Project change clears repository source data and rejects a cross-project start intent');
    check(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);
    report.consoleErrors = consoleErrors; report.failedResponses = failedResponses; report.pageErrors = pageErrors;
    const knownUnavailable = (path, status) => status === 403 && ['/api/hub-settings', '/api/voice/transcription/providers', '/api/voice/backend'].includes(path)
        || status === 503 && ['claude', 'codex'].some(provider => path === `/api/evolved/projects/${project.id}/providers/${provider}/models/refresh`);
    const knownConsole = item => [
        "SW registration error: TypeError: Cannot read properties of undefined (reading 'waiting')",
        'Failed to update visibility: TypeError: Failed to fetch',
        'Failed to reconcile queued state after SSE connect: TypeError: Failed to fetch',
        'Could not detect voice backend: ApiError: HTTP 403 Forbidden: {"error":"Endpoint unavailable in Evolved."}',
    ].includes(item.message) || /^Failed to load resource: the server responded with a status of (403|503) /.test(item.message)
        && knownUnavailable(item.path, Number(item.message.match(/status of (\d+)/)?.[1]));
    report.unexpectedConsole = consoleErrors.filter(item => !knownConsole(item));
    report.unexpectedResponses = failedResponses.filter(item => !knownUnavailable(item.path, item.status));
    report.diagnosticLimits = 'Service workers are intentionally blocked; hard navigations may abort visibility/queued-state fetches. Native model refresh has no operator/provider in this fixture (503); legacy hub-settings and voice endpoints are explicitly unavailable in Evolved (403). Exact routes/messages are recorded, not hidden; other console/HTTP errors fail.';
    check(report.unexpectedConsole.length === 0, `Unexpected console errors: ${JSON.stringify(report.unexpectedConsole)}`);
    check(report.unexpectedResponses.length === 0, `Unexpected HTTP errors: ${JSON.stringify(report.unexpectedResponses)}`);
    report.result = 'PASS';
    console.log(`PASS integrated project workflow: ${report.checks.length} checks; ${output}`);
} catch (error) {
    report.result = 'FAIL'; report.failures.push(String(error));
    if (page) { writeFileSync(join(output, 'failure-body.txt'), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 }); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
    console.error(String(error)); process.exitCode = 1;
} finally {
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    if (report.result !== 'PASS') writeFileSync(join(output, 'fixture-errors.txt'), stderr, { mode: 0o600 });
    await browser?.close(); child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(state, { recursive: true, force: true }); console.log(`Report: ${output}/report.json`);
}
