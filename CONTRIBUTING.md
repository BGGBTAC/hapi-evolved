# Contributing to HAPI-eVolved

HAPI-eVolved is an independent fork maintained in
[BGGBTAC/hapi-evolved](https://github.com/BGGBTAC/hapi-evolved). Contributions and
reports about this fork belong here. Our aim is to bring useful new features to
a self-hosted agent workspace quickly, through focused changes and reproducible
checks. Upstream contributions retain their attribution; Evolved has its own roadmap.

New here? Start with the [community guide](COMMUNITY.md) and an open
[good first issue](https://github.com/BGGBTAC/hapi-evolved/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22).
Each starter task should name its files, acceptance criteria and relevant checks.
Comment before taking a task so we can coordinate; ask in
[Q&A](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/q-a) if setup is unclear.

The 0.1.0 preview focuses on a fresh Linux
deployment, Web/PWA access, and Claude Code and Codex project runners. Inherited
upstream code does not imply support for every upstream deployment or client.

Start with the [project scope](docs/evolved/PROJECT.md),
[deployment guide](docs/evolved/DEPLOYMENT.md) and
[validation notes](docs/evolved/VALIDATION.md). Some detailed operating documents
are currently in German. See [SUPPORT.md](SUPPORT.md) for help and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Propose a focused change

Search this repository's [issues](https://github.com/BGGBTAC/hapi-evolved/issues)
before opening a new one. Describe the user problem, a concrete example, and the
expected result. Discuss substantial features or changes to security boundaries
before investing in a large implementation. Small fixes and documentation
improvements can go directly to a pull request.

Work on a branch and keep each pull request focused on one reviewable outcome.
Explain compatibility, migration or operating changes. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md) when discussing tradeoffs and reviewing work.

## Set up a development checkout

Use **Bun 1.3.14**, as pinned in [package.json](package.json), and install from the
repository root:

```sh
bun --version
bun install --frozen-lockfile
```

Use this repository's source and deployment files for Evolved. The inherited
upstream npm packages do not install this fork's complete stack. To exercise the
Evolved services, follow the [deployment guide](docs/evolved/DEPLOYMENT.md) with
separate local state and synthetic data. Docker Compose provides the sidecars;
their standalone requirements are documented under [services](services).

Do not point development or test commands at an existing installation's database,
runner home, credentials or workspace. Integration tests can start processes and
use network ports. Provider-backed tests may incur charges; use isolated test
credentials only when you intentionally choose to run them.

Keep the VitePress documentation development server on localhost. Do not pass
`--host` or expose it through a proxy or tunnel, particularly on Windows. Publish
the compiled documentation with a static server instead. The remaining tooling
advisories, their input boundaries and upgrade follow-up are recorded in
[the dependency review](docs/evolved/DEPENDENCY_REVIEW.md).

## Verify what you change

Add regression coverage for changed behavior and run checks relevant to the
affected packages. The root scripts include:

| Area | Checks from the repository root |
| --- | --- |
| CLI | `bun run typecheck:cli`, `bun run test:cli` |
| Hub | `bun run typecheck:hub`, `bun run test:hub` |
| Web | `bun run typecheck:web`, `bun run test:web`, `bun run build:web` |
| Shared protocol | `bun run test:shared` and typechecks for affected consumers |
| Relay | `bun run typecheck:relay`, `bun run test:relay` |
| Runner proxy | `bun run typecheck:proxy`, `bun run test:proxy` |
| Browser provider login | `bun run typecheck:runner-auth`, `bun run test:runner-auth` |
| Host runner control | `bun run typecheck:runner-control`, `bun run test:runner-control` |
| Deployment helpers | `bun run test:deployment` |

`bun run typecheck` runs all configured package typechecks. `bun run test` runs
the root test suites; it does not include every browser, native-client, sidecar
or live-provider check. CLI runner integration tests are separate:
`bun run test:cli:integration`. Run CLI unit and integration suites sequentially;
their test setup shares a temporary configuration path.

For Evolved browser and service acceptance, use the isolated procedure in
[LIVE_ACCEPTANCE.md](docs/evolved/LIVE_ACCEPTANCE.md). Record which checks ran and
which did not. A mocked provider test is not evidence of a successful live model
call. UI changes should include a browser check of the affected workflow.

If source fixtures change, run `bun run gen:fixtures` and include the generated
changes. For documentation-only changes, inspect the edited text, links and
`git diff --check`; a full application test run is unnecessary. For the docs
site, its build command is `bun run --cwd docs docs:build`.

## Prepare the pull request

`main` requires a pull request, resolved review conversations and the current
GitHub Actions checks `test`, `integration`, `windows-codex-mcp` and
`evolved-services`. Update your branch when it falls behind the target branch.
The sole maintainer currently works through the same checks without a required
second-person approval; CODEOWNERS does not permit self-approval. See
[repository governance](docs/evolved/GITHUB_GOVERNANCE.md) for the live rules,
security scanning and the procedure for adding maintainers.

Explain the previous behavior, the new behavior, and how you verified it. Link
related issues from this repository. When adapting an upstream patch, link the
original issue or pull request and describe Evolved-specific changes.

Preserve project authorization, revocation, runner isolation and security-profile
checks. Include focused negative tests when changing these boundaries. Keep
bootstrap tokens, recovery codes, cookies, API keys, private keys, real chat logs
and private project content out of commits, screenshots and test fixtures.

AI-assisted contributions are welcome. Identify material AI assistance in the
pull request, review the resulting code yourself, and provide reproducible
verification. The contributor remains responsible for correctness, provenance
and licensing; an assistant's claim that tests passed is not a test result.

Only contribute material you have the right to share. Preserve the
[AGPL-3.0-only license](LICENSE), existing copyright notices and third-party
attribution. Do not add unrelated generated files, dependency upgrades or
formatting changes to an otherwise focused patch.
