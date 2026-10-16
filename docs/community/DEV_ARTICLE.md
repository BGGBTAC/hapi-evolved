---
title: "HAPI-eVolved: connecting coding agents, GitHub and code intelligence on your own host"
published: false
tags: opensource, selfhosted, ai, devtools
---

> Unpublished project-introduction draft, suitable for the project's own GitHub
> Discussions. Do not automatically publish it to DEV: the current AI-content
> policy excludes promoting one's own program with generated articles. See
> [the publication notes](OUTREACH.md). The front matter remains unpublished.

HAPI-eVolved is an independent, AGPL-licensed fork of
[HAPI](https://github.com/tiann/hapi). It brings Claude Code and Codex into a
self-hosted browser workspace, with project repositories, local code intelligence
and persistent knowledge. It is a Linux source preview built with Docker Compose;
plan for approximately 12 GiB RAM for the stack and one runner. There are no official
prebuilt images.

The development goal is practical: make it easier to move from a project idea to
an agent working in the correct repository, then inspect what changed and keep the
useful context. HAPI provides the foundation; this fork follows its own roadmap
and preserves upstream history and attribution.

![HAPI-eVolved desktop project overview; scripted synthetic demo](https://raw.githubusercontent.com/BGGBTAC/hapi-evolved/main/assets/community/desktop.png)

## A workflow worth testing

Create a project and it receives its own folder. Connect a GitHub repository with
explicit access, clone it from project management, and select its checkout when
starting a session. Claude and Codex login is available through the browser once
the operator has installed the local control service. Provider credentials persist
in the project's private runner home.

When the agent has made a change, the repository view shows local differences
without requiring a separate running agent session. Codegraph adds source, symbol
and impact context. A review specialist can be started explicitly in that checkout.
These are review aids; they do not prove that a patch is correct or secure.

Useful findings can become knowledge proposals linked to a stored conversation or
source file. A human verifies them before treating them as established project
knowledge. Local memory works independently of optional, budgeted cloud extraction.

![Repository and Codegraph review; synthetic example](https://raw.githubusercontent.com/BGGBTAC/hapi-evolved/main/assets/community/codegraph.png)

The [short walkthrough](https://github.com/BGGBTAC/hapi-evolved/blob/main/assets/community/walkthrough.webm)
shows the real UI with synthetic data. GitHub and provider interactions are
controlled fixtures, and the recording makes no model calls. This is not a live
provider benchmark. The UI currently includes German labels; English setup and
pilot guides explain the important steps.

## Some deliberate boundaries

Repository grants, project execution profiles and provider login are separate
permissions. Connecting GitHub does not automatically authorize every repository
or give an agent unrestricted write access. Connecting a subscription does not
create a cloud-memory budget.

Plugins currently contribute declarative specialist instructions, skills and color
profiles from reviewed GitHub revisions. They do not install arbitrary Hub code.
Their instructions still need review before being used in an agent's task.

Model lists come from the native provider client and can be cached; the provider
decides actual account entitlement when a model is used. A usage display is a
report of native telemetry, not a promise of available quota.

## Try a separate installation

Start with the [published source release](https://github.com/BGGBTAC/hapi-evolved/releases)
and verify the attached checksums. Choose the installation layout before
initializing state: the
[quick start](https://github.com/BGGBTAC/hapi-evolved/blob/main/docs/evolved/QUICKSTART.md)
explains core-only exploration, while the
[English host-control guide](https://github.com/BGGBTAC/hapi-evolved/blob/main/docs/evolved/HOST_CONTROL.md)
defines the protected managed layout required for browser provider login. Use that
managed layout from the start for the complete pilot; the isolated core assistant
does not convert an existing installation into it.

Use a disposable repository initially. This preview does not migrate an existing
upstream HAPI installation, and native-app parity is not part of the supported
path. Provider-backed memory quality and a full backup-restore exercise remain
separate validation work. Read the selected release's known limitations before
installing it. Real provider sessions use your own account and may consume quota
or incur charges.

## Help shape the next steps

We are inviting a small group of self-hosting users to try the
[pilot workflow](https://github.com/BGGBTAC/hapi-evolved/blob/main/docs/evolved/PILOT.md)
and report where it becomes confusing. Failed installations are useful reports
too. No credentials, private repository access or email signup are required to
participate in the community feedback process.

For contributors, the repository has
[starter issues](https://github.com/BGGBTAC/hapi-evolved/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
and [contribution instructions](https://github.com/BGGBTAC/hapi-evolved/blob/main/CONTRIBUTING.md).
Questions and ideas belong in
[GitHub Discussions](https://github.com/BGGBTAC/hapi-evolved/discussions).

AI coding assistants contributed substantially to the code, tests and documentation.
This article draft was written and checked by AI agents at the maintainer's request.
Their output is subject to review and reproducible checks;
it is not independent proof that a feature works. HAPI-eVolved is not endorsed by
HAPI, Anthropic or OpenAI. The code retains AGPL-3.0-only and upstream notices;
provider tools and dependencies have their own licenses and terms.
