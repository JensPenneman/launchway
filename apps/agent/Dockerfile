# syntax=docker/dockerfile:1
# Node agent image: Node 24 + the Docker CLI with the Compose and Buildx plugins + git.
# Build from the repository root:  docker build -f apps/agent/Dockerfile -t launchway-agent .
#
# Base image choice: the official node:<v>-alpine image, with the docker CLI and its plugins
# copied from the official docker:<v>-cli image (same musl/Alpine userland; major versions set
# by the ARGs below, which Dependabot cannot update) and git from Alpine packages. This keeps
# Node on the exact LTS line used everywhere else, which distribution packages of Node do not
# guarantee.

ARG NODE_VERSION=24
ARG DOCKER_VERSION=29

FROM docker:${DOCKER_VERSION}-cli AS docker-cli

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --ignore-scripts
RUN pnpm turbo run build --filter=@launchway/agent
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@launchway/agent deploy --prod --ignore-scripts --config.inject-workspace-packages=true /out

FROM node:${NODE_VERSION}-alpine AS runtime
ARG LAUNCHWAY_VERSION=edge
LABEL org.opencontainers.image.title="Launchway agent" \
      org.opencontainers.image.description="Launchway node agent: runs Compose projects on its node" \
      org.opencontainers.image.source="https://github.com/JensPenneman/launchway" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apk add --no-cache git ca-certificates
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
ENV NODE_ENV=production \
    LAUNCHWAY_BUILD_VERSION=${LAUNCHWAY_VERSION} \
    LAUNCHWAY_WORKSPACE=/var/lib/launchway
WORKDIR /app
COPY --from=build /out ./
# Runs as root on purpose: the agent drives the host Docker daemon through the mounted socket,
# which is root-equivalent anyway (spec section 9). Compose drops all capabilities.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
