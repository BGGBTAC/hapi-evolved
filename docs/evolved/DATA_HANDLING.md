# HAPI-eVolved privacy and data handling

This describes the self-hosted stack, not a hosted-service privacy policy.
Operators are responsible for their installation, providers and retention.

| Data | Storage or destination | Control |
| --- | --- | --- |
| Accounts, roles and passkey public credentials | Private hub database | Project permissions and revocable sessions |
| Sessions and attachment originals | Hub database and attachment directory | Access and retention/deletion workflows |
| Project files | Selected or automatically managed workspace | Project binding and runner mount/profile |
| Vault values and GitHub credentials | Separate encrypted vault database | Master key outside workspaces; constrained operations |
| Local knowledge and sources | Hub ledger | Source checks, human verification and current ACLs |
| Derived knowledge | Memory service and Neo4j | Optional provider, budgets and generation-based deletion |
| Code index | Codegraph private mirror/index | Local processing with credential exclusions |
| Native provider credentials | Dedicated runner home | Native provider CLI; readable by that runner's agent |
| Browser provider challenges | Bounded login-worker memory and transient browser state | Bound to the initiating HAPI session; expiry, cancellation and live authorization |
| Specialist definitions and plugin manifests | Private hub database | Installation-admin changes, version-pinned sources, project-scoped starts |
| Backups and service logs | Operator storage | Operator encryption, access and retention |

## External requests

Memory sends selected authorized content to its model provider only after
configuration and project approval. Native agent requests use their own provider
sessions and terms. GitHub operations send repository queries and Git data to
GitHub. Offline synthetic tests do not establish real provider billing or quality.
Plugin previews read public GitHub repository metadata and the manifest at the
resolved commit; no repository scripts are executed. Provider sign-in opens the
provider's official account page. HAPI does not request the provider password.

Codegraph works locally. Compose disables configured Codegraph, Graphiti and
Neo4j telemetry/update paths. This does not describe every inherited client,
optional provider tool or operator-added service; review them before enabling.

## Deletion and retention

Revocation blocks new protected operations but cannot erase previously downloaded
data. Knowledge deletion invalidates derived results and queues durable graph
cleanup; backend failure can delay physical removal. Project removal preserves
source directories for separate operator handling.

Backups retain deleted data until the operator's retention window expires. Keep
vault keys with encrypted backups and outside agent workspaces. Follow restore
integrity and notification-epoch steps in the [operator guide](DEPLOYMENT.md).

## Support artifacts

Never attach databases, runner homes, operator/credential files, bootstrap or
recovery codes, or raw authenticated HTTP traces to public issues. Use synthetic
reproductions; redact identities, URLs and repository content you do not intend
to disclose. Follow the repository security policy for vulnerabilities.
