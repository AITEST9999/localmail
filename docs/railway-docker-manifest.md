# Docker artifacts for AITEST9999/localmail (Railway SUCCESS deploy 2026-09-23)

Commit these paths at repo root (no secrets in this package):

| Path | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage source (targets api/workers/smtp/dashboard) |
| `Dockerfile.api` | Single-final-stage image used by Railway api service |
| `Dockerfile.workers` | Railway workers service |
| `Dockerfile.smtp` | Railway smtp service |
| `Dockerfile.dashboard` | Railway dashboard service |
| `docker/entrypoint.sh` | Maps Railway PORT → API_PORT / SMTP_INBOUND_PORT |
| `.dockerignore` | Build context excludes |

Railway services point `dockerfilePath` at `Dockerfile.<svc>` (not Docker target API).
Node base image in these files is **22** (sanitize-html engines).

Do NOT commit: `.env`, `/workspace/localmail-railway/secrets/*`, `app-secrets.env`, `*-vars.json`, `bucket-creds.json`.

Optional polish already on box that may also need commit if not on main:
- apps/api tsconfig excludes for stub files (if changed)
- packages/db migrate.ts / embeddings export fixes (if changed for build)

Verify against Mini before force-pushing.

Also include these build-fix files from the successful box deploy (if Mini/main differs):

| Path | Why |
|------|-----|
| `apps/api/tsconfig.json` | Excludes stub `src/index.ts` + `src/plugins/**` so `tsc` succeeds |
| `packages/db/src/migrate.ts` | Migrate path used via railway ssh |

SHA256 of Docker core files (verify after unpack):
```
4c729330bfa19ef0fb88c033a305a72e477c24c1134aecac74448aa87cd8c263  Dockerfile
51c8dbbfb3370e08bd1a7e323edd069e28726a317b812e6d5cbc47cf8b60d1af  Dockerfile.api
4a19fb781a85bcac9cdb68eb3dbe74e74a10df90f75cd4614a9de3821c0ae192  Dockerfile.workers
c4500212518942ed5aec66c155bf4c2bef0754856ac04ef8cd32c03e07910061  Dockerfile.smtp
7b368264327e01afc0808bd57d295d370bda1258fcbeeda602d4b36ff392f441  Dockerfile.dashboard
487393e50e7d80dce43eea974f7a28c7cb4438afacea27c2d6a36d11fe82c0c5  docker/entrypoint.sh
e67d31f57b0fa88d6feedf3f63ed6996fd6a65897ada9d9d5b8530c6aa3797f4  .dockerignore
```
