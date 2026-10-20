# Pharmacist Platform

An Arabic-first (RTL), mobile-first web platform for pharmacists in Egypt: professional verification, jobs and applications, and later shifts, pharmacy listings and subscriptions. It is a single TypeScript modular monolith (Next.js, PostgreSQL, S3-compatible storage). The product serves Egypt only.

## Prerequisites

- Node.js 24 (see `.nvmrc`; 22.12 or newer also works locally)
- pnpm, via corepack: `corepack enable` (the version is pinned in `package.json`)
- Docker with Compose, for PostgreSQL, MinIO and Mailpit

## Quick start

```sh
pnpm install && pnpm bootstrap
```

`bootstrap` copies `.env.example` to `.env` if missing, starts the local services, applies migrations and starts the dev server at <http://localhost:3000>. Mailpit is at <http://localhost:8025> and the MinIO console at <http://localhost:9001>. The credentials in `.env.example` are local-only placeholders.

Other commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` (needs Docker), `pnpm test:e2e` (needs `pnpm build` and a Playwright Chromium), `pnpm services:down`.

## Documentation

- [CLAUDE.md](CLAUDE.md): project facts and working conventions
- [ADR-001: Initial architecture](docs/architecture/decisions/ADR-001-initial-architecture.md)
