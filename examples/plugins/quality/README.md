# Example: Quality Kit plugin

[`hapi-evolved.plugin.json`](hapi-evolved.plugin.json) in this folder is a complete
declarative plugin manifest (`schemaVersion: 1`) with one skill (`regressions`), one
specialist template (`reviewer`) that uses it, and one light color profile
(`clear-blue`). Its instruction and display texts are in German.

The manifest contains instruction text and colors only. It has no install scripts,
hooks, executable code, free CSS or MCP servers, and HAPI-eVolved does not run any
such content from plugins. Skills are prompt text that is passed with an explicitly
started task; they are not written into native Claude or Codex configuration.

## This folder is not an installable source

The installer reads **only** `hapi-evolved.plugin.json` in the **root** of a
**public** GitHub repository. It does not look into subdirectories, so
`BGGBTAC/hapi-evolved` with this path is not an installable plugin source. Private
repositories and other agents' native plugin formats are not imported either. To
use or adapt this example, publish it from a repository of your own.

## Publish it from your own public repository

1. Create a new **public** GitHub repository, for example
   `<owner>/hapi-quality-kit`.
2. Copy `hapi-evolved.plugin.json` from this folder into the **root** of that
   repository. Keep exactly this filename.
3. Change `id`, `name` and `description` so the plugin is clearly yours, and edit the
   skill, agent and theme entries as needed (see the rules below).
4. Validate it locally (offline, see below) and commit. Note the full commit SHA.
5. In HAPI-eVolved, open **Agents** (`/evolved?tab=agents`) as an installation
   administrator. In the plugin section, enter `<owner>/hapi-quality-kit` and a
   branch, tag or full commit SHA.
6. Open the preview and check the source repository, the resolved **commit**, the
   manifest checksum and the contained agents, skills and color profiles. Prefer the
   full commit SHA you reviewed in step 4.
7. Confirm the installation with a fresh passkey. It installs exactly the previewed
   content at the resolved commit; later pushes to a branch are not picked up.

A preview expires after ten minutes and is bound to the signed-in session. Updates
follow the same flow with their own preview and explicit confirmation; there are no
automatic updates. GitHub redirects are not followed, so after renaming the
repository you must preview the new source explicitly. Details:
[installing a plugin](../../../docs/evolved/EXTENSIONS.md#ein-plugin-installieren)
(German).

## Manifest rules used by this example

The complete format is described in
[manifest format](../../../docs/evolved/EXTENSIONS.md#manifestformat) (German). The
points that matter when copying this example:

- **Filename and placement:** `hapi-evolved.plugin.json` in the repository root, at
  most 512 KiB, valid UTF-8 JSON. Unknown fields are rejected.
- **Version:** `version` is a semantic version `MAJOR.MINOR.PATCH`, optionally with a
  `-prerelease` or `+build` suffix (for example `1.0.0`, `1.1.0-beta.1`), at most 64
  characters. Increase it whenever you publish changed content so reviewers can tell
  revisions apart; the installer still pins the reviewed commit, not the version.
- **IDs:** the plugin `id` and every agent, skill and theme `id` start with a
  lowercase letter and contain only lowercase letters, digits and `-` (at most 64
  characters). IDs must be unique within their list. Keep them stable across
  updates: an update that removes a skill used by an administrator's own agent
  definition is rejected until that agent is adjusted.
- **Skill references:** an agent's `skills` array lists skill IDs from the **same
  manifest** (here `["regressions"]`). A reference to a missing or duplicate skill
  is rejected. `providerPreference` is `either`, `claude` or `codex`; `model` is
  optional.
- **Color contrast:** a theme has `mode` `light` or `dark` and exactly the colors
  `background`, `surface`, `text`, `muted`, `accent`, `accentText` and `border`, each
  a six-digit hex value such as `#075985`. `text`, `muted` and `accent` must reach at
  least 4.5:1 contrast against both `background` and `surface`, and `accentText`
  against `accent`, following the
  [WCAG contrast definition](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
  Themes that miss this are rejected.

Passing validation shows that the manifest is well-formed. It does not review the
instruction text: read the source before installing, because imported instructions
become part of the human task when a specialist is started.

## Validate offline

From a checkout of this repository (after `bun install --frozen-lockfile`), run the
CLI source with Bun and pass your plugin directory or manifest file:

```sh
bun cli/src/index.ts evolved plugin validate examples/plugins/quality
bun cli/src/index.ts evolved plugin validate ../hapi-quality-kit
```

With an installed HAPI-eVolved CLI the same command is
`hapi evolved plugin validate <directory-or-file>`. It uses the same shared schema
as the hub installer, reads one bounded local file, and fetches, installs, writes or
executes nothing. A valid manifest prints a JSON summary with `"ok": true` and
exits with code 0. An invalid manifest prints `"ok": false` with the failing paths
and reasons, for example
`{ "path": "agents", "message": "Agent skills must refer to unique skills in this manifest" }`,
and exits with code 1. See
[checking a manifest locally](../../../docs/evolved/EXTENSIONS.md#manifest-lokal-prüfen)
(German).

## Tests and contributing

The checked-in example is parsed by the hub installer tests in
[`hub/src/evolved/extensions.test.ts`](../../../hub/src/evolved/extensions.test.ts)
and validated through the CLI in
[`cli/src/evolved/development/pluginValidate.test.ts`](../../../cli/src/evolved/development/pluginValidate.test.ts).
The schema itself lives in
[`shared/src/pluginManifest.ts`](../../../shared/src/pluginManifest.ts). If you change
this example in a pull request, run `bun test hub/src/evolved/extensions.test.ts`
and follow the [contributing guide](../../../CONTRIBUTING.md).
