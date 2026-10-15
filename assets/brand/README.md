# Inherited HAPI brand assets

HAPI-eVolved uses its [own brand assets](evolved/README.md) for the web app,
documentation and project presentation. This directory preserves the original
HAPI artwork and export process for upstream attribution and contributor reference.

The sources below originally supplied upstream HAPI's web, documentation, website,
Android and iOS icons. Native assets remain inherited; the preview validates the
Evolved web/PWA client.

## Design decisions

- Face, symmetric eyes, smile, coral palette, and rounded robot frame retained.
- Side nodes become mirrored angle-bracket ports: `< HAPI >`.
- The brackets carry two meanings without touching the face: developer/code
  context and local ↔ remote handoff direction.
- Directional negative space changes the port structure, rather than merely
  swapping a circle for another primitive.
- Endpoint cutouts are true transparency and survive monochrome use.
- The PWA maskable master reuses the same optical geometry at a uniform smaller
  scale so every handoff port remains inside the maskable safe area.
- iOS and installed PWA surfaces retain the robot mark while using its existing
  small-size optical corrections: slightly stronger frame, eyes, smile, and
  handoff ports, without the eye highlights that refract on iOS 26.
- The iOS 26 Icon Composer package renders the coral mark as one flat,
  non-glass foreground over Warm White; it does not introduce a second logo.
- 16 px uses simplified solid brackets; 32 px and above retain the negative
  angle-bracket ports.
- Horizontal lockup canvas remains tightened; no terminal-cursor treatment.

## Palette

- HAPI Coral: `#F25562`
- Warm White: `#FFF8F8`
- White: `#FFFFFF`
- Ink: `#17181C`

## Source SVGs

- `svg/hapi-mark.svg` — transparent primary brand mark.
- `svg/hapi-app-icon.svg` — full-bleed app icon master.
- `svg/hapi-optical-mark.svg` — transparent iOS launcher foreground matching
  the small-size optical geometry.
- `svg/hapi-tiny.svg` — simplified 16 px favicon master.
- `svg/hapi-small.svg` — optically corrected 24–64 px master.
- `svg/hapi-maskable.svg` — safe-area-scaled PWA optical master.
- `svg/hapi-adaptive-foreground.svg` — Android adaptive foreground master.
- `svg/hapi-monochrome.svg` — one-color mark.
- `svg/hapi-lockup-horizontal.svg` — tightened horizontal lockup.

## Legacy platform export

```bash
./assets/brand/export.sh
```

This upstream exporter can overwrite Evolved web/docs/website artwork. Do not use
it to refresh the Evolved identity; use the exporter in [the Evolved guide](evolved/README.md).

For upstream asset work, the script renders into a temporary directory, then updates only the files used
by `web/`, `docs/`, `website/`, `android/`, and `ios/`. Generated intermediates
are deliberately not stored in the repository.

Android adaptive, themed, and notification icons remain native VectorDrawable
resources under `android/app/src/main/res/`; keep them aligned with
`svg/hapi-adaptive-foreground.svg` when changing the geometry.
