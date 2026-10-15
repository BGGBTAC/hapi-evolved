# Get started with HAPI-eVolved

Use the [HAPI-eVolved quick start](../evolved/QUICKSTART.md) to create a separate
Linux installation. The fork is developed independently from
[tiann/hapi](https://github.com/tiann/hapi), with its own release scope and feature
roadmap. Upstream `@twsxtd/hapi` packages and `tiann/tap/hapi` do not install this fork.

1. Build a reviewed Evolved commit and initialize private state outside the checkout.
2. Start the Hub, Vault, Codegraph, Memory and Neo4j stack behind your private HTTPS origin.
3. Use the local one-time setup code to register a passkey, then create a team and project.
4. Install the local runner control service and choose **Abos verbinden** to connect
   Claude or Codex through the provider's official sign-in page.
5. Start a session. The project profile controls what the agent may do; new projects
   begin restricted. Grant write access explicitly when the task needs it.

Provider login and GitHub connection are separate. To clone or push repositories,
follow the [GitHub guide](../evolved/GITHUB.md). Cloud knowledge processing also has
its own configuration and budget; a connected subscription does not enable it.

Use the [PWA guide](./pwa.md) for phone installation, the
[user guide](../evolved/USER_GUIDE.md) for daily work, and the
[operator guide](../evolved/DEPLOYMENT.md) for backups and updates.
[Legacy installation](./installation.md#legacy-hapi-reference) remains available
for contributors investigating the inherited standalone runtime.
