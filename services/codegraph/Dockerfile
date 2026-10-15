FROM node:24-bookworm-slim
WORKDIR /app
COPY services/codegraph/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY services/codegraph/ ./
ENV NODE_ENV=production DO_NOT_TRACK=1 CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_UPDATE_CHECK=1 CODEGRAPH_NO_DOWNLOAD=1 EVOLVED_CODEGRAPH_PORT=8011
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8011
CMD ["node", "--liftoff-only", "server.mjs"]
