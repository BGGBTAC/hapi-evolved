# Preparing and publishing HAPI-eVolved

The first distribution is a **source preview**, version 0.1.0. No npm package,
official container registry, hosted service or app-store release is implied.
The root and CLI packages remain private to prevent accidental npm publication.
This document does not change the GitHub repository's visibility.

## Release inputs

Use one reviewed commit containing implementation, deployment fixes, branding,
documentation and the new project/GitHub flows. Merge the dependency chain of
open implementation PRs in order before choosing that commit. Do not create a
release from an unchanged upstream default branch or an unreviewed branch tip.
Keep the version in `package.json` and Compose image tags consistent. The CLI's
inherited package version is not the Evolved distribution version.

Required files include the README, LICENSE, NOTICE, CHANGELOG, operator/user
guides, CONTRIBUTING, SECURITY, SUPPORT, CODE_OF_CONDUCT and issue/PR templates.
Preserve inherited license notices. Review dependency and native-tool license
conditions before adding binary or container distributions.

## Check the release commit

```sh
bun install --frozen-lockfile
bun scripts/publication/check-workflows.ts
bun test scripts/publication/check-workflows.test.ts
bun run typecheck
bun run test
bun run build:web
bun run --cwd docs docs:build
```

Run the affected Codegraph/Memory service tests, runner tests and Evolved browser
acceptance as documented in their READMEs and `docs/evolved/LIVE_ACCEPTANCE.md`.
Use synthetic credentials and separate state. Record actual results against the
chosen SHA. Historical validation counts do not establish a new commit's status.
A queued, skipped or account-blocked GitHub job is not a passing CI result.

Inspect the new-project flow, independent folders, manual selection restrictions,
GitHub connection/revocation and native Git clone/fetch/push. Provider-backed
quality and a full restore exercise are separate from offline tests; retain any
untested limitation in the release notes.

## Produce a reviewable source artifact

The manual **HAPI-eVolved preview source bundle** workflow in
`.github/workflows/evolved-preview.yml` validates workflow policy, the frozen
install, typechecking and the web build. It uploads an Actions artifact containing
the source archive, `manifest.json` and `SHA256SUMS`. The manifest identifies the
exact commit and source version. It is not a full test report or a binary SBOM.

Choose the intended branch/commit when dispatching the workflow. GitHub only
offers manual dispatch after the workflow exists on the default branch. It has
read-only repository permissions and does not create tags, releases, packages,
images or deployments. The same packager can be run locally after checks:

```sh
SOURCE_BUNDLE_DIR=/absolute/path/outside/repository/preview \
  bun scripts/publication/bundle-source.ts
```

The packager archives the committed tree, not uncommitted working files. Review
the archive's contents and checksum before distributing it. Do not treat an
archive as a scan of Git history, Actions artifacts or issue attachments.

## Before changing visibility

- Review **all published refs and their history**, not only the current files.
  A full-history scan should produce a redacted report kept outside the repository.
  Classify test fixtures separately; a secret scanner is not a privacy review.
- Review historical operator paths, hostnames, identities, screenshots, issue
  exports, PR discussions, Actions logs and uploaded artifacts. Removing data in
  a new commit does not remove it from history. Choose and review a remediation
  method before making private development history public; do not rewrite shared
  history as an incidental release step.
- If a real credential is found, revoke/rotate it and address retained copies
  before publication. Do not include a raw scanner report in an issue or release.
- Verify the default branch, maintainer access, branch rules, Actions permissions
  and the source of any release credentials. Inherited publishing/AI-writing jobs
  are gated to `tiann/hapi`; do not remove that gate to publish Evolved.
- Enable and test GitHub private vulnerability reporting when the repository is
  public. Until available, follow SECURITY.md's contact-only fallback. This file
  cannot enable that GitHub setting.

GitHub states that repository code and Actions history/logs become public when
visibility changes. See [GitHub visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
Private reports require the repository feature to be enabled; see
[GitHub reporting configuration](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Publish only after the gates pass

An authorized maintainer changes visibility, creates a version tag on the
reviewed commit, and creates a GitHub **pre-release** with the source artifact,
checksums and truthful validation notes. Do not reuse upstream package names or
publisher credentials. Include installation steps, supported platforms, known
limits, license and the source SHA. `.github/release.yml` helps categorize notes;
it does not publish anything.

For network deployments of modified versions, give users an accessible source
offer for the version they actually run, including relevant build instructions.
The source repository must be accessible to those users. See the retained
[AGPL license, section 13](LICENSE) and the
[GNU AGPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#AGPLv3CorrespondingSource).

After publication, verify anonymous access to source/downloads and checksum
verification, confirm the private report channel, and test installation from the
published artifact on a clean machine. Update CHANGELOG with the actual release
date and tag only once those exist.
