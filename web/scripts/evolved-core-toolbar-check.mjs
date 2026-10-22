// Real Chromium acceptance for the merged upstream session-list toolbar (keep-rank
// shedding into More) and 48px search chrome, measured on the compiled CSS/React
// bundle. Nothing here stubs layout, ResizeObserver or the shed budget.

const SLOT_LABELS = { new: 'New Session', settings: 'Settings', browse: 'Browse' };
const CLONE = '[aria-hidden="true"], [inert]';

/** Scenario matrix: phone, tablet, desktop, narrow resizable sidebar and both font scales. */
export const TOOLBAR_CASES = [
    { name: 'w320', width: 320, height: 700 },
    { name: 'w390', width: 390, height: 844 },
    { name: 'w768', width: 768, height: 1024 },
    { name: 'w1440', width: 1440, height: 1000 },
    { name: 'w1440-narrow-sidebar', width: 1440, height: 1000, sidebar: 280, expectSidebar: 280 },
    { name: 'w960-narrow-sidebar', width: 960, height: 800, sidebar: 280, expectSidebar: 280 },
    { name: 'w1024-wide-sidebar-capped', width: 1024, height: 800, sidebar: 600, expectSidebar: 600 },
    { name: 'w320-app130', width: 320, height: 700, appScale: 1.3 },
    { name: 'w390-browser24px', width: 390, height: 844, browserFontPx: 24 },
    { name: 'w1440-narrow-sidebar-browser20px', width: 1440, height: 1000, sidebar: 280, expectSidebar: 280, browserFontPx: 20 },
    { name: 'w390-app130-browser20px', width: 390, height: 844, appScale: 1.3, browserFontPx: 20 },
    { name: 'w1440-narrow-sidebar-app130-browser20px', width: 1440, height: 1000, sidebar: 280, expectSidebar: 280, appScale: 1.3, browserFontPx: 20 },
];


/** Settle until real ResizeObserver/useLayoutEffect passes stop moving the toolbar. */
async function settle(page) {
    await page.waitForFunction(() => new Promise(resolve => {
        const snap = () => {
            const row = document.querySelector('[data-testid="session-list-header-row"]');
            if (!row) return 'missing';
            return [...row.querySelectorAll('button, summary, input')].map(el => {
                const r = el.getBoundingClientRect();
                return `${Math.round(r.x)},${Math.round(r.width)}`;
            }).join('|') + `#${row.querySelectorAll('[data-testid^="session-toolbar-slot-"]').length}`;
        };
        const first = snap();
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(first !== 'missing' && first === snap()))));
    }), null, { polling: 50, timeout: 10_000 });
}

/** Geometry audit of every real (non-clone) control in the header row. */
async function audit(page, label, minTarget) {
    const result = await page.evaluate(({ CLONE, minTarget }) => {
        const failures = [], small = [];
        const row = document.querySelector('[data-testid="session-list-header-row"]');
        const rowRect = row.getBoundingClientRect();
        const sidebar = row.closest('.app-session-sidebar');
        const sideRect = sidebar.getBoundingClientRect();
        const docOverflow = document.documentElement.scrollWidth - innerWidth;
        if (docOverflow > 0) failures.push(`document overflows by ${docOverflow}px`);
        if (row.scrollWidth > row.clientWidth + 1) failures.push(`header row scrollWidth ${row.scrollWidth} > clientWidth ${row.clientWidth}`);
        if (sidebar.scrollWidth > sidebar.clientWidth + 1) failures.push(`sidebar scrollWidth ${sidebar.scrollWidth} > ${sidebar.clientWidth}`);
        if (rowRect.right > sideRect.right + 0.5 || rowRect.left < sideRect.left - 0.5) failures.push('header row escapes sidebar');
        // Closed <details> content keeps a layout box in current Chromium (::details-content), but is not rendered.
        const real = [...row.querySelectorAll('button, summary, input, a')].filter(el => !el.closest(CLONE) && (el.tagName === 'SUMMARY' || !el.closest('details:not([open])')));
        const controls = real.filter(el => !real.some(other => other !== el && other.contains(el)));
        const boxes = [];
        for (const el of controls) {
            const r = el.getBoundingClientRect();
            const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.dataset.testid || el.textContent.trim().slice(0, 20) || el.tagName;
            if (r.width === 0 || r.height === 0) continue;
            boxes.push({ name, x: r.x, y: r.y, w: r.width, h: r.height });
            if (r.left < rowRect.left - 0.5 || r.right > rowRect.right + 0.5) failures.push(`${name} outside header row (${r.left.toFixed(1)}-${r.right.toFixed(1)} vs ${rowRect.left.toFixed(1)}-${rowRect.right.toFixed(1)})`);
            if (r.left < -0.5 || r.right > innerWidth + 0.5) failures.push(`${name} outside viewport`);
            if (el.tagName !== 'INPUT' && (r.width < 39.5 || r.height < 39.5)) failures.push(`${name} target ${r.width.toFixed(1)}x${r.height.toFixed(1)} < 40`);
            if (el.tagName !== 'INPUT' && (r.width < minTarget - 0.5 || r.height < minTarget - 0.5)) small.push(`${name} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !(el === hit || el.contains(hit))) failures.push(`${name} not hit-testable at its centre (hit ${hit?.outerHTML.slice(0, 80)})`);
            // Only the inert measuring copy counts here; decorative aria-hidden icons inside real buttons are fine.
            if (hit?.closest('[inert], [data-measure-id]')) failures.push(`${name} centre hits the aria-hidden measuring clone`);
        }
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ox > 0.5 && oy > 0.5) failures.push(`${a.name} overlaps ${b.name} by ${ox.toFixed(1)}px`);
        }
        const clones = [...row.querySelectorAll('[data-measure-id]')];
        const cloneRoot = clones[0]?.parentElement;
        if (!cloneRoot || cloneRoot.getAttribute('aria-hidden') !== 'true' || !cloneRoot.hasAttribute('inert')) failures.push('measuring clone root is not aria-hidden + inert');
        const defined = clones.map(el => el.dataset.measureId).filter(id => !id.startsWith('__'));
        const inline = [...row.querySelectorAll('[data-testid^="session-toolbar-slot-"]')].filter(el => !el.closest(CLONE)).map(el => el.dataset.testid.replace('session-toolbar-slot-', ''));
        const more = [...row.querySelectorAll('[data-testid="session-list-header-overflow"]')].filter(el => !el.closest(CLONE));
        return { failures, small, defined, inline, moreCount: more.length, boxes, rowWidth: rowRect.width, sidebarWidth: sideRect.width, htmlFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize) };
    }, { CLONE, minTarget });
    if (result.failures.length) throw Error(`${label}: ${result.failures.join('; ')}`);
    return result;
}

/** Playwright treats opacity:0 clones as visible; prove role locators skip them while raw selectors would not. */
async function checkCloneLocators(page, label) {
    const row = page.getByTestId('session-list-header-row');
    const evidence = [];
    for (const name of [SLOT_LABELS.settings, SLOT_LABELS.new]) {
        const raw = await row.locator(`[title="${name}"]`).count();
        const clone = row.locator(`[aria-hidden="true"] [title="${name}"]`);
        const byRole = await row.getByRole('button', { name, exact: true }).count();
        if (await clone.count() !== 1) throw Error(`${label}: expected one measuring clone for ${name}, saw ${await clone.count()}`);
        if (byRole !== raw - 1) throw Error(`${label}: role locator for ${name} counted ${byRole}, real controls ${raw - 1}`);
        evidence.push(`${name}: raw ${raw}, role ${byRole}, clone isVisible()=${await clone.isVisible()}`);
    }
    return evidence;
}

async function clickSlot(page, origin, id, inline, label) {
    const row = page.getByTestId('session-list-header-row');
    const name = SLOT_LABELS[id];
    let button;
    if (inline.includes(id)) {
        button = row.getByTestId(`session-toolbar-slot-${id}`).getByRole('button', { name, exact: true });
    } else {
        await row.getByRole('button', { name: 'More session list actions', exact: true }).click();
        const pop = page.getByRole('dialog');
        await pop.waitFor();
        button = pop.getByTestId(`session-toolbar-slot-${id}`).getByRole('button', { name, exact: true });
    }
    await button.waitFor();
    const box = await button.boundingBox();
    const viewport = page.viewportSize();
    if (!box || box.x < 0 || box.x + box.width > viewport.width || box.y < 0 || box.y + box.height > viewport.height) throw Error(`${label}: ${id} button outside viewport ${JSON.stringify(box)}`);
    await button.click();
    const target = { new: '/sessions/new', settings: '/settings', browse: '/browse' }[id];
    await page.waitForURL(url => url.pathname === target, { timeout: 10_000 });
    await page.goto(`${origin}/sessions`);
    await page.getByTestId('session-list-header-row').waitFor();
    await settle(page);
}

async function checkPopoverInViewport(page, locator, label) {
    await locator.waitFor();
    // Positioning may settle in the next frames (toggle event, layout effect); never accept an off-screen end state.
    let box;
    const viewport = page.viewportSize();
    for (let i = 0; i < 20; i++) {
        box = await locator.boundingBox();
        if (box && box.x >= -0.5 && box.x + box.width <= viewport.width + 0.5) return box;
        await page.waitForTimeout(100);
    }
    throw Error(`${label} outside viewport: ${JSON.stringify(box)} in ${viewport.width}px`);
}

/** The date picker closes like a user does it: a click on its full-screen backdrop outside the panel. */
/** Every shed action is visible, full-size and uncovered inside the More popover. */
async function checkMore(page, ids, minTarget, label) {
    await page.getByTestId('session-list-header-row').getByRole('button', { name: 'More session list actions', exact: true }).click();
    const pop = page.getByRole('dialog');
    await checkPopoverInViewport(page, pop, `${label} More popover`);
    for (const id of ids) {
        const button = pop.getByTestId(`session-toolbar-slot-${id}`).getByRole('button');
        if (!(await button.isVisible())) throw Error(`${label}: shed ${id} not visible in More`);
        const box = await button.boundingBox();
        if (box.width < minTarget - 0.5 || box.height < minTarget - 0.5) throw Error(`${label}: shed ${id} target ${box.width}x${box.height}`);
        const hit = await button.evaluate(el => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === h || el.contains(h); });
        if (!hit) throw Error(`${label}: shed ${id} covered in More`);
    }
    await page.keyboard.press('Escape');
    await pop.waitFor({ state: 'detached' });
}

/** Type a query in the expanded field, then collapse it with a real click on the row padding. */
async function enterQueryChip(page, query) {
    const row = page.getByTestId('session-list-header-row');
    if (!(await row.getByRole('searchbox').isVisible())) await row.getByRole('button', { name: /^Search sessions/ }).click();
    await row.getByRole('searchbox').fill(query);
    await page.locator('.app-session-sidebar').getByText(query).first().waitFor();
    const rowBox = await row.boundingBox();
    await page.mouse.click(rowBox.x + 3, rowBox.y + rowBox.height / 2);
    await row.getByTestId('session-list-search').and(page.locator('[data-expanded="false"]')).waitFor();
    await settle(page);
}

async function closeByBackdrop(page) {
    const viewport = page.viewportSize();
    await page.getByRole('button', { name: 'Close date picker', exact: true }).click({ position: { x: 2, y: viewport.height - 2 } });
}

async function checkCase(page, cdp, origin, spec) {
    const label = `toolbar ${spec.name}`;
    await page.setViewportSize({ width: spec.width, height: spec.height });
    await cdp.send('Page.setFontSizes', { fontSizes: { standard: spec.browserFontPx ?? 16, fixed: 13 } });
    await page.evaluate(spec => {
        if (spec.appScale) localStorage.setItem('hapi-font-scale', String(spec.appScale)); else localStorage.removeItem('hapi-font-scale');
        if (spec.sidebar) localStorage.setItem('hapi-sidebar-width', String(spec.sidebar)); else localStorage.removeItem('hapi-sidebar-width');
    }, spec);
    await page.goto(`${origin}/sessions`);
    await page.getByTestId('session-list-header-row').waitFor();
    await page.getByTestId('session-list-search').waitFor();
    await settle(page);
    const minTarget = spec.width <= 800 ? 44 : 40;
    const empty = await audit(page, `${label} idle`, minTarget);
    const expectFont = (spec.browserFontPx ?? 16) * (spec.appScale ?? 1);
    if (Math.abs(empty.htmlFontPx - expectFont) > 0.1) throw Error(`${label}: root font ${empty.htmlFontPx}px, expected ${expectFont}px`);
    if (spec.expectSidebar) {
        const cap = spec.width >= 920 ? Math.min(spec.expectSidebar, spec.width - 424) : spec.width;
        if (Math.abs(empty.sidebarWidth - cap) > 1) throw Error(`${label}: sidebar ${empty.sidebarWidth}px, expected ${cap}px`);
    }
    for (const id of ['new', 'settings']) if (!empty.defined.includes(id)) throw Error(`${label}: toolbar lacks ${id} (${empty.defined})`);
    const overflow = empty.defined.filter(id => !empty.inline.includes(id));
    if (overflow.length > 0 !== (empty.moreCount === 1)) throw Error(`${label}: More shown=${empty.moreCount} with overflow [${overflow}]`);
    for (const id of empty.inline) if (!empty.defined.includes(id)) throw Error(`${label}: unknown inline slot ${id}`);
    const cloneEvidence = await checkCloneLocators(page, label);

    const row = page.getByTestId('session-list-header-row');
    if (overflow.length) await checkMore(page, overflow, minTarget, label);
    for (const id of empty.defined.filter(id => SLOT_LABELS[id])) await clickSlot(page, origin, id, empty.inline, label);

    // Pinned Evolved filter menu: opens, stays on screen, closes. Only when it and More
    // cannot share the row does it move into More; either way it must be operable.
    const filterInMore = await row.getByTestId('session-list-header-filter').count() === 0;
    if (filterInMore) {
        if (!overflow.length) throw Error(`${label}: filter left the row without a More menu`);
        await row.getByRole('button', { name: 'More session list actions', exact: true }).click();
    }
    const filter = (filterInMore ? page.getByRole('dialog') : row).getByTestId('session-list-header-filter');
    await filter.locator('summary').click();
    await checkPopoverInViewport(page, filter.getByLabel('Sitzungsstatus', { exact: true }).locator('xpath=ancestor::div[1]'), `${label} filter panel`);
    for (const control of [filter.getByLabel('Sitzungsstatus', { exact: true }), filter.getByLabel('Aktivitätssortierung', { exact: true }), filter.getByRole('button', { name: 'Filter zurücksetzen', exact: true })]) {
        const hit = await control.evaluate(el => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === h || el.contains(h); });
        if (!hit) throw Error(`${label}: filter panel control not hit-testable`);
    }
    await filter.getByLabel('Sitzungsstatus', { exact: true }).selectOption('blocked');
    await filter.locator('summary').getByText('Filter ●').waitFor();
    await filter.getByRole('button', { name: 'Filter zurücksetzen', exact: true }).click();
    await filter.locator('summary').getByText('Filter', { exact: true }).waitFor();
    await filter.locator('summary').click();
    if (filterInMore) {
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
    }

    // Standalone calendar opens a picker inside the viewport.
    const calendar = row.getByTestId('session-list-search-date-standalone');
    if (!(await calendar.isVisible())) throw Error(`${label}: idle calendar hidden`);
    await calendar.click();
    const picker = page.getByRole('button', { name: 'Previous month', exact: true }).locator('xpath=ancestor::div[2]');
    await checkPopoverInViewport(page, picker, `${label} date picker`);
    await closeByBackdrop(page);
    await picker.waitFor({ state: 'detached' });

    // Expanded 48px field: input, embedded calendar and clear end-cap all visible and inside the field.
    await row.getByRole('button', { name: /^Search sessions/ }).click();
    const input = row.getByRole('searchbox');
    await input.waitFor();
    await input.fill('Search browser fixture');
    const clear = row.getByRole('button', { name: 'Clear search', exact: true });
    await clear.waitFor();
    await settle(page);
    const expanded = await page.evaluate(() => {
        const field = document.querySelector('[data-testid="session-list-search"][data-expanded="true"] > div');
        const f = field.getBoundingClientRect();
        const parts = ['input[type="search"]', '[data-testid="session-list-search-date-embedded"]', '.session-list-search-clear-endcap'].map(sel => {
            const el = field.querySelector(sel), r = el.getBoundingClientRect();
            const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { sel, x: r.x, w: r.width, h: r.height, inside: r.left >= f.left - 0.5 && r.right <= f.right + 0.5, hit: el === h || el.contains(h) };
        });
        return { field: { x: f.x, w: f.width }, parts, vw: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    for (const part of expanded.parts) {
        if (!part.inside || !part.hit || part.w < (part.sel.startsWith('input') ? 64 : 47.5) || (!part.sel.startsWith('input') && part.h < 47.5)) throw Error(`${label} expanded: ${JSON.stringify(part)} in field ${JSON.stringify(expanded.field)}`);
    }
    if (expanded.field.x + expanded.field.w > expanded.vw + 0.5 || expanded.overflow > 0) throw Error(`${label} expanded field overflows ${JSON.stringify(expanded)}`);
    const [inputPart, datePart, clearPart] = expanded.parts;
    if (!(inputPart.x + inputPart.w <= datePart.x + 0.5 && datePart.x + datePart.w <= clearPart.x + 0.5)) throw Error(`${label}: expected input | calendar | clear order ${JSON.stringify(expanded.parts)}`);
    // Evolved scope switch and exclude toggle stay operable next to upstream's 48px chrome.
    // Below the @xs container width the exclude toggle lives in the scope menu instead of the field.
    const exclude = row.getByRole('button', { name: 'Suchtreffer ausschließen', exact: true });
    const excludeInMenu = !(await exclude.isVisible());
    const scopeToggle = row.getByRole('button', { name: 'Search scope', exact: true });
    for (const pressed of ['true', 'false']) {
        if (excludeInMenu) await scopeToggle.click();
        if (await exclude.count() !== 1) throw Error(`${label}: expected exactly one reachable exclude toggle, saw ${await exclude.count()}`);
        await exclude.click();
        if (await exclude.getAttribute('aria-pressed') !== pressed) throw Error(`${label}: exclude toggle not ${pressed}`);
        if (excludeInMenu) {
            await scopeToggle.click();
            await exclude.waitFor({ state: 'hidden' });
        }
    }
    await row.getByRole('button', { name: 'Search scope', exact: true }).click();
    const scopeDefault = row.getByRole('button', { name: 'Default', exact: true });
    await checkPopoverInViewport(page, scopeDefault, `${label} search scope menu`);
    await scopeDefault.click();
    await scopeDefault.waitFor({ state: 'detached' });
    await row.getByTestId('session-list-search-date-embedded').click();
    await checkPopoverInViewport(page, picker, `${label} expanded date picker`);
    await closeByBackdrop(page);
    await picker.waitFor({ state: 'detached' });
    await clear.click();
    if (await input.inputValue() !== '') throw Error(`${label}: clear did not empty the query`);

    // Collapsed query chip keeps clear + calendar reachable; the chip may shed more actions into More.
    await enterQueryChip(page, 'Search browser fixture');
    const chip = await audit(page, `${label} query chip`, minTarget);
    const chipClear = row.getByRole('button', { name: 'Clear search', exact: true });
    if (!(await chipClear.isVisible()) || !(await calendar.isVisible())) throw Error(`${label}: chip clear/calendar not visible`);
    if (!chip.boxes.some(box => box.name === 'Clear search')) throw Error(`${label}: chip clear missing from audited controls`);
    const chipOverflow = chip.defined.filter(id => !chip.inline.includes(id));
    if (chipOverflow.length > 0 !== (chip.moreCount === 1)) throw Error(`${label}: query More inconsistent [${chipOverflow}]`);
    if (chipOverflow.length) await checkMore(page, chipOverflow, minTarget, `${label} query`);
    await chipClear.click();
    await row.getByRole('button', { name: /^Search sessions/ }).waitFor();
    if (await chipClear.count()) throw Error(`${label}: chip clear survived clearing`);
    // Actions shed only while a query is active are clicked through More in that state.
    for (const id of chipOverflow.filter(id => SLOT_LABELS[id])) {
        await enterQueryChip(page, 'Search browser fixture');
        await clickSlot(page, origin, id, [], `${label} query`);
    }
    return { name: spec.name, filterInMore, excludeInMenu, row: Math.round(empty.rowWidth), sidebar: Math.round(empty.sidebarWidth), font: empty.htmlFontPx, inline: empty.inline, more: overflow, queryInline: chip.inline, queryMore: chipOverflow, cloneEvidence, small: [...new Set([...empty.small, ...chip.small])] };
}

export async function checkCoreToolbar(page, origin, cases = TOOLBAR_CASES) {
    const original = page.viewportSize();
    const cdp = await page.context().newCDPSession(page);
    const results = [], failures = [];
    try {
        // Every scenario starts from a fresh navigation, so one failure does not hide the others.
        for (const spec of cases) {
            try {
                results.push(await checkCase(page, cdp, origin, spec));
                if (process.env.EVOLVED_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.EVOLVED_SCREENSHOT_DIR}/toolbar-${spec.name}.png` });
            } catch (error) {
                if (process.env.EVOLVED_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.EVOLVED_SCREENSHOT_DIR}/toolbar-${spec.name}-FAIL.png` }).catch(() => {});
                const message = error.message.startsWith('toolbar ') ? error.message : `toolbar ${spec.name}: ${error.message}`;
                failures.push(message);
                console.log(`FAIL ${message}`);
                await page.keyboard.press('Escape').catch(() => {});
            }
        }
    } finally {
        await cdp.send('Page.setFontSizes', { fontSizes: { standard: 16, fixed: 13 } });
        await page.evaluate(() => { localStorage.removeItem('hapi-font-scale'); localStorage.removeItem('hapi-sidebar-width') });
        await cdp.detach();
        if (original) await page.setViewportSize(original);
    }
    for (const result of results) console.log(`  toolbar ${result.name}: row ${result.row}px sidebar ${result.sidebar}px font ${result.font}px inline [${result.inline}] More [${result.more}${result.filterInMore ? ',filter' : ''}]${result.excludeInMenu ? ' exclude-in-scope-menu' : ''} · with query inline [${result.queryInline}] More [${result.queryMore}] · ${result.cloneEvidence.join('; ')}`);
    for (const result of results) if (result.small.length) console.log(`  WARN toolbar ${result.name}: below the 44px mobile toolbar target (40px floor met): ${result.small.join(', ')}`);
    if (failures.length) throw Error(`Session toolbar acceptance failed in ${failures.length}/${cases.length} scenarios:\n${failures.join('\n')}`);
    if (!results.some(result => result.more.length + result.queryMore.length > 0)) throw Error('No scenario shed an action into More; the overflow path was not exercised');
    if (!results.some(result => result.more.length + result.queryMore.length === 0)) throw Error('No scenario kept every action inline');
    console.log(`PASS real Chromium session toolbar/search at ${cases.map(c => c.name).join(', ')}: no overflowing/overlapping controls, hit-testable 40/44px targets, aria-hidden inert clones excluded, shed actions clicked through More, 48px search/calendar/clear, filter and date picker inside viewport`);
    return results;
}
