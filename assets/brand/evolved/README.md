# HAPI-eVolved logo

![HAPI-eVolved](hapi-evolved-logo-v1.png)

The primary horizontal logo combines a lowercase **e** and two connected graph
nodes with the exact wordmark **HAPI-eVolved**. The symbol represents evolution,
persistent memory and codegraph. Its teal direction follows the Evolved interface
in `web/src/evolved/evolved.css`.

- `hapi-evolved-logo-v1.png`: original generated raster artwork, transparent RGBA
  PNG, 2043 × 770 pixels (329,443 bytes).
- `PROMPT.txt`: complete generation prompt; generated with the built-in Imagegen
  tool on 2026-10-15, with no reference images.

Use on a light background with clear space around the mark. The dark wordmark is
intended for light surfaces. Preserve the aspect ratio and exact capitalization;
do not stretch or recolor the file. This is a horizontal wordmark, not a favicon.
The file is raster artwork, not a scalable vector master. The prompt specifies
teal `#0F766E` and ink `#172B2A`; the generated pixels are not a flat-color reference.

## Application icon companion

`hapi-evolved-mark.svg` is a small, code-native optical companion to the raster
wordmark. Its graph-e geometry matches `web/src/evolved/Brand.tsx`. It is not a
vector tracing or replacement of the original artwork above. The application
uses this simpler mark at navigation and launcher sizes.

`hapi-evolved-app-icon.svg` and `hapi-evolved-maskable-icon.svg` add a light neutral
surface and clear space. The maskable version has an opaque, square background;
the mark stays inside the central safe circle. The Safari pinned-tab mask is
monochrome. Native app assets inherited from upstream remain unchanged.

Rebuild the public SVG, PNG and multi-resolution ICO exports from the vector
source with the repository's existing Playwright dependency:

```sh
node web/scripts/export-evolved-icons.mjs
node web/scripts/export-evolved-icons.mjs --check
```

Use `PLAYWRIGHT_CHROME_PATH` when an installed Chromium executable is outside
Playwright's default cache. Use the same Chromium build for byte-identical
exports; the script reports its version and output hashes. No ImageMagick,
external fonts, network resources or image-generation service is involved.
Original raster artwork is never read or rewritten by the exporter.

## Repository banner

`hapi-evolved-github-banner.svg` is the code-native GitHub README banner. It uses
the existing graph-e companion, a fixed dark background for readability in both
GitHub themes, and the project tagline: **Your agents. Your infrastructure. Faster evolution.**
It has no scripts, external resources or embedded raster images. The original
logo and its provenance above remain unchanged.
