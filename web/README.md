# HAPI-eVolved web and PWA

The primary HAPI-eVolved client: a responsive workspace and coding-session UI for
desktop and mobile browsers. This independent fork builds on
[tiann/hapi](https://github.com/tiann/hapi)'s chat/session client. Start with the
[Evolved quick start](../docs/evolved/QUICKSTART.md) and
[user guide](../docs/evolved/USER_GUIDE.md).

`src/evolved/` contains the project workspace, passkey boundary, provider-login
cards, GitHub grants, persistent knowledge, Codegraph, Vault, previews, runner
access and specialist/plugin catalog. **Abos verbinden** starts actual native
provider login through the local control service; it does not collect provider
passwords. Model menus use scoped native snapshots and preserve unknown/stale states.

The default Evolved entry is `/evolved`; mobile bottom navigation and the desktop
sidebar expose the same project context. Appearance uses the existing theme store,
including coordinated light/dark profiles. Technical `hapi` API names remain;
legacy Telegram/token-login components below are not Evolved authentication.

The inherited React session engine remains alongside the Evolved workspace.

## What it does

- Session list with status, pending approvals, todos, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Codex `request_user_input` choices honor `isOther`: **None of the above**
  focuses optional notes, supports empty notes, and preserves the canonical
  wire value across languages. Recorded other answers and notes remain visible
  in live and historical cards; Pi/MCP forms without the flag are unchanged.
- Permission mode and model selection.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.
- Optional unread-session count on the Windows taskbar when installed as an Edge/Chrome PWA (toggleable in Display settings; off by default).

## Runtime behavior

- Evolved mode uses passkey registration/login, a secure cookie session and current project roles.
- Legacy standalone mode retains Telegram initData and `CLI_API_TOKEN[:namespace]`; these paths are not enabled by an Evolved Hub.
- The login screen includes a top-right hub picker; if unset, the app uses the same origin it was loaded from.
- Live updates come from the hub via SSE.
- Session `@` suggestions require conversation content, including untitled conversations. Names and directory labels affect display/search, not eligibility; empty stubs stay excluded.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Evolved workspace when Evolved mode is enabled; `/sessions` in legacy mode.
- `/evolved` - Project workspace; authorized `tab` and `project` query parameters preserve navigation context.
- `/sessions` - Session list.
- `/sessions/$sessionId` - Chat interface.
- `/sessions/new` - Create new session.
- `/sessions/$sessionId/files` - File browser with git status.
- `/sessions/$sessionId/file` - File viewer with diff support.
- `/sessions/$sessionId/terminal` - Terminal interface.
- `/browse` - Workspace browser, enabled by the runner's configured workspace roots.
- `/share` - Share-target landing (Web Share Target POST → `?id=`, or native `/share#url=&text=&title=`).
- `/settings` - Settings category hub (mobile) and responsive master-detail shell.
- `/settings/general` - Language preferences.
- `/settings/display` - Appearance, typography, colors, and session list preferences.
- `/settings/chat` - Message input, tool card, and conversation color preferences.
- `/settings/voice` - Everyday voice assistant preferences.
- `/settings/voice/voices` - Full-page voice picker.
- `/settings/voice/advanced` - Voice persona, tuning, and diagnostics.
- `/settings/machines` - Machine management and runner status.
- `/settings/storage` - SQLite storage sizes for the hub owner.
- `/settings/usage` - Cache-aware token usage dashboard for the hub owner.
- `/settings/about` - Application links and version information.

## Features

### Session list (`src/components/SessionList.tsx`)

- Active/inactive status indicator.
- Session title from name, summary, or path.
- Todo progress display.
- Pending permission request count.
- Agent name and model display.

### Chat interface (`src/components/SessionChat.tsx`)

- Message thread with infinite scroll.
- Composer for sending messages.
- Permission mode and model selection for supported agents.
  Cursor Auto uses CLI Auto for new/resumed sessions configured with Auto. When ACP does not advertise a literal Auto option, the session picker warns that switching back from a concrete model requires a restart; HAPI does not automatically restart an active session.
- Session abort and handoff controls.
- Codex **Continue planning** hides the current proposal's action menu locally
  and focuses the composer without sending a message or replacing its draft.
  The plan document remains readable; recycled cards stay dismissed and new
  proposals get fresh action menus.
- Context size display.
- Per-session scratchlist (`src/components/AssistantChat/ScratchlistPanel.tsx`)
  - Workbench panel for held notes/drafts; **distinct from the queue**.
  - Add/delete/reorder entries; promote to composer (copy) or queue (send).
  - Entries and attachments saved on the hub and synced across devices.
  - Reordering affects only the current view and resets when entries refresh.
  - Keyboard shortcut: Ctrl/Cmd+Shift+S to focus the add-input.

### File browser (`src/routes/sessions/files.tsx`)

- Git status view (staged/unstaged files).
- File search with ripgrep.
- Navigate to file viewer.

### File viewer (`src/routes/sessions/file.tsx`)

- File content display with syntax highlighting.
- Staged/unstaged diff view.

### Terminal (`src/routes/sessions/terminal.tsx`)

- Remote terminal via xterm.js
- Real-time via Socket.IO `/terminal`
- Resize handling

### Inherited voice integrations

Evolved blocks the host-global voice API/credential paths. The adapters below are
legacy implementation references, not a currently supported Evolved assistant flow.

- ElevenLabs (@elevenlabs/react), Gemini Live, and Qwen Realtime backends
- Real-time voice control
- Standard and realtime composer dictation with provider capability selection

### New session (`src/components/NewSession/`)

Modular session creation:

- Machine selector
- Directory input with recent paths
- Agent type selector
- Model selector
- Per-agent permission, effort, and collaboration controls when supported

### First-User-Experience (FUE)

For a new, non-essential feature whose affordance would otherwise be hard to
discover, consider the existing FUE primitive rather than a permanent UI block.
Optional, not a requirement for every feature or a reason to expand a bug fix.

- `src/lib/use-fue.ts`: `useFue(featureId)` returns `{ status, engage, dismiss }`; acknowledgement is isolated per feature in `hapi.fue.v1.<featureId>` localStorage keys.
- `src/components/Fue.tsx`: `FueDot` marks the affordance; `FueCallout` explains it while `status === 'engaging'`.
- Dismissal requires an affirmative user action ("Got it"), never an auto-timeout.
- The FUE dot and feature-specific badges/counters are mutually exclusive; onboarding wins until acknowledged.
- Opt in per feature; skip the wrapper if an upstream component already supplies onboarding.
- Working example: `ScratchlistToggleButton` in `src/components/AssistantChat/ComposerButtons.tsx`. Use the source rather than maintaining a copied example here.

## Authentication

Evolved: `src/evolved/auth.tsx` owns passkey enrollment/login, fresh-auth retries,
project selection and the session-token bridge. Sensitive login challenges stay in
transient component state. Logout/account/project changes invalidate or abandon
old requests; do not populate a new account's UI with late results.

`src/hooks/useAuth.ts` and `useAuthSource.ts` also retain the legacy standalone
Telegram/shared-token flows. Their presence is not an alternative Evolved login.
Session APIs use the scoped bridge token, while Evolved feature routes use the
human cookie session; authorization remains server-side.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Session/message/machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react + xterm.js + @elevenlabs/react + socket.io-client + workbox + shiki.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components.
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.

## Development

From the repo root:

```bash
bun install
bun run dev:web
```


For legacy-only Telegram development, set:

- `HAPI_PUBLIC_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Tests

Unit tests run under vitest + jsdom:

```bash
bun run test:web
```

End-to-end browser tests for the scratchlist component (real Chromium, real
`inert` focus blocking, real localStorage round-trips) live at the repo root
under `e2e/`:

```bash
bun run test:e2e          # headless
bun run test:e2e:ui       # Playwright UI mode (debug)
```

The spec drives a Vite-served fixture page (`web/e2e-fixtures/scratchlist-fixture.html`)
that mounts the production `ScratchlistPanel` in isolation, so no hub /
auth / socket setup is required.

## Evolved workspace verification

When `/health` enables Evolved, the web app uses passkeys and recovery codes;
legacy shared-token login is never mounted. The workspace at `/evolved` manages
projects, teams, passkeys, the vault, memory, codegraph, runner leases and previews.
Serve the PWA from the configured `EVOLVED_ORIGIN` so its session cookies and
WebAuthn relying-party identity stay on the same origin.

```bash
bun run test:web -- src/evolved src/api/client.test.ts
bun run --cwd web test:evolved:e2e
```

The browser check builds the production PWA and starts an isolated real hub and
vault server on temporary loopback ports. It exercises virtual WebAuthn,
recovery and step-up, project creation, encrypted vault writes, persistent
memory, runner lease downloads/revocation, the existing session API bridge,
preview sharing/revocation and browser-enforced preview isolation. All state and
credentials are synthetic and removed afterwards. Chromium must be installed for
Playwright; `PLAYWRIGHT_CHROME_PATH` can select an existing browser executable.
The check does not contact a memory provider or spend a cloud budget.

## Build

```bash
bun run build:web
```

The built assets land in `web/dist` and are served by hapi-hub. The single executable can embed these assets.

## Legacy standalone hosting

The supported Evolved preview serves assets from the same private HTTPS origin as
its Hub. Passkeys, cookies and mutation-origin checks must stay consistent; a
static-site deployment is not a tested substitute. The following is the inherited
legacy token-client hosting reference.

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any hapi hub:

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set hub CORS to allow the static origin (`HAPI_PUBLIC_URL` or `CORS_ORIGINS`).
4. Open the static site, click the top-right Hub button on the login screen, and enter the hapi hub origin.

Clear the hub override in the same dialog to return to same-origin behavior.
