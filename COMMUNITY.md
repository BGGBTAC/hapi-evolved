# Build HAPI-eVolved with us

HAPI-eVolved is an independent, self-hosted fork of HAPI for Claude Code and Codex
workflows. The source preview focuses on Linux, Docker Compose and desktop/mobile
Web/PWA. We welcome people who want to try a real project, improve an awkward
workflow or contribute a focused change.

## Try a project

Start with the [pilot guide](docs/evolved/PILOT.md), the
[installation guide](docs/evolved/QUICKSTART.md) and the
[published releases](https://github.com/BGGBTAC/hapi-evolved/releases).
Plan for about 12 GiB RAM for the stack and one runner. Browser-managed agents
also need the [operator-installed host control service](docs/evolved/HOST_CONTROL.md).
There are no official prebuilt images, and this is not an upstream-HAPI migration.

The pilot workflow is deliberately small: connect a repository, open a session in
its checkout, inspect a change with Codegraph, and propose a useful piece of
knowledge. Real provider sessions use your own account and its terms, limits and
possible costs. The recorded demo uses synthetic data and does not make model calls.

Share your experience in
[Show and tell](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/show-and-tell).
You can also report an unsuccessful installation; that is useful feedback.
No email list, screen sharing, credentials or access to your machine is required.

## Make your first contribution

Browse [good first issues](https://github.com/BGGBTAC/hapi-evolved/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
or [help wanted](https://github.com/BGGBTAC/hapi-evolved/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22).
Starter issues describe the problem, source files, acceptance criteria and a
relevant check. Comment on the issue if you would like to take it, so we can
coordinate work. An unassigned issue is not a promise that nobody is working on it.

The first contribution set is deliberately bounded; check each issue's current
status before starting:

| Task | Starting level |
| --- | --- |
| [English subscription-capacity guide #35](https://github.com/BGGBTAC/hapi-evolved/issues/35) | Documentation; good first issue |
| [Example-plugin publishing guide #36](https://github.com/BGGBTAC/hapi-evolved/issues/36) | Documentation; good first issue |
| [Knowledge-title length hint #37](https://github.com/BGGBTAC/hapi-evolved/issues/37) | React/accessibility; good first issue |
| [Non-submitting confirmation buttons #38](https://github.com/BGGBTAC/hapi-evolved/issues/38) | React regression fix; good first issue |
| [Offline plugin-manifest validator #39](https://github.com/BGGBTAC/hapi-evolved/issues/39) | Bounded filesystem/tooling work |
| [Project-switch model-selection tests #40](https://github.com/BGGBTAC/hapi-evolved/issues/40) | Asynchronous React tests |

Documentation, accessibility improvements, reproducible bug reports and
declarative plugin examples are welcome alongside code. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, branch/PR workflow and AI
assistance disclosure. No CLA is required; preserve the existing AGPL license
and attribution. Discuss larger changes before implementing them.

## Find the right conversation

| Need | Place |
| --- | --- |
| Installation or usage question | [Q&A](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/q-a) |
| Pilot experience or useful workflow | [Show and tell](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/show-and-tell) |
| An idea to discuss | [Ideas](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/ideas) |
| Reproducible bug or agreed implementation task | [Issues](https://github.com/BGGBTAC/hapi-evolved/issues/new/choose) |
| Releases and project updates | [Announcements](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/announcements) |
| Suspected vulnerability | [Private security reporting](SECURITY.md) |

Keep public reports small and redacted. Never upload environment files, provider
codes, tokens, private keys, database backups or private conversations. See
[SUPPORT.md](SUPPORT.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## How we maintain the community

Maintainers triage new reports, help clarify the smallest useful change, and
review contributions through the same required checks. We aim to respond promptly,
but there is no guaranteed response time. If an issue is larger than advertised,
we will split it or remove the beginner label. Contributors are credited in the
Git history and release notes; naming someone in an announcement is optional.

Our first-month targets are five independently reported installations, three
people reporting that they returned to use the project, and two external
contributions. These are targets, not results or a growth forecast. We count only
voluntary reports and public contributions from people outside the maintainer's
accounts and test fixtures. Downloads, stars and automated runs do not prove use.
We will publish aggregate progress and implemented feedback in Announcements;
there is no new application telemetry or recurring agent job behind this process.
