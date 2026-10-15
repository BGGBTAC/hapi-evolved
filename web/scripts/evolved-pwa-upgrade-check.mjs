/**
 * Real two-tab PWA upgrade using two production builds and the isolated Hub/Vault.
 * EVOLVED_PWA_OLD_DIST=/absolute/old/web/dist (required)
 * EVOLVED_PWA_NEW_DIST=/absolute/new/web/dist (defaults to current web/dist)
 * EVOLVED_PWA_EXPECT_BANNER=1 checks the fixed global banner after network navigation.
 * EVOLVED_PWA_PROBE_LEGACY_ACTIVATION=1 diagnoses old tabs' automatic reload listeners.
 * EVOLVED_PWA_VERIFY_NEW_TABS=1 checks explicit activation with two fixed clients.
 * No production state, storage deletion, provider calls or installs are used.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.env.EVOLVED_PWA_OLD_DIST) throw Error('EVOLVED_PWA_OLD_DIST is required');
const oldDist = resolve(process.env.EVOLVED_PWA_OLD_DIST);
const newDist = resolve(process.env.EVOLVED_PWA_NEW_DIST || join(repo, 'web/dist'));
for (const dist of [oldDist, newDist]) for (const file of ['index.html', 'sw.js']) assert(existsSync(join(dist, file)), `Missing ${dist}/${file}`);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.notEqual(digest(join(oldDist, 'sw.js')), digest(join(newDist, 'sw.js')), 'Builds must differ');
const state = mkdtempSync('/tmp/hapi-evolved-ui-pwa-');
const artifacts = mkdtempSync('/tmp/hapi-evolved-pwa-evidence-');
const report = { oldSw: digest(join(oldDist, 'sw.js')), newSw: digest(join(newDist, 'sw.js')), checks: [] };
mkdirSync(join(state, 'hub')); mkdirSync(join(state, 'web'));
function deploy(dist) { symlinkSync(dist, join(state, 'web/next')); renameSync(join(state, 'web/next'), join(state, 'web/dist')); }
deploy(oldDist);
async function port() { const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
const hubPort = await port(), vaultPort = await port(), origin = `http://localhost:${hubPort}`;
const child = spawn('bun', [join(repo, 'web/scripts/evolved-browser-hub.ts')], { cwd: join(state, 'hub'), env: { ...process.env, EVOLVED_TEST_STATE: state, EVOLVED_TEST_HUB_PORT: String(hubPort), EVOLVED_TEST_VAULT_PORT: String(vaultPort) }, stdio: ['ignore', 'ignore', 'pipe'] });
let errors = ''; child.stderr.on('data', data => { errors += data.toString(); });
const pause = ms => new Promise(done => setTimeout(done, ms));
let browser;
const entry = page => page.evaluate(() => [...document.scripts].find(script => /\/assets\/index-[^/]+\.js/.test(script.src))?.src);
async function waiting(page) {
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; await registration.update(); });
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting), { timeout: 20_000 });
    await pause(400);
}
async function ready(page) {
    await page.locator('.ev-workspace, .ew-shell').waitFor();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}
async function draft(page) {
    await page.locator('.ev-tabs').getByRole('button', { name: /Team & Konto/ }).click();
    await page.getByLabel('Neues Team', { exact: true }).fill('UNSAVED_SYNTHETIC_DRAFT');
    await page.evaluate(() => { window.__pwaUpgradeSentinel = 'same-document'; localStorage.setItem('pwa-upgrade-preserved', 'synthetic-preserved'); });
}
try {
    let healthy = false;
    for (let i = 0; i < 150; i++) { if (child.exitCode !== null) throw Error(`Fixture exited: ${errors}`); try { if ((await fetch(`${origin}/health`)).ok) { healthy = true; break; } } catch {} await pause(100); }
    assert(healthy, 'Synthetic Hub did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let first = await context.newPage();
    const cdp = await context.newCDPSession(first); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await first.goto(origin);
    await first.getByLabel('Benutzername', { exact: true }).fill('Synthetic PWA upgrade');
    await first.getByLabel(/^Einrichtungscode/).fill(readFileSync(join(state, 'bootstrap.token'), 'utf8').trim());
    await first.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
    await first.getByRole('heading', { name: 'Wiederherstellungscodes sichern' }).waitFor();
    await first.getByLabel('Ich habe die Codes sicher gespeichert.').check();
    await first.getByRole('button', { name: 'Weiter', exact: true }).click();
    await ready(first);
    const second = await context.newPage(); await second.goto(origin); await ready(second); await draft(second);
    const oldEntry = await entry(first); assert(oldEntry);
    const storageState = await context.storageState(); // Synthetic cookies stay in memory only.
    await first.screenshot({ path: join(artifacts, 'old-no-project.png') });
    deploy(newDist); await waiting(first);
    assert.equal(await first.getByTestId('pwa-update-banner').count(), 0, 'Old onboarding unexpectedly has a banner');
    report.checks.push('Old zero-project client has a waiting new worker but no visible update banner');
    await first.goto(`${origin}/`); await ready(first);
    assert.equal(await entry(first), oldEntry, 'Root document unexpectedly bypassed old precache');
    report.checks.push('Navigating to / still loads the old precached entry');
    await first.goto(`${origin}/evolved?design=upgrade-check`); await first.locator('.ew-shell').waitFor();
    assert.notEqual(await entry(first), oldEntry);
    assert.equal(await second.evaluate(() => window.__pwaUpgradeSentinel), 'same-document');
    assert.equal(await second.getByLabel('Neues Team', { exact: true }).inputValue(), 'UNSAVED_SYNTHETIC_DRAFT');
    assert.equal(await first.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)), true);
    report.checks.push('Direct /evolved navigation loads new HTML without worker activation or sibling-tab draft loss');
    if (process.env.EVOLVED_PWA_EXPECT_BANNER === '1') {
        await first.getByTestId('pwa-update-banner').waitFor();
        assert.equal(await first.getByTestId('pwa-update-banner').count(), 1);
        report.checks.push('Fixed zero-project surface displays exactly one update banner');
    }
    await first.screenshot({ path: join(artifacts, 'new-no-project.png') });
    await first.close(); await second.close(); await pause(500);
    first = await context.newPage(); await first.goto(origin); await ready(first);
    assert.notEqual(await entry(first), oldEntry);
    assert.equal(await first.evaluate(() => localStorage.getItem('pwa-upgrade-preserved')), 'synthetic-preserved');
    assert.equal(await first.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)), false);
    report.checks.push('Closing every app client and reopening activates the waiting version; authentication and localStorage survive');
    await context.close();

    if (process.env.EVOLVED_PWA_VERIFY_NEW_TABS === '1') {
        deploy(newDist);
        const fixed = await browser.newContext({ storageState });
        const initiator = await fixed.newPage(); await initiator.goto(`${origin}/evolved`); await ready(initiator);
        const sibling = await fixed.newPage(); await sibling.goto(`${origin}/evolved?tab=team`); await ready(sibling);
        await sibling.getByLabel('Neues Team', { exact: true }).fill('UNSAVED_FIXED_CLIENT_DRAFT');
        await sibling.evaluate(() => {
            window.__pwaUpgradeSentinel = 'same-document'; window.__pwaControllerChanges = 0;
            navigator.serviceWorker.addEventListener('controllerchange', () => { window.__pwaControllerChanges++; });
        });
        assert.equal(await initiator.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 1);
        assert.equal(await initiator.locator('script[src*="registerSW.js"]').count(), 0);
        report.checks.push('Production page has one service-worker registration and no injected plugin registration script');
        const next = join(state, 'next-dist'); cpSync(newDist, next, { recursive: true });
        // A byte-distinct worker is enough to exercise a real subsequent install;
        // every application asset is the unchanged fixed production build.
        writeFileSync(join(next, 'sw.js'), `${readFileSync(join(next, 'sw.js'), 'utf8')}\n// synthetic subsequent worker version\n`);
        deploy(next); await waiting(initiator); await waiting(sibling);
        await initiator.getByTestId('pwa-update-banner').waitFor(); await sibling.getByTestId('pwa-update-banner').waitFor();
        let siblingNavigations = 0; sibling.on('framenavigated', frame => { if (frame === sibling.mainFrame()) siblingNavigations++; });
        await initiator.evaluate(() => { window.__pwaUpgradeSentinel = 'initiator-before-action'; });
        await initiator.getByTestId('pwa-update-banner').getByRole('button', { name: 'Reload', exact: true }).click();
        await initiator.waitForFunction(() => window.__pwaUpgradeSentinel !== 'initiator-before-action'); await ready(initiator);
        await sibling.waitForFunction(() => window.__pwaControllerChanges > 0);
        await pause(2200); // Also outwait the explicit reload fallback.
        assert.equal(siblingNavigations, 0);
        assert.equal(await sibling.evaluate(() => window.__pwaUpgradeSentinel), 'same-document');
        assert.equal(await sibling.getByLabel('Neues Team', { exact: true }).inputValue(), 'UNSAVED_FIXED_CLIENT_DRAFT');
        assert.equal(await initiator.getByTestId('pwa-update-banner').count(), 0);
        report.checks.push('Two fixed clients: explicit update reloads only its initiator; sibling receives controllerchange but keeps its document and unsent draft');
        await fixed.close(); deploy(newDist);
    }

    if (process.env.EVOLVED_PWA_PROBE_LEGACY_ACTIVATION === '1') {
        deploy(oldDist);
        const probe = await browser.newContext({ storageState });
        const initiator = await probe.newPage(); await initiator.goto(origin); await ready(initiator);
        const sibling = await probe.newPage(); await sibling.goto(origin); await ready(sibling); await draft(sibling);
        deploy(newDist); await waiting(initiator); await waiting(sibling);
        let siblingNavigations = 0; sibling.on('framenavigated', frame => { if (frame === sibling.mainFrame()) siblingNavigations++; });
        await initiator.evaluate(async () => { (await navigator.serviceWorker.getRegistration()).waiting.postMessage({ type: 'SKIP_WAITING' }); });
        await sibling.waitForFunction(() => window.__pwaUpgradeSentinel !== 'same-document');
        assert(siblingNavigations > 0, 'Expected legacy controlling listener to reload the sibling');
        report.checks.push('Confirmed legacy hazard: explicit SKIP_WAITING also reloads the other old tab and destroys its unsaved in-memory draft');
        await probe.close();
    }
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS real PWA upgrade: ${report.checks.length} checks; artifacts ${artifacts}`);
} catch (error) {
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify({ ...report, failure: String(error) }, null, 2));
    console.error(`FAIL PWA upgrade: ${String(error)}; artifacts ${artifacts}`); process.exitCode = 1;
} finally {
    await browser?.close(); child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([new Promise(done => child.once('exit', done)), pause(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(state, { recursive: true, force: true });
}
