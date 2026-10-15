# Why HAPI-eVolved?

HAPI-eVolved is an independent fork of [tiann/hapi](https://github.com/tiann/hapi),
built to develop new coding-agent workflows faster and with more flexibility.
Upstream HAPI provides the local-first hub, agent wrappers, session transport and
remote control foundation. This fork keeps that work and its attribution, while
making its own product and release decisions.

## A workspace around the coding session

A remote chat is the starting point. Evolved adds the structure needed to keep
working across projects, people and sessions:

| Need | Evolved approach |
| --- | --- |
| Separate projects and teammates | Passkey accounts, team/project roles and dedicated project folders |
| Connect coding subscriptions | Browser-initiated native Claude/Codex sign-in with a managed project runner |
| Give an agent repository access | Project repository grants and a GitHub broker; no PAT in the agent workspace |
| Keep useful knowledge | Persistent source-backed proposals, human verification and optional graph processing |
| Understand the codebase | A separate local Codegraph index and explorer |
| Repeat a useful way of working | Specialist definitions and version-pinned declarative plugins |
| Control unattended work | Explicit profiles, revocable runner access and current authorization checks |
| Work from a phone | Responsive web/PWA with the same project context and approval flow |

These are implemented workflows, not a claim that every upstream issue is solved.
The [backlog review](../evolved/BACKLOG_REVIEW.md) separates completed work,
partial coverage and deferred ideas. Dated validation records describe what was
actually tested; they are not a blanket certification of later releases.

## Ownership comes with operating work

The preview runs on your Linux host. You operate HTTPS, updates, backups and
provider credentials. Hub, Vault, memory services and project runners have distinct
roles; this is a multi-service deployment rather than upstream's one-command
single-binary setup. The [quick start](../evolved/QUICKSTART.md) explains that choice.

Self-hosting does not mean all processing stays offline. Coding agents contact their
providers, GitHub operations contact GitHub, and optional memory extraction sends
authorized content to its configured model service. See [data handling](../evolved/DATA_HANDLING.md).

## Clear preview boundaries

The primary path is Linux with Claude Code or Codex and a browser/PWA. Native
mobile clients and additional agent adapters remain in the source tree for
continued development; they are not promises of current Evolved compatibility.
There is no automatic import of an old HAPI installation and no required account
on an Evolved-hosted service.

The names `hapi`, `HAPI_*` and some historical internal identifiers remain in the
code and wire format. The product is **HAPI-eVolved**, not an official upstream
release. The fork preserves upstream history, copyright and AGPL-3.0-only terms.

[Install the preview](../evolved/QUICKSTART.md) ·
[Understand the architecture](./how-it-works.md) ·
[Project scope](../evolved/PROJECT.md)
