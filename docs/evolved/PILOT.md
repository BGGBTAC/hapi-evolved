# Try HAPI-eVolved and tell us where it gets in your way

We are looking for a small group of Linux/self-hosting users who already work
with Claude Code or Codex. Try one disposable project first. This is a source
preview, not a production service or a migration path from an existing HAPI instance.

## Before starting

- Use a separate Linux environment with Docker Engine, Docker Compose, Bun 1.3.14
  and about 12 GiB RAM for the stack and one runner.
- Select a published revision from [Releases](https://github.com/BGGBTAC/hapi-evolved/releases)
  and read its installation instructions and known limitations. Verify its source
  archive with the attached `SHA256SUMS`; keep source, images and Compose files together.
- Follow the [quick start](QUICKSTART.md). The local core-stack assistant does not
  install the privileged host service required for managed browser provider login.
  Use the separate [English host-control guide](HOST_CONTROL.md) for that setup.
- Use a synthetic or disposable repository. Review its execution profile and
  repository grants before starting an agent. A provider session can consume
  subscription quota or incur charges; the maintainer does not supply an account.

The interface currently contains German labels. The steps below include their
visible names. An English installation guide does not imply a fully translated UI.

## One useful workflow

1. Create a project. Confirm that it has its own managed folder. For this
   disposable repository workflow, have a project administrator select
   **Arbeitsbereich / Workspace** before provider login or cloning. The initial
   restricted profile blocks clone and edits. A later profile change revokes
   existing runner access, so choose the intended scope first.
2. Open **Abos verbinden** and connect Claude or Codex after the operator has
   installed the control service. Verify the native login status.
3. Connect a GitHub repository you are entitled to use. Grant only the access
   needed for this test, then clone it from the project's repository management.
4. Select that checkout when creating a session. Ask the agent to identify a
   small, concrete improvement within the explicitly selected workspace profile.
   A read-only repository grant permits clone/fetch; pushing needs a separate
   GitHub write grant and the other documented push prerequisites.
5. Inspect the local diff and Codegraph impact hints. Check the affected files
   yourself. Review specialists and graph results do not replace human review.
6. Propose one useful note from a stored message or source file. Confirm its
   provenance before marking it verified. Local knowledge does not require
   activating budgeted cloud extraction.
7. Reopen the project on a phone or another day. Note whether the next action is
   easy to find and whether the saved project context is useful.

Stop whenever you encounter an unclear step. A short account of that point is
more helpful than completing the workflow with undocumented workarounds.

## Send a voluntary pilot report

Open [Show and tell](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/show-and-tell)
and use the pilot-report form. Include only what you are comfortable publishing:

- Release/tag, Linux distribution/architecture, approximate RAM and browser.
- Which milestone you reached: installation, project, repository, session,
  change review, knowledge proposal, or return visit.
- Rough setup time, the first confusing step and any help needed.
- Expected and observed behavior, plus one improvement you would value.
- Whether you returned to use it, if you have had time to try again.

Do not attach raw logs, configuration, passkey data, recovery/provider codes,
tokens, private repository URLs or conversations. Maintainers never need your
credentials. Report suspected vulnerabilities through [SECURITY.md](https://github.com/BGGBTAC/hapi-evolved/blob/main/SECURITY.md).

A bug belongs in an [issue](https://github.com/BGGBTAC/hapi-evolved/issues/new/choose),
and a setup question belongs in [Q&A](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/q-a).
Participation is voluntary; there are no incentives tied to stars, votes or positive reviews.
