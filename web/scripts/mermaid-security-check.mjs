// Run after the frozen workspace install and Playwright Chromium installation:
// timeout 90s node web/scripts/mermaid-security-check.mjs
// PLAYWRIGHT_CHROME_PATH optionally selects an existing Chromium executable.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webRequire = createRequire(path.join(webRoot, 'package.json'))
const viteRequire = createRequire(webRequire.resolve('vite/package.json'))
const { build } = viteRequire('esbuild')

// Import the production strict renderer and lightbox normalizer, not a copy of
// their security configuration. No application server or provider is started.
const bundle = await build({
    stdin: {
        contents: `import { renderMermaidSvg, normalizeMermaidSvgForStandaloneDisplay } from './src/components/assistant-ui/mermaid-diagram';
            window.mermaidSecurityProbe = { renderMermaidSvg, normalizeMermaidSvgForStandaloneDisplay };`,
        resolveDir: webRoot,
        loader: 'ts',
    },
    tsconfig: path.join(webRoot, 'tsconfig.json'),
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
})
assert.equal(bundle.outputFiles.length, 1)

const cases = [
    { name: 'ordinary-diagram', code: 'flowchart LR\n A[Start] --> B[Done]', mustRender: true },
    { name: 'mathematical-diagram', code: 'flowchart LR\n A["$$x^2$$"] --> B[Done]', mustRender: true, math: true },
    {
        name: 'classDef-html-escape',
        code: 'stateDiagram-v2\n classDef xss fill:red</style></svg><div id="injection-marker">injected</div><svg><style>a:b\n [*] --> A:::xss',
    },
    {
        name: 'fontFamily-css-escape',
        code: '%%{init: {"fontFamily": "x;a{b} :not(&){outline-width:23px!important;outline-style:solid!important} c{d}"}}%%\nflowchart LR\n A --> B',
    },
    {
        name: 'frontmatter-css-siblings',
        code: '---\nconfig:\n themeCSS: "& + *, & ~ *, :has(#sentinel) { outline-width:23px!important;outline-style:solid!important }"\n---\nflowchart LR\n A --> B',
    },
    {
        name: 'directive-css-siblings',
        code: '%%{init: {"themeCSS": "& + *, & ~ *, :has(#sentinel) { outline-width:23px!important;outline-style:solid!important }"}}%%\nflowchart LR\n A --> B',
    },
]

async function bounded(promise, label, milliseconds = 5_000) {
    let timer
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds) }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}),
    timeout: 15_000,
})
const results = []
try {
    for (const test of cases) {
        for (const display of ['inline', 'lightbox']) {
            const context = await browser.newContext({ serviceWorkers: 'block' })
            const requests = []
            const errors = []
            await context.route('**/*', async route => {
                requests.push(route.request().resourceType())
                await route.abort()
            })
            const page = await context.newPage()
            page.on('pageerror', error => errors.push(error.message))
            try {
                await page.setContent('<!doctype html><div id="sentinel">outside</div><div id="diagram-host"></div>')
                await page.addScriptTag({ content: bundle.outputFiles[0].text })
                const result = await bounded(page.evaluate(async ({ code, display }) => {
                    const probe = window.mermaidSecurityProbe
                    const outside = document.querySelector('#sentinel')
                    const container = document.querySelector('#diagram-host')
                    const host = display === 'lightbox' ? container.attachShadow({ mode: 'open' }) : container
                    const sibling = document.createElement('span')
                    sibling.textContent = 'synthetic sibling sentinel'
                    host.append(sibling)
                    const outline = element => {
                        const style = getComputedStyle(element)
                        return [style.outlineWidth, style.outlineStyle, style.outlineColor].join('|')
                    }
                    const outsideBefore = outline(outside)
                    const siblingBefore = outline(sibling)
                    const rendered = await probe.renderMermaidSvg(code, 'security-probe-svg', 'light')
                    // Match the two production insertion paths. The extra sibling
                    // detects scope escapes even when no sibling exists in today's UI.
                    host.innerHTML = display === 'lightbox'
                        ? '<style>:host{display:inline-block;line-height:0}svg{display:block;max-width:none;max-height:none}</style>'
                            + probe.normalizeMermaidSvgForStandaloneDisplay(rendered.svg ?? '')
                        : rendered.svg ?? ''
                    host.append(sibling)
                    await new Promise(resolve => setTimeout(resolve, 40))
                    return {
                        rendered: rendered.error === null && !!host.querySelector('svg'),
                        math: !!host.querySelector('math, .katex'),
                        injectedHtml: !!document.querySelector('#injection-marker') || !!host.querySelector('#injection-marker'),
                        outsideChanged: outline(outside) !== outsideBefore,
                        siblingChanged: outline(sibling) !== siblingBefore,
                    }
                }, { code: test.code, display }), `${test.name}/${display}`)
                const label = `${test.name}/${display}`
                assert.equal(result.injectedHtml, false, `${label}: HTML escaped the SVG`)
                assert.equal(result.outsideChanged, false, `${label}: CSS changed the surrounding document`)
                assert.equal(result.siblingChanged, false, `${label}: CSS changed the SVG sibling`)
                assert.equal(requests.length, 0, `${label}: attempted network access`)
                assert.deepEqual(errors, [], `${label}: browser error`)
                if (test.mustRender) assert.equal(result.rendered, true, `${label}: ordinary rendering failed`)
                if (test.math) assert.equal(result.math, true, `${label}: mathematical rendering failed`)
                results.push({ case: test.name, display, passed: true })
            } finally {
                await bounded(context.close(), 'browser context cleanup')
            }
        }
    }
} finally {
    await bounded(browser.close(), 'browser cleanup', 10_000)
}
console.log(JSON.stringify({ passed: true, checks: results.length, results }, null, 2))
