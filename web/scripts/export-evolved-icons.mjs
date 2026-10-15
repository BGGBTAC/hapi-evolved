/** Reproducible code-native PWA exports; original generated artwork is untouched. */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(repo, 'assets/brand/evolved/hapi-evolved-mark.svg'), 'utf8');
const geometry = source.replace(/^[\s\S]*?<title[^>]*>[\s\S]*?<\/title>/, '').replace(/<\/svg>\s*$/, '').trim();
if (!source.includes('viewBox="0 0 48 48"') || !geometry.startsWith('<path ') || /<(?:script|image|foreignObject)\b/i.test(source)) throw Error('Unexpected graph-e vector source');
const component = readFileSync(join(repo, 'web/src/evolved/Brand.tsx'), 'utf8');
for (const path of source.matchAll(/\bd="([^"]+)"/g)) {
    if (!component.includes(`d="${path[1]}"`)) throw Error('Brand.tsx and the vector master have diverged');
}
const checkOnly = process.argv.includes('--check');
if (process.argv.some(argument => argument.startsWith('--') && argument !== '--check')) throw Error('Only --check is supported');
const products = [];
function publish(path, data) {
    const content = typeof data === 'string' ? Buffer.from(data) : data;
    if (checkOnly) {
        if (!readFileSync(join(repo, path)).equals(content)) throw Error(`Generated icon drift: ${path}`);
    } else writeFileSync(join(repo, path), content);
    products.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
}
function iconSvg(maskable = false) {
    // The complete mark fits in the central 56.25% square: every painted point
    // lies within the maskable safe circle (radius 40% of the canvas).
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none" color="#0F766E" role="img" aria-labelledby="title">\n    <title id="title">HAPI-eVolved</title>\n    <rect width="512" height="512"${maskable ? '' : ' rx="104"'} fill="#F6F8F7" />\n    <g transform="translate(112 112) scale(6)">\n        ${geometry}\n    </g>\n</svg>\n`;
}
const icon = iconSvg();
const maskable = iconSvg(true);
publish('assets/brand/evolved/hapi-evolved-app-icon.svg', icon);
publish('assets/brand/evolved/hapi-evolved-maskable-icon.svg', maskable);
publish('web/public/icon.svg', icon);
publish('web/public/mask-icon.svg', source.replace('color="#0F766E"', 'color="#000000"'));

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
try {
    const page = await browser.newPage({ deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    async function render(svg, size) {
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
        return page.screenshot({ type: 'png', omitBackground: true, animations: 'disabled' });
    }
    for (const size of [64, 192, 512]) publish(`web/public/pwa-${size}x${size}.png`, await render(icon, size));
    for (const size of [192, 512]) publish(`web/public/pwa-maskable-${size}x${size}.png`, await render(maskable, size));
    publish('web/public/apple-touch-icon-180x180.png', await render(maskable, 180));
    // ICO supports PNG payloads. Keep 16/32/48px entries for browser/tab/OS use.
    const sizes = [16, 32, 48], images = [];
    for (const size of sizes) images.push(await render(icon, size));
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, index) => {
        const entry = 6 + index * 16;
        header[entry] = size; header[entry + 1] = size;
        header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
        offset += images[index].length;
    });
    publish('web/public/favicon.ico', Buffer.concat([header, ...images]));
    console.log(JSON.stringify({ mode: checkOnly ? 'verified' : 'exported', renderer: await browser.version(), products }, null, 2));
} finally { await browser.close(); }
