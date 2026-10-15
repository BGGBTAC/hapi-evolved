# GitHub repository governance

HAPI-eVolved is public at [BGGBTAC/hapi-evolved](https://github.com/BGGBTAC/hapi-evolved).
These settings protect contributions and future releases. They do not publish a
package, create a versioned release or deploy an application.

## Pull requests and the default branch

The active `HAPI-eVolved main protection` ruleset covers both `main` and the
repository's default branch. There are no bypass actors, including administrators.

- Changes must arrive through a pull request. Force pushes and branch deletion
  are blocked, and review conversations must be resolved.
- The branch must be current with its target and pass `test`, `integration`,
  `windows-codex-mcp` and `evolved-services`. The required check source is the
  GitHub Actions application, ID `15368`.
- CodeQL results are required as well. New findings in a PR block merging at
  security severity high/critical or alert level error. The initial baseline
  scan must finish before enabling this rule.
- Merge commits and squash merges are allowed; rebase merging is disabled.
  Merge commits preserve the fork's ancestry when that matters.
- Auto-merge is available only when explicitly enabled for an individual PR.
  Dependabot PRs are not automatically approved or opted into auto-merge.
  Merged head branches are automatically removed, and the Update branch button
  is enabled.

`BGGBTAC` is currently the only maintainer and CODEOWNER. Required approval count
is therefore zero, with no mandatory CODEOWNER or last-push approval. GitHub does
not count an author's own approval; requiring a second person now would block the
maintainer's work. This does not create a CI bypass. Review and actual validation
remain part of every contribution, including changes made with coding agents.
Existing approvals are dismissed when the reviewed code changes.
GitHub's default additional approval for unattributed Copilot PRs remains enabled;
GitHub documents that it has no effect while the required approval count is zero.

When another trusted maintainer receives repository access, update CODEOWNERS
and enable at least one independent approval with CODEOWNER review. Review this
policy and its checked-in ruleset payload in the same change.

Native-client and fixture workflows are conditional on changed paths. They are
not globally required checks because an untriggered workflow could leave an
unrelated PR waiting indefinitely. Merge Queue is not enabled: it first needs
appropriate `merge_group` workflow coverage. Commit signing is not required by
this policy.

## Tags and releases

Two separate rulesets cover **all tags**, including auxiliary tags:

- `HAPI-eVolved maintainer tag creation` allows creation only through its
  administrator-role exception (repository role ID `5`).
- `HAPI-eVolved immutable tags` blocks updates, force pushes and deletion with
  **no exceptions**. The creation exception cannot bypass this second ruleset.

Use a new version to correct a release. Do not create disposable tags as a test.
Tag creation and a versioned release still require the authorization and checks
in [RELEASING.md](https://github.com/BGGBTAC/hapi-evolved/blob/main/RELEASING.md). No tags or releases are created by this
configuration.

## Actions and security

Workflow tokens default to read-only and cannot create approving PR reviews.
All outside contributors need maintainer approval before their fork workflows
run. Approved workflows still retain the normal fork token and secret restrictions.
Use GitHub-hosted runners for public contributions.

Only GitHub-owned actions and the explicitly listed third-party actions in
`.github/actions-allowlist.json` are allowed. Workflow action references are pinned
to full commit SHAs, with the original version retained in a comment. Dependabot
can propose updates; it cannot bypass the required checks. Review a new action
before adding it to the allowlist. GitHub's managed CodeQL default setup is
separate from the checked-in workflows.
Pinning direct action references does not rewrite dependencies inside third-party
composite actions. The inherited, disabled Pages workflow still references a
composite action with a floating internal dependency; review that dependency
before enabling any upstream publishing workflow here.

Secret Scanning and Push Protection are enabled, along with Dependabot alerts
and security-update PRs. Private vulnerability reporting is enabled at the
[Security tab](https://github.com/BGGBTAC/hapi-evolved/security); follow
[SECURITY.md](https://github.com/BGGBTAC/hapi-evolved/blob/main/SECURITY.md). A scanner is not a replacement for checking
logs, screenshots, fixtures and other published material for private information.

CodeQL default setup scans GitHub Actions, JavaScript/TypeScript and Python with
the extended query suite and remote/local threat sources. These languages cover
the supported Linux/Web preview; this does not claim CodeQL coverage of the
inherited Swift or Kotlin clients. Existing findings remain visible for triage;
turning on a scanner is not a claim that every finding has been fixed.

The inherited publishing and AI-writing workflows remain guarded to the upstream
repository. No publication credentials or automatic deployment are configured by
this policy. Actions logs and artifacts retain the repository's 90-day limit;
individual workflows may choose shorter artifact retention.

Issue forms assign the existing `bug`, `enhancement` and `question` labels.
The additional labels in `.github/labels.json` support the release-note categories
and the explicit `skip-changelog` exclusion. Security reports still belong in
the private reporting channel, not in a public issue labelled `security`.

## Reproduce and inspect the settings

The files below are API request payloads, not automatically applied configuration:

- `.github/rulesets/main.json`
- `.github/rulesets/tag-creation.json`
- `.github/rulesets/tag-integrity.json`
- `.github/repository-settings.json`
- `.github/actions-allowlist.json`
- `.github/codeql-default-setup.json`
- `.github/labels.json` (additional labels, created individually if missing)

An authorized administrator can inspect the actual configuration using:

```sh
gh api repos/BGGBTAC/hapi-evolved/rulesets
gh api repos/BGGBTAC/hapi-evolved/rules/branches/main
gh api repos/BGGBTAC/hapi-evolved/actions/permissions
gh api repos/BGGBTAC/hapi-evolved/actions/permissions/selected-actions
gh api repos/BGGBTAC/hapi-evolved/actions/permissions/workflow
gh api repos/BGGBTAC/hapi-evolved/actions/permissions/fork-pr-contributor-approval
gh api repos/BGGBTAC/hapi-evolved/code-scanning/default-setup
gh api repos/BGGBTAC/hapi-evolved/automated-security-fixes
gh api repos/BGGBTAC/hapi-evolved/private-vulnerability-reporting
```

To reconcile a ruleset, find its exact name and ID first, then use `PUT` on
`repos/BGGBTAC/hapi-evolved/rulesets/ID` with `--input` and the corresponding JSON
file. Use `POST` on the rulesets collection only when that ruleset does not exist.
Read back the effective branch rules after applying changes; do not create
duplicate rulesets or disable protection to merge a failing PR.

Repository merge/security settings use `PATCH` on `repos/BGGBTAC/hapi-evolved`;
the action allowlist uses `PUT` on `actions/permissions/selected-actions`; CodeQL
default setup uses `PATCH` on `code-scanning/default-setup`. Enable Actions with
`allowed_actions: selected` before applying its allowlist. Enable SHA pinning
only after the pinned workflows have landed and their checks have succeeded.
Additional API settings for read-only tokens and outside-contributor approval
are documented above and must be verified separately.

See GitHub's documentation for [rulesets](https://docs.github.com/en/rest/repos/rules),
[Actions permissions](https://docs.github.com/en/rest/actions/permissions), and
[CodeQL default setup](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning).
