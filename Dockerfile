# syntax=docker/dockerfile:1
# One build, three runtime images: --target api | worker | web.
# Phase 2 local profile: no accounts are created and no secrets are baked in; configuration
# and secrets arrive at run time (see docker-compose.yml and ../Docs/Phase 2/operator-runbook.md).

FROM node:24-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Browser-visible API origin (non-secret). With the bundled nginx it is the web origin itself.
ARG VITE_API_BASE_URL=http://localhost:8080
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm build

FROM node:24-slim AS service
ENV NODE_ENV=production \
    TEST_PLATFORM_RUNTIME_DIR=/data/runtime \
    TEST_PLATFORM_DEFINITIONS_DIR=/data/definitions \
    TEST_PLATFORM_CONFIG_DIR=/data/config
WORKDIR /app
COPY --from=build /app /app
# The runtime directory is a named volume: it inherits this ownership when first created.
RUN mkdir -p /data/runtime/artifacts /data/runtime/logs /data/definitions /data/config \
 && chown -R node:node /data
USER node

FROM service AS api
ENV TEST_PLATFORM_API_HOST=127.0.0.1 TEST_PLATFORM_API_PORT=3000
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

FROM service AS worker
ENV TEST_PLATFORM_WORKER_HEALTH_PORT=3001 TEST_PLATFORM_MOCK_API_PORT=3002
EXPOSE 3002
CMD ["node", "apps/worker/dist/main.js"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
