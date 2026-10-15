/** Follow the same visible navigation a user sees, including the mobile sheet. */
export async function workspaceArea(page, name) {
    await page.locator('.ew-shell').waitFor();
    const desktop = page.getByRole('navigation', { name: 'Arbeitsbereich', exact: true });
    if (await desktop.isVisible()) {
        await desktop.getByRole('link', { name, exact: true }).click();
        return;
    }
    const mobile = page.getByRole('navigation', { name: 'Mobile Navigation', exact: true });
    const direct = mobile.getByRole('link', { name, exact: true });
    if (await direct.count()) {
        await direct.click();
        return;
    }
    await mobile.getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('navigation', { name: 'Weitere Bereiche', exact: true }).getByRole('link', { name, exact: true }).click();
}

export async function workspaceLogout(page) {
    await page.locator('.ew-shell').waitFor();
    const desktop = page.locator('.ew-sidebar');
    if (await desktop.isVisible()) {
        await desktop.getByRole('button', { name: 'Abmelden', exact: true }).click();
        return;
    }
    await page.getByRole('navigation', { name: 'Mobile Navigation', exact: true }).getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Abmelden', exact: true }).click();
}
