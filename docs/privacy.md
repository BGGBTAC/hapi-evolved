---
title: HAPI-eVolved data and privacy
aside: false
---

# HAPI-eVolved data and privacy

HAPI-eVolved is self-hosted software. Its operator controls the installation,
access, retention and configured external services. This page is a product data
summary, not a privacy policy on behalf of every operator or an upstream service.
The detailed reference is [Privacy and data handling](./evolved/DATA_HANDLING.md).

## Data in your installation

The Hub stores accounts, passkey public credentials, roles, sessions and knowledge
sources in private databases. Project files live in their bound workspace.
Attachments, service logs and backups have separate operator-managed storage.
The Vault stores encrypted values and GitHub credentials; its master key stays
outside agent workspaces. Native Claude/Codex credentials instead live in their
private runner home, where that runner's agent can use them.

The browser stores preferences and some local working state. Provider sign-in
challenges are transient, bound to the initiating HAPI session and expire; HAPI
opens the official provider page rather than asking for the provider password.
Use a private HTTPS origin and protect devices that can access the installation.

## Requests outside your host

- Coding agents contact the providers selected and authenticated by the operator/user.
- GitHub connection and Git operations contact GitHub through the project broker.
- Plugin previews fetch a public repository's manifest at a resolved commit; they
  do not execute repository scripts.
- Optional memory processing sends authorized content to its configured model
  provider after configuration and project budget approval.
- Any optional voice, push or other integration has its own destination and terms.

Self-hosting does not make these requests offline. A provider subscription, native
login or account entitlement is separate from HAPI authentication. Codegraph runs
locally; the standard stack disables its configured telemetry/update checks and
those of Graphiti/Neo4j. This is not a claim about every inherited adapter or
service an operator may add.

## Deletion and support

Revocation blocks future protected operations; it cannot retract already downloaded
data. Knowledge deletion invalidates derived results and queues graph cleanup.
Project removal preserves source directories. Backups retain deleted content until
the operator's retention window expires. Consult the
[backup and restore guide](./evolved/DEPLOYMENT.md) before restoring old state.

Never attach databases, runner homes, private keys, bootstrap/recovery codes or
raw authenticated network traces to a public issue. Prefer a synthetic reproduction.
Use this repository's [security reporting policy](https://github.com/BGGBTAC/hapi-evolved/blob/main/SECURITY.md)
for suspected vulnerabilities, and contact the operator for installation-specific
access, retention or deletion questions.

## Upstream provenance

This independent fork preserves the source history and notices of
[tiann/hapi](https://github.com/tiann/hapi). Its inherited native clients reference
upstream publisher services and privacy terms. HAPI-eVolved does not operate
`push.hapi.run`, upstream app-store listings or their support contacts, and cannot
make retention or deletion commitments on their behalf. The
[upstream privacy document at the fork baseline](https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/privacy.md)
remains a historical source, not this fork's hosted-service policy. Native clients
are [development paths](./guide/native-apps.md), not a supported Evolved release claim.
