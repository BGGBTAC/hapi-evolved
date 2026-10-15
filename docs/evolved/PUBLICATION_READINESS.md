# Preview preparation and acceptance — 2026-10-15

This report covers the automatic project-directory flow, project GitHub broker
and publication files on `feat/publication-readiness`. The containing Git commit
identifies the reviewed source. This remains a private source preview; no public
release, package publication or visibility change is claimed.

## Verified behavior

- Creating a project without a manual path creates its own private UUID folder.
  Manual browsing starts only after the administrator requests it. Overlapping
  roots, symlinks, nested mounts and protected paths are rejected.
- Browser GitHub setup uses real Hub and signed Vault routes. The acceptance
  provider supplies synthetic responses; no real GitHub token was imported.
  Connection persistence, project isolation, read/write grants, rotation,
  disconnect, token clearing and browser-storage exclusion were checked.
- Native Git cloned, fetched and pushed a branch through the production runner
  proxy, Hub and signed Vault into a local Git HTTP backend. Revoked access was
  denied. This proves the transport path, not organization approval or a live
  GitHub account's permissions.
- Role/profile changes permanently revoke existing runner leases. Git requires
  a lease-derived capability. Transfers are bounded before body reads and stop
  when authorization expires or is revoked.

## Validation

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed |
| `bun run test` | 9,038 passed, 15 intentionally skipped, no failures |
| `bun run typecheck` | CLI, Hub, Web, relay and runner proxy passed |
| `bun run build:web` | Production build passed |
| `bun run --cwd docs docs:build` | Passed with link checking enabled |
| Publication policy and source-bundle tests | 17 passed |
| Workflow `actionlint` 1.7.12 | Passed; optional shellcheck/pyflakes not installed |
| Codegraph service tests | 4 passed, including a real FIFO regression |
| Memory service tests | 9 passed |
| Additional VM acceptance-guard tests | 11 passed |
| Evolved Chromium browser acceptance | All nine acceptance groups passed |

The skipped tests require optional provider/native integrations or explicitly
supplied operator fixtures. The browser suite uses temporary state and virtual
passkeys; it does not modify the operator's account. Remote GitHub Actions are
separate evidence: local success is not a remote CI pass.

After the final small review fixes, the affected suites were rerun: Hub (1,677
passed, three skipped), runner proxy (19 passed), deployment guards (22 passed)
and Codegraph (four passed), plus Hub/proxy typechecks and the documentation
build. The earlier full-suite total above is retained as the result of that
actual command, rather than inflated with repeated tests.

## Review and publication limits

Claude Opus 5.5 reviewed the design and implementation adversarially. Concrete
findings were corrected and the changes reviewed again; the
[redacted review record](reviews/publication-github-2026-10-15.json) records model
identity, input hashes, dispositions and residual limits. Review is evidence,
not a guarantee that no defect remains.

The secret audit scanned all then-available Git refs (1,546 commits) and the
working snapshot. Its six historical candidates were classified as synthetic
fixtures, hashes or prose; no real credential was confirmed. Privacy review also
covered 13,040 historical text blobs. This does not establish that every retained
artifact is suitable for publication: historical operator paths and private
development context require a separate visibility decision. Current documentation
uses portable paths; Git history was not rewritten.

The publication workflow only builds a source artifact with its exact commit,
manifest and SHA256 checksums. Follow [RELEASING.md](https://github.com/BGGBTAC/hapi-evolved/blob/main/RELEASING.md) before
changing visibility or creating a release. Live GitHub account authorization,
Git LFS/SSH, GitHub App authorization, cloud-provider quality, native-client
parity and a complete disaster-recovery restore remain outside this acceptance.
