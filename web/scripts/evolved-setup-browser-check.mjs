import { chromium } from 'playwright';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { workspaceArea } from './evolved-navigation.mjs';

/**
 * Built web app against a real isolated Hub + Vault with a virtual passkey: project creation hands over to the setup
 * of exactly the returned project, the wizard steps never mutate on open/next/back, Odoo.sh staging and production are
 * saved independently and survive a reload, and the wizard stays compact at 390/320 px. A generic plugin module with a
 * required repository field runs the two-phase path: general project with a noted draft, profile, synthetic GitHub token and
 * grant through the real Hub/Vault, clone, draft kept across the GitHub detour and a reload, then explicit activation.
 * Only the runner-dependent repository transport (status, clone job) is answered by a page route, as in the GitHub check;
 * no real Git transfer, provider, model or Odoo.sh is contacted.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), state = mkdtempSync('/tmp/hapi-evolved-ui-');
const evidence = process.env.EVOLVED_SETUP_EVIDENCE_DIR ?? join(state, 'evidence');
mkdirSync(evidence, { recursive: true });
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
const hubPort = await freePort(), vaultPort = await freePort(), origin = `http://localhost:${hubPort}`;
const suffix = randomBytes(4).toString('hex');
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: repo, env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hubPort), EVOLVED_TEST_VAULT_PORT: String(vaultPort), EVOLVED_TEST_PLUGINS: '1', EVOLVED_TEST_MODULE_SUFFIX: suffix, EVOLVED_CONTROL_SOCKET: '', EVOLVED_CONTROL_KEY_FILE: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
let fixtureErrors = '', browser;
child.stderr.on('data', data => fixtureErrors += data.toString());
const fail = message => { throw Error(message); };
const marks = [];
const mark = text => { marks.push(text); console.log(`ok - ${text}`); };
try {
    let ready = false;
    for (let i = 0; i < 150; i++) { if (child.exitCode !== null) fail('Fixture stopped: ' + fixtureErrors); try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    if (!ready) fail('Fixture startup timeout');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors = [], mutations = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/evolved/') && request.method() !== 'GET') mutations.push(`${request.method()} ${path}`);
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin);
    await page.getByLabel('Benutzername', { exact: true }).fill('Setup Test');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await page.getByRole('heading', { name: 'Wiederherstellungscodes sichern' }).waitFor();
    await page.getByLabel('Ich habe die Codes sicher gespeichert.').check();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await workspaceArea(page, 'Team & Konto');
    await page.getByLabel('Neues Team', { exact: true }).fill('Setup team');
    await page.getByRole('button', { name: 'Team anlegen', exact: true }).click();
    await page.getByRole('heading', { name: 'Mitglieder · Setup team' }).waitFor();

    const create = async (name, configure) => {
        await workspaceArea(page, 'Projekte');
        await page.getByLabel('Projektname', { exact: true }).fill(name);
        if (configure) await configure();
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/evolved/projects' && r.request().method() === 'POST' && r.status() === 201);
        await page.getByRole('button', { name: 'Projekt anlegen', exact: true }).click();
        const id = (await (await response).json()).project.id;
        await page.getByRole('heading', { name: `Einrichtung · ${name}` }).waitFor().catch(async error => {
            await page.screenshot({ path: join(evidence, `failed-handoff-${id}.png`) });
            fail(`${error.message}\nURL ${page.url()}\n${(await page.locator('main').innerText()).slice(0, 1500)}`);
        });
        const url = new URL(page.url());
        if (url.searchParams.get('tab') !== 'setup' || url.searchParams.get('project') !== id) fail(`Creation of ${name} did not enter its own setup: ${page.url()}`);
        if (await page.getByLabel('Aktives Projekt', { exact: true }).inputValue() !== id) fail(`Active project is not ${name}`);
        return id;
    };
    const alpha = await create('Alpha');
    mark('General project creation enters its setup by the returned id');
    // With Alpha active, create ERP with Odoo 19: the returned project is entered without a manual selection.
    const before = mutations.length;
    const erp = await create('ERP Odoo', async () => {
        await page.getByRole('radio', { name: /^Odoo/ }).check();
        await page.getByRole('radio', { name: '19.0', exact: true }).check();
    });
    const afterCreate = mutations.slice(before);
    if (afterCreate.some(item => item.includes(alpha))) fail(`Mutation for the previous project after creating ERP: ${afterCreate.join(', ')}`);
    if (afterCreate.length !== 1) fail(`Unexpected mutations around creation: ${afterCreate.join(', ')}`);
    mark('Odoo project created from another active project: new id selected, no mutation of the old project');

    // Walk all steps with next/back: reads only.
    const walkStart = mutations.length;
    const steps = page.getByRole('navigation', { name: 'Einrichtungsschritte', exact: true });
    await steps.getByRole('button', { name: /Profil/ }).click();
    await page.getByRole('heading', { name: 'Profil', level: 2, exact: true }).waitFor();
    for (const next of ['Anbieter und Runner', 'GitHub und Repository', 'Modul und Einstellungen', 'Prüfen und einrichten', 'Zusammenfassung']) {
        await page.getByRole('button', { name: `Weiter: ${next}`, exact: true }).click();
        await page.getByRole('heading', { name: next, level: 2, exact: true }).waitFor();
        if (new URL(page.url()).searchParams.get('project') !== erp) fail('Step navigation lost the project');
    }
    await page.getByRole('button', { name: 'Zurück: Prüfen und einrichten', exact: true }).click();
    await page.getByRole('heading', { name: 'Prüfen und einrichten', level: 2, exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Zusammenfassung', level: 2, exact: true }).waitFor();
    if (mutations.length !== walkStart) fail(`Opening steps mutated: ${mutations.slice(walkStart).join(', ')}`);
    mark('Profile → provider → GitHub → module → checks → summary, back/next and browser back without any mutation');

    // Module step: separate staging and production, saved explicitly, restored after reload.
    await steps.getByRole('button', { name: /Modul und Einstellungen/ }).click();
    await page.getByRole('heading', { name: 'Modul und Einstellungen', level: 2, exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Odoo.sh', exact: true }).check();
    const staging = page.getByRole('region', { name: 'Staging', exact: true }), production = page.getByRole('region', { name: 'Produktion', exact: true });
    await staging.getByLabel(/^Staging-Branch/).fill('staging');
    await staging.getByLabel(/^Staging · Build-ID/).fill('25004381');
    await staging.getByLabel(/^Staging · Build-Host/).fill('erp-staging-25004381.dev.odoo.com');
    await staging.getByLabel(/^Staging · SSH-Ressource/).fill('odoo-sh-ssh');
    await production.getByLabel(/^Produktion-Branch/).fill('main');
    await production.getByLabel(/^Produktion · SSH-Ressource/).fill('odoo-sh-ssh');
    // The SSH reference needs this stage's own build: the save stays blocked with a reason at the field until then.
    await page.locator('#ev-dev-save-state').getByText(/Produktion · SSH-Ressource: braucht zuerst Build-ID und Build-Host/).waitFor();
    if (await production.getByLabel(/^Produktion · SSH-Ressource/).getAttribute('aria-invalid') !== 'true') fail('Missing production build not marked at the field');
    await production.getByLabel(/^Produktion · Build-ID/).fill('25004102');
    await production.getByLabel(/^Produktion · Build-Host/).fill('erp-main-25004102.dev.odoo.com');
    await staging.getByRole('link', { name: 'Online-Editor ↗', exact: true }).waitFor();
    await page.getByText(/dieselbe SSH-Ressource/).waitFor();
    await page.getByLabel(/^Arbeitsbranch für Sitzungen/).fill('main');
    await page.getByText(/Das ist der Produktions-Branch/).waitFor();
    await page.getByLabel(/^Arbeitsbranch für Sitzungen/).fill('feature-x');
    // Hosting toggle keeps the draft.
    await page.getByRole('radio', { name: 'Lokal', exact: true }).check();
    await page.getByRole('radio', { name: 'Odoo.sh', exact: true }).check();
    if (await staging.getByLabel(/^Staging · Build-ID/).inputValue() !== '25004381') fail('Hosting toggle lost the staging draft');
    if (mutations.length !== walkStart) fail('Editing sent something before saving');
    if (await page.getByRole('button', { name: 'Speichern', exact: true }).isDisabled()) fail(`Save blocked: ${await page.locator('#ev-dev-save-state').innerText()}`);
    const saved = page.waitForResponse(r => /\/development\/modules$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    const response = await saved;
    if (response.status() !== 200) fail(`Save refused: ${response.status()} ${await response.text()}`);
    const body = response.request().postDataJSON();
    const odooSh = body.settings.odoo.odooSh;
    if (odooSh.staging.buildId !== '25004381' || odooSh.production.buildId !== '25004102' || odooSh.production.branch !== 'main' || odooSh.staging.sshResourceId !== 'odoo-sh-ssh' || odooSh.production.sshResourceId !== 'odoo-sh-ssh' || body.settings.odoo.developmentBranch !== 'feature-x') fail(`Unexpected save body: ${JSON.stringify(body.settings.odoo)}`);
    await page.getByText(/Gespeichert als Revision 2\./).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Modul und Einstellungen', level: 2, exact: true }).waitFor();
    if (await page.getByRole('region', { name: 'Staging', exact: true }).getByLabel(/^Staging · Build-Host/).inputValue() !== 'erp-staging-25004381.dev.odoo.com') fail('Staging not restored after reload');
    if (await page.getByRole('region', { name: 'Produktion', exact: true }).getByLabel(/^Produktion · Build-Host/).inputValue() !== 'erp-main-25004102.dev.odoo.com') fail('Production not restored separately');
    mark('Staging and production saved independently via explicit CAS save, shared SSH resource allowed with a note, restored after reload');

    // Compact, overflow-free wizard on phones; the step list is a short list, not large tiles.
    for (const [width, height] of [[390, 844], [320, 740]]) {
        await page.setViewportSize({ width, height });
        for (const step of ['profile', 'github', 'module', 'summary']) {
            await page.goto(`${origin}/evolved?tab=setup&project=${erp}&step=${step}`);
            await page.locator('#ev-setup-step-title').waitFor();
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (overflow > 1) fail(`Setup step ${step} overflows by ${overflow}px at ${width}px`);
            const tall = await page.evaluate(() => [...document.querySelectorAll('.ev-setup-step')].map(item => item.getBoundingClientRect().height).filter(value => value > 90));
            if (tall.length) fail(`Step buttons too tall at ${width}px: ${tall.join(', ')}`);
        }
        await page.goto(`${origin}/evolved?tab=setup&project=${erp}&step=module`);
        const stagingCard = page.getByRole('region', { name: 'Staging', exact: true });
        await stagingCard.waitFor();
        // Embedded panels are flattened inside the wizard: inputs keep most of the width on phones.
        const inset = await stagingCard.getByLabel(/^Staging · Build-ID/).evaluate(element => element.getBoundingClientRect().left);
        if (inset > 48) fail(`Staging input starts at x=${Math.round(inset)} at ${width}px: nested padding too large`);
        // The workspace scrolls inside its content area; a tall viewport of the same width shows the whole wizard as evidence.
        for (const step of ['module', 'profile', 'github']) {
            await page.setViewportSize({ width, height: 6000 });
            await page.goto(`${origin}/evolved?tab=setup&project=${erp}&step=${step}`);
            await page.locator('#ev-setup-step-title').waitFor();
            await page.waitForTimeout(300);
            await page.screenshot({ path: join(evidence, `setup-${step}-${width}-full.png`) });
        }
        await page.setViewportSize({ width, height });
    }
    await page.setViewportSize({ width: 1440, height: 4000 });
    await page.goto(`${origin}/evolved?tab=setup&project=${erp}&step=module`);
    await page.getByRole('region', { name: 'Staging', exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(evidence, 'setup-module-1440-full.png') });
    // Single-token choice labels such as „Odoo.sh“ must not be split across lines.
    const split = await page.evaluate(() => [...document.querySelectorAll('.ev-dev-segment .ev-dev-mode')].map(label => {
        const text = label.textContent.trim(), lines = new Set();
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange(); range.selectNodeContents(node);
            for (const rect of range.getClientRects()) if (rect.width > 0) lines.add(Math.round(rect.top));
        }
        return !text.includes(' ') && lines.size > 1 ? text : null;
    }).filter(Boolean));
    if (split.length) fail(`Choice labels split mid-token on desktop: ${split.join(', ')}`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    mark('390/320 px: no horizontal overflow, compact step list');
    await pluginTwoPhase(page, create, mutations);
    if (mutations.some(item => /modules-doctor|modules-inspect|\/start$|\/providers\//.test(item))) fail(`Unexpected action: ${mutations.join(', ')}`);
    if (mutations.filter(item => item.endsWith('/sync')).length !== 1) fail(`Exactly one explicit clone expected: ${mutations.join(', ')}`);
    if (errors.length) fail(`Page errors: ${errors.join('; ')}`);
    console.log(JSON.stringify({ ok: true, checks: marks, mutations, evidence }));
} finally {
    await browser?.close();
    // Never leave the fixture Hub running: wait for its exit, force it after a grace period.
    if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
    }
    rmSync(state, { recursive: true, force: true });
}

/** Two-phase generic plugin module with a required repository field, through the same wizard as Odoo. */
async function pluginTwoPhase(page, create, mutations) {
    const title = 'Repository-Szenario', repository = 'synthetic-owner/browser-repo', token = 'github_pat_synthetic_browser_credential_only';
    await workspaceArea(page, 'Agenten & Plugins');
    await page.getByLabel(/^GitHub-Repository/).fill('synthetic-owner/browser-modules');
    await page.getByRole('button', { name: 'Plugin prüfen', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Plugin-Vorschau' });
    await preview.getByText(title, { exact: true }).waitFor();
    const installed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/evolved/plugins' && r.request().method() === 'POST' && r.status() === 201);
    await preview.getByRole('button', { name: 'Diese Fassung installieren', exact: true }).click();
    const plugin = (await (await installed).json()).plugin;
    const moduleId = `plugin:${plugin.id}:repo-${suffix}`;

    // Phase 1: general project; the module is only noted (no development body, nothing active).
    let creationBody;
    const recordCreation = request => { if (new URL(request.url()).pathname === '/api/evolved/projects' && request.method() === 'POST') creationBody = request.postDataJSON(); };
    page.on('request', recordCreation);
    await workspaceArea(page, 'Projekte');
    await page.getByLabel('Projektname', { exact: true }).fill('Plugin Repo');
    await page.getByRole('radio', { name: title, exact: true }).check();
    await page.getByLabel(/^Paketname im Repository/).fill('aus_anlage');
    await page.getByText(/Zweistufige Einrichtung/).waitFor();
    const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/evolved/projects' && r.request().method() === 'POST' && r.status() === 201);
    await page.getByRole('button', { name: 'Allgemein anlegen und Modul vormerken', exact: true }).click();
    const projectId = (await (await created).json()).project.id;
    page.off('request', recordCreation);
    if ('development' in creationBody) fail('Two-phase creation sent a module');
    await page.getByRole('heading', { name: 'Einrichtung · Plugin Repo' }).waitFor();
    const steps = page.getByRole('navigation', { name: 'Einrichtungsschritte', exact: true });
    await steps.getByRole('button', { name: /Modul und Einstellungen.*Entwurf/ }).waitFor();
    const saved = async () => (await (await page.request.get(`${origin}/api/evolved/projects/${projectId}/development/modules`)).json()).config;
    if ((await saved()).settings.activeModuleId !== null) fail('Noted module became active without saving');

    // Profile first (explicit confirmation, passkey), then GitHub through the real Hub/Vault with a synthetic account.
    await steps.getByRole('button', { name: /Profil/ }).click();
    await page.getByRole('button', { name: '„Arbeitsbereich“ wählen', exact: true }).click();
    const profileSaved = page.waitForResponse(r => new URL(r.url()).pathname === `/api/evolved/projects/${projectId}/profile` && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    if ((await profileSaved).status() !== 200) fail('Profile change refused');
    await steps.getByRole('button', { name: /Profil.*Erledigt/ }).waitFor();

    // Draft edits survive the GitHub detour and a reload (browser-local, nothing saved).
    await steps.getByRole('button', { name: /Modul und Einstellungen/ }).click();
    const packageName = page.getByLabel(/^Paketname im Repository/);
    await packageName.waitFor();
    if (await packageName.inputValue() !== 'aus_anlage') fail('Creation values not in the noted draft');
    await page.getByText(/Vorgemerkt, noch nicht gespeichert/).waitFor();
    await packageName.fill('im_entwurf');
    await steps.getByRole('button', { name: /GitHub und Repository/ }).click();
    await page.getByLabel('Fine-grained Personal Access Token', { exact: true }).fill(token);
    const connected = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/github') && r.request().method() === 'POST' && r.status() === 200);
    await page.getByRole('button', { name: 'GitHub verbinden', exact: true }).click();
    await connected;
    await page.getByText('synthetic-github-account', { exact: true }).waitFor();
    await page.getByLabel(/^GitHub-Repository/).fill(repository);
    const granted = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/github/repositories') && r.request().method() === 'PUT' && r.status() === 200);
    await page.getByRole('button', { name: 'Repository freigeben', exact: true }).click();
    await granted;

    // Runner transport only: repository status and the clone job are answered by the page (no Git transfer).
    const me = await (await page.request.get(`${origin}/api/evolved/me`)).json();
    const rootPath = me.accessibleProjects.find(item => item.id === projectId).rootPath;
    const prefix = `/api/evolved/projects/${projectId}`;
    let local = 'missing', job = null, polls = 0;
    const [owner, name] = repository.split('/');
    const transport = async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (path === `${prefix}/repositories` && request.method() === 'GET') return respond({ connected: true, rootPath, canSync: true, canPush: false, runner: { status: 'ready' }, repositories: [{
            id: '123', owner, name, fullName: repository, permission: 'read', cloneUrl: `https://github.com/${repository}.git`, path: `${rootPath}/repositories/${repository}`,
            local: { state: local, branch: local === 'ready' ? 'main' : null, dirty: local === 'ready' ? false : null }, ...(job ? { job } : {}) }] });
        if (path === `${prefix}/repositories/123/sync` && request.method() === 'POST') { job = { id: '00000000-0000-4000-8000-0000000000c1', repositoryId: '123', action: 'clone', state: 'running' }; return respond({ job }, 202); }
        if (job && path === `${prefix}/repository-jobs/${job.id}`) { if (++polls >= 2) { local = 'ready'; job = { ...job, state: 'succeeded' }; } return respond({ job }); }
        return route.fallback();
    };
    const pattern = new RegExp(`/api/evolved/projects/${projectId}/(?:repositories(?:/123/sync)?|repository-jobs/[^/?]+)(?:\\?.*)?$`);
    await page.route(pattern, transport);
    try {
        await page.getByRole('button', { name: 'Repository-Status prüfen', exact: true }).click();
        await page.getByRole('button', { name: `Ins Projekt klonen: ${repository}`, exact: true }).click();
        await page.getByText('Repository geklont.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Stand neu prüfen', exact: true }).click();
        await page.getByRole('button', { name: 'Als Standard vormerken und zum Modul', exact: true }).click();
        await page.getByRole('heading', { name: 'Modul und Einstellungen', level: 2, exact: true }).waitFor();
        if (await page.getByLabel(/^Paketname im Repository/).inputValue() !== 'im_entwurf') fail('Draft value lost across the GitHub detour');
        await page.reload();
        const afterReload = page.getByLabel(/^Paketname im Repository/);
        await afterReload.waitFor();
        if (await afterReload.inputValue() !== 'im_entwurf') fail('Draft value lost after reload');
        if ((await saved()).settings.activeModuleId !== null) fail('Something was saved before the explicit save');
        await page.getByLabel(/^Quell-Repository/).selectOption('123');
        const save = page.getByRole('button', { name: 'Speichern', exact: true });
        if (await save.isDisabled()) fail(`Save blocked: ${await page.locator('#ev-dev-save-state').innerText()}`);
        const put = page.waitForResponse(r => new URL(r.url()).pathname === `${prefix}/development/modules` && r.request().method() === 'PUT');
        await save.click();
        const response = await put;
        if (response.status() !== 200) fail(`Activation refused: ${response.status()} ${await response.text()}`);
        const config = await saved();
        const entry = config.settings.modules[moduleId];
        if (config.settings.activeModuleId !== moduleId || config.settings.repositoryId !== '123' || entry?.values.source !== '123' || entry.values.packageName !== 'im_entwurf') fail(`Unexpected activation: ${JSON.stringify(config.settings)}`);
        await steps.getByRole('button', { name: /Modul und Einstellungen.*Erledigt/ }).waitFor();
        await steps.getByRole('button', { name: /GitHub und Repository.*Erledigt/ }).waitFor();
        const leftover = await page.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith('hapi.evolved.setup-intent:') && key.includes(id)), projectId);
        if (leftover.length) fail('Draft kept after the explicit save');
    } finally { await page.unroute(pattern, transport); }
    if (mutations.some(item => item.includes(projectId) && /development\/modules$/.test(item) && !item.startsWith('PUT'))) fail('Unexpected module mutation');
    mark('Generic plugin with required repository: noted draft, profile, synthetic grant, clone via runner transport, draft kept across GitHub detour and reload, explicit activation with the bound repository');
}
