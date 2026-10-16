# Managed browser login: the host control service

The browser's **Abos verbinden / Connect subscriptions** action needs a local
operator service to create isolated project runners and start native Claude/Codex
login. Docker Compose alone starts the core services; it does not install this
privileged service. The source installation assistant also leaves it to the operator.

These instructions target the current source tree with the standard-library-only
initializer. The older `v0.1.0-preview.1` initializer imports workspace packages;
for that tag use its versioned deployment guide and install the frozen workspace
dependencies in protected staging before running initialization.

This guide describes the existing managed deployment layout on a dedicated Linux
host. It is not an upgrade script or a procedure for converting an assistant-created
local stack. The assistant uses separate project/image names; the managed service
expects the stock `hapi-evolved` backend network and image names below. Choose this
layout from the start if you need managed browser login. Stop at any existing-path,
account, port or stack conflict instead of replacing another installation.

## Required layout

| Item | Bundled service default |
| --- | --- |
| Reviewed source | `/opt/hapi-evolved` |
| Private state | `/var/lib/hapi-evolved` |
| Service UID/GID | `1001:1001` (both nonzero) |
| Root-owned Bun 1.3.14 binary | `/usr/local/lib/hapi-evolved/bun` |
| Control socket directory | `/run/hapi-evolved-control` |
| Hub endpoint used by the operator | `http://127.0.0.1:3006` |
| Core Compose project / backend | `hapi-evolved` / `hapi-evolved_backend` |
| Local core / runner images | `hapi-evolved:0.1.0` / `hapi-evolved-runner:0.1.0` |

Use a dedicated unprivileged service identity. Check that the numeric IDs are
appropriate for your host; do not repurpose an existing personal account. If your
service identity uses other IDs, adapt the unit and Compose settings consistently.
Host root and access to the Docker daemon are trusted administrative access.

The source, Bun binary and every ancestor directory must belong to root and must
not be writable by the Hub, runners, groups or other users. Use real canonical
paths, not symlinks or a checkout inside a developer's home. Stage and verify the
release archive and its checksums before installing the reviewed source. Install
required build tools using your host's normal administration process.
Before initialization, install a verified Bun **1.3.14** executable as the real
root-owned file `/usr/local/lib/hapi-evolved/bun` with mode `0755`.

## Initialize before protecting the outer state directory

Prepare a new, empty `/var/lib/hapi-evolved` with mode `0700`, initially owned by
the chosen service UID/GID. From the reviewed source directory, run the existing
initializer **as that unprivileged service identity**:

```sh
cd /opt/hapi-evolved
# Run this command as the chosen service user, not as root:
/usr/local/lib/hapi-evolved/bun deploy/evolved/init.ts /var/lib/hapi-evolved
```

The initializer uses the Bun/Node standard library and works from the source
archive without `.git` or installed workspace packages. It creates private
per-service directories and separate signing/control keys;
it does not print credentials. The resulting `compose.env` must contain your
service UID/GID. Before the root-ownership step below, edit `compose.env` and
set `EVOLVED_ORIGIN` to your final private HTTPS origin. The standalone initializer
does not take an `--origin` CLI option. Choose the origin before registering passkeys; `http://localhost:3006` works for a local test.

Then protect **only the outer directory**:

```sh
sudo chown root:root /var/lib/hapi-evolved
sudo chmod 0700 /var/lib/hapi-evolved
```

Do not use recursive `chown`: the service-owned Hub, workspace and other
subdirectories must keep their UID/GID and private modes. Do not rerun initialization
as the service user after root owns the outer directory. Existing protected state
needs a deliberate migration for new files, not a permission reset.

## Install the operator unit

The unit uses the root-owned Bun installed earlier, not a shell's personal Bun
installation. Review the supplied unit and adapt UID/GID or layout
before enabling it. Start the unit before Compose so the Hub mounts its existing
runtime socket directory:

```sh
sudo install -m 0644 \
  /opt/hapi-evolved/deploy/evolved/hapi-evolved-control.service \
  /etc/systemd/system/hapi-evolved-control.service
sudo systemctl daemon-reload
sudo systemctl enable --now hapi-evolved-control.service
sudo systemctl status hapi-evolved-control.service --no-pager
```

The unit manages `/run/hapi-evolved-control`. It runs as root because it creates
project containers and protected workspace bind anchors. Its local protocol accepts
signed, short-lived project operations; it is not a general-purpose shell API.
The socket is never a public HTTP service. Keep the source and runtime immutable
to less-privileged service accounts after installation.

## Build and start the managed stack

Use source, Compose files and images from the same reviewed revision. The commands
below run on the chosen installation host as its Docker administrator. Remove
conflicting exported `EVOLVED_*`, `COMPOSE_*` or remote Docker settings first;
Compose environment overrides can otherwise change the selected state or origin.

```sh
cd /opt/hapi-evolved
sudo docker compose -p hapi-evolved \
  --env-file /var/lib/hapi-evolved/compose.env \
  -f deploy/evolved/compose.yml build hub
sudo docker build -f deploy/evolved/Runner.Dockerfile \
  -t hapi-evolved-runner:0.1.0 .
sudo docker compose -p hapi-evolved \
  --env-file /var/lib/hapi-evolved/compose.env \
  -f deploy/evolved/compose.yml up -d --build
curl --fail http://localhost:3006/health
```

These are local image builds; the tag `0.1.0` is the distribution base version,
not a substitute for recording the exact release/source SHA. They are not downloads
from an official Evolved registry. Never rebuild these shared tags on a host that
already uses them for a different revision without a planned update.

The Hub binds to loopback; configure your own private HTTPS reverse proxy separately.
Keep database, Vault, Memory and Codegraph ports internal. The Hub receives only
the read-only control socket directory, not the Docker socket.

## First account and provider connection

Read `/var/lib/hapi-evolved/hub/bootstrap.token` privately on your own terminal
and enter it at your configured origin's `/evolved` page. Do not paste it into
chat, logs or a public issue. Register a passkey and save recovery codes offline.

Create a team and project, then choose **Abos verbinden**, the project and the
provider. Follow the provider's official login page. Codex uses a device code;
Claude uses the one-time returned code. The native CLI status confirms login;
this does not prove quota or model entitlement. Provider credentials persist in
the private project runner home. HAPI access, GitHub grants and provider login
remain separate permissions.

## If something is not ready

| Symptom | Check |
| --- | --- |
| Hub health fails | Core Compose status and the selected loopback port; do not start a second stack on it. |
| Control service refuses startup | Canonical root-owned source/runtime/ancestors, private control-key metadata, and matching nonzero service IDs. Do not print the key. |
| Browser reports no managed service | Unit status, socket directory mount, matching state and the stock backend/image layout. |
| Login cancelled or expired | Restart the browser login flow; old provider codes are not reusable. |
| Project directory identity changed | Stop and follow the targeted [workspace recovery procedure](DEPLOYMENT.md#einen-außerhalb-von-hapi-ersetzten-projektordner-prüfen); do not bypass its checks. |

For upgrades, stop writers and make a consistent encrypted backup of data and
keys, then rebuild and coordinate the core, operator and affected runners. A full
backup-restore acceptance is still a separate preview limitation. See the
[operator guide](DEPLOYMENT.md#betrieb-sicherung-und-aktualisierung) for details.
