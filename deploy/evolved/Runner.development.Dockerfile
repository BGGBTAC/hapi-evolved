# Optional HAPI-eVolved development runner image.
#
# Same agents, Bun, runtime wrapper, Git configuration, user and paths as
# Runner.Dockerfile, plus system toolchains for the Odoo/Android/iOS development
# modes. It does not replace Runner.Dockerfile. The operator chooses which image
# is built under the runner tag used by runner-control; see
# docs/evolved/DEVELOPMENT_MODES.md.
#
# Not included on purpose: Docker CLI/socket, Android SDK packages (license
# acceptance is a human decision per project), Swift, Odoo sources, wkhtmltopdf
# (not packaged in Debian 13) and any started service. Project toolchains are
# installed explicitly by the recipes under deploy/evolved/development into the
# project workspace, never into this read-only root filesystem.
FROM hapi-evolved:0.1.0 AS source
FROM oven/bun:1.3.14 AS bun-runtime
# Private CPython 3.12 for the bundled Claude Ads core (upstream supports only 3.11/3.12; Debian 13 has 3.13).
# Exact official image index digest (python 3.12.15, linux/amd64 manifest
# sha256:e8a38829209aea82774882e5157e1f7c3e8c8393ff53a697b3580896e57f345c).
FROM python:3.12-slim-trixie@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 AS ads-python
FROM node:24-trixie-slim

# Prevent package scripts from starting PostgreSQL and from creating the global
# /var/lib/postgresql cluster. Each project creates its own cluster explicitly.
# Base runner tools (identical set to Runner.Dockerfile) plus development tooling.
# Debian 13 provides Python 3.13, PostgreSQL 17 and OpenJDK 21.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 0755 /usr/sbin/policy-rc.d \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-common \
    && sed -ri 's/^#?\s*create_main_cluster\s*=.*$/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
    && grep -qx 'create_main_cluster = false' /etc/postgresql-common/createcluster.conf \
    && apt-get install -y --no-install-recommends \
        ca-certificates git openssh-client ripgrep python3 util-linux tini curl procps \
        python3-venv python3-dev \
        postgresql-17 postgresql-client-17 \
        openjdk-21-jdk-headless \
        build-essential pkg-config libpq-dev libxml2-dev libxslt1-dev libldap-dev libsasl2-dev \
        libjpeg-dev zlib1g-dev libffi-dev libssl-dev \
        libxml2-utils xz-utils unzip gnupg file jq less tzdata \
        libcurl4-openssl-dev libedit2 libncurses-dev libsqlite3-0 \
        libnss-wrapper \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/sbin/policy-rc.d \
    && test ! -e /var/lib/postgresql/17/main \
    && test -x /usr/lib/postgresql/17/bin/initdb \
    && test -x /usr/lib/postgresql/17/bin/pg_ctl \
    && python3 -c 'import sys, venv, ensurepip; assert sys.version_info[:2] >= (3, 12)' \
    && java -version 2>&1 | grep -q '"21\.' \
    && ls /usr/lib/*-linux-gnu/libnss_wrapper.so >/dev/null

RUN npm install -g @anthropic-ai/claude-code@2.1.285 @openai/codex@0.157.0 && npm cache clean --force
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=source /app /app
COPY services/runner-proxy /app/services/runner-proxy
COPY services/runner-auth /app/services/runner-auth
COPY deploy/evolved/development /app/deploy/evolved/development
# Claude Ads runtime: interpreter, standard library and libpython only, under /opt/hapi-ads-python. No pip,
# ensurepip or site-packages; the wrapper sets the library path for that child only. The build fails unless it is
# exactly 3.12 with the required standard modules and the vendored core answers through the HAPI bridge.
COPY --from=ads-python /usr/local/bin/python3.12 /opt/hapi-ads-python/bin/python3.12
COPY --from=ads-python /usr/local/lib/python3.12 /opt/hapi-ads-python/lib/python3.12
COPY --from=ads-python /usr/local/lib/libpython3.12.so.1.0 /opt/hapi-ads-python/lib/libpython3.12.so.1.0
COPY --chmod=0755 deploy/evolved/hapi-ads-python /opt/hapi-ads-python/bin/hapi-ads-python
RUN rm -rf /opt/hapi-ads-python/lib/python3.12/site-packages /opt/hapi-ads-python/lib/python3.12/ensurepip \
        /opt/hapi-ads-python/lib/python3.12/test /opt/hapi-ads-python/lib/python3.12/idlelib /opt/hapi-ads-python/lib/python3.12/tkinter \
    && /opt/hapi-ads-python/bin/hapi-ads-python -I -S -B -c 'import sys, argparse, csv, dataclasses, datetime, decimal, hashlib, html, json, math, pathlib, re, tempfile; assert sys.version_info[:2] == (3, 12), sys.version; assert sys.prefix == "/opt/hapi-ads-python", sys.prefix' \
    && /opt/hapi-ads-python/bin/hapi-ads-python -I -S -B /app/cli/src/evolved/ads/bridge.py /app/vendor/claude-ads/upstream version | grep -q '"core": "2.0.0"' \
    && python3 -c 'import sys; assert sys.version_info[:2] == (3, 13)' \
    && test ! -e /opt/hapi-ads-python/lib/python3.12/site-packages && test ! -e /opt/hapi-ads-python/bin/pip3
COPY --chmod=0755 deploy/evolved/hapi-runner.sh /usr/local/bin/hapi
RUN chmod 0755 /app/deploy/evolved/development/bin/* \
    && ln -s /app/deploy/evolved/development/bin/hapi-dev /usr/local/bin/hapi-dev \
    && mkdir -p /runner /workspaces /managed-workspaces && chown node:node /runner /workspaces /managed-workspaces
# Public GitHub reads use anonymous Internet access through the local proxy.
# Private reads and pushes retain project-scoped broker grants; no GitHub token
# is installed in the runner. Public repository registration is not required.
RUN git config --system url.http://runner-proxy:3010/evolved-git/github.com/.insteadOf https://github.com/ \
    && git config --system http.followRedirects false

# Read by the development doctor as a hint only; every tool is still probed.
RUN printf '%s\n' \
        'variant=development' \
        'schema=1' \
        'base=node:24-trixie-slim' \
        'python=3.13' \
        'ads-python=3.12 /opt/hapi-ads-python' \
        'postgresql=17' \
        'jdk=21' \
        'recipes=/app/deploy/evolved/development/bin' \
        > /etc/hapi-runner-image && chmod 0644 /etc/hapi-runner-image

USER node
ENV HAPI_HOME=/runner/hapi CLAUDE_CONFIG_DIR=/runner/claude CODEX_HOME=/runner/codex
WORKDIR /runner
CMD ["bun", "/app/cli/src/index.ts", "runner", "start-sync"]
