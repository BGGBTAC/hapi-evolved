# HAPI-eVolved roadmap

HAPI-eVolved is a fast-moving, independent fork of HAPI. We prioritize useful
features that make self-hosted agent work simpler, more capable and easier to
control. This is a priority guide, not a release schedule. Discuss substantial
proposals in this repository's issues before implementation.

## Available in the source preview

- Browser subscription login and persistent managed Claude/Codex project runners.
- Dynamic native model catalogs, reusable specialist agents and GitHub extensions.
- Automatic project folders, direct GitHub workflows and local credential management.
- Persistent memory, Codegraph and project-scoped workflow tools.
- Integrated readiness, repository session context, local diffs, impact review and
  source-linked knowledge proposals. See the [Fable/Opus project workflow plan](docs/evolved/PROJECT_WORKFLOW.md).
- Responsive desktop/PWA navigation, usage visibility and selectable color profiles.

See the [changelog](CHANGELOG.md) for details and [validation](docs/evolved/VALIDATION.md)
for tested behavior. Repository visibility, a tagged release, npm packages and
prebuilt images are separate delivery steps; the [release process](RELEASING.md)
describes their checks.

## Next validation work

- A full encrypted-backup restore drill on an isolated installation.
- Provider-backed memory extraction and cost validation with an approved budget;
  offline tests do not establish model quality.
- GitHub App authorization and shorter-lived installation tokens as an alternative
  to operator-created repository-scoped tokens.
- Accessibility and browser checks for setup, repository connections and passkeys.
- Reproducible image distribution, dependency inventory and updates before offering
  official prebuilt images.

## Later candidates

Native iOS/Android parity, more agents, migration from HAPI installations and
development-server previews need their own designs and acceptance.
The [dated backlog](docs/evolved/BACKLOG_REVIEW.md) records individual decisions.

Score functionality from **1 (small benefit) to 6 (critical benefit)** and
feasibility from **1 (hardest) to 6 (easiest)**. Functionality at least 4 and
feasibility at least 3 qualify an in-scope item for implementation; evaluate the
cost and benefit of other items. Security, integrity and demonstrated behavior
take precedence over a score alone.
