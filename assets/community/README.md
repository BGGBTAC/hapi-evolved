# HAPI-eVolved — scripted UI demo

These media show the real Web/PWA interface with a synthetic project. Every frame
and screenshot carries an explicit demo caption; this is not a recording of a real
customer, provider account or model run. The workspace currently includes German
labels; the explanatory captions are English.

| File | Content |
| --- | --- |
| `walkthrough.webm` | 60–90 seconds: project, repository, local diff, Codegraph impact, review preparation, knowledge proposal |
| `desktop.png` | Desktop project overview, 1440 × 1000 |
| `mobile.png` | Mobile layout, 390 × 844; browser viewport, not a physical-device claim |
| `codegraph.png` | Real indexed relationships from the selected synthetic source file |
| `recording.json` | Source/input hashes, checks, chapter timings and media hashes |
| `social-preview.png` | 1280 × 640 brand artwork for GitHub's social preview, below 1 MiB |

**Real:** isolated Hub, encrypted Vault, virtual WebAuthn enrollment, local Git
checkout/diff, Codegraph indexing and source-linked Memory proposal. GitHub
responses and runner availability use the existing offline workflow fixtures.
No remote clone/push, provider login, model response or cloud extraction is shown.
The review form is prepared but its Start button is never pressed. Proposed
knowledge remains unverified; graph relationships are hints, not proof of passing
tests. Enrollment/recovery screens are completed before recording and excluded.

Only an explanatory strip is added by the recording harness. Product labels,
status, error messages and controls are not rewritten or hidden. Browser requests
are restricted to the fresh loopback Hub; the fixture inherits no personal
provider/account configuration. The independent fork retains credit to
[tiann/hapi](https://github.com/tiann/hapi).

## Reproduce

Use the recorded source/dependency revision on Linux with Bun 1.3.14 and Node 24.
No new dependency or host service is needed:

```sh
bun install --frozen-lockfile
npm ci --prefix services/codegraph --ignore-scripts
bun run build:web
bunx playwright install chromium
node scripts/community/record-demo.mjs
node scripts/community/check-media.mjs
```

Playwright uses its bundled video encoder; the checker uses the same installed
ffmpeg to extract six frames for visual review and verifies browser playback.
Existing generated media are never
overwritten: preserve or move them first when deliberately making another take.
The script starts only the existing isolated browser fixture, records in a new
private temporary directory, and stops its own processes/removes synthetic state
afterward. Failure diagnostics stay outside Git. Review all media before sharing;
the JSON report checks behavior but cannot replace a visual review.
Set `PLAYWRIGHT_CHROME_PATH` to an already installed Chromium executable when
using a browser outside Playwright's default cache. A fixed synthetic formula is
also checked in the real chat renderer before recording; it is not model output.

The social preview is a separate code-native composition of the existing SVG
mark and project copy; it is not a product screenshot. Recreate it with
`node scripts/community/social-preview.mjs`. Upload it manually in GitHub's
repository social-preview settings; the script does not publish or upload it.

The media are a feature demonstration, not installation guidance. Use the pinned
[preview quick start](../../docs/evolved/QUICKSTART.md) for installation requirements
and the limitations of the source-only Linux preview.
