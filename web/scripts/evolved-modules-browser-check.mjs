import { chromium } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { workspaceArea } from './evolved-navigation.mjs';

/**
 * Real isolated Hub + WebAuthn check for development modules contributed by a GitHub plugin.
 * Only GitHub is synthetic (test fixture); install, persistence, CAS and module status run in the Hub.
 * The module ids and the second title are random per run, so the already built bundle meets
 * scenario modules it has never seen; its script hash is compared before and after.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), state = mkdtempSync('/tmp/hapi-evolved-ui-');
const evidence = process.env.EVOLVED_MODULES_EVIDENCE_DIR ?? join(state, 'evidence');
mkdirSync(evidence, { recursive: true });
const suffix = randomBytes(4).toString('hex');
// Long names (mirrored in evolved-browser-hub.ts) make picker rows wrap at 320/390 px.
const otherTitle = `Zufallsszenario ${suffix} mit ausführlichem Titel für schmale Bildschirme`;
const pluginName = 'Browser Modules · synthetische Sammlung mit bewusst langem Namen für Zeilenumbrüche';
/**
 * Every visible module picker: each row keeps all its content (radio, title/detail text, badge) inside its own box,
 * rows do not overlap, rows stay touch-sized. Measured on the DOM, not only via page overflow.
 */
async function assertPickerGeometry(page, label) {
    const problems = await page.evaluate(() => {
        const issues = [], tolerance = 0.5;
        const lists = [...document.querySelectorAll('.ev-dev-picker-list')].filter(list => list.getClientRects().length);
        if (!lists.length) issues.push('no visible picker');
        for (const list of lists) {
            const rows = [...list.querySelectorAll(':scope > .ev-dev-picker-row')];
            if (rows.length < 2) issues.push('picker has fewer than two rows');
            let previous = null;
            for (const row of rows) {
                const box = row.getBoundingClientRect();
                const name = row.querySelector('strong')?.textContent ?? '?';
                if (box.height < 43.5) issues.push(`${name}: row ${box.height.toFixed(2)}px below touch size`);
                for (const child of row.querySelectorAll('input, .ev-dev-picker-text, .ev-dev-picker-text > *, .ev-dev-pill')) {
                    const inner = child.getBoundingClientRect();
                    const below = inner.bottom - box.bottom, above = box.top - inner.top, right = inner.right - box.right, left = box.left - inner.left;
                    if (Math.max(below, above, right, left) > tolerance) issues.push(`${name}: ${child.className || child.tagName} outside row (above ${above.toFixed(2)}, below ${below.toFixed(2)}, left ${left.toFixed(2)}, right ${right.toFixed(2)})`);
                }
                const text = row.querySelector('.ev-dev-picker-text');
                if (text && text.scrollHeight > text.clientHeight + 1) issues.push(`${name}: text clipped (${text.scrollHeight}/${text.clientHeight})`);
                if (previous && box.top < previous.bottom - tolerance) issues.push(`${name}: overlaps previous row by ${(previous.bottom - box.top).toFixed(2)}px`);
                previous = box;
            }
        }
        return issues;
    });
    if (problems.length) fail(`${label}: picker geometry: ${problems.join('; ')}`);
}
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
const hubPort = await freePort(), vaultPort = await freePort(), origin = `http://localhost:${hubPort}`;
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: repo, env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hubPort), EVOLVED_TEST_VAULT_PORT: String(vaultPort), EVOLVED_TEST_PLUGINS: '1', EVOLVED_TEST_MODULE_SUFFIX: suffix, EVOLVED_CONTROL_SOCKET: '', EVOLVED_CONTROL_KEY_FILE: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
let fixtureErrors = '', browser;
child.stderr.on('data', data => fixtureErrors += data.toString());
const fail = message => { throw Error(message); };
try {
    let ready = false;
    for (let i = 0; i < 150; i++) { if (child.exitCode !== null) fail('Fixture stopped: ' + fixtureErrors); try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    if (!ready) fail('Fixture startup timeout');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors = [], puts = [], legacy = [], actions = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (/\/projects\/[^/]+\/development\/modules$/.test(path) && request.method() === 'PUT') puts.push(request.postDataJSON());
        if (/\/projects\/[^/]+\/development(?:\/context|\/knowledge)?$/.test(path)) legacy.push(`${request.method()} ${path}`);
        if (/\/development\/modules-(?:doctor|inspect)$/.test(path) || /\/agent-catalog\/[^/]+\/start$/.test(path)) actions.push(`${request.method()} ${path}`);
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin);
    await page.getByLabel('Benutzername', { exact: true }).fill('Module Test');
    await page.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await page.getByRole('heading', { name: 'Wiederherstellungscodes sichern' }).waitFor();
    await page.getByLabel('Ich habe die Codes sicher gespeichert.').check();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await workspaceArea(page, 'Team & Konto');
    await page.getByLabel('Neues Team', { exact: true }).fill('Module team');
    await page.getByRole('button', { name: 'Team anlegen', exact: true }).click();
    await page.getByRole('heading', { name: 'Mitglieder · Module team' }).waitFor();
    await workspaceArea(page, 'Projekte');
    await page.getByLabel('Projektname', { exact: true }).fill('Module Alpha');
    const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/evolved/projects' && r.request().method() === 'POST' && r.status() === 201);
    await page.getByRole('button', { name: 'Projekt anlegen', exact: true }).click();
    const projectId = (await (await created).json()).project.id;
    await page.getByLabel('Aktives Projekt', { exact: true }).selectOption({ label: 'Module Alpha' });

    const bundleHash = async () => createHash('sha256').update(await page.evaluate(async () => {
        const parts = [];
        for (const script of [...document.querySelectorAll('script[src]')]) parts.push(await (await fetch(script.src)).text());
        return parts.join('\n');
    })).digest('hex');
    const before = await bundleHash();

    // MOD-01: install the module-only plugin from the reviewed preview; nothing is activated.
    await workspaceArea(page, 'Agenten & Plugins');
    await page.getByLabel(/^GitHub-Repository/).fill('synthetic-owner/browser-modules');
    await page.getByRole('button', { name: 'Plugin prüfen', exact: true }).click();
    const previewRegion = page.getByRole('region', { name: 'Plugin-Vorschau' });
    await previewRegion.getByText('c'.repeat(40), { exact: true }).waitFor();
    await previewRegion.getByText(otherTitle, { exact: true }).waitFor();
    await previewRegion.getByText(/Neu installiert, in keinem Projekt aktiv/).first().waitFor();
    const installed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/evolved/plugins' && r.request().method() === 'POST' && r.status() === 201);
    await previewRegion.getByRole('button', { name: 'Diese Fassung installieren', exact: true }).click();
    const plugin = (await (await installed).json()).plugin;
    await page.getByText(/Entwicklungsmodule werden in keinem Projekt automatisch aktiviert/).waitFor();
    const moduleId = `plugin:${plugin.id}:scenario-${suffix}`;
    const afterInstall = await (await page.request.get(`${origin}/api/evolved/projects/${projectId}/development/modules`)).json();
    if (afterInstall.config.settings.activeModuleId !== null || afterInstall.config.revision !== 0) fail('Installing a plugin changed a project configuration');
    if (!afterInstall.catalog.modules.some(entry => entry.id === moduleId) || afterInstall.catalog.modules.some(entry => 'fields' in entry.form)) fail('Catalog entries missing or not bounded');
    const r1Digest = afterInstall.catalog.modules.find(entry => entry.id === moduleId).digest;

    // The project creation form uses the same picker: same geometry rules with the long plugin entries.
    await workspaceArea(page, 'Projekte');
    await page.getByRole('radio', { name: otherTitle, exact: true }).waitFor();
    for (const [width, height] of [[1440, 1000], [390, 844], [320, 740]]) {
        await page.setViewportSize({ width, height });
        await page.getByRole('radio', { name: otherTitle, exact: true }).waitFor();
        if (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 1) fail(`Project creation overflows horizontally at ${width} px`);
        await assertPickerGeometry(page, `creation ${width} px`);
        if (width !== 1440) { await page.locator('.ev-dev-picker-list').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `creation-picker-${width}.png`), fullPage: false }); }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // MOD-02 / FIELD-01: choose the new module, fill typed values including false and 0, save, reload.
    await workspaceArea(page, 'Entwicklung');
    await page.getByRole('heading', { name: 'Entwicklungsmodul', exact: true }).waitFor();
    await page.getByRole('radio', { name: otherTitle, exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Synthetisches Szenario', exact: true }).check();
    const packageName = page.getByLabel(/^Paketname für Übergänge/);
    await packageName.fill('mein_paket');
    await page.getByLabel(/^Kanal/).selectOption('beta');
    if (await page.getByLabel(/^Parallele Jobs/).inputValue() !== '0') fail('Number default 0 is not shown');
    if (await page.getByLabel('Mit Web-Ziel', { exact: true }).isChecked()) fail('Boolean default false is not shown');
    await page.getByLabel(/^Zusätzliche Pfade/).fill('docs/Übersicht\nlib');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await page.getByText(/Gespeichert als Revision 1\./).waitFor();
    const firstPut = puts.at(-1);
    const values = firstPut?.settings.modules?.[moduleId]?.values;
    if (firstPut?.expectedRevision !== 0 || firstPut.settings.activeModuleId !== moduleId || firstPut.settings.modules[moduleId].moduleDigest !== r1Digest
        || JSON.stringify(values) !== JSON.stringify({ packageName: 'mein_paket', channel: 'beta', jobs: 0, web: false, paths: ['docs/Übersicht', 'lib'], path: '.' })) fail(`Unexpected module save body: ${JSON.stringify(firstPut)}`);
    await page.reload();
    await page.getByText(/^Gespeichert: Synthetisches Szenario · Revision 1/).waitFor();
    if (await packageName.inputValue() !== 'mein_paket' || await page.getByLabel(/^Kanal/).inputValue() !== 'beta') fail('Saved values not restored after reload');
    await page.getByRole('heading', { name: 'Handbuch · Synthetisches Szenario' }).waitFor();
    await page.getByText('Synthetische Prüfung', { exact: true }).waitFor();

    // Second unknown module: own fields with similar ids, the first module's values stay untouched.
    await page.getByRole('radio', { name: otherTitle, exact: true }).check();
    await page.getByLabel(/^Pfadvariante/).waitFor();
    if (!await page.getByLabel('Paket bündeln', { exact: true }).isChecked()) fail('Second module default not applied');
    if (await packageName.count()) fail('Fields of the first module shown for the second');
    await page.getByRole('radio', { name: 'Synthetisches Szenario', exact: true }).check();
    if (await packageName.inputValue() !== 'mein_paket') fail('Inactive module values were not preserved');
    if (await page.getByRole('button', { name: 'Verwerfen', exact: true }).count()) await page.getByRole('button', { name: 'Verwerfen', exact: true }).click();

    // Viewports: no horizontal overflow, labels and errors readable, save reachable above mobile navigation.
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const reachable = locator => locator.evaluate(element => { const rect = element.getBoundingClientRect(); const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return Boolean(target && (target === element || element.contains(target))); });
    for (const [width, height] of [[1440, 1000], [390, 844], [320, 740]]) {
        await page.setViewportSize({ width, height });
        await page.getByRole('heading', { name: 'Entwicklungsmodul', exact: true }).waitFor();
        if (await overflow() > 1) fail(`Development page overflows horizontally at ${width} px`);
        const row = await page.getByRole('radio', { name: 'Allgemein', exact: true }).locator('xpath=..').boundingBox();
        if (!row || row.height < 40 || row.height > 96) fail(`Module picker rows are not compact at ${width} px: ${JSON.stringify(row)}`);
        await assertPickerGeometry(page, `settings ${width} px`);
        if (width !== 1440) { await page.locator('.ev-dev-picker-list').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `modules-picker-${width}.png`), fullPage: false }); }
        if (width === 390) { await packageName.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, 'modules-390-fields.png'), fullPage: false }); }
        if (width === 320) {
            // FIELD-02: required field emptied; Enter keeps focus on the problem and sends nothing.
            const count = puts.length;
            await packageName.fill('   ');
            await page.getByText('Pflichtfeld: bitte ausfüllen.', { exact: true }).waitFor();
            if (await packageName.getAttribute('aria-invalid') !== 'true') fail('Required error is not announced on the field');
            await page.getByLabel(/^Zusätzliche Pfade/).focus();
            await page.getByLabel(/^Parallele Jobs/).press('Enter');
            if (!await packageName.evaluate(element => element === document.activeElement)) fail('Enter did not focus the first invalid field');
            await page.waitForTimeout(300);
            if (puts.length !== count) fail('An invalid draft was sent');
            await page.screenshot({ path: join(evidence, 'modules-320-required.png'), fullPage: false });
            const discard = page.getByRole('button', { name: 'Verwerfen', exact: true });
            await discard.scrollIntoViewIfNeeded();
            if (!await reachable(discard) || !await reachable(page.getByRole('button', { name: 'Speichern', exact: true }))) fail('Save bar is covered at 320 px');
            if (await overflow() > 1) fail('Error state overflows at 320 px');
            await discard.click();
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // CREATE-RACE: a second tab reviews a project creation with R1 while this tab installs R2. The Hub must refuse the
    // stale digest; the tab offers an explicit reload, keeps the draft and then creates with the new revision.
    const creator = await context.newPage();
    creator.on('pageerror', error => errors.push(String(error)));
    const creations = [];
    creator.on('response', response => { if (new URL(response.url()).pathname === '/api/evolved/projects' && response.request().method() === 'POST') creations.push({ status: response.status(), body: response.request().postDataJSON() }); });
    await creator.goto(page.url());
    await workspaceArea(creator, 'Projekte');
    await creator.getByLabel('Projektname', { exact: true }).fill('Module Race');
    await creator.getByRole('radio', { name: 'Synthetisches Szenario', exact: true }).check();
    await creator.getByLabel(/^Paketname für Übergänge/).fill('race_pkg');
    await creator.getByLabel(/^Parallele Jobs/).fill('3');

    // LIFE-02: plugin update R2 (new required field, removed option) requires explicit project adoption.
    await workspaceArea(page, 'Agenten & Plugins');
    await page.getByLabel(/^Branch, Tag oder Commit/).fill('updated');
    const card = page.locator('.ev-agent-card').filter({ has: page.getByText(pluginName, { exact: true }) });
    await card.getByRole('button', { name: 'Update prüfen', exact: true }).click();
    await previewRegion.getByText('d'.repeat(40), { exact: true }).waitFor();
    await previewRegion.getByText(/1 Projekt muss die neue Fassung danach übernehmen/).waitFor();
    if (await previewRegion.getByRole('checkbox').count()) fail('Update preview asks for an extra confirmation checkbox');
    await previewRegion.getByRole('button', { name: 'Diese Fassung aktualisieren', exact: true }).click();
    await page.getByText(/Ein Projekt muss die neue Modulfassung unter „Entwicklung“ übernehmen/).waitFor();

    const createRace = creator.getByRole('button', { name: 'Projekt anlegen', exact: true });
    await createRace.click();
    await creator.getByText('Modul nicht mehr aktuell.', { exact: true }).waitFor();
    if (creations.length !== 1 || creations[0].status !== 409) fail(`Stale creation was not refused by the Hub: ${JSON.stringify(creations.map(item => item.status))}`);
    if (!await createRace.isDisabled()) fail('A stale creation can be repeated without reloading');
    if (await creator.getByLabel('Projektname', { exact: true }).inputValue() !== 'Module Race') fail('Project draft lost after a stale refusal');
    await creator.getByRole('button', { name: 'Modulliste neu laden und prüfen', exact: true }).click();
    const raceTarget = creator.getByLabel(/^Build-Ziel/);
    await raceTarget.waitFor();
    if (await raceTarget.getAttribute('aria-invalid') !== 'true' || !await createRace.isDisabled()) fail('New required field is not enforced after reload');
    if (await creator.getByLabel(/^Paketname für Übergänge/).inputValue() !== 'race_pkg' || await creator.getByLabel(/^Parallele Jobs/).inputValue() !== '3') fail('Compatible module values lost after reload');
    await raceTarget.fill('aab');
    await createRace.click();
    await creator.getByText('Projekt angelegt.', { exact: true }).waitFor();
    const raceBody = creations.at(-1);
    const raceEntry = raceBody?.body.development?.settings.modules?.[moduleId];
    if (creations.length !== 2 || raceBody.status !== 201 || !raceEntry || raceEntry.moduleDigest === r1Digest || raceEntry.values.packageName !== 'race_pkg' || raceEntry.values.jobs !== 3 || raceEntry.values.target !== 'aab' || raceBody.body.name !== 'Module Race')
        fail(`Unexpected creation retry: ${JSON.stringify(creations)}`);
    await creator.close();
    await workspaceArea(page, 'Entwicklung');
    await page.getByText('Neue Modulfassung installiert.', { exact: false }).waitFor();
    await page.getByRole('heading', { name: 'Aufgaben, Prüfungen und Handbuch gesperrt' }).waitFor();
    if (await page.getByRole('heading', { name: 'Handbuch · Synthetisches Szenario' }).count()) fail('Handbook of an unadopted revision is shown');
    await page.screenshot({ path: join(evidence, 'modules-1440-adoption.png'), fullPage: false });
    await page.getByRole('button', { name: 'Installierte Fassung übernehmen und Werte prüfen', exact: true }).click();
    const target = page.getByLabel(/^Build-Ziel/);
    await target.waitFor();
    await page.locator('label', { has: target }).getByText('Neu in dieser Fassung').waitFor();
    if (await page.getByLabel(/^Kanal/).getAttribute('aria-invalid') !== 'true') fail('Removed option is not reported');
    if (await page.getByRole('button', { name: 'Speichern', exact: true }).isEnabled()) fail('An invalid adoption can be saved');
    await page.getByLabel(/^Kanal/).selectOption('stable');
    await target.fill('apk');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await page.getByText(/Gespeichert als Revision 2\./).waitFor();
    const adoption = puts.at(-1);
    const adopted = adoption?.settings.modules?.[moduleId];
    if (adoption?.expectedRevision !== 1 || !adopted || adopted.moduleDigest === r1Digest || adopted.values.channel !== 'stable' || adopted.values.target !== 'apk' || adopted.values.packageName !== 'mein_paket') fail(`Unexpected adoption body: ${JSON.stringify(adoption)}`);
    await page.getByRole('heading', { name: 'Handbuch · Synthetisches Szenario' }).waitFor();

    // LIFE-01: disabling the plugin keeps the selection and values visible, never falls back.
    await workspaceArea(page, 'Agenten & Plugins');
    await card.getByRole('button', { name: 'Deaktivieren', exact: true }).click();
    await page.getByText(/Plugin wurde deaktiviert\. Projekte mit einem seiner Entwicklungsmodule/).waitFor();
    await workspaceArea(page, 'Entwicklung');
    await page.getByText(/Das Plugin dieses Moduls ist deaktiviert/).first().waitFor();
    if (!await page.getByRole('radio', { name: 'Synthetisches Szenario', exact: true }).isChecked() || await page.getByRole('radio', { name: 'Allgemein', exact: true }).isChecked()) fail('Disabled module fell back to another choice');
    if (!await packageName.isDisabled() || await packageName.inputValue() !== 'mein_paket') fail('Disabled module values are not shown read-only');
    if (await page.getByRole('button', { name: 'Sitzung vorbereiten' }).count()) fail('Tasks offered for a disabled module');

    const after = await bundleHash();
    if (before !== after) fail('Web bundle changed during the module run');
    if (legacy.length) fail(`Web app used v1 development routes: ${legacy.join(', ')}`);
    if (actions.length) fail(`Module changes triggered actions: ${actions.join(', ')}`);
    if (errors.length) fail('Browser errors: ' + errors.join('; '));
    console.log(`PASS real isolated Hub: module-only plugin install activates nothing; creation racing a plugin update is refused (409), reloaded explicitly and retried with the new digest keeping the draft; unknown modules scenario-${suffix}/other-${suffix} rendered by the unchanged bundle (sha256 ${before.slice(0, 16)}); typed values incl. false/0 persisted via v2 CAS; reload; inactive values kept; 1440/390/320 without overflow; required error + Enter focus without request; R2 adoption with new required field and removed option; disable keeps read-only values without fallback. Evidence: ${evidence}`);
    await context.close();
} finally {
    if (browser) await browser.close();
    child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(state, { recursive: true, force: true });
}
