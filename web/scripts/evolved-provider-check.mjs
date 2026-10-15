/**
 * Real built UI + isolated Hub/Vault/passkeys, with explicitly synthetic provider
 * responses. This tests browser flows/layout, NOT real provider authentication.
 * Run after build:web; PLAYWRIGHT_CHROME_PATH optionally selects local Chromium.
 */
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runnerProtocol = JSON.parse(execFileSync('bun', ['-e', `
    import { CURRENT_MACHINE_CAPABILITIES, RUNNER_CAPABILITIES } from './shared/src/runnerCapabilities.ts';
    import { PROTOCOL_VERSION } from './shared/src/version.ts';
    import { APP_VERSION } from './shared/src/buildInfo.ts';
    process.stdout.write(JSON.stringify({ machineCapabilities: CURRENT_MACHINE_CAPABILITIES, runnerCapabilities: RUNNER_CAPABILITIES, protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION }));
`], { cwd: repo, encoding: 'utf8', timeout: 10000 }));
const state = mkdtempSync('/tmp/hapi-evolved-ui-provider-');
const output = mkdtempSync('/tmp/hapi-provider-browser-');
const report = { fixture: 'real Hub/Vault/WebAuthn and built UI; provider/model API responses and the agent-start machine are synthetic; no live provider login or model inference', checks: [], views: [], failures: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
const hub = await port(), vault = await port(), graph = await port(), origin = `http://localhost:${hub}`;
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: repo, env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hub), EVOLVED_TEST_VAULT_PORT: String(vault), EVOLVED_TEST_CODEGRAPH_PORT: String(graph) }, stdio: ['ignore', 'ignore', 'pipe'] });
let fixtureErrors = '', browser, page;
child.stderr.on('data', data => { fixtureErrors = (fixtureErrors + data.toString()).slice(-20_000); });
try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null) throw Error(`Fixture stopped: ${fixtureErrors}`);
        try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch {}
        await delay(100);
    }
    if (!ready) throw Error('Fixture did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(String(error)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin);
    await page.getByLabel('Benutzername', { exact: true }).fill('Provider UI fixture');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await page.getByLabel('Ich habe die Codes sicher gespeichert.').check();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('heading', { name: 'Übersicht', exact: true }).waitFor();
    const request = (path, body) => page.evaluate(async ({ path, body }) => {
        const response = await fetch(`/api/evolved${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw Error(`Fixture API ${response.status}`);
        return response.json();
    }, { path, body });
    const { team } = await request('/teams', { name: 'Browser design team' });
    const { project } = await request('/projects', { teamId: team.id, name: 'Dein Projekt' });
    const connected = { codex: false, claude: false }, operations = new Map();
    let rejectedCodes = 0, cancellations = 0, logouts = 0, modelRefreshes = 0;
    const catalogReady = new Set();
    await page.route('**/api/evolved/projects/*/providers**', async route => {
        const url = new URL(route.request().url()), method = route.request().method();
        const suffix = url.pathname.split('/providers')[1].split('/').filter(Boolean), provider = suffix[0];
        const summary = () => ({ runner: { status: 'ready', managed: true }, providers: ['codex', 'claude'].map(provider => ({ provider, status: connected[provider] ? 'connected' : 'disconnected', method: connected[provider] ? 'subscription' : null, checkedAt: Date.now() })) });
        let result, status = 200;
        if (suffix[1] === 'models') {
            if (method === 'POST' && suffix[2] === 'refresh') { catalogReady.add(provider); modelRefreshes++; }
            const ready = catalogReady.has(provider);
            result = { provider, status: ready ? 'ready' : 'unavailable', method: ready ? 'subscription' : null, source: 'native-cli', catalogOrigin: 'native-reported', entitlementVerified: false, upstreamRefresh: 'unknown', stale: !ready, checkedAt: ready ? Date.now() : null, expiresAt: ready ? Date.now() + 300_000 : null, models: ready ? [{ id: provider === 'claude' ? 'opus' : 'codex-native-example', label: provider === 'claude' ? 'Opus · CLI-Katalog' : 'Codex · CLI-Katalog', ...(provider === 'claude' ? { resolvedModel: 'claude-opus-5-5' } : {}), reasoningEfforts: ['low', 'high'] }] : [] };
        }
        else if (!provider) result = summary();
        else if (suffix.length === 1 && method === 'DELETE') { connected[provider] = false; logouts++; result = summary(); }
        else if (suffix[1] === 'login' && suffix.length === 2 && method === 'POST') {
            const operation = { id: `fixture-${provider}`, provider, state: 'waiting', flow: provider === 'codex' ? 'device' : 'code', expiresAt: Date.now() + 600_000, verificationUrl: provider === 'codex' ? 'https://auth.openai.com/codex/device' : 'https://claude.com/cai/oauth/authorize?state=synthetic', ...(provider === 'codex' ? { userCode: 'AAAA-BBBBB' } : {}) };
            operations.set(provider, operation); result = { operation };
        } else if (method === 'DELETE') { operations.delete(provider); cancellations++; result = { ok: true }; }
        else if (suffix[3] === 'code') {
            const { code } = route.request().postDataJSON();
            if (code !== 'synthetic#state') { rejectedCodes++; status = 400; result = { error: 'Bestätigungscode ungültig.', code: 'invalid_code' }; }
            else { connected[provider] = true; result = { operation: { ...operations.get(provider), state: 'connected' } }; operations.set(provider, result.operation); }
        } else result = { operation: operations.get(provider) };
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
    });
    async function navigate(tab) { await page.goto(`${origin}/evolved?tab=${tab}&project=${project.id}`); await page.locator('.ew-content').waitFor(); }
    async function capture(name, width, theme = 'light') {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
        await page.evaluate(theme => { localStorage.setItem('hapi-appearance', theme); window.dispatchEvent(new StorageEvent('storage', { key: 'hapi-appearance', newValue: theme })); }, theme);
        await delay(100);
        if (name.startsWith('runner')) await page.getByRole('group', { name: 'Gültigkeit des HAPI-Zugangs' }).scrollIntoViewIfNeeded();
        if (name === 'providers-claude') await page.getByRole('region', { name: 'Claude-Anmeldung' }).scrollIntoViewIfNeeded();
        const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, radios: [...document.querySelectorAll('.ev-choice input[type=radio]')].map(input => { const r = input.getBoundingClientRect(), label = input.closest('label').getBoundingClientRect(); return { width: r.width, height: r.height, targetHeight: label.height }; }), targets: [...document.querySelectorAll('.ev-provider-card button,.ev-provider-link')].filter(element => element.getBoundingClientRect().height > 0).map(element => ({ label: element.textContent, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })) }));
        if (metrics.scrollWidth > width + 1) throw Error(`${name}: horizontal overflow`);
        if (metrics.radios.some(radio => radio.width > 20 || radio.height > 20 || radio.targetHeight < 44)) throw Error(`${name}: radio geometry regression`);
        if (metrics.targets.some(target => target.width < 44 || target.height < 44)) throw Error(`${name}: action target below 44px`);
        const file = `${name}-${width}-${theme}.png`; await page.screenshot({ path: join(output, file), fullPage: true }); report.views.push({ file, ...metrics });
    }
    await navigate('providers');
    await page.getByRole('button', { name: 'Mit Codex verbinden' }).click();
    await page.getByLabel('Gerätecode').waitFor();
    await page.getByRole('button', { name: 'Mit Claude verbinden' }).click();
    await page.getByLabel('Claude-Bestätigungscode').waitFor();
    for (const width of [1440, 390, 320]) await capture('providers-waiting', width);
    await capture('providers-waiting', 390, 'dark');
    await capture('providers-claude', 320);
    await capture('providers-claude', 390, 'dark');
    if (await page.getByRole('link', { name: /Bei ChatGPT anmelden/ }).getAttribute('href') !== 'https://auth.openai.com/codex/device') throw Error('Unexpected native provider link');
    await page.getByLabel('Claude-Bestätigungscode').fill('invalid#fixture');
    await page.getByRole('button', { name: 'Anmeldung bestätigen' }).click();
    await page.getByRole('alert').filter({ hasText: 'Bestätigungscode ungültig.' }).waitFor();
    if (await page.getByLabel('Claude-Bestätigungscode').inputValue()) throw Error('Code retained after submission');
    await page.getByLabel('Claude-Bestätigungscode').fill('synthetic#state');
    await page.getByRole('button', { name: 'Anmeldung bestätigen' }).click();
    await page.getByRole('region', { name: 'Claude-Anmeldung' }).getByText('Abo verbunden').waitFor();
    await page.getByRole('region', { name: 'Codex-Anmeldung' }).getByRole('button', { name: 'Abbrechen' }).click();
    await page.getByLabel('Gerätecode').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Claude abmelden' }).click();
    if (logouts) throw Error('Logout before confirmation');
    await page.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    await page.getByRole('button', { name: 'Mit Claude verbinden' }).waitFor();
    if (rejectedCodes !== 1 || cancellations !== 1 || logouts !== 1) throw Error('Missing provider action');
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    if (/AAAA-BBBBB|synthetic#state|invalid#fixture/.test(storage)) throw Error('Challenge stored in browser storage');
    report.checks.push('Codex/Claude start and official links; rejected and accepted Claude code; cancel; confirmed logout; no challenge in browser storage');
    await navigate('runner');
    await page.getByRole('radio', { name: 'Dauerhaft – bis zum Widerruf' }).waitFor();
    for (const width of [1440, 390, 320]) await capture('runner', width);
    await page.getByRole('radio', { name: 'Befristet', exact: true }).check();
    await page.getByLabel('HAPI-Zugang gültig für (Stunden, maximal 168)').waitFor();
    await capture('runner-limited', 320, 'dark');
    await page.goto(`${origin}/settings/display`);
    await page.getByText('Ocean', { exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.colorTheme === 'evolved-ocean');
    for (const width of [1440, 390, 320]) await capture('appearance', width);
    await page.getByText('Iris', { exact: true }).click();
    await page.reload();
    if (!await page.getByRole('radio', { name: 'Iris', exact: true }).isChecked()) throw Error('Palette not persisted');
    await capture('appearance-iris', 390, 'dark');
    // The real built-in catalog remains authoritative; only a synthetic online
    // machine enables the launch form. This harness never submits a paid task.
    await page.route('**/api/evolved/projects/*/agent-catalog', async route => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, machines: [{ id: 'synthetic-runner', name: 'Projektdienst · Browser-Test' }] } });
    });
    await navigate('agents');
    await page.getByText('Architektur', { exact: true }).waitFor();
    await capture('agents', 1440);
    await capture('agents', 320);
    report.checks.push('Real built-in agent catalog reachable through the new navigation');
    await page.locator('.ev-agent-card').filter({ has: page.getByText('Architektur', { exact: true }) }).getByRole('button', { name: 'Aufgabe starten', exact: true }).click();
    const modelPicker = page.getByRole('combobox', { name: 'Modell für diesen Start (optional)' });
    await page.getByRole('option', { name: /Opus · CLI-Katalog/ }).waitFor({ state: 'attached' });
    await modelPicker.selectOption('opus');
    if (modelRefreshes !== 1) throw Error('Cold admin catalog did not use exactly one explicit discovery POST');
    await modelPicker.scrollIntoViewIfNeeded();
    await capture('agent-model-catalog', 390, 'dark');
    await capture('agent-model-catalog', 320, 'light');
    await page.getByRole('button', { name: 'Liste aktualisieren', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Liste aktualisieren' && !button.disabled));
    if (await modelPicker.inputValue() !== 'opus' || modelRefreshes !== 2) throw Error('Explicit catalog refresh lost selected model');
    report.checks.push('Synthetic native catalog: automatic cold-admin POST, resolved model selection, explicit refresh preserves selected ID; no task submitted');
    report.checks.push('18px native radio controls with >=44px labels; no viewport overflow; profiles persist after reload');
    // New project sessions must derive cwd from real Hub-created project metadata.
    // Machine RPCs are synthetic and never start an agent or perform inference.
    const projectSessionRequests = [], projectPathChecks = [];
    let runnerFolderExists = true;
    const projectFolders = new Map([[project.id, project.rootPath]]);
    await page.route('**/api/machines', route => {
        const projectId = route.request().headers()['x-hapi-project-id'];
        return route.fulfill({ json: { machines: [{
            id: 'synthetic-project-runner', namespace: `evolved:${projectId}`, seq: 1,
            active: true, activeAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
            protocolVersion: runnerProtocol.protocolVersion,
            metadataVersion: 1, runnerStateVersion: 1,
            metadata: { host: 'Isolated project runner', platform: 'linux', happyCliVersion: runnerProtocol.appVersion, capabilities: runnerProtocol.machineCapabilities, workspaceRoots: projectFolders.has(projectId) ? [projectFolders.get(projectId)] : [] },
            runnerState: { status: 'running', capabilities: runnerProtocol.runnerCapabilities },
        }] } });
    });
    await page.route('**/api/machines/synthetic-project-runner/**', async route => {
        const request = route.request(), suffix = new URL(request.url()).pathname.split('/synthetic-project-runner/')[1];
        if (suffix === 'agent-availability') return route.fulfill({ json: { agents: [{ agent: 'claude', available: true }] } });
        if (suffix === 'paths/exists') {
            const { paths } = request.postDataJSON();
            projectPathChecks.push({ projectId: request.headers()['x-hapi-project-id'], paths });
            return route.fulfill({ json: { exists: Object.fromEntries(paths.map(path => [path, runnerFolderExists])) } });
        }
        if (suffix === 'spawn') {
            projectSessionRequests.push({ projectId: request.headers()['x-hapi-project-id'], body: request.postDataJSON() });
            return route.fulfill({ json: { type: 'error', message: 'Synthetic spawn captured; no agent was started.' } });
        }
        return route.fulfill({ status: 404, json: { error: 'Synthetic machine endpoint unavailable' } });
    });
    await page.evaluate(() => {
        localStorage.setItem('hapi:newSession:agent', 'claude');
        localStorage.setItem('hapi:lastMachineId', 'synthetic-project-runner');
        localStorage.setItem('hapi:recentPaths', JSON.stringify({ 'synthetic-project-runner': ['/outside-project-recent'] }));
        sessionStorage.setItem('hapi:new-session-form-draft', JSON.stringify({ agent: 'claude', model: 'auto', machineId: 'synthetic-project-runner', sessionType: 'worktree', worktreeName: '../../outside-draft' }));
    });
    await page.goto(`${origin}/sessions/new`);
    await page.getByLabel('Project folder', { exact: true }).waitFor();
    if (await page.getByLabel('Project folder', { exact: true }).textContent() !== project.rootPath) throw Error('Direct project session did not use stored folder');
    if (await page.getByRole('textbox', { name: 'Directory', exact: true }).count() || await page.getByRole('button', { name: 'Browse', exact: true }).count() || await page.getByText('Worktree', { exact: true }).count()) throw Error('Project session exposes a directory/worktree picker');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => { document.querySelectorAll('.app-scroll-y').forEach(element => { element.scrollTop = 0; }); });
    if (await page.getByText(/runner\(s\) out of date/).count()) throw Error('Synthetic machine does not advertise the current protocol capabilities');
    await capture('project-session-folder', 390, 'light');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText('Synthetic spawn captured; no agent was started.').waitFor();
    if (projectSessionRequests.length !== 1 || projectSessionRequests[0].body.directory !== project.rootPath || projectSessionRequests[0].body.sessionType !== 'simple' || projectSessionRequests[0].body.worktreeName !== undefined || projectSessionRequests[0].projectId !== project.id) throw Error('Project start request escaped its stored folder/scope');
    const { project: secondProject } = await request('/projects', { teamId: team.id, name: 'Second session project' });
    projectFolders.set(secondProject.id, secondProject.rootPath);
    await page.goto(`${origin}/evolved?tab=projects&project=${secondProject.id}`);
    await page.waitForFunction(id => document.querySelector('select[aria-label="Aktives Projekt"]')?.value === id, secondProject.id);
    await page.goto(`${origin}/sessions/new?machineId=synthetic-project-runner&directory=${encodeURIComponent(project.rootPath)}`);
    await page.getByLabel('Project folder', { exact: true }).waitFor();
    if (await page.getByLabel('Project folder', { exact: true }).textContent() !== secondProject.rootPath) throw Error('Old project URL overrode new project root');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText('Synthetic spawn captured; no agent was started.').waitFor();
    if (projectSessionRequests.length !== 2 || projectSessionRequests[1].body.directory !== secondProject.rootPath || projectSessionRequests[1].projectId !== secondProject.id) throw Error('Second project start used stale root or authority');
    if (projectPathChecks.some(check => check.paths.some(path => path !== (check.projectId === project.id ? project.rootPath : secondProject.rootPath)))) throw Error('URL/draft/recent path reached machine discovery');
    runnerFolderExists = false;
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText('Project folder unavailable on the runner. Ask an administrator to check the project folder and runner mount.').first().waitFor();
    if (projectSessionRequests.length !== 2) throw Error('Missing project folder triggered a spawn/mkdir');
    report.checks.push('Project session: real Hub-assigned root, no directory/worktree picker; hostile URL/draft/recents ignored; exact project/root/simple spawn DTO; second project isolated; missing runner folder blocks spawn (machine responses synthetic)');
    if (consoleErrors.length) throw Error(`Browser exceptions: ${consoleErrors.join('; ')}`);
    report.checks.push('No browser runtime exceptions');
} catch (error) { report.failures.push(String(error)); process.exitCode = 1; if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]); if (child.exitCode === null) child.kill('SIGKILL'); rmSync(state, { recursive: true, force: true }); writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify({ output, checks: report.checks.length, views: report.views.length, failures: report.failures })); }
