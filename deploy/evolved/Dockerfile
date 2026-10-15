FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build:web

FROM oven/bun:1.4.3
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production HAPI_EVOLVED_ENABLED=1
LABEL org.opencontainers.image.title="HAPI evolved" org.opencontainers.image.version="0.1.0" org.opencontainers.image.source="https://github.com/BGGBTAC/hapi-evolved" org.opencontainers.image.licenses="AGPL-3.0-only"
USER bun
EXPOSE 3006
CMD ["bun", "hub/src/index.ts"]
