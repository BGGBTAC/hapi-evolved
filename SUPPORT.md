# Getting help with HAPI-eVolved

HAPI-eVolved is an independent fork. Use
[community Q&A](https://github.com/BGGBTAC/hapi-evolved/discussions/categories/q-a)
for setup and usage questions, and
[this repository's issues](https://github.com/BGGBTAC/hapi-evolved/issues) for
reproducible bugs; upstream HAPI's support channels do not maintain this fork.
Support is community-based, with no guaranteed response time or service level.

The **0.1.0 preview** targets a fresh Linux deployment, the Web/PWA client and
Claude Code/Codex project runners. Other clients and agent adapters retained in
the source tree are not a claim of equivalent preview support. There is no
supported in-place import of an existing HAPI installation.

## Start with the documentation

- [Quick start and first account — English](docs/evolved/QUICKSTART.md)
- [Installation, operation and recovery — German](docs/evolved/DEPLOYMENT.md)
- [Managed browser login: host control — English](docs/evolved/HOST_CONTROL.md)
- [Pilot workflow and voluntary feedback](docs/evolved/PILOT.md)
- [User guide](docs/evolved/USER_GUIDE.md)
- [Project scope and architecture](docs/evolved/PROJECT.md)
- [Validation evidence and known limits](docs/evolved/VALIDATION.md)
- [Contributing a fix](CONTRIBUTING.md)

Some detailed guides are currently in German. Documentation clarification and
translation contributions are welcome.

## Choose the right report

Search existing issues first, then use the
[issue chooser](https://github.com/BGGBTAC/hapi-evolved/issues/new/choose):

- **Bug report:** a reproducible mismatch between expected and actual behavior.
- **Feature request:** a workflow problem and the outcome that would improve it.
- **Support request:** a setup, usage or documentation question.

For a suspected vulnerability, follow [SECURITY.md](SECURITY.md) before posting.
For a conduct concern, follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). A public
request to arrange a private channel must contain no incident or vulnerability
details.

## Share enough information safely

Include the Evolved version and source commit, how it was installed, operating
system/architecture, browser version and relevant agent/service versions. A
legacy CLI package version alone may not identify the Evolved checkout. Describe
what you tried, the expected result and the actual result; a small synthetic
reproduction is more useful than a full private workspace.

Provide only the relevant, manually reviewed log excerpt. Replace secrets and
private identifiers with consistent placeholders. Never attach environment
files, bootstrap tokens, recovery codes, credentials, cookies, private keys,
database backups or unredacted conversations. Screenshots and URLs can also
contain private content and access tokens.

Maintainers do not need access to your live system or credentials to triage a
report. If a secret was accidentally published, revoke or rotate it promptly;
editing a comment alone does not invalidate the exposed credential.
