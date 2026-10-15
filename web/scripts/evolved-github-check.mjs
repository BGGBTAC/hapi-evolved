import { workspaceArea } from './evolved-navigation.mjs';
const syntheticToken = 'github_pat_synthetic_browser_credential_only';
const repository = 'synthetic-owner/browser-repo';

export async function checkGithub(page) {
    const githubTab = () => workspaceArea(page, 'GitHub');
    const profileChanges = [];
    const recordProfileChange = request => {
        if (/\/api\/evolved\/projects\/[^/]+\/profile$/.test(new URL(request.url()).pathname) && request.method() === 'PUT') {
            profileChanges.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
        }
    };
    page.on('request', recordProfileChange);
    const mutation = (method, suffix = '') => page.waitForResponse(response =>
        new URL(response.url()).pathname.endsWith(`/github${suffix}`)
        && response.request().method() === method && response.status() === 200);
    const grant = async (permission = 'read') => {
        await page.getByLabel(/^GitHub-Repository/).fill(repository);
        await page.getByLabel('Git-Berechtigung', { exact: true }).selectOption(permission);
        const saved = mutation('PUT', '/repositories');
        await page.getByRole('button', { name: 'Repository freigeben', exact: true }).click();
        const metadata = await (await saved).json();
        if (JSON.stringify(metadata).includes(syntheticToken)) throw Error('GitHub response exposed credential');
        await page.getByText(repository, { exact: true }).waitFor();
    };
    const assertRestricted = async () => {
        const profile = await page.evaluate(async () => {
            const response = await fetch('/api/evolved/me');
            if (!response.ok) throw Error(`Project profile check: ${response.status}`);
            const me = await response.json();
            return me.accessibleProjects.find(project => project.name === 'Browsercheck')?.profile;
        });
        if (profile !== 'restricted' || profileChanges.length) throw Error('Repository grant silently changed the project profile');
    };
    // Only synthetic fixture leases are created here. Their tokens stay inside this
    // isolated browser callback and are never returned, persisted or printed.
    const issueDefaultLease = async name => page.evaluate(async name => {
        const meResponse = await fetch('/api/evolved/me');
        if (!meResponse.ok) throw Error(`Fixture project lookup: ${meResponse.status}`);
        const me = await meResponse.json();
        const projectId = me.accessibleProjects.find(project => project.name === 'Browsercheck')?.id;
        if (!projectId) throw Error('Synthetic GitHub project missing');
        const response = await fetch(`/api/evolved/projects/${projectId}/runner-leases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, expiresInSeconds: 300 }) });
        if (response.status !== 201) throw Error(`Synthetic lease creation: ${response.status}`);
        const lease = await response.json();
        return { id: lease.id, projectId };
    }, name);
    const inspectLease = async lease => page.evaluate(async lease => {
        const response = await fetch(`/api/evolved/projects/${lease.projectId}/runner-leases`);
        if (!response.ok) throw Error(`Synthetic lease inspection: ${response.status}`);
        const body = await response.json();
        return body.leases.find(item => item.id === lease.id);
    }, lease);
    try {
    await githubTab();
    const restrictedLease = await issueDefaultLease('Synthetic GitHub restricted runner');
    const before = await inspectLease(restrictedLease);
    if (before?.profile !== 'restricted' || before.revokedAt || before.scopes.includes('git:write')) throw Error('Restricted runner default permissions are invalid');
    const tokenInput = page.getByLabel('Fine-grained Personal Access Token', { exact: true });
    await tokenInput.fill(syntheticToken);
    const connected = mutation('POST');
    await page.getByRole('button', { name: 'GitHub verbinden', exact: true }).click();
    await connected;
    await page.getByText('synthetic-github-account', { exact: true }).waitFor();
    if (await tokenInput.inputValue()) throw Error('Submitted GitHub token was retained in input');
    if (await page.evaluate(token => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(token), syntheticToken)) throw Error('GitHub token persisted in browser storage');
    if ((await page.locator('body').innerText()).includes(syntheticToken)) throw Error('GitHub token rendered');
    await grant('write');
    await page.getByText('Lesen und Push freigegeben', { exact: true }).waitFor();
    await page.getByText('Push durch Projektprofil gesperrt', { exact: true }).waitFor();
    const permission = page.getByLabel(`Git-Berechtigung für ${repository}`, { exact: true });
    if (await permission.locator('option[value=write]').isDisabled()) throw Error('Restricted profile blocks configuring a repository write grant');
    await assertRestricted();
    for (const next of ['read', 'write']) {
        const changed = mutation('PUT', '/repositories');
        await permission.selectOption(next);
        await changed;
        await page.locator('.ev-row small').filter({ hasText: next === 'write' ? /^Lesen und Push freigegeben$/ : /^Nur lesen$/ }).waitFor();
        await assertRestricted();
    }

    await page.reload();
    await githubTab();
    await page.getByText(repository, { exact: true }).waitFor();
    if (await permission.inputValue() !== 'write') throw Error('Saved restricted-project write grant did not survive reload');
    await page.getByText('Push durch Projektprofil gesperrt', { exact: true }).waitFor();
    await page.getByLabel('Aktives Projekt', { exact: true }).selectOption({ label: 'Automatic browser project' });
    await githubTab();
    await page.getByText('Noch kein GitHub-Konto verbunden.', { exact: true }).waitFor();
    if (await page.getByText(repository, { exact: true }).count()) throw Error('GitHub metadata crossed projects');
    await page.getByLabel('Aktives Projekt', { exact: true }).selectOption({ label: 'Browsercheck' });
    await githubTab();
    await page.getByText(repository, { exact: true }).waitFor();
    if (await permission.inputValue() !== 'write') throw Error('Saved write grant was lost while switching projects');
    const unchangedLease = await inspectLease(restrictedLease);
    if (unchangedLease.revokedAt || unchangedLease.scopes.includes('git:write')) throw Error('Repository grant changed existing runner authority');
    const activate = page.getByRole('button', { name: 'Arbeitsbereich für Push aktivieren', exact: true });
    await activate.click();
    await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await assertRestricted();
    if ((await inspectLease(restrictedLease)).revokedAt) throw Error('Canceled profile change revoked the existing runner');
    await activate.click();
    const activated = page.waitForResponse(response =>
        /\/api\/evolved\/projects\/[^/]+\/profile$/.test(new URL(response.url()).pathname)
        && response.request().method() === 'PUT' && response.status() === 200);
    await page.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    const activatedResponse = await activated;
    const { project } = await activatedResponse.json();
    if (project.profile !== 'workspace' || profileChanges.length !== 1
        || profileChanges[0].path !== `/api/evolved/projects/${project.id}/profile`
        || JSON.stringify(profileChanges[0].body) !== JSON.stringify({ profile: 'workspace' })) throw Error('Explicit profile activation did not target the selected project exactly once');
    if (!(await inspectLease(restrictedLease)).revokedAt) throw Error('Explicit profile change did not revoke the previous runner lease');
    const workspaceLease = await issueDefaultLease('Synthetic GitHub workspace runner');
    const after = await inspectLease(workspaceLease);
    if (after?.profile !== 'workspace' || after.revokedAt || !after.scopes.includes('runner:connect') || !after.scopes.includes('git:write')) throw Error('New workspace lease lacks default push authorization');
    await activate.waitFor({ state: 'hidden' });
    await page.getByText(/^Projektprofil: „Arbeitsbereich“\. Das Profil/).waitFor();
    if (await page.getByText('Push durch Projektprofil gesperrt', { exact: true }).count()) throw Error('Restricted profile warning remained after explicit activation');
    await page.getByText('Lesen und Push freigegeben', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Runner für Push einrichten', exact: true }).click();
    await page.getByRole('heading', { name: 'Runner-Zugänge', exact: true }).waitFor();
    if (new URL(page.url()).searchParams.get('project') !== project.id) throw Error('Runner setup link lost the selected project');
    const pushScope = page.getByLabel('In GitHub-Repositorys pushen', { exact: true });
    if (!await pushScope.isChecked() || await pushScope.isDisabled()) throw Error('Workspace runner does not offer the default push scope');
    await githubTab();
    await page.getByText(repository, { exact: true }).waitFor();
    if (await permission.inputValue() !== 'write') throw Error('Runner setup navigation lost the repository write grant');

    await tokenInput.fill(syntheticToken);
    if (!await page.getByRole('button', { name: 'Verbindung ersetzen', exact: true }).isDisabled()) throw Error('Connection replacement lacks grant-removal acknowledgment');
    await page.getByLabel('Ich ersetze die Verbindung und entferne bisherige Repository-Freigaben.', { exact: true }).check();
    const rotated = mutation('POST');
    await page.getByRole('button', { name: 'Verbindung ersetzen', exact: true }).click();
    await rotated;
    await page.getByText('Noch kein Repository freigegeben.', { exact: true }).waitFor();
    await grant();
    await page.getByRole('button', { name: 'Repository-Freigabe widerrufen', exact: true }).click();
    const revoked = mutation('DELETE', '/repositories/123');
    await page.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    await revoked;
    await page.getByText('Noch kein Repository freigegeben.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'GitHub-Verbindung trennen', exact: true }).click();
    const disconnected = mutation('DELETE');
    await page.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    await disconnected;
    await page.getByText('Noch kein GitHub-Konto verbunden.', { exact: true }).waitFor();

    await workspaceArea(page, 'Projekte');
    await page.getByRole('button', { name: /^Eingeschränkt Schreib/ }).click();
    await page.getByText('Profil gespeichert.', { exact: true }).waitFor();
    console.log('PASS real project-scoped GitHub Hub/Vault broker: synthetic provider connect, restricted-project new and existing read/write grants, persistence/isolation, explicit profile activation/cancel and lease revocation, new default push scope, project-scoped runner setup, rotation, revoke/disconnect; no browser token persistence');
    } finally { page.off('request', recordProfileChange); }
}
