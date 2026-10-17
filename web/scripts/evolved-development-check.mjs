import { workspaceArea } from './evolved-navigation.mjs';

/**
 * Real Hub round trip for the project development mode: activate, persist,
 * reload, compact mobile layout and switching back to the general mode.
 * Fails if activation triggers any check, status read or session start.
 */
export async function checkDevelopment(page) {
    const actions = [];
    const track = request => {
        const path = new URL(request.url()).pathname;
        if (/\/development\/(?:doctor|inspect|build-status)$/.test(path) || /\/agent-catalog\/[^/]+\/start$/.test(path)) actions.push(`${request.method()} ${path}`);
    };
    page.on('request', track);
    try {
        await workspaceArea(page, 'Entwicklung');
        await page.getByRole('heading', { name: 'Entwicklungsmodus', exact: true }).waitFor();
        const save = page.getByRole('button', { name: 'Speichern', exact: true });
        if (await save.isEnabled()) throw Error('Save is enabled without changes');
        await page.getByRole('radio', { name: 'Odoo', exact: true }).check();
        await page.getByRole('radio', { name: '19.0', exact: true }).check();
        await page.getByText('Ungespeicherter Entwurf', { exact: true }).waitFor();
        const saved = page.waitForResponse(r => /\/api\/evolved\/projects\/[^/]+\/development$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT');
        await save.click();
        const response = await saved;
        if (response.status() !== 200) throw Error(`Development save failed with ${response.status()}`);
        const body = response.request().postDataJSON();
        if (body.expectedRevision !== 0 || body.settings.mode !== 'odoo' || body.settings.odoo.major !== 19 || body.settings.repositoryId !== null) throw Error('Unexpected development save body');
        await page.getByText(/Gespeichert als Revision 1\./).waitFor();
        await page.reload();
        await page.getByText(/Gespeichert: Odoo 19 · Community · lokal · Revision 1/).waitFor();
        await page.getByRole('heading', { name: /Handbuch · Odoo/ }).waitFor();
        await page.getByText('Local Odoo 19 runtime from source', { exact: true }).waitFor();
        if (await page.getByText('Local Odoo 20 runtime from source', { exact: true }).count()) throw Error('Odoo 20 knowledge shown for an Odoo 19 project');

        const viewport = page.viewportSize();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('radio', { name: 'Android', exact: true }).waitFor();
        const overflow = await page.evaluate(() => {
            const content = document.querySelector('.ew-content');
            return { page: document.documentElement.scrollWidth - window.innerWidth, content: content ? content.scrollWidth - content.clientWidth : 0 };
        });
        if (overflow.page > 1 || overflow.content > 1) throw Error(`Development page overflows horizontally on mobile: ${JSON.stringify(overflow)}`);
        const radioBox = await page.getByRole('radio', { name: 'Allgemein', exact: true }).locator('xpath=..').boundingBox();
        if (!radioBox || radioBox.height < 40 || radioBox.width > 390 / 2) throw Error(`Mode picker is not compact on mobile: ${JSON.stringify(radioBox)}`);
        await page.setViewportSize({ width: 320, height: 740 });
        await page.getByRole('radio', { name: 'iOS', exact: true }).check();
        const mobileSave = page.getByRole('button', { name: 'Speichern', exact: true });
        await mobileSave.scrollIntoViewIfNeeded();
        const uncovered = await mobileSave.evaluate(element => { const rect = element.getBoundingClientRect(); const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return Boolean(target && (target === element || element.contains(target))); });
        if (!uncovered) throw Error('Save button is covered on a 320 px viewport');
        if (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 1) throw Error('Development page overflows horizontally at 320 px');
        await page.getByRole('button', { name: 'Verwerfen', exact: true }).click();
        if (viewport) await page.setViewportSize(viewport);

        await page.getByRole('radio', { name: 'Allgemein', exact: true }).check();
        const reverted = page.waitForResponse(r => /\/development$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT');
        await page.getByRole('button', { name: 'Speichern', exact: true }).click();
        if ((await reverted).status() !== 200) throw Error('Switching back to the general mode failed');
        await page.getByText(/Gespeichert als Revision 2\./).waitFor();
        if (actions.length) throw Error(`Mode changes triggered actions: ${actions.join(', ')}`);
        console.log('PASS development mode activation persists, reloads, stays compact on mobile and triggers no checks');
    } finally {
        page.off('request', track);
    }
}
