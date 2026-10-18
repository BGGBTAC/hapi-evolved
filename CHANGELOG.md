# Changelog

Changes specific to HAPI-eVolved are recorded here. Upstream history remains in
Git. Source version numbers do not imply a published GitHub release, npm package
or container image.

## Unreleased

- Guided project setup for new and existing projects, including repository-dependent
  plugin modules; creation enters the new project and readiness follows its bound checkout.
- Separate Odoo.sh staging and production settings, explicit environment status reads,
  preserved legacy values and clearer Enterprise-source guidance. Project settings use
  storage envelope 3 on explicit save; older binaries refuse this newer format.
- Ordinary feature branches tracking a differently named origin branch no longer block
  repository chat starts. Pull follows the validated upstream and retains fast-forward checks.

- Per-project Odoo 19/20, iOS and Android development modes, with revision-checked
  settings, a default repository and prepared specialist sessions.
- Bundled, versioned development handbooks available to Claude and Codex without
  graph indexing; read-only toolchain diagnostics and static repository inspection.
- Odoo.sh integration through existing GitHub repository grants and combined
  commit status, with explicit dashboard and SSH references.
- Optional development runner and project-local setup/test helpers for Odoo,
  Android and portable Swift. Native iOS builds require macOS or an external
  workflow; Android SDK setup retains explicit human licence acknowledgement.
- Development modules from GitHub plugins (`schemaVersion: 2`, `developmentModules`):
  declarative settings, handbook, recipes and specialist tasks bound to a module
  digest, with explicit per-project adoption of plugin updates. Runners implement
  the fixed `hapi.toolchain` v1 and `hapi.repository-inventory` v1 providers and
  advertise them as capabilities; module data cannot supply commands or code.
- Agent tools and `hapi evolved development` use the contract-2 module routes
  (operating context v8), the runner proxy admits exactly the module
  context/knowledge/doctor/inspect reads, and `hapi evolved plugin validate`
  plus `--local --definition` check a plugin manifest offline. Django example
  plugin and author guide in `docs/evolved/DEVELOPMENT_MODULES.md`.

- Project MCP shop with Context7 and custom public HTTPS Streamable HTTP servers,
  encrypted credentials, connection checks, explicit tool grants, read-only access
  and bounded call diagnostics shared by Claude and Codex.
- Fresh authorization after runner request-body reads, local Claude MCP Host/Origin
  validation, human-only knowledge status changes and Codegraph reindexing, and
  consistent explicit tool filtering in the Codex bridge.
- Failed specialist/plugin loading now shows an error instead of an empty catalog.

## [0.1.0-preview.2](https://github.com/BGGBTAC/hapi-evolved/releases/tag/v0.1.0-preview.2) — 2026-10-16

Community source preview from commit
`50566349a1ce3e130e47d03829257ad2a24f1351`. See the release notes for the source
archive, checksums, validation scope and remaining dependency advisories.

- A fresh Linux core-installation assistant with read-only prerequisite/status
  checks, private state, isolated images and explicit build/start steps. Managed
  browser provider login remains a separate, documented host-control setup.
- English installation and pilot guides, GitHub Discussion forms, contribution
  entry points and an explicitly labelled synthetic UI walkthrough with desktop,
  mobile and Codegraph screenshots.
- Security updates for affected application and build dependencies; the release
  notes identify remaining tooling advisories and the exact tested revision.
- Correct PWA cache revisions for stable KaTeX fonts, excluding the static-host
  fallback that is copied after service-worker generation; final-asset CI checks.

## [0.1.0-preview.1](https://github.com/BGGBTAC/hapi-evolved/releases/tag/v0.1.0-preview.1) — 2026-10-16

First published source preview, built from commit
`72df6df86b9bbb0e4c946bdb146b4c47390b731a`. The release includes the source archive,
manifest, checksums, installation instructions and known limitations.

### Added

- Integrated project readiness with a live runner RPC probe, distinct partial
  failures and browser subscription setup as the normal onboarding path.
- Explicit repository selection for ordinary sessions and specialists, with
  server-owned session links and no implicit directory fallback.
- Repository worktree/diff views without a running session, bounded sensitive
  content filtering, Codegraph change impact and read-mode review specialists.
- Knowledge proposals from stored conversation text or a selected source file;
  source provenance is supplied by the Hub and proposals remain unverified.

- A coherent HAPI-eVolved project identity across GitHub, documentation and the
  web interface, with explicit upstream fork attribution and a separate roadmap.

- Browser-based native Codex/Claude subscription login, account status, cancellation
  and logout; missing project runners are provisioned automatically by a narrow
  local control service. Provider credentials persist in private runner homes.
- Reusable global specialist definitions with project-scoped, idempotent starts.
- Reviewed, commit-pinned public GitHub plugins for agent templates, skills and
  validated color profiles, with update previews, disabling and removal.
- Ocean, Iris and Sand color profiles, visual previews and a visible appearance link.
- Native Claude/Codex model catalogs in session and specialist selectors, with
  scoped caching, explicit refresh, account/source limits and manual model IDs.

- Responsive workspace navigation, project dashboard and a unified desktop/PWA
  design, with dark/OLED themes, accessible mobile controls and new app icons.
- Project-scoped subscription-capacity views from native Claude/Codex telemetry,
  with per-window freshness, reset times and explicit unavailable states.
- Team/project roles, passkeys, one-time recovery codes and step-up authentication.
- A separate encrypted local credential vault and constrained resource broker.
- Persistent knowledge, source verification and local search, with an optional
  budgeted Graphiti/Neo4j knowledge graph.
- Local Codegraph search, source inspection, graph/impact exploration and refresh.
- Isolated Claude Code/Codex runners with revocable leases and project profiles.
- Permanent runner access until revocation, with optional timed access; existing
  access deadlines are preserved and internal credentials stay short-lived.
- Automatic per-project directories and optional manual folder selection.
- Project GitHub connections with repository grants and brokered Git operations.
- Durable attachment originals, searchable history, saved prompts, scoped
  automation, private previews and expiring share links.
- A dedicated logo, community documentation and source-preview packaging.

### Fixed

- Source-file intake rejects FIFO replacements without blocking filesystem
  workers. Expanded intake exclusions preserve unchanged legacy knowledge.
- Specialist starts do not create a missing project or checkout directory.

- Runner RPC registrations are restored after Hub reconnects and capability
  renewal without disconnecting the native client. Delayed acknowledgements
  cannot cross connection generations, and RPC ownership is checked by the Hub.

- New project sessions automatically use the stored project folder. Old paths,
  form drafts and URL parameters cannot override it; the server validates the
  root and rejects unrelated folders and unsupported external worktree starts.

- Repository write grants are selectable independently of the execution profile,
  with contextual push requirements and an explicit profile/runner setup path.
- Codegraph statistics no longer render nested SDK objects as React children;
  empty workspaces return an empty graph and explain automatic indexing.
- A visible subscription setup page distinguishes native Codex/Claude logins
  from HAPI runner access, with accurate provider instructions and status limits.

- PWA updates are visible before sign-in and project selection; consistent HTML,
  service-worker and manifest cache headers, with no automatic reload of other
  tabs already running the corrected client.
- Global event handlers no longer block browser zoom gestures and shortcuts.
- Mobile chat placeholder readability and excessive composer toolbar height.
- Browser zoom, landscape PWA use and dark-mode workspace styling.
- Replay duplication, usage-history paging and delayed client-cache updates.
- Claude resume identity handling, reconnect behavior and process cleanup.
- Attachment migration/restore integrity and notification epochs after restore.
- Runner restart after a Linux boot or container restart, including reused PID
  namespace identifiers, preserving machine identity, credentials and workspaces.

### Validation and limits

See [initial validation](docs/evolved/VALIDATION.md),
[backlog validation](docs/evolved/BACKLOG_REVIEW.md) and
[reproducible live acceptance](docs/evolved/LIVE_ACCEPTANCE.md), plus the
[project/GitHub and publication acceptance](docs/evolved/PUBLICATION_READINESS.md).
Dated reports apply to their named commits, not automatically to later releases.
The release commit passed required CI and CodeQL. A fresh, isolated Docker Compose
installation passed service health, access-control and web-asset checks. All three
published downloads were retrieved anonymously and matched the tested candidate
byte for byte. See the release notes for exact CI runs and dependency advisories.
Native client parity, real cloud extraction quality and a complete backup restore
drill remain separate checks.
