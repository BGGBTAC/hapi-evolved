/**
 * Responsive acceptance against the real, isolated Evolved Hub/Vault fixture.
 * Run after `bun run build:web`: node web/scripts/evolved-design-check.mjs
 * Only synthetic local state is used; no provider login or production endpoint.
 * EVOLVED_DESIGN_OUTPUT_DIR may point to a new/empty directory for screenshots.
 * EVOLVED_DESIGN_EXTENDED=1 checks tablet, landscape, all tools, NewSession and
 * 130% app text size + emulated OS text scale in OLED (not a physical iOS test).
 * EVOLVED_DESIGN_FOCUS=1 repeats only the sidebar target / toolbar focus regressions.
 */
import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const focusOnly = process.env.EVOLVED_DESIGN_FOCUS === '1';
const extended = focusOnly || process.env.EVOLVED_DESIGN_EXTENDED === '1';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = mkdtempSync('/tmp/hapi-evolved-ui-design-');
const output = process.env.EVOLVED_DESIGN_OUTPUT_DIR
    ? resolve(process.env.EVOLVED_DESIGN_OUTPUT_DIR)
    : mkdtempSync('/tmp/hapi-evolved-design-artifacts-');
if (!existsSync(output)) mkdirSync(output, { mode: 0o700 });
const outputStat = lstatSync(output);
if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || outputStat.uid !== process.getuid() || readdirSync(output).length) {
    rmSync(state, { recursive: true, force: true });
    throw Error('Design output must be an owned, empty, real directory');
}
chmodSync(output, 0o700);
const report = { mode: focusOnly ? 'focused sidebar target / toolbar dialog focus' : extended ? 'extended tablet/landscape/font-scale/OLED' : 'standard', fixture: 'isolated synthetic Hub/Vault and authenticated CLI Socket.IO', views: [], checks: [], failures: [] };
const sockets = [];
const heartbeats = [];
let browser;
let child;
let context;
let page;
let cdp;
let fixtureErrors = '';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
function check(condition, message) {
    if (!condition) report.failures.push(message);
}
async function api(path, method = 'GET', body) {
    const response = await context.request.fetch(`${origin}/api/evolved${path}`, {
        method, headers: { origin }, ...(body === undefined ? {} : { data: body }),
    });
    if (!response.ok()) throw Error(`Synthetic API ${method} ${path}: HTTP ${response.status()}`);
    return response.status() === 204 ? null : response.json();
}
async function waitForApp() {
    await page.locator(extended ? 'body' : '.ew-content, .ev-content, [data-testid="composer-shell"], main').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await pause(200);
}
async function workspace(tab = 'overview', projectId) {
    await page.goto(`${origin}/evolved?tab=${tab}${projectId ? `&project=${encodeURIComponent(projectId)}` : ''}`);
    await page.locator('.ew-content, .ev-content').waitFor();
    await waitForApp();
}

async function verifyCapacityData(projectId, predicate, description) {
    let snapshot;
    for (let attempt = 0; attempt < 60; attempt++) {
        snapshot = await api(`/projects/${projectId}/capacity`);
        if (predicate(snapshot)) return snapshot;
        await pause(100);
    }
    throw Error(`Real capacity API did not confirm ${description}`);
}

async function verifyCapacityPresentation(mode) {
    const panel = page.getByTestId('capacity-panel').first();
    await panel.locator('[data-capacity-provider="codex"]').waitFor();
    const codex = panel.locator('[data-capacity-provider="codex"]');
    const claude = panel.locator('[data-capacity-provider="claude"]');
    if (mode === 'fresh') {
        await codex.locator('[data-capacity-window="codex:primary"]').waitFor();
        check(/62\s*%/.test(await codex.innerText()) && /29\s*%/.test(await codex.innerText()), 'Capacity: provider-derived 62%/29% remaining not displayed');
        check(await codex.getByRole('meter').first().getAttribute('aria-valuenow') === '38', 'Capacity: meter does not expose actual 38% used');
        check(await claude.getByRole('meter').count() === 0 && !/\d\s*%/.test(await claude.innerText()), 'Capacity: unknown Claude utilization became a numerical quota');
    } else if (mode === 'stale') {
        await codex.locator('.ew-capacity-report[data-capacity-stale="true"]').waitFor();
        check((await codex.innerText()).includes('Veraltet'), 'Capacity: stale observation lacks visible stale label');
    } else {
        await codex.getByText('Keine Nutzungsfenster gemeldet.', { exact: true }).waitFor();
        check(await codex.getByRole('meter').count() === 0 && !/\d\s*%/.test(await codex.innerText()), 'Capacity: unavailable report displays a numerical quota');
    }
}

async function auditView(name) {
    await waitForApp();
    const measurements = await page.evaluate(() => {
        const shown = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const controls = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),textarea,select,[role=textbox]')].filter(shown);
        const clippedControls = controls.filter(element => {
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= innerHeight) return false;
            for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
                if (['auto', 'scroll'].includes(getComputedStyle(ancestor).overflowX)) return false;
            }
            return rect.left < -1 || rect.right > innerWidth + 1;
        }).map(element => ({ tag: element.tagName, name: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 70) }));
        const tinyInputs = innerWidth <= 800 ? controls.filter(element => {
            if (!element.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]),textarea,select,[role=textbox]')) return false;
            return parseFloat(getComputedStyle(element).fontSize) < 16;
        }).map(element => ({ tag: element.tagName, fontSize: getComputedStyle(element).fontSize, label: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.labels?.[0]?.textContent?.slice(0, 70) })) : [];
        const headings = [...document.querySelectorAll('h1')].filter(shown).map(element => element.textContent);
        const placeholder = document.querySelector('[data-testid="rich-composer-placeholder"]');
        const placeholderFontSize = placeholder && shown(placeholder) ? parseFloat(getComputedStyle(placeholder).fontSize) : null;
        const primaryNav = [...document.querySelectorAll('.ew-bottom-nav a,.ew-bottom-nav button')].filter(shown);
        const smallNavigation = primaryNav.filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.height < 44 || rect.width < 44;
        }).map(element => element.textContent?.trim());
        // Resolve the browser's actual colors (including color-mix/oklch) into
        // sRGB, then composite transparent ancestor backgrounds before WCAG
        // contrast calculation. Gradient/image backgrounds need visual review.
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const rgba = color => {
            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
            const value = [...ctx.getImageData(0, 0, 1, 1).data]; value[3] /= 255; return value;
        };
        const over = (fg, bg) => [0, 1, 2].map(index => fg[index] * fg[3] + bg[index] * (1 - fg[3])).concat(1);
        const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const contrast = [];
        for (const element of [...document.querySelectorAll('.evolved h1,.evolved h2,.evolved .ev-muted,.evolved .ev-primary,.ew-sidebar a,.ew-bottom-nav a')].filter(shown)) {
            if (!element.textContent.trim() || element.matches(':disabled,[aria-disabled=true]')) continue;
            const chain = []; for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
            if (chain.some(ancestor => getComputedStyle(ancestor).backgroundImage !== 'none' || Number(getComputedStyle(ancestor).opacity) < 1)) continue;
            let bg = [255, 255, 255, 1];
            for (const ancestor of chain) bg = over(rgba(getComputedStyle(ancestor).backgroundColor), bg);
            const style = getComputedStyle(element), fg = over(rgba(style.color), bg);
            const a = luminance(fg), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
            const large = parseFloat(style.fontSize) >= 24 || parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700;
            contrast.push({ text: element.textContent.trim().slice(0, 65), ratio: Math.round(ratio * 100) / 100, minimum: large ? 3 : 4.5 });
        }
        return {
            width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
            dark: document.documentElement.classList.contains('dark'), appearance: document.documentElement.dataset.theme,
            rootFontSize: getComputedStyle(document.documentElement).fontSize, appFontScale: getComputedStyle(document.documentElement).getPropertyValue('--app-font-scale').trim(),
            workspaceFontSize: document.querySelector('.ew-shell') ? getComputedStyle(document.querySelector('.ew-shell')).fontSize : null,
            pageHeadingFontSize: document.querySelector('.ew-page-heading h1') ? getComputedStyle(document.querySelector('.ew-page-heading h1')).fontSize : null,
            clippedControls, tinyInputs, headings,
            smallNavigation, language: document.documentElement.lang, contrast, placeholderFontSize,
        };
    });
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const unnamed = ax.nodes.filter(node => !node.ignored && ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'slider'].includes(node.role?.value) && !node.name?.value?.trim())
        .map(node => node.role.value);
    check(measurements.scrollWidth <= measurements.width + 1, `${name}: document horizontal overflow`);
    check(measurements.clippedControls.length === 0, `${name}: clipped controls ${JSON.stringify(measurements.clippedControls)}`);
    check(measurements.tinyInputs.length === 0, `${name}: mobile input below 16px ${JSON.stringify(measurements.tinyInputs)}`);
    check(measurements.smallNavigation.length === 0, `${name}: primary navigation below 44px`);
    check(unnamed.length === 0, `${name}: accessible names missing (${unnamed.join(', ')})`);
    check(Boolean(measurements.language), `${name}: document language missing`);
    check(measurements.placeholderFontSize === null || measurements.placeholderFontSize >= 12, `${name}: composer placeholder below 12px (${measurements.placeholderFontSize})`);
    const poorContrast = measurements.contrast.filter(item => item.ratio < item.minimum);
    check(poorContrast.length === 0, `${name}: text contrast ${JSON.stringify(poorContrast)}`);
    const screenshot = `${name}.png`;
    await page.screenshot({ path: join(output, screenshot), fullPage: false, animations: 'disabled' });
    report.views.push({ name, screenshot, ...measurements, unnamedControls: unnamed });
}

async function inspectScrolledControls(name) {
    const findings = await page.evaluate(async () => {
        const scroller = document.querySelector('.ew-content') ?? [...document.querySelectorAll('main,div')].find(element => element.scrollHeight > element.clientHeight + 100 && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
        const originalTop = scroller?.scrollTop ?? 0;
        const overflow = new Set(), smallTargets = new Set();
        const positions = scroller ? [0, (scroller.scrollHeight - scroller.clientHeight) / 2, scroller.scrollHeight] : [0];
        for (const position of positions) {
            if (scroller) scroller.scrollTop = position;
            await new Promise(resolve => requestAnimationFrame(resolve));
            for (const element of document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,summary')) {
                const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
                if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || rect.bottom <= 0 || rect.top >= innerHeight) continue;
                const name = (element.getAttribute('aria-label') || element.textContent || element.labels?.[0]?.textContent || element.getAttribute('placeholder') || element.tagName).trim().slice(0, 80);
                if (rect.left < -1 || rect.right > innerWidth + 1) overflow.add(name);
                const target = element.matches('input[type=checkbox],input[type=radio]') ? element.closest('label') ?? element : element;
                const targetRect = target.getBoundingClientRect();
                if ((targetRect.height < 24 || targetRect.width < 24) && !(element.tagName === 'A' && style.display === 'inline')) smallTargets.add(`${name} (${Math.round(targetRect.width)}×${Math.round(targetRect.height)})`);
            }
        }
        if (scroller) scroller.scrollTop = originalTop;
        return { overflow: [...overflow], targetsBelow24: [...smallTargets] };
    });
    check(!findings.overflow.length, `${name}: scrolled controls overflow ${JSON.stringify(findings.overflow)}`);
    check(!findings.targetsBelow24.length, `${name}: targets below 24px ${JSON.stringify(findings.targetsBelow24)}`);
    report.checks.push({ name, scrolledControlAudit: findings });
}

async function seedMachine(token, project) {
    const id = 'synthetic-responsive-machine';
    const capabilities = ['agent-availability', 'cursor-chat-store-status', 'stop-runner'];
    const response = await fetch(`${origin}/cli/machines`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id, metadata: { host: 'synthetic-responsive-runner', platform: 'linux', happyCliVersion: '0.1.0', displayName: 'Isolierter Runner für Tablet- und Querformatprüfung', workspaceRoots: [project.rootPath], capabilities }, runnerState: null }) });
    if (!response.ok) throw Error(`Synthetic machine registration: HTTP ${response.status}`);
    const socket = io(`${origin}/cli`, { transports: ['websocket'], reconnection: false, auth: { token, machineId: id, clientType: 'machine-scoped' } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Synthetic machine socket timeout')), 10_000); socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('connect_error', error => { clearTimeout(timer); reject(error); }); });
    const replies = {
        'agent-availability': () => ({ agents: [{ agent: 'claude', available: true }, { agent: 'codex', available: true }] }),
        'path-exists': params => ({ exists: Object.fromEntries((params.paths ?? []).map(path => [path, path === project.rootPath])) }),
        'list-directory': () => ({ success: true, path: project.rootPath, directories: [], parent: null }),
        listCodexModels: () => ({ success: true, models: [{ id: 'synthetic-design-model', displayName: 'Design-Modell (synthetisch)', isDefault: true, supportedReasoningEfforts: ['medium'] }] }),
    };
    socket.on('rpc-request', (request, acknowledge) => {
        const method = request.method.slice(id.length + 1);
        const handler = replies[method];
        acknowledge(JSON.stringify(handler ? handler(typeof request.params === 'string' ? JSON.parse(request.params) : request.params ?? {}) : { success: false, error: 'Synthetic method unavailable' }));
    });
    Object.keys(replies).forEach(method => socket.emit('rpc-register', { method: `${id}:${method}` }));
    const heartbeat = () => socket.emit('machine-alive', { machineId: id, time: Date.now() });
    heartbeat(); heartbeats.push(setInterval(heartbeat, 4000));
}

async function seedAgent(provider, token, project, capacity) {
    const response = await fetch(`${origin}/cli/sessions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tag: `design-${provider}`, metadata: { path: project.rootPath, host: 'synthetic-design-runner', name: provider === 'codex' ? 'Responsive Navigation und saubere Projektgrenzen' : 'Kapazitätsfenster und zuverlässige Wiederaufnahme', flavor: provider }, agentState: null }),
    });
    if (!response.ok) throw Error(`Synthetic session creation: HTTP ${response.status}`);
    const { session } = await response.json();
    const socket = io(`${origin}/cli`, { transports: ['websocket'], reconnection: false, auth: { token, sessionId: session.id, clientType: 'session-scoped' } });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Synthetic CLI socket timeout')), 10_000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });
    // Real Hub→authenticated CLI RPC, with an explicitly synthetic catalog.
    // Otherwise the UI correctly renders an RPC error instead of a normal chat.
    socket.on('rpc-request', (request, acknowledge) => {
        if (request.method === `${session.id}:listCodexModels`) {
            acknowledge(JSON.stringify({ success: true, models: [{ id: 'synthetic-design-model', displayName: 'Design-Modell (synthetisch)', isDefault: true, supportedReasoningEfforts: ['medium'] }] }));
        } else acknowledge(JSON.stringify({ success: false, error: 'Synthetic method unavailable' }));
    });
    socket.emit('rpc-register', { method: `${session.id}:listCodexModels` });
    let version = session.agentStateVersion;
    async function setCapacity(value) {
        const result = await socket.timeout(10_000).emitWithAck('update-state', { sid: session.id, expectedVersion: version, agentState: { providerCapacity: value } });
        if (result.result !== 'success') throw Error(`Synthetic capacity state rejected: ${result.result}`);
        version = result.version;
    }
    await setCapacity(capacity);
    const heartbeat = () => socket.emit('session-alive', { sid: session.id, time: Date.now(), thinking: false });
    heartbeat(); heartbeats.push(setInterval(heartbeat, 4000));
    socket.emit('message', { sid: session.id, localId: `${provider}:design:user`, message: { role: 'user', content: { type: 'text', text: 'Prüfe die mobile Navigation, Kapazitätsfenster und die Projektgrenzen. Die Anwendung soll auch bei 320 Pixeln bedienbar bleiben.' } } });
    socket.emit('messages-consumed', { sid: session.id, localIds: [`${provider}:design:user`] });
    socket.emit('message', { sid: session.id, localId: `${provider}:design:reply`, message: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Die Navigation besitzt jetzt klare Ziele und verständliche Statusangaben.\n\n- Projektkontext bleibt sichtbar.\n- Anbieterfenster werden mit Datenstand und Zurücksetzung angezeigt.\n- Unbekannte Kapazität wird nicht als 100 % frei ausgegeben.\n\n```ts\nconst viewport = { width: 320, height: 740 };\n```' } } } });
    return { id: session.id, setCapacity };
}

async function verifyMobileNavigation() {
    await workspace('overview');
    const more = page.getByRole('button', { name: 'Mehr', exact: true });
    await more.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    check(await dialog.evaluate(element => element.contains(document.activeElement)), 'Mobile menu: initial focus outside dialog');
    const focusableCount = await dialog.locator('button,a[href],input,select,textarea,[tabindex="0"]').count();
    for (let index = 0; index < focusableCount + 2; index++) {
        await page.keyboard.press('Tab');
        check(await dialog.evaluate(element => element.contains(document.activeElement)), 'Mobile menu: keyboard focus escaped dialog');
    }
    await auditView('mobile-390-menu');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    check(await more.evaluate(element => element === document.activeElement), 'Mobile menu: Escape did not restore trigger focus');
    await more.click();
    await page.getByRole('dialog').getByRole('link', { name: 'Gedächtnis', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('tab') === 'memory');
    await page.getByText('Verifizierte mobile Arbeitsweise', { exact: true }).waitFor();
    await page.goBack();
    await page.waitForURL(url => !url.searchParams.get('tab') || url.searchParams.get('tab') === 'overview');
    await page.goForward();
    await page.waitForURL(url => url.searchParams.get('tab') === 'memory');
    await page.reload();
    await page.getByText('Verifizierte mobile Arbeitsweise', { exact: true }).waitFor();
    report.checks.push('Mobile menu focus trap/Escape/return, real links, Back/Forward and deep-link reload');
}

const hubPort = await freePort(), vaultPort = await freePort(), origin = `http://localhost:${hubPort}`;
try {
    child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], {
        cwd: repo, env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hubPort), EVOLVED_TEST_VAULT_PORT: String(vaultPort) }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => { fixtureErrors = (fixtureErrors + chunk.toString()).slice(-8000); });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
        if (child.exitCode !== null) throw Error(`Isolated fixture exited (${child.exitCode})`);
        try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch { /* wait for fixture */ }
        await pause(100);
    }
    if (!ready) throw Error('Isolated fixture startup timeout');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-DE', colorScheme: 'light', reducedMotion: 'reduce' });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => report.failures.push(`Browser error: ${error.message}`));
    cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin);
    await page.getByLabel('Benutzername', { exact: true }).waitFor();
    if (!extended) await auditView('desktop-1440-onboarding');
    for (const [name, width, height, scheme] of (extended ? [] : [['mobile-390-onboarding', 390, 844, 'light'], ['mobile-320-onboarding', 320, 740, 'light'], ['mobile-390-dark-onboarding', 390, 844, 'dark']])) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await auditView(name);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByLabel('Benutzername', { exact: true }).fill('Designprüfung');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await page.getByRole('heading', { name: 'Wiederherstellungscodes sichern' }).waitFor();
    await page.getByLabel('Ich habe die Codes sicher gespeichert.').check();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    const { team } = await api('/teams', 'POST', { name: 'Studio · Produktentwicklung' });
    const { project } = await api('/projects', 'POST', { teamId: team.id, name: 'HAPI-eVolved · Mobile Arbeitsoberfläche' });
    const { project: emptyProject } = await api('/projects', 'POST', { teamId: team.id, name: 'Internationalisierung und Barrierefreiheit für verteilte Entwicklungsteams' });
    const memory = await api(`/projects/${project.id}/memory`, 'POST', { title: 'Verifizierte mobile Arbeitsweise', body: 'Navigation und Formulare bleiben bei 320 Pixeln bedienbar. Anbieterfenster zeigen ihre Herkunft und den Beobachtungszeitpunkt.', sources: [{ kind: 'manual' }] });
    await api(`/projects/${project.id}/memory/${memory.item.id}`, 'PATCH', { status: 'verified' });
    const lease = await api(`/projects/${project.id}/runner-leases`, 'POST', { name: 'Synthetic responsive acceptance', scopes: ['runner:connect'], expiresInSeconds: 3600 });
    const exchanged = await fetch(`${origin}/api/evolved/runner/token`, { method: 'POST', headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' }, body: '{}' });
    if (!exchanged.ok) throw Error('Synthetic runner lease exchange failed');
    const { token } = await exchanged.json();
    const now = Date.now();
    const codexCapacity = { provider: 'codex', source: 'codex-app-server', scope: 'account', observedAt: now, status: 'available', reason: null, windows: [
        { id: 'codex:primary', usedPercent: 38, remainingPercent: 62, resetsAt: now + 3 * 3600_000, durationMinutes: 300, status: 'allowed' },
        { id: 'codex:secondary', usedPercent: 71, remainingPercent: 29, resetsAt: now + 4 * 86400_000, durationMinutes: 10080, status: 'warning' },
    ] };
    const claudeCapacity = { provider: 'claude', source: 'claude-sdk', scope: 'account', observedAt: now, status: 'unknown', reason: 'utilization_not_reported', windows: [
        { id: 'five_hour', usedPercent: null, remainingPercent: null, resetsAt: now + 2 * 3600_000, durationMinutes: 300, status: 'allowed' },
    ] };
    if (extended) await seedMachine(token, project);
    const codex = await seedAgent('codex', token, project, codexCapacity);
    await seedAgent('claude', token, project, claudeCapacity);
    await verifyCapacityData(project.id, data => {
        const codex = data.providers.find(provider => provider.provider === 'codex')?.reports[0];
        const claude = data.providers.find(provider => provider.provider === 'claude')?.reports[0];
        return codex?.stale === false && codex.windows[0]?.remainingPercent === 62 && codex.windows[1]?.remainingPercent === 29
            && claude?.windows[0]?.usedPercent === null && claude?.windows[0]?.remainingPercent === null;
    }, 'source-derived remaining percentages and unknown Claude utilization');
    await page.reload();
    await workspace();
    await page.getByRole('combobox', { name: 'Aktives Projekt', exact: true }).selectOption(project.id);
    report.checks.push('Real WebAuthn enrollment; persisted teams/projects/memory; authenticated CLI sessions and capacity state');

    for (const [name, width, height, scheme] of (extended ? [
        ['tablet-768', 768, 1024, 'light'], ['tablet-1024-landscape', 1024, 768, 'light'],
        ['phone-landscape-844', 844, 390, 'light'], ['mobile-320-oled-font130', 320, 740, 'dark'],
    ] : [
        ['desktop-1440', 1440, 1000, 'light'], ['mobile-390', 390, 844, 'light'],
        ['mobile-320', 320, 740, 'light'], ['desktop-1440-dark', 1440, 1000, 'dark'], ['mobile-390-dark', 390, 844, 'dark'], ['mobile-320-dark', 320, 740, 'dark'],
    ]).filter(([name]) => !focusOnly || ['tablet-1024-landscape', 'mobile-320-oled-font130'].includes(name))) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        if (extended) {
            const enlarged = name.includes('font130');
            await cdp.send('Emulation.setEmulatedOSTextScale', { scale: enlarged ? 1.3 : 1 });
            await page.evaluate(({ enlarged }) => { localStorage.setItem('hapi-font-scale', enlarged ? '1.3' : '1'); localStorage.setItem('hapi-appearance', enlarged ? 'oled' : 'light'); }, { enlarged });
        }
        for (const tab of (focusOnly ? [] : extended ? ['overview', 'capacity', 'projects', 'memory', 'github', 'team', 'runner', 'codegraph', 'vault', 'automation', 'previews'] : ['overview', 'capacity', 'projects', 'memory', 'github', 'team', 'runner', 'codegraph'])) {
            await workspace(tab);
            if (tab === 'capacity') await verifyCapacityPresentation('fresh');
            await auditView(`${name}-${tab}`);
            if (extended) await inspectScrolledControls(`${name}-${tab}`);
        }
        if (extended) {
            await page.goto(`${origin}/sessions/new`);
            await page.getByRole('radio', { name: 'Claude Code', exact: true }).or(page.getByRole('radio', { name: 'Claude', exact: true })).first().waitFor();
            await auditView(`${name}-new-session`);
            await inspectScrolledControls(`${name}-new-session`);
            if (focusOnly && width === 1024) {
                const copy = page.locator('button[title^="Copy: "]').first();
                await copy.focus();
                const target = await copy.evaluate(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height, opacity: getComputedStyle(element).opacity }; });
                check(target.width >= 44 && target.height >= 44 && target.opacity === '1', `${name}: copy target must be 44px and visible on keyboard focus (${JSON.stringify(target)})`);
                report.checks.push('Sidebar copy-path button is at least 44px and visible on keyboard focus');
            }
            const input = page.locator('input:not([type=radio]):not([type=checkbox]):not([type=hidden])').first();
            if (await input.count()) { await input.focus(); await page.keyboard.press('Tab'); check(await page.evaluate(() => document.activeElement !== document.body), `${name}: NewSession keyboard lost focus`); }
            if (!focusOnly && width <= 900) { await workspace('overview'); await page.getByRole('button', { name: 'Mehr', exact: true }).click(); await page.getByRole('dialog').waitFor(); await auditView(`${name}-menu`); await page.keyboard.press('Escape'); }
        }
        if (focusOnly && width !== 320) continue;
        await page.goto(`${origin}/sessions/${codex.id}`);
        await page.getByTestId('composer-shell').waitFor();
        for (let attempt = 0; attempt < 10; attempt++) {
            const acknowledge = page.getByRole('button', { name: 'Got it', exact: true }).first();
            if (!await acknowledge.isVisible()) break;
            await acknowledge.click();
            await pause(100);
        }
        check(!/Failed to load Codex models/.test(await page.locator('body').innerText()), 'Chat fixture: authenticated model RPC failed');
        await auditView(`${name}-chat`);
        if (extended && width === 320) {
            for (const label of ['Persönliche Prompts', '/btw']) {
                const trigger = page.getByTestId('composer-toolbar-items').getByRole('button', { name: label, exact: true });
                await trigger.scrollIntoViewIfNeeded(); await trigger.click();
                const dialog = page.getByRole('dialog'); await dialog.waitFor();
                check(await dialog.evaluate(element => element.contains(document.activeElement)), `${name}: ${label} dialog focus outside`);
                await auditView(`${name}-toolbar-${label === '/btw' ? 'btw' : 'prompts'}`);
                await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
                await page.waitForFunction(label => [...document.querySelectorAll('[data-testid="composer-toolbar-items"] button')].some(element => (element.getAttribute('aria-label') || element.textContent)?.trim() === label && element === document.activeElement), label, { timeout: 1500 }).catch(() => {});
                check(await trigger.evaluate(element => document.activeElement === element), `${name}: ${label} Escape did not restore focus`);
            }
        }
        if (!focusOnly) { await page.goto(`${origin}/settings/display`); await auditView(`${name}-settings`); }
    }
    if (!extended) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await verifyMobileNavigation();
    await workspace('capacity', emptyProject.id);
    const emptyCapacity = page.getByTestId('capacity-panel');
    await emptyCapacity.getByText('Noch keine Kapazitätsmeldung.', { exact: false }).first().waitFor();
    check(await emptyCapacity.getByRole('meter').count() === 0, 'Capacity: project switch retained another project quota');
    await auditView('mobile-390-capacity-empty-project');
    await workspace('capacity', project.id);
    await codex.setCapacity({ ...codexCapacity, observedAt: now - 24 * 3600_000 });
    await verifyCapacityData(project.id, data => data.providers.find(provider => provider.provider === 'codex')?.reports[0]?.stale === true, 'stale source timestamp');
    await workspace('capacity');
    await verifyCapacityPresentation('stale');
    await auditView('mobile-390-capacity-stale');
    await codex.setCapacity({ provider: 'codex', source: 'codex-app-server', scope: 'account', observedAt: Date.now(), status: 'unknown', reason: 'not_reported', windows: [] });
    await verifyCapacityData(project.id, data => data.providers.find(provider => provider.provider === 'codex')?.reports[0]?.windows.length === 0, 'unreported provider capacity');
    await workspace('capacity');
    await verifyCapacityPresentation('unknown');
    await auditView('mobile-390-capacity-unavailable');
    await codex.setCapacity({ provider: 'codex', source: 'codex-app-server', scope: 'account', observedAt: Date.now(), status: 'unknown', reason: 'authentication_required', windows: [] });
    await workspace('capacity');
    await page.getByTestId('capacity-panel').getByText('Der Agent benötigt eine Anmeldung beim Anbieter.', { exact: true }).waitFor();
    await auditView('mobile-390-capacity-authentication');
    }
    await api(`/projects/${project.id}/runner-leases/${lease.id}`, 'DELETE');
    report.checks.push(focusOnly ? 'Targeted 1024px sidebar / 320px OLED 130% font-scale dialog regressions; synthetic runner lease revoked' : extended ? 'Tablet/landscape/OLED and 130% app+OS text-scale audit; synthetic runner lease revoked' : 'Stale and unavailable provider data use real authenticated state updates; synthetic runner lease revoked');
} catch (error) {
    report.failures.push(error instanceof Error ? error.message : String(error));
    if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
    heartbeats.forEach(clearInterval);
    sockets.forEach(socket => socket.disconnect());
    await browser?.close();
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
        if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(state, { recursive: true, force: true });
    report.passed = report.failures.length === 0;
    writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`${report.passed ? 'PASS' : 'FAIL'} design acceptance: ${report.views.length} views, ${report.failures.length} findings; artifacts ${output}`);
    if (!report.passed) {
        console.error(report.failures.join('\n'));
        process.exitCode = 1;
    }
}
