FROM hapi-evolved:0.1.0 AS source
FROM oven/bun:1.3.14 AS bun-runtime
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client ripgrep python3 util-linux tini curl procps && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.285 @openai/codex@0.157.0 && npm cache clean --force
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=source /app /app
COPY services/runner-proxy /app/services/runner-proxy
RUN mkdir -p /runner /workspaces && chown node:node /runner /workspaces
USER node
ENV HAPI_HOME=/runner/hapi CLAUDE_CONFIG_DIR=/runner/claude CODEX_HOME=/runner/codex
WORKDIR /runner
CMD ["bun", "/app/cli/src/index.ts", "runner", "start-sync"]
