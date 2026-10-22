# Fresh local core-stack assistant

This assistant checks prerequisites and initializes/builds/starts a **new core
stack** on Linux. It does not install operating-system packages, enable a host
service, configure DNS/HTTPS, migrate upstream HAPI or upgrade existing state.
Managed provider login and native project runners require the separate
[host-control layout](HOST_CONTROL.md); choose that path from the start if needed.

Use a reviewed source checkout or extracted archive containing
`deploy/evolved/install.ts`. The first `v0.1.0-preview.1` release predates this
assistant. This guide targets `v0.1.0-preview.3`; check the release record before
selecting that tag. Source archives do not need
Git metadata or installed workspace packages to run its checks and initializer.

## Check first

Run as an ordinary Linux user, not root or sudo, with Bun 1.3.14, Docker Engine,
Docker Buildx and the Docker Compose plugin **2.20.0 or later** already installed
(including Compose 5). Use a local Unix socket connected to rootful Docker.
Rootless Docker, user-namespace remapping and Docker Desktop are unsupported
because private bind mounts require the same numeric UID/GID inside and outside
the containers. Docker access is trusted administrative access. Avoid exported Compose, Evolved or remote-Docker overrides; the assistant
refuses them rather than silently changing the target installation.

```sh
bun deploy/evolved/install.ts check --state "$HOME/.local/share/hapi-evolved-pilot"
bun deploy/evolved/install.ts check --state "$HOME/.local/share/hapi-evolved-pilot" --json
```

`check` and `status` are read-only. They do not create state, pull images, build
or start containers. They report requirements, conflicts and the next steps.
Plan about 12 GiB RAM for the stack and a future runner, at least 20 GiB free for
image builds, and additional space for repositories and backups.

Use a separate absolute state path outside the source tree, without symlinks,
spaces or interpolation characters. Existing parent directories must belong to
root or the invoking user and must not be group/world writable; root-owned sticky
directories such as `/tmp` are allowed. Newly created components are private.
The default port is loopback `3006` and the
local browser origin is `http://localhost:3006`. Select a different free port
with `--port` before initialization. For a preconfigured private HTTPS proxy,
set its exact origin with `--origin`; the assistant does not configure the proxy.

## Initialize, build and start deliberately

```sh
bun deploy/evolved/install.ts init --state "$HOME/.local/share/hapi-evolved-pilot"
bun deploy/evolved/install.ts build --state "$HOME/.local/share/hapi-evolved-pilot"
bun deploy/evolved/install.ts start --state "$HOME/.local/share/hapi-evolved-pilot"
bun deploy/evolved/install.ts status --state "$HOME/.local/share/hapi-evolved-pilot"
```

Alternatively, after checking the plan, explicitly run the fresh-install sequence:

```sh
bun deploy/evolved/install.ts install --yes --state "$HOME/.local/share/hapi-evolved-pilot"
```

`--yes` applies only to a fresh installation. An existing state directory belongs
to its original installation; the assistant will not adopt it, change its origin,
rotate its keys or replace its containers. Repeating a completed initialization
preserves its private files. The saved metadata binds the state to this source
location and Compose definition; moving it or changing its configuration requires
a deliberate operator procedure.

The core images and Compose project use a state-specific namespace. Hub, Vault,
Memory, Neo4j and Codegraph start without access to an existing host-control socket.
The assistant never stops an unrelated service to free a port. A separate image
build does not create native provider accounts or enable cloud-memory spending.

The isolated acceptance run used Docker Engine 29.8.2 with its containerd image
store and Compose 5.6.0. This is tested evidence, not a claim that every engine,
storage backend or Linux configuration has been validated.

## First browser visit

Inspect the reported service status. Once the Hub is ready, open its configured
origin at `/evolved`. Read `hub/bootstrap.token` yourself from the private state
directory and enter it locally; the assistant never prints that code. Register a
passkey and save recovery codes offline. Choose the final hostname before doing
this because passkeys are domain-bound.

The interface can display core project, knowledge and administration screens,
but managed login/session workflows need the separate operator setup. A successful
core startup is not a claim that a provider account, GitHub repository or model
request has been tested. See the [pilot guide](PILOT.md) for the complete workflow.

## Interrupted or conflicting setup

Docker build/start output is suppressed by the assistant; a long build can be
quiet, and its error message intentionally omits raw process output. The JSON
report identifies the private state and Compose project. An operator can inspect
that exact project and the matching Docker operation locally; review and redact
any diagnostic excerpts before sharing them.

The assistant leaves state in place on failure. It never automatically removes
an operation lock or repairs partial credentials. The lock is the private file
`installer.operation.lock` inside the chosen `--state` directory. A failed or
timed-out Docker command can leave daemon work running after the CLI returns.
Inspect the original operation and this installation's containers/images before
retrying; a missing CLI process alone is not proof that the build has stopped.
Only after the operator has confirmed that no operation remains active, checked
for partial or conflicting resources, and preserved the failure evidence should
they move this exact lock to a private evidence location. Never remove another
installation's lock or automate this recovery. Retry the appropriate individual
step; `install --yes` deliberately refuses initialized state. Use a new empty state directory
for a new attempt only after deciding what should happen to the existing one.
Do not delete keys from a used installation or paste configuration into an issue.

For an already running managed installation, use its original operator procedure
and a consistent backup. The assistant intentionally provides no `upgrade`,
`reset`, `delete` or automatic cleanup command.
