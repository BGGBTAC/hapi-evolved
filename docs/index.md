---
title: HAPI-eVolved documentation
description: Self-hosted coding agents, project permissions, memory and browser control.
---

# HAPI-eVolved documentation

HAPI-eVolved is an independent fork of [tiann/hapi](https://github.com/tiann/hapi).
It keeps HAPI's local-first coding-agent foundation and develops new workflows at
its own pace: team projects, browser provider login, constrained GitHub access,
persistent knowledge, a local code graph and reusable specialist agents.

The current preview targets **Linux hosts, Claude Code and Codex, with a desktop
browser or mobile PWA**. Run it on infrastructure you control. It is a separate
installation, not an in-place upgrade of an existing HAPI hub.

## Start here

| You want to… | Read |
| --- | --- |
| Install a private preview | [Quick start](./evolved/QUICKSTART.md) |
| Understand the fork and its scope | [Why HAPI-eVolved?](./guide/why-hapi.md) |
| Connect a Claude or Codex subscription | [Provider login](./evolved/PROVIDER_LOGIN.md) |
| Work with teams, projects and permissions | [User guide](./evolved/USER_GUIDE.md) |
| Clone, edit and push project repositories | [GitHub connection](./evolved/GITHUB.md) |
| Use specialist agents and declarative plugins | [Agents and plugins](./evolved/EXTENSIONS.md) |
| Understand reported subscription limits | [Capacity](./evolved/CAPACITY.md) |
| Operate, back up or restore the stack | [Deployment](./evolved/DEPLOYMENT.md) |
| Know where data goes | [Data handling](./evolved/DATA_HANDLING.md) |

The overview and quick start are in English. Several detailed operator and feature
guides are currently in German; they describe the same implementation, including
the German labels used by the new workspace screens.

## What the preview includes

Create a team and a project; HAPI-eVolved creates a dedicated project directory.
Connect a provider through its official sign-in page, then start a session from
the browser. The local control service prepares a private project runner when
needed. GitHub credentials stay in the separate vault, while scoped Git operations
pass through the broker. Project profiles and current permissions remain in force.

Knowledge proposals and their sources persist across sessions. Optional Graphiti/
Neo4j processing requires provider configuration and a project budget. Codegraph
indexes source locally. Neither a model catalog nor a capacity report guarantees
that an account can use a particular model; the provider decides at execution.

## Read the right kind of reference

[Architecture](./guide/how-it-works.md) explains the current service boundaries.
The repository also retains upstream agent adapters, native apps and wire-protocol
references. Those pages mark inherited or unvalidated paths explicitly. Their
presence does not promise Evolved passkey support, signed mobile releases, or
access to upstream hosted services. Technical names such as `hapi`, `HAPI_HOME`
and `@hapi/protocol` remain where the code and protocol still use them.

HAPI-eVolved is not an official HAPI release and is not affiliated with its
maintainers or with the model providers. Upstream history, copyright notices and
the AGPL-3.0-only license are preserved. Follow this fork's source and release
instructions; upstream npm, Homebrew and app-store downloads are different builds.
