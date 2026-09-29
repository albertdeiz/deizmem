# Built on the Pi itself, so the image is native arm64 with no cross-building.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The runtime carries one bundled file, the web bundle and the migrations: no node_modules.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DM_MIGRATIONS_DIR=/app/migrations DM_BLOB_ROOT=/data/blobs DM_WEB_ROOT=/app/web
COPY --from=build /app/dist/dm.js ./dm.js
COPY --from=build /app/dist/web ./web
COPY migrations ./migrations
RUN mkdir -p /data/blobs && chown -R node:node /data
USER node
ENTRYPOINT ["node", "/app/dm.js"]
