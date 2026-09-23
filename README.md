# LocalMail

LocalMail is a local-first email inbox API for AI agents. This repository currently contains the Phase 0 foundation: a pnpm/Turborepo workspace, validated configuration, infrastructure definitions, the complete initial database model, and a small Fastify API shell.

The product brief and roadmap live in [`agentmail.md`](./agentmail.md). Progress is tracked in [`STATUS.md`](./STATUS.md).

## Prerequisites

- Node.js 20 or newer
- pnpm 9 (Corepack can install the pinned version)
- Docker Desktop or another Docker Engine with Compose v2

## Setup

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
docker compose ps
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The seed is idempotent. It creates a local development pod, stores a one-way scrypt hash of `ADMIN_API_KEY`, and creates `support-bot@localmail.test`. Keep real credentials only in the ignored `.env` file. Generate `APP_ENCRYPTION_KEY` with `openssl rand -base64 32` before implementing features that persist DKIM or webhook secrets.

Phase 0 exposes:

- API: <http://localhost:8080>
- API health: <http://localhost:8080/healthz>
- API docs placeholder: <http://localhost:8080/docs>
- Mailpit UI: <http://localhost:8025>
- MinIO console: <http://localhost:9001>

`pnpm dev` currently starts the API. SMTP, workers, dashboard, MCP, SDK, CLI, and core packages are compile-safe stubs for later phases.

## Smoke test

In one terminal:

```bash
pnpm dev
```

In another:

```bash
curl --fail --silent http://localhost:8080/healthz
curl --fail --silent http://localhost:8080/docs
```

Expected health response (the timestamp varies):

```json
{"status":"ok","service":"localmail-api","timestamp":"2026-09-22T00:00:00.000Z"}
```

Run the repository checks with:

```bash
pnpm check
pnpm build
```

## Database

The schema in `packages/db/src/schema.ts` covers every table from brief §6. The checked-in SQL migration lives in `packages/db/migrations`.

```bash
pnpm db:generate  # create a migration after schema changes
pnpm db:migrate   # apply pending migrations
pnpm db:seed      # seed local development records
```

The initial schema includes tenant foreign keys, cascading ownership, unique constraints, an idempotency-key store, the requested chronological indexes, GIN indexes for labels and full-text search, and a generated `tsvector` search column. `@localmail/core` includes AES-256-GCM helpers so future DKIM keys and webhook secrets can be encrypted before persistence.

## Services

| Service | Port(s) | Purpose |
| --- | --- | --- |
| PostgreSQL 16 | 5432 | relational data and full-text search |
| Redis 7 | 6379 | queues and future pub/sub |
| MinIO | 9000, 9001 | S3-compatible objects and console |
| Mailpit | 1025, 8025 | outbound SMTP capture and UI |

Every Compose service has a health check and a persistent named volume.
