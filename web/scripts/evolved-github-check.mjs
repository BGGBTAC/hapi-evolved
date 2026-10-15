const syntheticToken = 'github_pat_synthetic_browser_credential_only';
const repository = 'synthetic-owner/browser-repo';

export async function checkGithub(page) {
    const githubTab = () => page.getByRole('button', { name: 'GitHub', exact: true }).click();
    const mutation = (method, suffix = '') => page.waitForResponse(response =>
        new URL(response.url()).pathname.endsWith(`/github${suffix}`)
        && response.request().method() === method && response.status() === 200);
    const grant = async () => {
        await page.getByLabel(/^GitHub-Repository/).fill(repository);
        const saved = mutation('PUT', '/repositories');
        await page.getByRole('button', { name: 'Repository freigeben', exact: true }).click();
        const metadata = await (await saved).json();
        if (JSON.stringify(metadata).includes(syntheticToken)) throw Error('GitHub response exposed credential');
        await page.getByText(repository, { exact: true }).waitFor();
    };
    await githubTab();
    const tokenInput = page.getByLabel('Fine-grained Personal Access Token', { exact: true });
    await tokenInput.fill(syntheticToken);
    const connected = mutation('POST');
    await page.getByRole('button', { name: 'GitHub verbinden', exact: true }).click();
    await connected;
    await page.getByText('synthetic-github-account', { exact: true }).waitFor();
    if (await tokenInput.inputValue()) throw Error('Submitted GitHub token was retained in input');
    if (await page.evaluate(token => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(token), syntheticToken)) throw Error('GitHub token persisted in browser storage');
    if ((await page.locator('body').innerText()).includes(syntheticToken)) throw Error('GitHub token rendered');
    await grant();
    if (!await page.getByLabel(`Git-Berechtigung für ${repository}`, { exact: true }).locator('option[value=write]').isDisabled()) throw Error('Restricted profile offered Git write grant');

    await page.reload();
    await githubTab();
    await page.getByText(repository, { exact: true }).waitFor();
    await page.getByLabel('Aktives Projekt', { exact: true }).selectOption({ label: 'Automatic browser project' });
    await githubTab();
    await page.getByText('Noch kein GitHub-Konto verbunden.', { exact: true }).waitFor();
    if (await page.getByText(repository, { exact: true }).count()) throw Error('GitHub metadata crossed projects');
    await page.getByLabel('Aktives Projekt', { exact: true }).selectOption({ label: 'Browsercheck' });
    await githubTab();
    await page.getByText(repository, { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Projekte', exact: true }).click();
    await page.getByRole('button', { name: /^Arbeitsbereich Projektbezogene/ }).click();
    await page.getByText('Profil gespeichert.', { exact: true }).waitFor();
    await githubTab();
    const writeGranted = mutation('PUT', '/repositories');
    await page.getByLabel(`Git-Berechtigung für ${repository}`, { exact: true }).selectOption('write');
    await writeGranted;
    await page.getByText('Lesen und Push freigegeben', { exact: true }).waitFor();

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

    await page.getByRole('button', { name: 'Projekte', exact: true }).click();
    await page.getByRole('button', { name: /^Eingeschränkt Schreib/ }).click();
    await page.getByText('Profil gespeichert.', { exact: true }).waitFor();
    console.log('PASS real project-scoped GitHub Hub/Vault broker: synthetic provider connect, persistence, read/write grant, profile restriction, rotation, revoke/disconnect; no browser token persistence');
}
