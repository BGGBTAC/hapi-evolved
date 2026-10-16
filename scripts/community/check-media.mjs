/** Decode the final recording locally and retain frames for visual inspection. */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Reuse the encoder installed by the pinned Playwright dependency; no system
// ffmpeg or downloaded helper is required. coreBundle is a package export.
const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('playwright/package.json'));
const ffmpeg = playwrightRequire('playwright-core/lib/coreBundle').registry.registry.findExecutable('ffmpeg').executablePathOrDie('javascript');
const media = join(root, 'assets/community');
const recorded = JSON.parse(readFileSync(join(media, 'recording.json'), 'utf8'));
for (const [name, expected] of Object.entries(recorded.files)) {
    if (!['desktop.png', 'mobile.png', 'codegraph.png', 'walkthrough.webm'].includes(name)) throw Error('Unexpected media manifest');
    const file = join(media, name);
    if (statSync(file).size !== expected.bytes || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected.sha256) throw Error('Media hash mismatch');
}
const output = mkdtempSync('/tmp/hapi-evolved-community-frames-');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}), args: ['--no-sandbox'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/*', route => route.request().url() === 'https://media.invalid/walkthrough.webm'
        ? route.fulfill({ contentType: 'video/webm', body: readFileSync(join(media, 'walkthrough.webm')) }) : route.abort());
    await page.setContent('<style>body{margin:0;background:#09232a}video{display:block;width:1440px;height:1000px}</style><video muted preload="auto" src="https://media.invalid/walkthrough.webm"></video>');
    await page.locator('video').evaluate(video => new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(Error('Video decoding failed')); if (video.readyState >= 2) resolve(); }));
    const metadata = await page.locator('video').evaluate(video => ({ duration: video.duration, width: video.videoWidth, height: video.videoHeight }));
    if (metadata.duration < 60 || metadata.duration > 90 || metadata.width !== 1440 || metadata.height !== 1000) throw Error('Unexpected video metadata');
    for (const seconds of [3, 18, 30, 42, 55, 73]) {
        // Headless screenshots of a hardware video surface can be blank even
        // when decoding succeeds. Decode frames independently for visual review.
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', join(media, 'walkthrough.webm'), '-frames:v', '1', join(output, `frame-${seconds}.png`)], { stdio: 'pipe', timeout: 15000, maxBuffer: 1024 * 1024 });
    }
    await page.locator('video').evaluate(video => new Promise((resolve, reject) => { video.onended = resolve; video.onerror = () => reject(Error('Video playback failed')); video.currentTime = 0; video.playbackRate = 16; video.play().catch(reject); }));
    writeFileSync(join(output, 'checked.json'), JSON.stringify({ result: 'PASS', ...metadata, decodedFrameSeconds: [3, 18, 30, 42, 55, 73], scope: 'Browser decode/playback and six frames independently decoded by the existing Playwright ffmpeg; frames require human visual review.' }, null, 2));
    console.log(`PASS: final video decoded and played; review frames at ${output}`);
} finally { await browser.close(); }
