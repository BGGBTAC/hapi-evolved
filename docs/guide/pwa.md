# HAPI-eVolved on your phone: the PWA

The responsive web app is the primary mobile client for HAPI-eVolved. Install it
from **your own Evolved HTTPS origin**; it uses the same passkey account and project
permissions as a desktop browser. Upstream native apps are a separate
[development path](./native-apps.md). Begin with the [quick start](../evolved/QUICKSTART.md)
if the Hub is not installed yet.

## Install

On a browser that offers app installation, use the address-bar install action or
its **Install app / Add to Home Screen** menu. Android Chromium-based browsers
may also show the app's install prompt. On iPhone/iPad, opening the site in Safari
and choosing **Share → Add to Home Screen** is the documented path. Browser menu
names and availability depend on the platform; absence of a prompt does not mean
the Hub is unavailable.

On desktop, use the corresponding install action in a supporting browser or keep
using an ordinary tab. There is no separate Evolved mobile account or app-store
package to install. Your phone must be able to reach the private Hub; installing
a PWA does not create a tunnel or publish the server.

## Navigation and project context

Mobile navigation provides overview, sessions, projects and **Mehr** (More).
The additional tools include **Abos verbinden**, GitHub, knowledge, Codegraph,
Vault, automation and previews. Desktop uses the same tools in the sidebar.
The selected project controls access; putting a project ID in a URL never grants
permission. [The user guide](../evolved/USER_GUIDE.md) explains daily operation.

Display settings include light/dark/OLED modes, coordinated palettes and text
preferences. Browser zoom remains available. Browser captures and automated
accessibility checks do not substitute for testing your physical device.

## Connectivity and updates

Current project data, authorization and agent actions require a connection to the
Hub. Cached UI or previously loaded content is not a complete offline workspace,
and offline actions are not queued for later execution. Reconnect before sending
work or relying on current state.

The app checks for a new service worker and shows an update banner. Save unsent
work before confirming an update. Current builds reload only the tab that requested
it; very old tabs can still contain older update listeners. If an old start page
persists after an upgrade, open `/evolved` directly in a separate tab on the same
origin. This avoids the old precached root page without clearing account storage.
See [PWA updates](../evolved/PWA_UPDATES.md) for the tested upgrade behavior.

HTML, manifest and worker responses require revalidation; content-hashed assets
use long-lived caching. Header changes do not erase an already installed service
worker's caches. Do not clear site data as the default troubleshooting step: it
can remove drafts and local preferences.

## Notifications and shared content

Notification delivery depends on the browser, OS permissions, network access and
configured server path. It is not guaranteed background execution. Use the
[notifications reference](./notifications.md) to distinguish Evolved behavior from
inherited upstream native and messaging integrations.

The inherited Android Web Share Target and `/share` flow can ingest text/files
into a session picker. A target session must still be accessible to your account;
sharing into the app is not an authorization grant. Only use share integrations
that have been verified on your chosen browser/device.

## Troubleshooting

- **Cannot open the site:** confirm private network access, the exact HTTPS origin
  and the operator's Hub health before changing account data.
- **Passkey unavailable:** use the registered device/security key or the documented
  recovery flow. Changing the hostname can invalidate the expected passkey scope.
- **Old interface:** open `/evolved` directly and review the update guidance above.
- **Unknown capacity:** wait for an actual native report; do not interpret missing
  data as a full subscription allowance. See [capacity](../evolved/CAPACITY.md).
- **Provider login unavailable:** the operator must install the local control service;
  installing the PWA does not provision that service.
