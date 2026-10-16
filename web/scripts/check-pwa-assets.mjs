// Run after the complete web build (including its final static-host fallback copy):
// node web/scripts/check-pwa-assets.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8')
assert(!sw.includes('self.__WB_MANIFEST'), 'Service worker still contains an uninjected manifest')

// Workbox injects JSON. Locate its sole array without evaluating the service worker.
const candidates = [...sw.matchAll(/\[\s*\{\s*"(?:revision|url)"\s*:/g)]
assert.equal(candidates.length, 1, 'Expected exactly one injected precache manifest')
const start = candidates[0].index
let depth = 0
let quoted = false
let escaped = false
let end = -1
for (let i = start; i < sw.length; i++) {
    const char = sw[i]
    if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '[') depth++
    else if (char === ']' && --depth === 0) { end = i + 1; break }
}
assert(end > start, 'Incomplete precache JSON array')
const entries = JSON.parse(sw.slice(start, end))
assert(Array.isArray(entries) && entries.length > 0, 'Empty precache manifest')

function localFile(url) {
    assert(typeof url === 'string' && url.length > 0, 'Missing precache URL')
    assert(!/[\\\x00-\x20:%?#]/.test(url), `Non-local or ambiguous asset URL: ${url}`)
    assert(!url.startsWith('/') && !url.split('/').includes('..'), `Unsafe asset URL: ${url}`)
    const file = path.resolve(dist, url)
    assert(file.startsWith(`${dist}${path.sep}`), `Asset outside dist: ${url}`)
    assert(lstatSync(file).isFile(), `Asset is not a regular file: ${url}`)
    return file
}
const md5 = bytes => createHash('md5').update(bytes).digest('hex')
const manifest = new Map()
let checkedRevisions = 0
for (const entry of entries) {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid precache entry')
    assert.deepEqual(Object.keys(entry).sort(), ['revision', 'url'], 'Unexpected precache fields')
    const file = localFile(entry.url)
    assert(entry.revision === null || /^[a-f0-9]{32}$/.test(entry.revision), `Invalid revision: ${entry.url}`)
    if (manifest.has(entry.url)) {
        assert.equal(manifest.get(entry.url), entry.revision, `Conflicting duplicate: ${entry.url}`)
        continue
    }
    manifest.set(entry.url, entry.revision)
    if (entry.revision !== null) {
        assert.equal(md5(readFileSync(file)), entry.revision, `Precache revision differs from final bytes: ${entry.url}`)
        checkedRevisions++
    } else assert(/^assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(entry.url), `Stable asset name has no content revision: ${entry.url}`)
}
assert.equal(manifest.get('index.html'), md5(readFileSync(localFile('index.html'))), 'Index must be revisioned and precached')
assert(!manifest.has('404.html'), 'Post-build static fallback must not be precached')
assert(!manifest.has('sw.js'), 'Service worker must not precache itself')
assert(readFileSync(localFile('404.html')).equals(readFileSync(localFile('index.html'))), 'Static fallback differs from the built SPA')

// All generated JS/CSS remains available to the offline shell. HTML entry
// references must also exist, including the separately served web manifest.
const assetFiles = readdirSync(path.join(dist, 'assets'), { recursive: true })
    .filter(file => /\.(?:js|css)$/.test(file)).map(file => `assets/${file}`)
for (const file of assetFiles) {
    localFile(file)
    assert(manifest.has(file), `JavaScript/CSS asset missing from precache: ${file}`)
}
for (const match of readFileSync(localFile('index.html'), 'utf8').matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const url = match[1].replace(/^\//, '')
    localFile(url)
    if (/\.(?:js|css)$/.test(url)) assert(manifest.has(url), `HTML entry asset missing from precache: ${url}`)
}
console.log(JSON.stringify({
    passed: true,
    entries: entries.length,
    uniqueEntries: manifest.size,
    checkedRevisions,
    precachedJavaScriptAndCss: assetFiles.length,
    staticFallbackExcluded: true,
    stableNameAssetsWithoutRevision: [],
}, null, 2))
