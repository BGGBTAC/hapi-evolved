# HAPI-eVolved

<img src="assets/brand/evolved/hapi-evolved-logo-v1.png" alt="HAPI-eVolved: a connected graph-e" width="640">

**A self-hosted workspace for coding agents, with teams, protected credentials,
persistent memory and code intelligence.**

HAPI-eVolved builds on [HAPI](https://github.com/tiann/hapi). This is an independent
project maintained in [BGGBTAC/hapi-evolved](https://github.com/BGGBTAC/hapi-evolved).
It preserves the upstream history, AGPL license and contributor attribution.

**Status: 0.1.0 preview in preparation.** Use a separate installation and back up
its state. A source version is not a published release or an external security
audit. [Validation](docs/evolved/VALIDATION.md) records what was tested and the
remaining limits; [release preparation](RELEASING.md) tracks publication gates.

## What it does

| Area | Capability |
| --- | --- |
| Agents | Browser subscription login, automatically managed project runners and reusable specialist definitions |
| Models | Native Claude/Codex catalogs with refresh, explicit source limits and manual model IDs; no built-in replacement list |
| Workspace | Responsive desktop sidebar/mobile navigation, project dashboard and accessible light/dark/OLED design |
| Capacity | Native Claude/Codex subscription reports with remaining quota, reset times and explicit unknown/stale states |
| Teams | Passkeys, recovery codes, team/project roles, revocable runner access |
| Projects | A dedicated folder is created automatically; administrators can optionally attach an existing allowed folder |
| GitHub | Project repository connections and brokered Git access; credentials remain in the local vault |
| Credentials | An encrypted local vault and constrained resource actions, administered in the browser |
| Memory | Persistent local knowledge and search; optional Graphiti/Neo4j knowledge graph with explicit provider configuration and budgets |
| Codegraph | Local symbol, caller, impact and affected-test exploration with automatic indexing |
| Workflow | Durable attachments, history search, saved prompts, project-scoped automation and private previews |
| Extensions | Version-pinned GitHub plugins for agents, skills and validated color profiles |

The vault is an integration credential store, not a browser password autofill
product. Codegraph and the knowledge graph are separate. Cloud memory starts
paused and requires operator configuration and an explicit project budget.

## Start here

The supported preview deployment is **Linux + Docker Compose**, built from this
repository. Use **Bun 1.3.14** for initialization and source development. Plan for
about **12 GiB RAM** for the stack and one runner. Choose the final HTTPS hostname
before registering a passkey; `http://localhost:3006` is suitable for a local test.

```sh
git clone https://github.com/BGGBTAC/hapi-evolved.git
cd hapi-evolved
bun install --frozen-lockfile
bun deploy/evolved/init.ts "$HOME/.local/share/hapi-evolved"
```

Use a reviewed commit or published preview tag containing Evolved. While the
implementation pull requests are still open, the default branch may not contain
these features. Follow the [English quick start](docs/evolved/QUICKSTART.md) to
set the origin, start the services and register your first passkey.

Upstream `@twsxtd/hapi` npm packages and upstream hosted services do **not** install
this Evolved stack. Repository and package publication are separate: workspace
packages intentionally retain `private: true`.

## Documentation

| Document | Purpose |
| --- | --- |
| [Quick start](docs/evolved/QUICKSTART.md) | First installation, initialization and account setup — English |
| [Operator guide](docs/evolved/DEPLOYMENT.md) | Services, isolated runners, backup/restore and upgrades — German |
| [User guide](docs/evolved/USER_GUIDE.md) | Projects, teams, vault, memory and Codegraph — German |
| [GitHub connection](docs/evolved/GITHUB.md) | Repository grants, native Git and credential boundaries |
| [Responsive interface](docs/evolved/DESIGN.md) | Desktop/PWA navigation, accessibility and browser checks |
| [Browser provider login](docs/evolved/PROVIDER_LOGIN.md) | Native Claude/Codex account connection and persistent runner credentials |
| [Extensions](docs/evolved/EXTENSIONS.md) | Global specialists, GitHub plugins and manifest format |
| [Subscription capacity](docs/evolved/CAPACITY.md) | Native data sources, freshness and account-wide limits |
| [Project architecture](docs/evolved/PROJECT.md) | Scope and trust boundaries — German |
| [Privacy and data](docs/evolved/DATA_HANDLING.md) | Storage, providers and retention |
| [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) | Changes and remaining work |
| [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) | Development and help |
| [Security policy](SECURITY.md) | Private vulnerability reporting |
| [Releasing](RELEASING.md) | Source artifacts, checks and publication procedure |

Detailed evidence is in the dated [backlog review](docs/evolved/BACKLOG_REVIEW.md).
It is a snapshot, not a claim that every upstream issue has been fixed. Native
apps, other inherited agent integrations and the old marketing website are in
the tree but outside the Evolved preview's validated Linux/web/Claude/Codex scope.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build:web
```

Codegraph additionally uses Node 24; memory uses Python 3.12. Their pinned
dependencies and focused checks are documented in
[Codegraph](services/codegraph/README.md) and [memory](services/memory/README.md).
See [CONTRIBUTING.md](CONTRIBUTING.md) for Evolved development configuration.
Do not point tests at a live installation.

## License and credits

The software is licensed under **AGPL-3.0-only**, with retained third-party
notices. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [cli/NOTICE](cli/NOTICE).
The upstream baseline is
[`tiann/hapi@5847b034`](https://github.com/tiann/hapi/tree/5847b034e5cb84f2617766945c994b7905c5c03e).
Thanks to HAPI's contributors and the [Happy](https://github.com/slopus/happy)
and happy-cli contributors acknowledged in the inherited notices.

For a network deployment of a modified version, offer its users the corresponding
source, following [section 13 of the license](LICENSE). Keep notices and build
instructions with redistributed source. Provider CLIs, models and container
dependencies retain their own licenses and service terms.
