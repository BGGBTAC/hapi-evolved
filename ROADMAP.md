# Roadmap

This is a priority guide, not a release schedule. Discuss substantial proposals
in this repository's issues before implementation.

## First public preview

- Review and merge implementation, deployment and publication work.
- Verify the exact release commit with CI and isolated end-to-end acceptance.
- Complete history/artifact disclosure review and enable private security reporting.
- Distribute a source preview with its commit, checksums and documented limits.

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
