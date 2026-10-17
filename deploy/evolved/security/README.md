# Native runner sandbox profiles

Codex 0.157 uses Bubblewrap to enforce read-only and workspace-write access.
Docker's default Seccomp policy prevents its unprivileged user namespace; Docker's
default AppArmor profile also denies its mount setup. The supplied policies allow
that setup while retaining the container's existing capabilities, root filesystem,
workspace mounts, PID isolation and `no-new-privileges` setting. They apply only to
the `runner` service. The proxy, egress service and host defaults stay unchanged.

This contract targets Linux amd64/arm64 with AppArmor 4, enabled unprivileged user
namespaces and Docker Engine. Ubuntu 24.04 is the tested host. Missing host support
is a setup error: there is no automatic switch to `unconfined`, privileged mode,
extra container capabilities or full-disk access. Do not change a host's global
AppArmor or namespace sysctls to work around an incompatible setup.

## Install

From the reviewed root-owned source at `/opt/hapi-evolved`, install the named
profile before starting the operator or recreating project runners:

```sh
sudo install -o root -g root -m 0644 \
  /opt/hapi-evolved/deploy/evolved/security/runner.apparmor \
  /etc/apparmor.d/hapi-evolved-runner
sudo apparmor_parser -r /etc/apparmor.d/hapi-evolved-runner
```

Review an existing file of that name before replacing it. The profile has no
executable attachment, so loading it changes no unrelated process. Compose selects
`apparmor=hapi-evolved-runner` and reads the supplied Seccomp JSON relative to the
Compose file. Keep both policy files and every ancestor root-owned and immutable
to the Hub and runners. The operator checks this ownership at startup.

Recreate existing runners after installing the reviewed source and profile.
Updating an enforce profile affects containers already using that profile; treat
future policy updates as runner maintenance. To roll back, stop/recreate its users
before removing only this named profile. Never replace `docker-default`.

## What changes from Docker default

Sources are pinned to [moby/profiles at
4b8214fc4971e06172938a1f1554ccff6647ee80](https://github.com/moby/profiles/tree/4b8214fc4971e06172938a1f1554ccff6647ee80),
under the included [Apache-2.0 license](LICENSE.moby).

`runner-seccomp.json` retains all 60 upstream Seccomp rules unchanged and appends
four rules: the exact `clone` flag combination used by Bubblewrap (new user,
mount, PID and IPC namespaces), `unshare(CLONE_NEWUSER)`,
`mount`/`pivot_root`, and `umount2(MNT_DETACH)`. `clone3`, `setns`, new mount APIs,
BPF and other privileged calls retain their Docker-default restrictions.
Only amd64/arm64 receive the additional `clone` rule. Network namespaces are
not allowed; managed Codex confirms Internet access before executing tools. The policy test verifies
the complete original baseline by digest, not just selected forbidden calls.

`runner.apparmor` derives from the same revision's Docker template. It keeps its
kernel-path denies, socket-family restrictions and peer rules; ABI 4 adds explicit
Unix-socket and user-namespace permissions. Mount permission is limited to
Bubblewrap's `/tmp`/`newroot` construction, private/slave propagation and the two
root pivots. Remounts are confined to `/newroot`; ordinary arbitrary mounts and
mount namespaces remain denied. Linux still requires namespace ownership for
these operations. No capability is added to a container or its agent processes.

Unprivileged nested user/mount/PID/IPC namespaces remain available to processes;
this is additional kernel attack surface. Keep the host kernel current. The root
supervisor is trusted: it drops all capabilities and supplementary groups before
starting the unprivileged runner. Tools and app-server processes must have zero
permitted and bounding capabilities.

The inner Codex sandbox keeps its filesystem policy and drops effective/permitted
capabilities before executing tools. Its Legacy Landlock flag is unsuitable:
Codex 0.157 explicitly rejects it for filesystem-restricted policies.

## Verify without provider access

After loading the named profile, run this disposable local test with the current
runner image. It uses no network beyond container loopback, no host mounts, no
credentials and no model turns:

```sh
cd /opt/hapi-evolved
sudo docker run --rm -i --network none --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt apparmor=hapi-evolved-runner \
  --security-opt seccomp="$PWD/deploy/evolved/security/runner-seccomp.json" \
  --read-only --tmpfs /tmp:rw,nosuid,size=256m \
  --env HOME=/tmp --entrypoint python3 hapi-evolved-runner:0.1.0 - \
  < deploy/evolved/check-codex-sandbox.py
```

The JSON result must report `passed: true`: native `command/exec` reaches a
synthetic TCP endpoint, read-only rejects writes, workspace-write permits only
its workspace, repeated resume preserves settings, and tools retain zero effective
capabilities plus `no-new-privileges`. The outer process also verifies that an
arbitrary mount and a mount namespace without a new user namespace are denied.
Run this check after changing Codex, Docker, kernel or either policy.

Repository checks: `bun run test:deployment`. The VM acceptance validator also
requires the named AppArmor profile and exact reviewed Seccomp policy on the
actual runner container.
