# GitHub connection

Connect GitHub once **per project**. Authorized agents in that project's isolated
runners then use ordinary Git commands to clone, fetch and push the repositories
you grant. They do not need their own GitHub login, and they never receive the
GitHub credential from the vault.

## Connect in the browser

1. Open **GitHub** in the Evolved workspace as a project administrator.
2. Create a **fine-grained personal access token** in your GitHub account. Select
   the intended resource owner and repositories, set an expiration, and grant
   repository **Contents: read-only** for clone/fetch or **Contents: read and
   write** for push. GitHub includes basic repository metadata permission.
3. Enter the token in the connection form and confirm your passkey if requested.
   The broker checks the GitHub account before saving the token encrypted.
4. Add an exact `owner/repository` and select **read** or **write**. The broker
   checks its canonical repository name, numeric identity and visibility. GitHub
   enforces the token's permissions on each Git operation, including pushes.
   Connecting an account alone grants no repositories to agents.

The preview uses your own repository-scoped token. It does not pretend to be an
already registered OAuth/GitHub App. A managed GitHub App with short-lived
installation tokens is a roadmap item. Organization policy may require approval
before a token can access private repositories.

GitHub's [token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
explains permissions, organization approval and expiration. Enter the token only
in the authenticated connection form, never in chat, a Git remote URL, an issue,
a project file or a runner environment variable. No existing host `gh` login is
automatically imported.

During setup, the submitted token passes transiently through the authenticated
browser request and Hub to the Vault. Its persistent storage is confined to the
Vault; connection responses and agent requests never return it.

## Repository permission and actual push access

The repository dropdown records **this project's grant**, even when the project
still uses the default **Eingeschränkt** profile. Saving **Lesen und Push** does
not silently raise the project profile or prove that GitHub will accept a push.
The controls explain the remaining requirements at the point of use:

1. The exact repository has a **Lesen und Push** grant.
2. The project uses **Arbeitsbereich** or **Erweitert**. In the GitHub panel,
   **Arbeitsbereich für Push aktivieren** offers an explicit, separate change.
   Confirming expands workspace execution rights and revokes all existing runner
   leases and capabilities for this project. It does not connect a new runner.
3. Follow **Runner für Push einrichten**, issue a new runner access with
   **In GitHub-Repositorys pushen**, and configure/restart its runner with the
   matching profile and a writable workspace. Existing leases are not upgraded.
4. The GitHub token itself must permit **Contents: read and write** for this
   repository, and GitHub account permissions and branch rules must permit the
   operation. Reading repository metadata cannot verify these push permissions.

The UI distinguishes a saved repository grant from an allowed project profile.
It does not label these as a connected runner or a successful push. After an
uncertain connection error it rereads the saved grant. If a profile change may
already have taken effect, use **Projektstatus aktualisieren** before retrying.
The server treats setting the already current profile as an authorized no-op:
it does not revoke runner access or add another profile-change audit entry.
Only an actual transition to a different profile revokes existing leases and
capabilities. The active profile is disabled in the project settings.

## Agent access

New runner leases include `git:read`. Profiles that permit writing additionally
offer `git:write`; an administrator can remove either scope. Existing leases
are not silently expanded: recreate them to add Git access. A `restricted`
profile cannot push. Repository grants and GitHub's own token permissions still
apply even when a runner has the scope.

Inside an authorized, writable runner workspace:

```sh
git clone https://github.com/OWNER/REPOSITORY.git
cd REPOSITORY
git switch -c feat/my-change
# Edit, review, test and commit your changes.
git push -u origin feat/my-change
```

Replace `OWNER/REPOSITORY` with a granted repository. The runner's system Git
configuration routes supported GitHub HTTPS URLs through its private proxy.
Provider CLIs and agent subprocesses inherit this Git configuration. A local
clone writes files, so a read-only `restricted` workspace cannot accept a clone
into that mounted directory even when its GitHub read permission is valid. Use
a writable project profile/mount for coding work.

The connection permits Git operations; it is not an unrestricted GitHub REST API
or a `gh` login. It does not create repositories, merge PRs or publish releases.
Use branches and pull requests. Configure GitHub rulesets to protect the default
branch and prevent unwanted force-pushes, deletions and tag changes: a write
grant alone is not branch protection.

## Boundaries and limits

The path is **agent → project runner proxy → hub authorization → signed vault
broker → GitHub**. The proxy holds the runner lease outside the agent container.
The hub checks project membership, lease/capability scopes and profile; the vault
checks repository grants and identity, and adds the credential only on its final
GitHub request. The runner has no general outbound GitHub credential channel.

Only HTTPS smart Git discovery, upload-pack and receive-pack are supported.
Arbitrary URLs, redirects, unrelated API requests and compressed HTTP bodies are
rejected. Native Git pack compression is supported; it is different from HTTP
content encoding. SSH transport, Git LFS and arbitrary GitHub Enterprise hosts are
outside this preview's broker. Submodule repositories need their own grants and
supported HTTPS URLs.

The broker verifies the repository's numeric identity before contacting its
canonical name. GitHub smart HTTP addresses repositories by name, so a remote
owner deleting and recreating that name between these requests remains a small
race window. Grant only repositories whose owner you trust.

Transfers are bounded to 64 MiB per request, 512 MiB per response and two minutes,
with at most two concurrent transfers per project, four per hub and two in the
vault broker. Large
histories may require a shallow clone or smaller pushes. These limits are
resource bounds, not throughput guarantees.

## Rotate or disconnect

Replacing a connection clears its old grants; grant repositories again for the
new credential. Removing a grant or disconnecting blocks new broker requests and
aborts active broker streams. Membership/profile changes and lease revocation
also stop future authorized transfers; active hub streams recheck authorization
every second. Already transferred data and already accepted remote writes cannot
be undone by revocation.

Disconnecting removes the local connection. Revoke the token separately in
GitHub if it should no longer exist at the provider. Expired, revoked or
organization-pending tokens require reconnecting with valid authorization.
Connection management is reserved for human project administrators with fresh
passkey authentication; agents cannot create grants for themselves.
