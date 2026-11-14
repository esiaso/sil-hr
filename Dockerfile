# Multi-stage build for the monorepo. Targets: api (also worker and webhook-sink), web, test.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ---- dependencies (cached unless a manifest or the lockfile changes)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- source + build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY docs docs
RUN pnpm --filter @sil/hr-shared build \
 && pnpm --filter @sil/hr-api build \
 && pnpm --filter @sil/hr-web build \
 && chmod -R a+rX /repo

# ---- test runner: docker compose --profile test run --build --rm test
FROM build AS test
ENV NODE_ENV=test
CMD ["pnpm", "test"]

# ---- API runtime (also used for the worker and the development webhook sink)
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/main.js"]

# ---- web runtime (Next.js standalone server)
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
