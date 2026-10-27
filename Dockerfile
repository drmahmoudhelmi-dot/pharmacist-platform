# syntax=docker/dockerfile:1.7
# Production images (ADR-001). Targets:
#   web      Next.js standalone server (port 3000)
#   worker   pg-boss worker (worker/index.ts via tsx)
#   migrate  one-shot: applies Drizzle migrations and installs pg-boss's schema
#
# No secret is baked in. `next build` needs no environment variables: env
# validation (src/shared/config/env.ts) runs lazily on first use at runtime.
# Runtime configuration: see staging.env.example.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
# pnpm at the version in package.json ("packageManager"), via corepack.
WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack install

# Full dependency tree (dev dependencies included) for the build.
FROM base AS deps
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Production dependencies only, including sharp's prebuilt native binary
# (@img/sharp-linux-*) and tsx, which the worker and migrate targets run.
FROM base AS prod-deps
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---------------------------------------------------------------- web
FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output is a self-contained server (server.js plus the traced
# node_modules). Static assets and public/ are not traced: copy them in.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]

# ------------------------------------------------------------- worker
# Runs TypeScript source with tsx (path alias "@/" comes from tsconfig.json).
FROM node:${NODE_VERSION}-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node worker ./worker
COPY --chown=node:node db ./db
# Email templates import the message catalogues.
COPY --chown=node:node messages ./messages
USER node
HEALTHCHECK --interval=30s --timeout=20s --start-period=60s --retries=3 \
  CMD ["node_modules/.bin/tsx", "worker/health.ts", "--this-host"]
CMD ["node_modules/.bin/tsx", "worker/index.ts"]

# ------------------------------------------------------------ migrate
# Same contents as the worker; runs what `pnpm db:migrate` runs.
FROM worker AS migrate
HEALTHCHECK NONE
CMD ["node_modules/.bin/tsx", "src/shared/db/migrate.ts"]
