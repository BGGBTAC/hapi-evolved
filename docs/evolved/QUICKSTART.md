# HAPI-eVolved quick start

This starts a separate Linux preview installation. It does not migrate accounts,
sessions or credentials from HAPI. Use source and Compose files from the same
reviewed Evolved commit or published preview tag. Until implementation PRs are
merged, the default branch alone may still contain upstream HAPI.

## Requirements

- Linux, Docker Engine and the Docker Compose plugin.
- Git and **Bun 1.3.14**.
- About **12 GiB RAM** for the stack and one runner, plus disk space for images,
  repositories, history and backups.
- A passkey-capable browser. Remote access uses your final HTTPS hostname;
  `http://localhost:3006` is available for a local test.

Host administrator and Docker access remain trusted.

## Initialize private state

```sh
git clone https://github.com/BGGBTAC/hapi-evolved.git
cd hapi-evolved
bun install --frozen-lockfile
bun deploy/evolved/init.ts "$HOME/.local/share/hapi-evolved"
```

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

Use the [GitHub guide](GITHUB.md) to connect repositories, and the
[runner instructions](DEPLOYMENT.md#einen-isolierten-projekt-runner-starten) to start
an isolated agent. For the browser flow, install the [local runner control service](DEPLOYMENT.md#browser-anmeldung-und-verwaltete-projektdienste), then open **Abos verbinden**. The browser provisions the project runner and starts native provider login. Connecting GitHub
does not connect a model provider or authorize cloud spending.

## Memory, backups and updates

Local knowledge/search need no cloud provider. Extraction and hybrid search
require a provider, current prices and an explicit project budget.
See the [memory configuration](https://github.com/BGGBTAC/hapi-evolved/blob/main/services/memory/README.md).

Back up state and private keys together from a stopped, consistent stack.
Without its master key the vault is unrecoverable. Follow the
[backup and restore procedure](DEPLOYMENT.md#betrieb-sicherung-und-aktualisierung)
before upgrading. Project removal does not delete its source files from disk.
