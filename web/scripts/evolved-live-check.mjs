/** Real HTTPS acceptance stack only. No database access, real providers, or human passkeys. */
import {
    constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
    readFileSync, readdirSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

class CheckFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}
function requireCheck(condition, code) { if (!condition) throw new CheckFailure(code); }

export function configuration(env = process.env, phase = process.argv[2] ?? 'seed') {
    requireCheck(['seed', 'resume', 'persist', 'revoke'].includes(phase), 'invalid_phase');
    let url;
    try { url = new URL(env.EVOLVED_TEST_URL); } catch { throw new CheckFailure('https_origin_required'); }
    requireCheck(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'https_origin_required');
    const workspace = env.EVOLVED_TEST_WORKSPACE ?? '/workspaces/acceptance';
    requireCheck(/^\/workspaces\/acceptance(?:\/[A-Za-z0-9_-]+)*$/.test(workspace) && posix.normalize(workspace) === workspace, 'acceptance_workspace_required');
    requireCheck(phase !== 'seed' || Boolean(env.EVOLVED_BOOTSTRAP_FILE), 'bootstrap_file_required');
    requireCheck(phase === 'seed' || Boolean(env.EVOLVED_TEST_OUTPUT_DIR), 'existing_output_directory_required');
    const graphSymbol = env.EVOLVED_TEST_GRAPH_SYMBOL ?? '';
    requireCheck(!graphSymbol || /^[A-Za-z_$][A-Za-z0-9_$]{0,100}$/.test(graphSymbol), 'invalid_graph_symbol');
    return {
        phase, origin: url.origin, workspace, graphSymbol,
        bootstrapFile: env.EVOLVED_BOOTSTRAP_FILE,
        outputDirectory: env.EVOLVED_TEST_OUTPUT_DIR,
        executablePath: env.PLAYWRIGHT_CHROME_PATH,
    };
}

/** Descriptor checks avoid following a swapped symlink while opening sensitive files. */
export function readPrivateFile(filename) {
    let fd;
    try {
        const path = resolve(filename);
        requireCheck(realpathSync(path) === path, 'private_file_symlink');
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = fstatSync(fd);
        requireCheck(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.size <= 4 * 1024 * 1024, 'private_file_permissions');
        return readFileSync(fd, 'utf8');
    } finally { if (fd !== undefined) closeSync(fd); }
}

export function prepareOutputDirectory(requested, phase) {
    const directory = requested ? resolve(requested) : mkdtempSync(join(tmpdir(), 'hapi-evolved-live-'));
    if (requested && phase === 'seed') {
        try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = lstatSync(directory);
    requireCheck(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700 && realpathSync(directory) === directory, 'private_directory_permissions');
    requireCheck(phase !== 'seed' || readdirSync(directory).length === 0, 'seed_output_directory_not_empty');
    return directory;
}

function savePrivate(directory, name, value) {
    const temporary = join(directory, `.${name}-${randomUUID()}`);
    writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(directory, name));
}
function readJson(directory, name) { return JSON.parse(readPrivateFile(join(directory, name))); }

async function browserApi(page, path, { method = 'GET', body, headers = {}, expected = 200 } = {}) {
    requireCheck(path.startsWith('/api/') || path === '/health', 'invalid_api_path');
    const result = await page.evaluate(async ({ path, method, body, headers }) => {
        const response = await fetch(path, {
            method, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(40_000),
            headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let data; try { data = JSON.parse(text); } catch { data = null; }
        return { status: response.status, data };
    }, { path, method, body, headers });
    requireCheck((Array.isArray(expected) ? expected : [expected]).includes(result.status), `http_${method.toLowerCase()}_${result.status}`);
    return result.data;
}

async function anonymousStatus(browser, origin, path, headers = {}) {
    const context = await browser.newContext();
    try {
        const response = await context.request.get(origin + path, { headers, maxRedirects: 0 });
        return response.status();
    } finally { await context.close(); }
}

async function addAuthenticator(context, page, saved) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    if (saved) {
        requireCheck(Array.isArray(saved.credentials) && saved.credentials.length > 0, 'missing_virtual_credentials');
        for (const credential of saved.credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
    }
    return { cdp, authenticatorId };
}

async function saveBrowserState(directory, context, authenticator, origin) {
    savePrivate(directory, 'browser-state.json', await context.storageState());
    const cookies = await context.cookies(origin);
    const session = cookies.find(cookie => cookie.name === '__Host-hapi-evolved');
    requireCheck(session?.secure && session.httpOnly && session.sameSite === 'Strict' && session.path === '/', 'secure_session_cookie_required');
    savePrivate(directory, 'session-cookie.txt', `${session.name}=${session.value}\n`);
    savePrivate(directory, 'virtual-authenticator.json', await authenticator.cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticator.authenticatorId }));
}

async function loginAgain(page, origin, displayName) {
    // A real logout/login exercises durable passkey registration and refreshes step-up authority.
    await browserApi(page, '/api/evolved/auth/logout', { method: 'POST', body: {} });
    await page.goto(origin);
    await page.getByLabel('Benutzername (optional)', { exact: true }).fill(displayName);
    await page.getByRole('button', { name: 'Mit Passkey anmelden', exact: true }).click();
    await page.getByRole('button', { name: 'Team & Konto', exact: true }).waitFor();
}

async function verifyPreview(page, context, browser, origin, preview) {
    requireCheck(await anonymousStatus(browser, origin, preview.openPath) === 401, 'private_preview_requires_login');
    const popup = await context.newPage();
    try {
        const response = await popup.goto(origin + preview.openPath);
        requireCheck(response?.status() === 200, 'preview_document_missing');
        const headers = response.headers(), policy = headers['content-security-policy'] ?? '';
        requireCheck(policy.includes('sandbox allow-scripts;') && !policy.includes('allow-same-origin') && !headers['access-control-allow-credentials'], 'preview_sandbox_headers');
        await popup.getByRole('heading', { name: 'Evolved acceptance preview', exact: true }).waitFor();
        const probe = await popup.evaluate(async origin => {
            const result = {};
            try { localStorage.setItem('acceptance-probe', 'synthetic'); result.storage = 'allowed'; } catch { result.storage = 'blocked'; }
            try { document.cookie = 'acceptance-probe=synthetic'; result.cookie = 'allowed'; } catch { result.cookie = 'blocked'; }
            try { await fetch(origin + '/api/evolved/me', { credentials: 'include' }); result.api = 'allowed'; } catch { result.api = 'blocked'; }
            try { const response = await fetch('./asset.txt'); result.asset = response.ok ? (await response.text()).trim() : 'failed'; } catch { result.asset = 'blocked'; }
            return result;
        }, origin);
        requireCheck(probe.storage === 'blocked' && probe.cookie === 'blocked' && probe.api === 'blocked' && probe.asset === 'acceptance-asset-ok', 'preview_runtime_isolation');
        const ticket = popup.url();
        await page.evaluate(url => { const frame = document.createElement('iframe'); frame.id = 'acceptance-preview-probe'; frame.src = url; document.body.append(frame); }, ticket);
        await page.frameLocator('#acceptance-preview-probe').getByRole('heading', { name: 'Evolved acceptance preview', exact: true }).waitFor();
        const frame = await (await page.locator('#acceptance-preview-probe').elementHandle()).contentFrame();
        const blocked = await frame.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } });
        requireCheck(blocked, 'preview_parent_document_isolation');
    } finally {
        await popup.close();
        await page.evaluate(() => document.getElementById('acceptance-preview-probe')?.remove());
    }
}

async function verifyCodegraph(page, projectPath, symbol) {
    if (!symbol) return { status: 'skipped', reason: 'EVOLVED_TEST_GRAPH_SYMBOL not configured; no graph fixture asserted' };
    const deadline = Date.now() + 120_000;
    let node;
    do {
        const status = await browserApi(page, projectPath + '/codegraph/status');
        requireCheck(status.state !== 'error' && status.state !== 'unconfigured', 'codegraph_unavailable');
        if (status.state === 'ready') {
            const search = await browserApi(page, projectPath + '/codegraph/search?q=' + encodeURIComponent(symbol));
            node = search.nodes?.find(candidate => candidate.name === symbol);
        }
        if (!node) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!node && Date.now() < deadline);
    requireCheck(node, 'codegraph_fixture_not_indexed');
    const suffix = '?nodeId=' + encodeURIComponent(node.id);
    const detail = await browserApi(page, projectPath + '/codegraph/node' + suffix);
    const graph = await browserApi(page, projectPath + '/codegraph/graph' + suffix);
    const impact = await browserApi(page, projectPath + '/codegraph/impact' + suffix);
    requireCheck(detail.node?.id === node.id && JSON.stringify(detail.source).includes(symbol), 'codegraph_source');
    requireCheck(graph.nodes?.some(candidate => candidate.id === node.id) && graph.edges?.length > 0 && impact.nodes?.length > 0, 'codegraph_edges_and_impact');
    return { status: 'passed' };
}

export async function runLiveCheck(config) {
    const checks = [];
    const setup = config.phase === 'seed' || config.phase === 'resume';
    let current = 'private_output_directory', directory, browser, context, page, authenticator, handoff;
    const run = async (name, operation) => {
        current = name;
        const result = await operation();
        checks.push({ check: name, ...(result?.status ? result : { status: 'passed' }) });
        return result;
    };
    const record = async () => {
        if (handoff) savePrivate(directory, 'handoff.json', { ...handoff, checks });
        if (context && authenticator && (await context.cookies(config.origin)).some(cookie => cookie.name === '__Host-hapi-evolved')) {
            await saveBrowserState(directory, context, authenticator, config.origin);
        }
    };
    try {
        directory = prepareOutputDirectory(config.outputDirectory, config.phase);
        // Empty seed output prevents overwriting another acceptance identity or operator files.
        if (config.phase !== 'seed') {
            handoff = readJson(directory, 'handoff.json');
            requireCheck(handoff.kind === 'hapi-evolved-synthetic-acceptance' && handoff.origin === config.origin && handoff.workspace === config.workspace && handoff.profile === 'restricted', 'handoff_scope_mismatch');
            for (const key of ['projectId', 'teamId', 'userId', ...(config.phase === 'resume' ? [] : ['leaseId'])]) requireCheck(/^[0-9a-f-]{36}$/.test(handoff[key]), 'invalid_handoff_id');
            requireCheck(/^Evolved acceptance [0-9a-f]{8}$/.test(handoff.displayName), 'synthetic_identity_required');
        }
        current = 'launch_https_browser';
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true, ...(config.executablePath ? { executablePath: config.executablePath } : {}), args: ['--no-sandbox'] });
        context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, ...(config.phase === 'seed' ? {} : { storageState: readJson(directory, 'browser-state.json') }) });
        context.setDefaultTimeout(30_000);
        page = await context.newPage();
        authenticator = await addAuthenticator(context, page, config.phase === 'seed' ? undefined : readJson(directory, 'virtual-authenticator.json'));
        await page.goto(config.origin);
        await run('https_evolved_health', async () => {
            const health = await browserApi(page, '/health');
            requireCheck(health.status === 'ok' && health.evolved?.enabled === true, 'evolved_health_disabled');
        });
        if (config.phase === 'seed') {
            await run('fresh_synthetic_passkey_enrollment', async () => {
                const status = await browserApi(page, '/api/evolved/auth/status');
                requireCheck(status.initialized === false && status.authenticated === false && !status.enrollment, 'refuse_initialized_or_enrolling_stack');
                const token = readPrivateFile(config.bootstrapFile).trim();
                requireCheck(/^[A-Za-z0-9_-]{20,200}$/.test(token), 'invalid_bootstrap_format');
                const displayName = 'Evolved acceptance ' + randomUUID().slice(0, 8);
                await page.getByLabel('Benutzername', { exact: true }).fill(displayName);
                await page.getByLabel(/^Einrichtungscode/).fill(token);
                await page.getByRole('button', { name: 'Passkey erstellen', exact: true }).click();
                await page.getByRole('heading', { name: 'Wiederherstellungscodes sichern', exact: true }).waitFor();
                const recoveryCodes = await page.locator('.ev-recovery-codes code').allTextContents();
                requireCheck(recoveryCodes.length > 0, 'recovery_codes_missing');
                savePrivate(directory, 'recovery-codes.json', recoveryCodes);
                await page.getByLabel('Ich habe die Codes sicher gespeichert.').check();
                await page.getByRole('button', { name: 'Weiter', exact: true }).click();
                await page.getByRole('button', { name: 'Team & Konto', exact: true }).waitFor();
                const me = await browserApi(page, '/api/evolved/me');
                requireCheck(me.user?.isAdmin === true, 'synthetic_admin_missing');
                handoff = { kind: 'hapi-evolved-synthetic-acceptance', origin: config.origin, displayName, userId: me.user.id, workspace: config.workspace, profile: 'restricted', createdAt: new Date().toISOString(), graphSymbol: config.graphSymbol };
                await record();
            });
            await run('synthetic_team_and_restricted_project', async () => {
                const { team } = await browserApi(page, '/api/evolved/teams', { method: 'POST', body: { name: 'Evolved acceptance team' }, expected: 201 });
                const { project } = await browserApi(page, '/api/evolved/projects', { method: 'POST', body: { teamId: team.id, name: 'Evolved acceptance project', rootPath: config.workspace }, expected: 201 });
                requireCheck(project.profile === 'restricted' && project.rootPath === config.workspace, 'restricted_workspace_project');
                Object.assign(handoff, { teamId: team.id, projectId: project.id, namespace: project.namespace });
                await record();
                await page.reload();
                await page.getByRole('combobox', { name: 'Aktives Projekt', exact: true }).selectOption(project.id);
            });
        } else {
            await run('persisted_passkey_login', async () => {
                await loginAgain(page, config.origin, handoff.displayName);
                const me = await browserApi(page, '/api/evolved/me');
                const project = me.accessibleProjects.find(project => project.id === handoff.projectId);
                requireCheck(me.user.id === handoff.userId && me.user.displayName === handoff.displayName && me.user.isAdmin && project?.rootPath === config.workspace && project.teamId === handoff.teamId && project.profile === 'restricted', 'persisted_identity_or_project_missing');
                await page.getByRole('combobox', { name: 'Aktives Projekt', exact: true }).selectOption(handoff.projectId);
                await record();
            });
        }
        const projectPath = `/api/evolved/projects/${handoff.projectId}`;
        if (config.phase === 'revoke') {
            await run('runner_lease_revoked', async () => {
                await browserApi(page, `${projectPath}/runner-leases/${handoff.leaseId}`, { method: 'DELETE' });
                const token = readPrivateFile(join(directory, 'runner.lease')).trim();
                requireCheck(await anonymousStatus(browser, config.origin, '/api/evolved/runner/authority', { authorization: 'Bearer ' + token }) === 401, 'revoked_runner_lease_still_accepted');
                const { leases } = await browserApi(page, projectPath + '/runner-leases');
                requireCheck(leases.find(lease => lease.id === handoff.leaseId)?.revokedAt, 'runner_lease_revocation_missing');
                handoff.leaseRevoked = true;
            });
        } else {
            await run(setup ? 'vault_write_catalog_no_plaintext_read' : 'persisted_vault_catalog_no_plaintext_read', async () => {
                let syntheticValue;
                if (setup && !handoff.secretId) {
                    syntheticValue = 'acceptance-only-' + randomBytes(24).toString('hex');
                    const result = await browserApi(page, projectPath + '/secrets', { method: 'POST', body: { name: 'ACCEPTANCE_SYNTHETIC_VALUE', value: syntheticValue }, expected: 201 });
                    requireCheck(result.secret?.id && !JSON.stringify(result).includes(syntheticValue) && !('value' in result.secret), 'vault_write_exposed_plaintext');
                    handoff.secretId = result.secret.id;
                }
                const { secrets } = await browserApi(page, projectPath + '/secrets');
                requireCheck(secrets.some(secret => secret.id === handoff.secretId) && secrets.every(secret => !('value' in secret)), 'vault_catalog_metadata_only');
                if (syntheticValue) requireCheck(!JSON.stringify(secrets).includes(syntheticValue), 'vault_catalog_exposed_plaintext');
                // There is no plaintext route. The outer legacy auth fallback may deny
                // an unmatched /api path before Hono reaches its 404 handler.
                await browserApi(page, `${projectPath}/secrets/${handoff.secretId}`, { expected: [401, 403, 404, 405] });
                requireCheck(await anonymousStatus(browser, config.origin, projectPath + '/secrets') === 401, 'vault_anonymous_access');
                await page.getByRole('button', { name: 'Tresor', exact: true }).click();
                await page.getByText('ACCEPTANCE_SYNTHETIC_VALUE', { exact: true }).waitFor();
                if (syntheticValue) requireCheck(!(await page.locator('body').innerText()).includes(syntheticValue), 'vault_ui_exposed_plaintext');
            });
            await run(setup ? 'local_memory_propose_verify_search_delete' : 'persisted_local_memory_and_search', async () => {
                if (setup) {
                    await browserApi(page, projectPath + '/memory/settings', { method: 'PATCH', body: { enabled: false, cloudAllowed: false, monthlyBudgetMicros: 0, jobBudgetMicros: 0 } });
                    const { item } = await browserApi(page, projectPath + '/memory', { method: 'POST', body: { title: 'Acceptance disposable note', body: 'This synthetic acceptance note is removed after local verification.', sources: [{ kind: 'manual' }] }, expected: 201 });
                    requireCheck(item.status === 'proposed', 'memory_proposal_status');
                    const verified = await browserApi(page, `${projectPath}/memory/${item.id}`, { method: 'PATCH', body: { status: 'verified' } });
                    requireCheck(verified.item?.status === 'verified', 'memory_verification_status');
                    const query = `/api/evolved/memory/search?projectId=${handoff.projectId}&q=disposable`;
                    const search = await browserApi(page, query);
                    requireCheck(search.mode === 'ledger' && search.results.some(result => result.id === item.id), 'local_memory_search');
                    await browserApi(page, `${projectPath}/memory/${item.id}`, { method: 'DELETE', expected: 202 });
                    requireCheck(!(await browserApi(page, query)).results.some(result => result.id === item.id), 'deleted_memory_searchable');
                    if (!handoff.memoryId) {
                        const durable = await browserApi(page, projectPath + '/memory', { method: 'POST', body: { title: 'Acceptance persistent note', body: 'The synthetic acceptance record survives a service restart.', sources: [{ kind: 'manual' }] }, expected: 201 });
                        handoff.memoryId = durable.item.id;
                    }
                    await browserApi(page, `${projectPath}/memory/${handoff.memoryId}`, { method: 'PATCH', body: { status: 'verified' } });
                }
                const memory = await browserApi(page, projectPath + '/memory');
                requireCheck(memory.items.some(item => item.id === handoff.memoryId && item.status === 'verified') && memory.settings.cloudAllowed === false && memory.settings.enabled === false && memory.budget.spentMicros === 0, 'persisted_local_memory');
                const search = await browserApi(page, `/api/evolved/memory/search?projectId=${handoff.projectId}&q=persistent`);
                requireCheck(search.mode === 'ledger' && search.results.some(item => item.id === handoff.memoryId), 'persisted_memory_search');
                await page.getByRole('button', { name: 'Gedächtnis', exact: true }).click();
                await page.getByText('Acceptance persistent note', { exact: true }).waitFor();
            });
            await run('real_codegraph_source_edges_impact', () => verifyCodegraph(page, projectPath, handoff.graphSymbol));
            // Refresh using the same real ceremony before fresh-passkey protected operations.
            await run('passkey_reauthentication', () => loginAgain(page, config.origin, handoff.displayName));
            await run('private_preview_and_browser_sandbox', async () => {
                if (setup && !handoff.previewId) {
                    const { preview } = await browserApi(page, projectPath + '/previews', { method: 'POST', body: { name: 'Evolved acceptance preview', directory: config.workspace + '/dist' }, expected: 201 });
                    handoff.previewId = preview.id;
                }
                const { previews } = await browserApi(page, projectPath + '/previews');
                const preview = previews.find(preview => preview.id === handoff.previewId);
                requireCheck(preview, 'persisted_preview_missing');
                await verifyPreview(page, context, browser, config.origin, preview);
            });
            await run('preview_share_explicit_and_revocable', async () => {
                const path = `${projectPath}/previews/${handoff.previewId}/shares`;
                const share = await browserApi(page, path, { method: 'POST', body: { expiresInSeconds: 60 }, expected: 201 });
                requireCheck(new URL(share.url).origin === config.origin, 'preview_share_wrong_origin');
                const sharePath = new URL(share.url).pathname;
                requireCheck(await anonymousStatus(browser, config.origin, sharePath) === 200, 'preview_share_unavailable');
                await browserApi(page, `${path}/${share.id}`, { method: 'DELETE' });
                requireCheck(await anonymousStatus(browser, config.origin, sharePath) === 404, 'preview_share_not_revoked');
            });
            await run('authenticated_project_session_bridge', async () => {
                const bridge = await browserApi(page, `/api/evolved/session-token?projectId=${handoff.projectId}`);
                requireCheck(typeof bridge.token === 'string', 'bridge_token_missing');
                const sessions = await browserApi(page, '/api/sessions', { headers: { authorization: `Bearer ${bridge.token}`, 'x-hapi-project-id': handoff.projectId } });
                requireCheck(Array.isArray(sessions.sessions), 'session_bridge_response');
                requireCheck(await anonymousStatus(browser, config.origin, '/api/sessions') === 401, 'legacy_api_anonymous_access');
            });
            await run('restricted_runner_lease_private_handoff', async () => {
                if (setup && !handoff.leaseId) {
                    const lease = await browserApi(page, projectPath + '/runner-leases', { method: 'POST', body: { name: 'Evolved synthetic acceptance runner', scopes: ['runner:connect', 'memory:read', 'codegraph:read'], expiresInSeconds: 3600 }, expected: 201 });
                    requireCheck(lease.profile === 'restricted' && lease.projectId === handoff.projectId, 'runner_lease_scope');
                    savePrivate(directory, 'runner.lease', lease.token + '\n');
                    Object.assign(handoff, { leaseId: lease.id, leaseExpiresAt: lease.expiresAt });
                }
                const { leases } = await browserApi(page, projectPath + '/runner-leases');
                requireCheck(leases.some(lease => lease.id === handoff.leaseId && !lease.revokedAt && lease.expiresAt > Date.now()), 'runner_lease_missing_or_expired');
                const token = readPrivateFile(join(directory, 'runner.lease')).trim();
                requireCheck(await anonymousStatus(browser, config.origin, '/api/evolved/runner/authority', { authorization: 'Bearer ' + token }) === 200, 'runner_authority_unavailable');
            });
        }
        await record();
        return { status: 'passed', phase: config.phase, projectId: handoff.projectId, outputDirectory: directory, checks };
    } catch (error) {
        // Never log Playwright/API exceptions: they can contain form values or bearer URLs.
        checks.push({ check: current, status: 'failed', code: error instanceof CheckFailure ? error.code : 'operation_failed' });
        if (directory) {
            try { await record(); } catch { /* Preserve the original safe check result. */ }
            try { savePrivate(directory, 'last-checks.json', { phase: config.phase, checks }); } catch { /* No secret-bearing fallback output. */ }
        }
        return { status: 'failed', phase: config.phase, ...(handoff?.projectId ? { projectId: handoff.projectId } : {}), ...(directory ? { outputDirectory: directory } : {}), checks };
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    // Playwright debug logging can disclose form values and Authorization headers.
    delete process.env.DEBUG;
    delete process.env.PWDEBUG;
    let result;
    try { result = await runLiveCheck(configuration()); }
    catch (error) { result = { status: 'failed', checks: [{ check: 'configuration', status: 'failed', code: error instanceof CheckFailure ? error.code : 'invalid_configuration' }] }; }
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
}
