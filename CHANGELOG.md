# Changelog

Changes specific to HAPI-eVolved are recorded here. Upstream history remains in
Git. Source version numbers do not imply a published GitHub release, npm package
or container image.

## Unreleased — 0.1.0 preview

### Added

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
- Runner restart after a Linux boot or PID namespace change, preserving machine
  identity and session state.

### Validation and limits

See [initial validation](docs/evolved/VALIDATION.md),
[backlog validation](docs/evolved/BACKLOG_REVIEW.md) and
[reproducible live acceptance](docs/evolved/LIVE_ACCEPTANCE.md), plus the
[project/GitHub and publication acceptance](docs/evolved/PUBLICATION_READINESS.md).
Dated reports apply to their named commits, not automatically to later releases.
Native client parity, real cloud extraction quality, a complete backup restore
drill and a public distribution release remain separate checks.
