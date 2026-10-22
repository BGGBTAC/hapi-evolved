# Dependency review — community source preview

## Follow-up — 2026-10-22

The Bun workspace audit now returns `{}` with exit status 0 after a fresh
`bun install --frozen-lockfile --ignore-scripts` using Bun 1.3.14. The lockfile
is byte-stable across that install. This supersedes the retained findings in the
October 16 snapshot below; it is not a complete system security audit or a promise
about advisories published after this review.

| Dependency group | Resolution |
|---|---|
| MCP and request parsing | MCP SDK 1.32.0 and Hono 4.13.11; Express 5.3.0 resolves body-parser 2.4.0 and qs 6.16.1. The small website server also uses Express 5, with its named SPA wildcard and six real HTTP regression tests. |
| Compatible transitive updates | Babel core 7.29.7, AJV 8.18.0, bn.js 4.12.3, colord 2.9.4, follow-redirects 1.16.1, query-string 9.5.1 (decode-uri-component 0.5.0), UUID 13.0.1 and YAML 2.8.4. The separate cosmiconfig YAML 1.10.3 branch is preserved. Each new override satisfies its consumers' declared ranges. |
| Web and PWA tooling | Vite 7.3.7, Vitest 4.1.12, vite-plugin-pwa 1.3.0 and Workbox 7.4.1. Workbox's supported Terser plugin resolves serialize-javascript 7.1.2 without forcing a new major into the old plugin. |
| Documentation | Exactly pinned [VitePress 2.0.0-alpha.20](https://github.com/vuejs/vitepress/releases/tag/v2.0.0-alpha.20), using its supported Vite 8.3.5 dependency. This removes the Vite 5/esbuild 0.21 branch. It is an explicitly reviewed prerelease, confined to the documentation toolchain. |
| Unused styling plugin | Removed the unused website `@tailwindcss/typography` dependency, eliminating its vulnerable selector-parser branch. Website HTML, JavaScript and CSS output is unchanged. |

Validation on the freshly installed graph includes all seven root typechecks,
website typechecking, 65 focused CLI tests, 43 Hub tests, 20 web tests and six
website HTTP tests. Web/PWA, website/documentation and embedded Hub builds pass.
The independent dependency review checks both locked ranges and actual consumer
resolution: an incremental Bun install had retained old isolated-store symlinks,
so final checks used a fresh installation. React, React DOM, TypeScript, the
renderer versions and Bun itself were not upgraded by this follow-up.

Chromium checks pass for the old and new documentation builds: desktop navigation,
local search (16 results for GitHub), dark theme, the custom theme component and
mobile navigation at 390 pixels. No local failed requests or JavaScript errors
occurred. Three source Markdown links that already broke the old documentation
build now point to their repository files. The subsequent documentation follow-up
also repaired 24 pre-existing references to source/evidence files outside the
generated site. They now link to the corresponding versioned repository files;
the static-output crawl finds no missing local file targets. External services
and every individual fragment anchor are outside that check.

The PWA manifest check passes with 155 unique entries, 51 matching content
revisions and no unrevisioned stable-name assets. Chromium installs the actual
worker and loads the exact current root shell and a KaTeX font offline. It does
not test arbitrary deep links. The Express regression can be rerun with
`bun test ./website/src/server/app.test.ts`; repository-wide integration checks
remain the responsibility of the final combined change and required CI.

## Historical snapshot — 2026-10-16

The remainder records the previous review and its then-open findings. Use the
October 22 follow-up above for the current workspace dependency status.

Review date: 2026-10-16. Scope: the committed Bun workspace dependency graph, installed with Bun 1.3.14. This is a dependency review, not a complete system security audit. It does not cover native provider binaries, operating-system packages, container base images, or the separately locked Codegraph npm service.

The five originally reported GitHub Dependabot advisories are addressed. A broader npm advisory query found additional affected versions; compatible high/critical runtime updates were included before community promotion. The final graph has no matching critical advisory and retains two high advisories in build tooling, described below. Lower-severity findings remain open. This is not a zero-vulnerability claim.

## Original five advisories

| Advisory | Resolution |
|---|---|
| [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) — ws | ws 8.21.0; the optional React Devtools chain retains its compatible ws 7.5.11 branch. |
| [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) — ws | Both installed major branches contain their fixes. Engine.IO/client and Socket.IO adapter parents are updated without a major change. |
| [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) — KaTeX | KaTeX 0.18.2, including Mermaid's transitive copy. |
| [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) — Vitest | CLI/web and the entire Vitest family use 4.1.11. The unused website Vitest dependency was removed. |
| [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) — Vitest mocker | Vitest/mocker 4.1.11. |

The website is a root Bun workspace. Its unreferenced standalone lock and unused Builder/Manus development plugins were removed; installs use the root frozen lock. Dependabot alerts and the repository's existing automation policy are unchanged by this patch.

## Additional runtime corrections

The expanded audit also prompted same-major updates to MCP SDK 1.31.0, Fastify 5.12.5, Hono 4.13.7, tar 7.5.21, Seroval 1.6.3, proxy-addr 2.0.8, shell-quote 1.12.0, Socket.IO parser 4.2.7, and their affected transitive dependencies. These include the critical [tar](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw), [Seroval](https://github.com/lxsmnsyc/seroval/security/advisories/GHSA-p6vx-979v-rg4c), [proxy-addr](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h), and [shell-quote](https://github.com/ljharb/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p) reports.

The ws 7/8, Rollup 2/4, and other required major-version branches remain separate. Dependency and optional-dependency ranges are checked against the actual locked graph; native Rollup packages follow their matching Rollup release. Root overrides are limited to the affected Engine.IO/adapter parents, KaTeX, lodash-es, Mermaid, and DOMPurify. The renderer overrides also remove the older Mermaid copy brought in by Streamdown. Seroval 1.6.3 satisfies TanStack's existing `^1.5.4` range and needs no override.

These constraints apply to the supported source installation with its frozen root lock. They do not establish safety for independently published npm workspace packages. Updating MCP, Fastify, and Hono still requires API, authentication, socket, and runner regression tests; same-major versioning alone is not an acceptance test.

## Untrusted diagram rendering

Mermaid code blocks from chat reach the production SVG renderer. Its `securityLevel: 'strict'` configuration is not a browser sandbox: the inline view inserts the SVG as HTML, and the lightbox normalizes that SVG before inserting it into a ShadowRoot. Benign regression payloads demonstrated HTML insertion and surrounding-page CSS changes with the old Mermaid version.

Mermaid **11.16.1** and DOMPurify **3.4.17** close all 28 previously matched advisory IDs in this render chain: nine Mermaid advisories and 19 DOMPurify advisories. Mermaid 11.16.1 is the first compatible 11.x version covering the complete nine-advisory set, including sibling CSS escapes and the Gantt/XY/radar rendering denial-of-service cases. DOMPurify 3.4.17 includes the sanitizer fixes and the subsequent Trusted Types dependency correction. This does not mean all 28 vulnerable API/configuration combinations were exploitable in this application.

| Updated package | Resolved advisory IDs |
|---|---|
| Mermaid 11.16.1 | [GHSA-2v8p-3f2j-5mp7](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-2v8p-3f2j-5mp7), [GHSA-3rrr-jr9j-h3q3](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-3rrr-jr9j-h3q3), [GHSA-6m6c-36f7-fhxh](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-6m6c-36f7-fhxh), [GHSA-6x64-9x62-f2gx](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-6x64-9x62-f2gx), [GHSA-87f9-hvmw-gh4p](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-87f9-hvmw-gh4p), [GHSA-c4c3-pg64-4m4v](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-c4c3-pg64-4m4v), [GHSA-ghcm-xqfw-q4vr](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-ghcm-xqfw-q4vr), [GHSA-rhh3-jpg6-66xh](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-rhh3-jpg6-66xh), [GHSA-xcj9-5m2h-648r](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-xcj9-5m2h-648r) |
| DOMPurify 3.4.17 | [GHSA-39q2-94rc-95cp](https://github.com/cure53/DOMPurify/security/advisories/GHSA-39q2-94rc-95cp), [GHSA-55q2-fjhq-7xh7](https://github.com/cure53/DOMPurify/security/advisories/GHSA-55q2-fjhq-7xh7), [GHSA-6688-9rhm-gjv2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2), [GHSA-76mc-f452-cxcm](https://github.com/cure53/DOMPurify/security/advisories/GHSA-76mc-f452-cxcm), [GHSA-c2j3-45gr-mqc4](https://github.com/cure53/DOMPurify/security/advisories/GHSA-c2j3-45gr-mqc4), [GHSA-cj63-jhhr-wcxv](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cj63-jhhr-wcxv), [GHSA-cjmm-f4jc-qw8r](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cjmm-f4jc-qw8r), [GHSA-cmwh-pvxp-8882](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cmwh-pvxp-8882), [GHSA-crv5-9vww-q3g8](https://github.com/cure53/DOMPurify/security/advisories/GHSA-crv5-9vww-q3g8), [GHSA-gvmj-g25r-r7wr](https://github.com/cure53/DOMPurify/security/advisories/GHSA-gvmj-g25r-r7wr), [GHSA-h7mw-gpvr-xq4m](https://github.com/cure53/DOMPurify/security/advisories/GHSA-h7mw-gpvr-xq4m), [GHSA-h8r8-wccr-v5f2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-h8r8-wccr-v5f2), [GHSA-hpcv-96wg-7vj8](https://github.com/cure53/DOMPurify/security/advisories/GHSA-hpcv-96wg-7vj8), [GHSA-r47g-fvhr-h676](https://github.com/cure53/DOMPurify/security/advisories/GHSA-r47g-fvhr-h676), [GHSA-rp9w-3fw7-7cwq](https://github.com/cure53/DOMPurify/security/advisories/GHSA-rp9w-3fw7-7cwq), [GHSA-v2wj-7wpq-c8vv](https://github.com/advisories/GHSA-v2wj-7wpq-c8vv), [GHSA-v9jr-rg53-9pgp](https://github.com/cure53/DOMPurify/security/advisories/GHSA-v9jr-rg53-9pgp), [GHSA-vxr8-fq34-vvx9](https://github.com/cure53/DOMPurify/security/advisories/GHSA-vxr8-fq34-vvx9), [GHSA-x4vx-rjvf-j5p4](https://github.com/cure53/DOMPurify/security/advisories/GHSA-x4vx-rjvf-j5p4) |

The permanent browser regression imports the production renderer and normalizer. It checks ordinary and mathematical diagrams, HTML escapes, configuration CSS, and sibling selectors from both frontmatter and init directives, in both inline and lightbox contexts. It blocks and rejects any attempted network request. The broader review also exercised bounded Gantt/XY/radar and architecture inputs. Rendering still runs on the browser main thread; these fixes do not guarantee protection against every future rendering denial of service.

After `bun install --frozen-lockfile` and installation of Playwright Chromium, run from the repository root:

```sh
timeout 90s node web/scripts/mermaid-security-check.mjs
```

`PLAYWRIGHT_CHROME_PATH` may select an existing Chromium executable. The script starts no application server or provider and uses synthetic local inputs only. It includes per-case deadlines; the outer timeout bounds the complete browser process.

## Retained high build-tool advisories

| Package and advisory | Exposure and decision | Follow-up |
|---|---|---|
| serialize-javascript 6.0.2 — [GHSA-5c6j-r48x-rmvq](https://github.com/yahoo/serialize-javascript/security/advisories/GHSA-5c6j-r48x-rmvq) | Build dependency through Workbox and the Rollup Terser plugin. The vulnerable call serializes minifier option objects, not chat or HTTP data. No untrusted environment, network, or user object is passed to those options by this repository. The app uses `injectManifest` with a checked-in service worker. The fixed line starts at major 7; forcing it into the plugin's declared major 6 range is deferred. | Upgrade the compatible Workbox/Terser toolchain separately. Do not accept untrusted minifier/plugin options or run untrusted build configurations with credentials. |
| Vite 5.4.21 — [GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff) | Required by VitePress 1.6.4 for documentation development/build. The high issue requires an exposed development server and Windows/NTFS path behavior. Production serves compiled static output; CI builds docs. No patched Vite 5 release exists, and forcing a new major would violate VitePress's declared dependency. | Keep `docs:dev` on localhost; do not add `--host` or expose it on Windows. Keep credentials outside the docs tree. Upgrade VitePress with its supported Vite line separately. See [contributing guidance](https://github.com/BGGBTAC/hapi-evolved/blob/main/CONTRIBUTING.md). |

These are explicit development/build restrictions, not advisory dismissals or a guarantee for arbitrary deployment configurations.

## Remaining lower-severity findings

The final npm query matches 19 distinct advisory IDs across 13 package groups, including the two high build-tool advisories above, after filtering against exact locked versions. Multiple advisory IDs may describe one dependency; multiple installed versions may match one ID. The table is a snapshot and can change when the advisory database changes.

| Package/version | Use and follow-up | Remaining advisory IDs |
|---|---|---|
| @babel/core 7.28.5 | Build-time transforms; follow up with the Babel toolchain. | [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8) |
| ajv 8.17.1 | Runtime schema validation through MCP/Fastify; schedule a compatible validator update. | [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) |
| bn.js 4.12.2 | Transitive tooling arithmetic; review its input path before changing the older major. | [GHSA-378v-28hj-76wf](https://github.com/advisories/GHSA-378v-28hj-76wf) |
| body-parser 1.20.4, 2.2.1 | Express request-body parsing, including MCP tooling; schedule the fixed compatible branch. | [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6) |
| colord 2.9.3 | UI color handling; follow up on untrusted color parsing. | [GHSA-2wm5-q62r-hmrv](https://github.com/advisories/GHSA-2wm5-q62r-hmrv) |
| decode-uri-component 0.4.1 | Transitive URI parsing; follow up on malformed input handling. | [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) |
| esbuild 0.21.5 | Documentation development tooling; keep development servers local. | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) |
| postcss-selector-parser 6.0.10 | Build-time stylesheet processing; follow up with the CSS toolchain. | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) |
| qs 6.14.0 | Express query parsing; schedule compatible parsing updates. | [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [GHSA-6rw7-vpxm-498p](https://github.com/advisories/GHSA-6rw7-vpxm-498p), [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26), [GHSA-w7fw-mjwx-w883](https://github.com/advisories/GHSA-w7fw-mjwx-w883) |
| serialize-javascript 6.0.2 | Build-only minifier option serialization; same boundary as above. | [GHSA-qj8w-gfj5-8c6v](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v) |
| uuid 13.0.0 | Identifier generation; review the affected APIs before updating its required major branches. | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) |
| vite 5.4.21 | Documentation development server; same local-only restriction as above. | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9), [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) |
| yaml 2.8.2 | CLI configuration/data parsing; schedule the compatible fixed patch. | [GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp) |

## Verification and review

Independent, actual Claude Opus 5.5 reviews accepted the dependency design and the final render-chain correction conditionally on the final installation, regression, and build gates. It recommended the documented build-tool restrictions instead of untested major overrides. Review findings led to removal of unused website tooling and its ineffective nested override, restoration of unrelated UI package versions, full dependency-closure validation, and explicit consumer-resolution checks.

A fresh workspace installation and an independent installation using an initially empty cache both use the exact frozen lock. Actual consumer resolutions and package-file hashes of 126 affected or coupled packages match; no required dependency is unresolved. A subsequent normal install leaves the lock unchanged. Incremental-install results obtained before this fresh installation are not final evidence.

Relevant required peer ranges are compatible. A Seroval round-trip through the version actually resolved by TanStack passes. Both the web and website resolve Mermaid 11.16.1 and render ordinary and mathematical diagrams in Chromium with KaTeX 0.18.2, without JavaScript errors. All 12 permanent renderer browser checks and the real chat KaTeX check pass. The separate adversarial review reproduced two old-version escapes and passed 18 current-version cases across inline and lightbox paths, without external requests or JavaScript errors.

Hono now rejects an oversized chunked body before invoking the downstream handler: the request-boundary regression must expect 413 instead of 401 while retaining the bounded-read check. This is an [intentional upstream limit-enforcement fix](https://github.com/honojs/hono/commit/db05b96d7a4de569ba9e965052b0593663b164fc); the middleware does not promise explicit cancellation of the input stream.

Local acceptance on the final render dependency graph includes all seven typechecks, 3,956 web tests, the web/PWA and website builds, the existing Evolved browser checks, and the integrated browser workflow with real local Git and Codegraph fixtures. The permanent renderer check also passes independently. The preceding graph, before the isolated Mermaid/DOMPurify correction, passed 3,253 CLI tests, 1,878 Hub tests, 14 CLI integration tests, and the remaining package suites; those results are distinguished from the final render-consumer checks rather than presented as a second complete run.

The built-asset check also found and corrected two existing PWA cache issues: the post-build `404.html` copy is excluded from precaching, while stable-name KaTeX fonts now receive content revisions. Only hashed JavaScript/CSS filenames omit revisions. Run `node web/scripts/check-pwa-assets.mjs` after the complete web build to verify final bytes, the fallback copy, and precache coverage. The accepted build has 155 unique precache entries, 51 matching content revisions, and no unrevisioned stable-name assets. An isolated Chromium check installed the actual worker and loaded the exact current root shell and a KaTeX font offline. The correction changed only `sw.js`; application assets and the demo's recorded index hash remained identical. This verifies the root shell, not arbitrary deep links or automatic reloads of existing tabs.

The final commit must still pass the repository's required CI checks before merging or releasing. Release archives must identify that exact commit and lockfile. Published web/PWA assets must come from the accepted build, with regenerated hashed renderer chunks and service-worker precache entries; do not reuse old renderer assets. No GitHub alert is dismissed automatically.
