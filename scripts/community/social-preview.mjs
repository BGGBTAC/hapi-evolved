/** Code-native social artwork; existing SVG mark, no generated or invented UI. */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, 'assets/community');
const output = join(directory, 'social-preview.png');
const mark = readFileSync(join(root, 'assets/brand/evolved/hapi-evolved-mark.svg'), 'utf8');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>HAPI-eVolved social preview</title>
<style>*{box-sizing:border-box}body{margin:0;width:1280px;height:640px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#f3fffb;background:#09232a;background-image:radial-gradient(ellipse at 110% 0%,#17624d 0%,transparent 56%)}main{height:100%;padding:58px 68px;position:relative}header{display:flex;align-items:center;gap:24px}header .mark{width:82px;height:82px;background:#f2fcf8;border-radius:22px;padding:14px}header svg{width:100%;height:100%}header span{font-size:49px;letter-spacing:-1.8px;font-weight:750}h1{font-size:64px;letter-spacing:-2.2px;line-height:1.12;margin:43px 0 20px;font-weight:750}h1 em{font-style:normal;color:#7ce5bd}p{font-size:26px;line-height:1.5;margin:0;color:#c0dfd8;max-width:960px}.line{height:1px;background:#467369;margin:35px 0 21px}footer{display:flex;justify-content:space-between;align-items:center;font-size:18px;color:#a6c7bd}footer strong{color:#dafff0;font-weight:600}.orbit{position:absolute;right:67px;top:63px;width:86px;height:26px;display:flex;gap:8px}.orbit i{display:block;border:2px solid #6bdcb1;border-radius:50%;width:14px;height:14px}.orbit i:nth-child(2){opacity:.55}.orbit i:nth-child(3){opacity:.25}</style>
<main><header><div class="mark">${mark}</div><span>HAPI-eVolved</span></header><div class="orbit" aria-hidden="true"><i></i><i></i><i></i></div><h1>Your agents.<br><em>Your infrastructure.</em></h1><p>A self-hosted workspace for Claude Code + Codex.<br>Projects, GitHub, code intelligence and persistent memory.</p><div class="line"></div><footer><span>Independent fork of tiann/hapi · Source preview</span><strong>BGGBTAC/hapi-evolved</strong></footer></main></html>`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
    await page.route('**/*', route => route.abort());
    await page.setContent(html); await page.evaluate(() => document.fonts.ready);
    mkdirSync(directory, { recursive: true });
    const png = await page.screenshot({ animations: 'disabled' });
    if (png.length >= 1024 * 1024) throw Error('Social preview exceeds 1 MiB.');
    // Exclusive creation rejects both existing files and symlinks; derive the
    // report from the exact captured buffer rather than reopening the output.
    writeFileSync(output, png, { flag: 'wx' });
    writeFileSync(join(directory, 'social-preview.json'), JSON.stringify({ width: 1280, height: 640, bytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'), browser: browser.version(),
        provenance: 'Code-native brand composition using assets/brand/evolved/hapi-evolved-mark.svg. No product UI screenshot or generated image.' }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Created assets/community/social-preview.png (${png.length} bytes).`);
} finally { await browser.close(); }
