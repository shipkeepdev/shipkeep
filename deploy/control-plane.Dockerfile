# syntax=docker/dockerfile:1
# Control plane image (task M8.3): the API, the web UI it serves, and what a deployment needs to
# prepare its database (Prisma migrations and the restricted runtime role).
#
#   docker build -f deploy/control-plane.Dockerfile -t shipkeep .
#
# Commands, all without a shell:
#   node main.js                                              the control plane (default)
#   node_modules/.bin/prisma migrate deploy --config prisma.config.ts   apply migrations
#   node postgres/provision-runtime.mjs                       create the restricted API login
#
# The base image is pinned by digest (THREAT_MODEL, supply chain); Renovate keeps it current.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ARG PNPM_VERSION=11.28.6
# Toolchain for the agent binaries that the web build publishes under /install (deploy/build-installer.sh).
ARG GO_IMAGE=golang:1.26-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS go

# JavaScript output does not depend on the CPU, so the build runs once on the builder's platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
# Stamped into the agent binaries; the build context has no git history.
ARG SHIPKEEP_VERSION=dev
ARG SHIPKEEP_COMMIT=unknown
ENV CI=true NX_DAEMON=false GOTOOLCHAIN=local PATH=/usr/local/go/bin:$PATH \
  SHIPKEEP_VERSION=${SHIPKEEP_VERSION} SHIPKEEP_COMMIT=${SHIPKEEP_COMMIT}
COPY --from=go /usr/local/go /usr/local/go
WORKDIR /src
# `pnpm install` installs the git hooks (lefthook), which needs a repository to exist.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate
COPY . .
RUN git init -q . && pnpm install --frozen-lockfile
RUN NODE_ENV=production pnpm exec nx run-many -t build -p web api \
  && pnpm exec nx run api:prune

FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production \
  WEB_DIST_DIR=/app/web/browser
WORKDIR /app
# apps/api/dist holds main.js, a pruned package.json and lockfile, and the workspace packages.
COPY --from=build /src/apps/api/dist/ ./
# Native modules (argon2) are installed here, for the platform the image runs on.
RUN corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
  && pnpm install --prod --frozen-lockfile \
  && rm -rf /root/.local/share/pnpm /root/.cache
COPY --from=build /src/dist/apps/web/browser ./web/browser
COPY apps/api/prisma ./prisma
COPY apps/api/prisma.config.ts ./
COPY deploy/postgres/runtime-role.sql deploy/postgres/provision-runtime.mjs ./postgres/
COPY LICENSE NOTICE ./
USER node
EXPOSE 3000 7443
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.API_PORT || 3000) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "main.js"]
