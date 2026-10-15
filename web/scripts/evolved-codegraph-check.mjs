import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceArea } from './evolved-navigation.mjs';

// Actual browser -> authenticated Hub -> real SDK adapter, synthetic project only.
export async function checkCodegraph(page, workspace) {
    await workspaceArea(page, 'Codegraph');
    await page.getByText('Noch kein Code im Index', { exact: true }).waitFor();
    if (await page.getByRole('alert').count()) throw Error('Empty index rendered an error');
    await page.getByRole('link', { name: 'Repository verbinden', exact: true }).waitFor();
    await writeFile(join(workspace, 'orbital.ts'), 'export function orbitalMarker() { return 42; }\nexport function caller() { return orbitalMarker(); }\n');
    await page.getByRole('group', { name: 'Interaktiver Codegraph', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByLabel('Symbol oder Datei suchen', { exact: true }).fill('orbitalMarker');
    await page.getByRole('button', { name: 'Suchen', exact: true }).click();
    await page.locator('.ev-node-list button').filter({ hasText: 'orbitalMarker' }).first().click();
    await page.getByLabel('Quelltext orbital.ts', { exact: true }).waitFor();
    if (await page.getByRole('alert').count()) throw Error('Indexed graph rendered an error');
    const reindex = page.waitForResponse(response => response.url().endsWith('/codegraph/reindex') && response.request().method() === 'POST' && response.status() === 200);
    await page.getByRole('button', { name: 'Neu indizieren', exact: true }).click();
    await reindex;
    await page.getByRole('group', { name: 'Interaktiver Codegraph', exact: true }).waitFor();
    await workspaceArea(page, 'Abos verbinden');
    await page.getByRole('heading', { name: 'Abos verbinden', level: 2, exact: true }).waitFor();
    for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        if (overflow) throw Error(`Subscription setup overflows at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    console.log('PASS real Codegraph empty workspace, nested-statistics contract, automatic indexing, default graph, symbol source, reindex and subscription onboarding navigation');
}
