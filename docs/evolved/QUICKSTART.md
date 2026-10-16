# HAPI-eVolved quick start

An independent fork of [tiann/hapi](https://github.com/tiann/hapi), developed on its
own roadmap for faster improvements to self-hosted coding-agent workflows.

This starts a Linux preview on a **fresh, dedicated host**. The manual commands
below use shared `hapi-evolved` Compose/image names: do not run them on a host
that already has an Evolved stack or matching image tags. They do not migrate accounts,
sessions or credentials from HAPI. Use source and Compose files from the same
reviewed Evolved revision. These commands target `v0.1.0-preview.2`. Verify that
this tag appears as a published [source release](https://github.com/BGGBTAC/hapi-evolved/releases)
with an archive, `manifest.json`, `SHA256SUMS` and validation notes before using it.
The archive's exact filename and source SHA are recorded in its manifest.
The `main` branch contains ongoing development and is not itself a release.

## Requirements

- Linux, Docker Engine and the Docker Compose plugin.
- Git and **Bun 1.3.14**.
- About **12 GiB RAM** for the stack and one runner, plus disk space for images,
  repositories, history and backups.
- A passkey-capable browser. Remote access uses your final HTTPS hostname;
  `http://localhost:3006` is available for a local test.

Host administrator and Docker access remain trusted.

## Choose a setup path

For browser-managed Claude/Codex login, follow the separate
[English host-control guide](HOST_CONTROL.md) on a dedicated host. It explains
the required protected source/state layout and initialization order. Core-only
Compose setup does not install that privileged service. That guide targets the
initializer shipped with this source tree; `v0.1.0-preview.1` additionally needs
its frozen workspace dependencies installed before initialization. Use its
[versioned deployment guide](https://github.com/BGGBTAC/hapi-evolved/blob/v0.1.0-preview.1/docs/evolved/DEPLOYMENT.md)
when remaining on that first preview.

Source revisions containing `deploy/evolved/install.ts` also provide a
fresh local core-stack assistant, suitable for exploring the interface before
setting up managed runners. See [the assistant guide](INSTALL_ASSISTANT.md).
It uses separate images and network names and cannot be converted implicitly
into the stock host-control layout. Choose the managed path from the start when
you want browser-managed agents.

## Initialize private state

```sh
git clone --branch v0.1.0-preview.2 --depth 1 https://github.com/BGGBTAC/hapi-evolved.git
cd hapi-evolved
bun install --frozen-lockfile
bun deploy/evolved/init.ts "$HOME/.local/share/hapi-evolved"
```

Keep the source, Compose definitions and images from the same revision. Do not
install an upstream npm/Homebrew package into this checkout; it is a different build.

The initializer keeps private files outside the repository and preserves keys on
repeated runs. Edit `~/.local/share/hapi-evolved/compose.env`: set `EVOLVED_ORIGIN`
to the exact browser origin, for example `https://agents.example.com`. Preserve
the generated state directory and UID/GID. Do not put tokens in this file.
Register passkeys only after choosing the final hostname; they are domain-bound.

## Start services

Build the hub/vault image first; the vault uses it without its own build definition.

```sh
docker compose --env-file "$HOME/.local/share/hapi-evolved/compose.env" \
  -f deploy/evolved/compose.yml build hub
docker compose --env-file "$HOME/.local/share/hapi-evolved/compose.env" \
  -f deploy/evolved/compose.yml up -d --build
docker compose --env-file "$HOME/.local/share/hapi-evolved/compose.env" \
  -f deploy/evolved/compose.yml ps
curl --fail http://localhost:3006/health
```

The hub binds to loopback. Remote access needs your private HTTPS reverse proxy.
Database, vault, memory and Codegraph ports remain internal. These commands do
not configure DNS or public hosting.

## Create an account and project

Read the setup code in your own terminal on the host:

```sh
cat "$HOME/.local/share/hapi-evolved/hub/bootstrap.token"
```

Open the configured origin at `/evolved`, enter the code, register a passkey and
save recovery codes offline. Never paste these codes into issues, chat or Git.
Setup expires after 24 hours; an enrollment started in the browser lasts ten
minutes. See [unfinished setup recovery](DEPLOYMENT.md).

Create a team, then enter a project name. A separate managed directory is created
automatically. The optional manual control attaches an existing allowed server
directory and requires installation-admin rights plus a recent passkey.
A local browser folder picker would not select a directory on the server.

## Connect a provider and start work

For browser-managed runners, the operator must first install the
[local control service](HOST_CONTROL.md).
The Compose-only commands above do not install that privileged host service. Its
bundled unit expects root-owned `/opt/hapi-evolved`, state under `/var/lib/hapi-evolved`
and UID/GID1001; adapt the unit and protected paths for another layout. Do not point
it at a user-writable source checkout. Follow the operator guide's initialization
order; never recursively change existing data ownership to root.

Then open **Abos verbinden**, select the project and connect Claude or Codex.
The browser provisions the managed runner and opens the official provider sign-in
flow. Finish the device-code flow (Codex) or submit the one-time return code
(Claude). HAPI verifies native login status; it does not request the provider password.
See [provider login](PROVIDER_LOGIN.md) for cancellation, logout and model selection.

Create a session with the connected provider. It starts automatically in the
selected project's saved folder; there is no path to find or type. Previously used
folders and URL parameters cannot override that project folder.
New projects are restricted by default;
a project administrator must explicitly choose an appropriate profile for file changes.
A native catalog can be cached and does not guarantee model entitlement.

Use the [GitHub guide](GITHUB.md) to connect repositories separately. Alternatively,
operators can configure a [manual isolated runner](DEPLOYMENT.md#einen-isolierten-projekt-runner-starten).
Connecting GitHub or a coding subscription does not authorize cloud memory spending.

## Memory, backups and updates

Local knowledge/search need no cloud provider. Extraction and hybrid search
require a provider, current prices and an explicit project budget.
See the [memory configuration](https://github.com/BGGBTAC/hapi-evolved/blob/v0.1.0-preview.2/services/memory/README.md).

Back up state and private keys together from a stopped, consistent stack.
Without its master key the vault is unrecoverable. Follow the
[backup and restore procedure](DEPLOYMENT.md#betrieb-sicherung-und-aktualisierung)
before upgrading. Project removal does not delete its source files from disk.
