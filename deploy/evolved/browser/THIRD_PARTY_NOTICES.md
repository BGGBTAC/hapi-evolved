# Third-party components of the HAPI-eVolved project browser image

- **camofox-browser** 1.18.1 by Jo Inc, MIT License. Source: https://github.com/jo-inc/camofox-browser,
  commit `39c82094013480b373df6600d44c7f036f58356e`, installed from the npm tarball
  `@askjo/camofox-browser@1.18.1` (sha256 `b89badde10eaf3df0327c850cdc880560ea445d88bd6502314716a7123df3d66`,
  64 files byte-identical to that commit). License text: `/app/LICENSE` (also `deploy/evolved/browser/LICENSE.camofox-browser`).
  HAPI integration changes: `camofox.config.json` (plugins), `plugins/hapi-egress/`, `hapi-entry.mjs`,
  two asserted `server.js` patches (`geoip: false`; refuse to listen unless `hapi-egress` loaded), dependency lock with
  `@modelcontextprotocol/sdk` 1.32.0, `hono` 4.13.11 and `proxy-addr` 2.0.8.
- **Camoufox** 152.0.4-beta.30 by daijro, Mozilla Public License 2.0, based on Mozilla Firefox (MPL-2.0).
  Unmodified official release asset; source form: https://github.com/daijro/camoufox (tag `v152.0.4-beta.30`).
  License text: `/usr/share/doc/hapi-evolved/MPL-2.0`.
- **camoufox-js** 0.11.5, MPL-2.0 (https://github.com/apify/camoufox-js); further npm dependencies under their
  own licenses as recorded in `/app/package-lock.json` and each package in `/app/node_modules`.
