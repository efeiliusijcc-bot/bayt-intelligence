FROM node:22.18.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY server ./server
RUN npm run build \
  && npm prune --omit=dev

FROM node:22.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4180 \
    RUNTIME_DIR=/app/runtime \
    BAYT_COLLECTION_DB=/data/current/collection.db \
    BAYT_CANDIDATES_DIR=/data/current/candidates \
    COLLECTOR_INCOMING_ROOT=/incoming \
    COLLECTOR_INCOMING_REMOTE_ROOT=/opt/bayt-intelligence/data/incoming \
    BAYT_SAMPLE_XLS=/data/network-capture-samples/2026-08-21_(50_CVs).xls \
    BAYT_SAMPLE_ZIP=/data/network-capture-samples/2026-08-21_(50_CVs).zip

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
RUN mkdir -p /app/runtime /data \
  && chown -R node:node /app/runtime

USER node
EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4180/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--experimental-strip-types", "server/index.ts"]
