# syntax=docker/dockerfile:1
# Control-plane image: the API plus the built web UI.
# Build from the repository root:  docker build -f apps/api/Dockerfile -t slipway .

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Dependencies first (manifests + lockfile only) so source changes keep this layer cached.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --ignore-scripts
# Builds contracts, the API and the web UI (which generates its client from the API's OpenAPI document).
RUN pnpm turbo run build --filter=@slipway/api --filter=@slipway/web
# Self-contained directory with production dependencies only. Workspace packages are injected
# (copied with their own dependencies) for this step only; development keeps them symlinked.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@slipway/api deploy --prod --ignore-scripts --config.inject-workspace-packages=true /out

FROM node:${NODE_VERSION}-alpine AS runtime
ARG SLIPWAY_VERSION=edge
LABEL org.opencontainers.image.title="Slipway" \
      org.opencontainers.image.description="Slipway control plane: REST API and web UI" \
      org.opencontainers.image.source="https://github.com/JensPenneman/slipway" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    SLIPWAY_BUILD_VERSION=${SLIPWAY_VERSION} \
    SLIPWAY_WEB_ROOT=/app/web
WORKDIR /app
# Files stay owned by root and read-only for the runtime user; compose runs with read_only: true.
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
