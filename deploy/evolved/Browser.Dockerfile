# syntax=docker/dockerfile:1
# HAPI-eVolved optional project browser image (operator-built, started with --pull never).
#   jo-inc/camofox-browser 1.18.1 (MIT, commit 39c82094013480b373df6600d44c7f036f58356e) from the
#   immutable npm tarball, plus Camoufox 152.0.4-beta.30 (MPL-2.0, daijro/camoufox release asset).
# Build: docker build -f deploy/evolved/Browser.Dockerfile -t hapi-evolved-browser:0.1.0 .
# All downloads happen here, are size/digest-checked and never at runtime.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY deploy/evolved/browser/SHA256SUMS ./
RUN set -eu; \
    case "$TARGETARCH" in amd64) asset=camoufox-152.0.4-beta.30-lin.x86_64.zip; size=663467670 ;; arm64) asset=camoufox-152.0.4-beta.30-lin.arm64.zip; size=653870625 ;; *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; esac; \
    curl -fsSL --proto '=https' --tlsv1.2 -o camofox-browser-1.18.1.tgz https://registry.npmjs.org/@askjo/camofox-browser/-/camofox-browser-1.18.1.tgz; \
    curl -fsSL --proto '=https' --tlsv1.2 -o "$asset" "https://github.com/daijro/camoufox/releases/download/v152.0.4-beta.30/$asset"; \
    test "$(stat -c %s "$asset")" = "$size"; \
    grep -E " (camofox-browser-1.18.1.tgz|$asset)\$" SHA256SUMS | sha256sum -c -; \
    node -e "const h=require('crypto').createHash('sha512').update(require('fs').readFileSync('camofox-browser-1.18.1.tgz')).digest('base64');if(h!=='JLxRXtsCnAyaewFf/jWteZUJLW0x4m+WhZNNRa7iVOWa21R/7/GHH7x6g83DPi7fJ4aIGeq9+RZlHduGiOMOAg==')process.exit(1)"; \
    mkdir -p /out/app /out/camoufox; \
    tar -xzf camofox-browser-1.18.1.tgz -C /out/app --strip-components=1 --no-same-owner; \
    unzip -q "$asset" -d /out/camoufox; \
    rm -f "$asset" camofox-browser-1.18.1.tgz
WORKDIR /out/app
COPY deploy/evolved/browser/package.json deploy/evolved/browser/package-lock.json deploy/evolved/browser/camofox.config.json deploy/evolved/browser/hapi-entry.mjs deploy/evolved/browser/patch-upstream.mjs ./
COPY deploy/evolved/browser/plugins/hapi-egress/ ./plugins/hapi-egress/
# Lockfile install without lifecycle scripts (no postinstall browser/GeoIP/add-on download).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# better-sqlite3 uses the native prebuild included in the integrity-checked npm package.
# Exercise that exact native module offline; this does not claim a source compilation.
RUN --network=none node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"
RUN --network=none node patch-upstream.mjs server.js && rm patch-upstream.mjs \
    && printf '{"version":"152.0.4","release":"beta.30"}' > /out/camoufox/version.json \
    && CAMOUFOX_INSTALL_DIR=/out/camoufox node --input-type=module -e "import { camoufoxPath, launchPath, installedVerStr } from 'camoufox-js/dist/pkgman.js'; camoufoxPath(false); launchPath(); if (installedVerStr() !== '152.0.4-beta.30') process.exit(1)" \
    && rm -rf plugins/youtube plugins/vnc plugins/persistence node_modules/.cache \
    && chmod -R a+rX,go-w /out

FROM ${NODE_IMAGE}
# Runtime libraries for Firefox under Xvfb; fonts for rendering. No compilers, curl or shells beyond the base.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 libxrandr2 libxcomposite1 libxdamage1 libxss1 libasound2 libpci3 \
      libgl1 libegl1 libglx-mesa0 libgl1-mesa-dri xvfb xauth fonts-liberation fonts-noto-core fonts-dejavu-core fontconfig tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/camoufox /opt/camoufox
COPY --from=build /out/app /app
COPY LICENSE /usr/share/doc/hapi-evolved/LICENSE
COPY deploy/evolved/browser/THIRD_PARTY_NOTICES.md /usr/share/doc/hapi-evolved/THIRD_PARTY_NOTICES.md
# Camoufox and camoufox-js are MPL-2.0; Debian base-files ships the license text.
RUN test -s /usr/share/common-licenses/MPL-2.0 && ln -s /usr/share/common-licenses/MPL-2.0 /usr/share/doc/hapi-evolved/MPL-2.0
WORKDIR /app
ENV NODE_ENV=production CAMOUFOX_INSTALL_DIR=/opt/camoufox PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CAMOFOX_CRASH_REPORT_ENABLED=false CAMOFOX_DISABLE_DEFAULT_ADDONS=1 PROMETHEUS_ENABLED=false
LABEL org.opencontainers.image.title="hapi-evolved-browser" \
      org.opencontainers.image.source="https://github.com/jo-inc/camofox-browser" \
      org.opencontainers.image.revision="39c82094013480b373df6600d44c7f036f58356e" \
      org.opencontainers.image.version="1.18.1+camoufox-152.0.4-beta.30" \
      org.opencontainers.image.licenses="MIT AND MPL-2.0"
USER 1000:1000
EXPOSE 9377
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--max-old-space-size=256", "hapi-entry.mjs"]
