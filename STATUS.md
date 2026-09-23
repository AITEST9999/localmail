# LocalMail status

## Host live verification — 2026-09-23

Host pass on Surendras-Mac-mini (not hermetic-only). Compose left up; API `:8080`, SMTP `:2525`, dashboard `:3000`, workers (incl. `embed-message`) left running.

| Step | Result | Notes |
|------|--------|-------|
| 0 Bring stack up | **PASS** | `postgres`/`redis`/`minio`/`mailpit` healthy. Postgres image switched to `pgvector/pgvector:pg16` (alpine lacked `vector`). API/workers/SMTP via `tsx` + `EMBEDDINGS_USE_ONNX=true`. `GET /healthz` → 200. |
| 1 pgvector migration | **PASS** | `pnpm db:migrate` applied `0002_bouncy_the_watchers.sql`. `vector` 0.8.6; `messages.embedding vector(384)`; `messages_embedding_hnsw_idx`. |
| 2 Mailpit DKIM | **PASS** | Create+echo-verify domain `localmail.test` → `verified`; send from inbox on that domain; Mailpit `GET /api/v1/message/:id/headers` shows `Dkim-Signature` with `d=localmail.test`, `s=lm1`, `a=rsa-sha256`. |
| 3 Playwright dashboard | **PASS (HTTP) / SKIP (Playwright)** | No Playwright dep/scripts in monorepo. HTTP smoke: login 200; invalid key → `/login?error=invalid_api_key`; valid key sets `localmail_session` → `/inboxes` 200 with `@localmail.test` addresses. `DASHBOARD_SESSION_SECRET` + `LOCALMAIL_API_URL` set. |
| 4 k6 | **PASS (scaled)** | Installed k6 v2.3.0 to `~/.local/bin`. Scaled: 20 inboxes / 30s — checks 97/97, send p95≈82ms, search p95≈49ms, errors 0%. Heavier: 50 inboxes / 60s — checks 391/391, send p95≈60ms, search p95≈38ms, 651 HTTP reqs, errors 0%. Full 1k/10k/5m not run this pass. |
| 5 ONNX semantic search | **PASS** | Worker wrote dense 384-d embedding (382 nonzero, L2=1). First ingest wait ~4.4s. After minimal SQL fix, `GET /v1/search?q=money%20back&mode=semantic` → 200, hit on inbound billing fixture, `mode=semantic`, `rank≈0.359`, query ~171ms. |
| 6 Jev LEFT JOIN | **SKIP / follow-up** | `jev_decision` still hardcoded `null` in message mappers; store has no `jev_decisions` join. Not a quick additive fix this pass. |

**Code fixes this pass (minimal blockers only):**
1. `docker-compose.yml`: `postgres:16-alpine` → `pgvector/pgvector:pg16`.
2. `apps/api/src/store.ts` `searchMessagesSemantic`: vector bind was emitting bare `[...]` SQL (Postgres `syntax error at or near "["`); now parameterized `'[...]'::vector` string cast.
3. Workspace: `pnpm add -w @xenova/transformers`; `.env` gained `EMBEDDINGS_USE_ONNX`, `LOCALMAIL_API_URL`, `DASHBOARD_SESSION_SECRET` (secrets not logged).

**Remaining blockers / follow-ups:** Playwright suite not present; full 1k-inbox/10k-message k6; Jev `LEFT JOIN` for real `jev_decision` payloads; k6 `constant-arrival-rate` scenario appeared as default 1 VU under k6 v2.3.0 (duration/inbox envs still applied).

## Phase 5 — P5-25d semantic search (pgvector half): DONE (environment-qualified)

Added migration `packages/db/migrations/0002_bouncy_the_watchers.sql` as the sole migration author: enables the `vector` extension, adds nullable `messages.embedding vector(384)`, and creates the HNSW `vector_cosine_ops` index. Added `packages/embeddings` with a normalized 384-dimensional offline fallback and optional local Xenova/all-MiniLM-L6-v2 ONNX runtime (`EMBEDDINGS_USE_ONNX=true`), plus the `embed-message` queue/worker sibling to `jev-classify` and an explicit `backfill:embeddings` script. `GET /v1/search` now accepts `mode=semantic` (FTS remains default), computes cosine rank, includes mode/rank in summaries, and rejects cross-mode cursor replay.

Evidence: API **62 tests** passing (semantic route + mode cursor coverage), workers **10 tests** passing, embeddings dimension test passing; API/workers/events/embeddings/db typechecks and API/workers lint green; OpenAPI regenerated. Docker/Postgres pgvector and model-download live smoke were unavailable here, so the real extension/index query and first-run ONNX latency remain to be exercised on a host with pgvector. The default fallback keeps local tests/offline development deterministic; install `@xenova/transformers` and set `EMBEDDINGS_USE_ONNX=true` for the approved model.

## Phase 5 — P5-28b metrics + structured logging + k6: DONE (environment-qualified)

Added Prometheus HTTP counters/histograms and rate-limit rejection counters, unauthenticated `/metrics`, Fastify route-template labels, pino redaction for authorization/cookies/API keys/secrets, and a redaction-sentinel test. Added parameterized `k6/load.js` + run instructions for the 1k-inbox/10k-message scenario. API tests: **62 passing**; API/workers/SMTP typecheck and API lint pass. Live k6 was not run because the local stack/k6 binary is unavailable.

## Phase 5 — P5-28a metrics + logging + k6 design: DONE (approved 2026-09-23)

Doc: [`docs/phase5-metrics.md`](docs/phase5-metrics.md). Design-only, last of Phase 5's design gates — no app code, no `package.json` edits (`prom-client` is a new, not-yet-added dependency, noted for P5-28b). Full metric list: HTTP request count/duration (`route` label is always the Fastify route *template*, never an interpolated path — the one real cardinality/PII decision in this doc), rate-limit-rejection counter split by `key`/`pod` scope, BullMQ queue-depth gauge + job-duration histogram (labeled by queue, additive-by-construction for P5-25d's future `embed-message` queue), a WS-connection gauge sourced from `ws-hub.ts`'s existing connection map (deliberately **no** `pod_id` label), an SMTP accept/reject counter. **`/metrics` auth:** unauthenticated, same as `/healthz` — rationale is the local-first threat model plus avoiding a new credential/awkward scrape-config auth; the real safeguard is the cardinality/PII discipline itself (no pod/key/inbox/email/domain ever becomes a label), not endpoint auth. **Logging:** pino `redact` config (not per-call-site discipline) covers API keys, webhook secrets, DKIM private keys, the dashboard session cookie, and `Authorization` headers; extends the CLI's existing redaction-sentinel test pattern server-side; flags `apps/workers/src/runtime.ts`'s existing string-interpolated log lines as worth converting to structured fields for consistency. **k6:** new `k6/` directory, targets the real running API, 1,000 inboxes/10,000 messages per agentmail.md §10 task 28, with an explicit accepted limitation that it load-tests the API send path (k6 has no native SMTP support) and starting-point thresholds flagged as tunable, not final. Next: Codex implements P5-28b — the last Phase 5 task.

## Phase 5 — P5-27 Python SDK: DONE (repo-internal)

Added `packages/sdk-python`, an editable-install `httpx` client covering inboxes, threads, messages, drafts, webhooks, domains, API keys, search, `me`, polling `wait_for_email`, and constant-time webhook signature verification. It is not published to PyPI. Python tests: **4 passing** (GET retry, non-idempotent POST retry policy, signature vectors, polling wait). Install/docs are in `packages/sdk-python/README.md`.

## Phase 5 — P5-26b dashboard: DONE (environment-qualified)

Scaffolded the Next.js 15 App Router dashboard with encrypted `httpOnly` API-key sessions (`/api/session` + logout), SDK-backed BFF login validation, inbox/thread/detail views, sanitized HTML/raw-header display, webhooks, domains, search, and API-key settings views. Added dependency-boundary coverage proving no `@localmail/db`/`@localmail/jev` dependency. Dashboard test, typecheck, lint, and production build pass. The additive `jev_decision` response field is present as a nullable compatibility field and OpenAPI was regenerated; full database-backed LEFT JOIN and Playwright/live smoke remain follow-up work because the local stack/browser is unavailable.

## Phase 5 — P5-25c semantic search (pgvector) design: DONE (approved 2026-09-23)

Doc: [`docs/phase5-search-semantic.md`](docs/phase5-search-semantic.md). Design-only — no migration, no app code. **Q7:** local in-process ONNX embeddings (`Xenova/all-MiniLM-L6-v2`, 384-dim) inside `apps/workers` + a new shared `packages/embeddings` package for query-time inference in `apps/api`; no hosted API, no *required* Ollama service (optional backend only — `docker compose up -d` stays a 4-service flow). Migration plan (for P5-25d, sole author per AGENTS.md §5): `vector` extension, `messages.embedding vector(384)` nullable column, `hnsw`/cosine-ops index. API: `mode=fts|semantic` on the existing `GET /v1/search`, not a new route; cursor now encodes `mode` and rejects cross-mode replay. Generation: `embed-message` enqueued as a sibling job to `jev-classify` on `message.received`, plus a one-time backfill script. Explicit latency budget: ~500ms async ingest target, ~200ms query-time budget on the request path — flagged as something to validate, not assumed. Next: P5-25d (Codex), only after P5-25b has been in real use for a while, per the phase-order rationale in `docs/phase5-plan.md` §1 (already the case).

## Phase 5 — P5-26a Next.js dashboard design: DONE (approved 2026-09-23)

Doc: [`docs/phase5-dashboard.md`](docs/phase5-dashboard.md). Design-only — no app code, no `package.json` edits; `apps/dashboard` confirmed still an 8-line stub (no Next.js scaffold exists yet). **Auth:** `httpOnly` session cookie backed by a pod-scoped API key entered once at login, encrypted with a new `DASHBOARD_SESSION_SECRET` (not `APP_ENCRYPTION_KEY`); all data access proxied server-side (BFF pattern) so the raw key never reaches client JS — no second auth system, same Bearer-key model every other client already uses. **IA:** login, inboxes, thread list/detail (raw headers + sanitized HTML), webhooks + delivery log, drafts, domains + verify, search, API keys — every view mapped to an existing SDK method; SDK-only, zero dependency edge to `packages/db`/`packages/jev` (PLAN.md Decision 2.4), enforced by a proposed dependency-boundary test. **Real API gap found:** nothing in `apps/api` reads `jev_decisions` back out today (confirmed by grepping every `operationId`) — required for agentmail.md §2.12's "Jev decisions + confidence" view. Resolved as a small additive field on `getMessage`/`getThread` (no new route/scope/migration), scoped into P5-26b rather than left as a mid-implementation surprise or a `packages/db` workaround. Next: Codex implements P5-26b.

## Phase 5 — P5-24b custom domains + mock DNS + DKIM: DONE (environment-qualified)

Added pod-scoped domain CRUD and echo-back verification with `domains:read`/`domains:write`, RSA-2048 `lm1` keypairs, AES-GCM encrypted private-key storage, and responses that never serialize `dkim_private_key`. Verified custom-domain outbound messages now pass Nodemailer DKIM options; baseline `MAIL_DOMAIN` remains unsigned. API tests: **60 passing**; API/workers typecheck and lint green; OpenAPI refreshed; no migration. Live Mailpit DKIM smoke was not runnable because the local Docker/API stack is unavailable in this environment.

## Phase 5 — P5-24a domains + DKIM design: DONE (approved 2026-09-23)

Doc: [`docs/phase5-domains.md`](docs/phase5-domains.md). Design-only — no app code, migrations, or `package.json` edits; `domains` table already exists, no schema change needed. Decisions: **Q4** mock-DNS verify is echo-back (caller echoes `createDomain`'s `dkim` DNS record back to `POST /v1/domains/:id/verify`; match → `verified`, mismatch → `failed`, both `200`; malformed body → `400`). **Q5** RSA-2048 keypair, selector `lm1`; private key encrypted via the existing `packages/core/src/crypto.ts` (same helper already used for webhook secrets), never returned by any route regardless of scope. DKIM signing integration point identified precisely in `apps/api/src/outbound.ts`: must happen inside `build()`'s `composer.sendMail(...)` call (Nodemailer/mailcomposer signs at MIME-composition time, not at `sendRaw()`'s SMTP hand-off) — confirmed against the installed `nodemailer@10.0.10`, with an explicit flag for P5-24b to verify the `dkim` mail-option's exact shape against the installed types rather than assume. Default `MAIL_DOMAIN` always stays unsigned. New scopes `domains:read`/`domains:write`. Next: Codex implements P5-24b.

## Live MVP smoke (post rate-limit hotfix) — 2026-09-23 ~12:53 ET

After appending `RATE_LIMIT_*` to `.env`, rebuilding `@localmail/config`, hardening `createRedisRateLimiter`, and restarting API/workers/SMTP on the Product host:

- `GET /v1/me` → 200 with `scopes:["*"]`
- `POST /v1/inboxes` → 201
- `POST /v1/api-keys` `{scopes:["messages:send"]}` → 200 with one-time `api_key`
- `GET /v1/search?q=test` → 200 with ranked `data[]`

Codex sandbox still cannot open `docker.sock` (earlier environment-qualified notes). Host-shell curls work when API is up; tsx-watch restarts can briefly drop `:8080`. Scheduled-draft + scoped-key deny live curls were not re-captured in the same healthy window — hermetic tests cover those paths.


## Rate-limit hotfix — DONE (2026-09-23)

RATE_LIMIT_RPS/BURST and RATE_LIMIT_POD_RPS/BURST are now explicitly finite, positive env values and are passed into the Redis limiter from `createApp`. `createRedisRateLimiter` rejects NaN, Infinity, zero, and negative bucket settings before request handling. Regression coverage passes (API 59 tests; config 3 tests), including authenticated `/v1/me` returning 200 in the app test suite. Live curl could not run because the local API/Docker stack is not reachable in this environment.

Updated: 2026-09-23 (Phase 5 MVP design gates approved)

## Phase 5 — P5-25b full-text search: DONE (environment-qualified)

Implemented `GET /v1/search` with `messages:read`, pod/inbox scoping, parameterized `plainto_tsquery('english', ...)`, `ts_rank` ordering, and opaque `(rank,id)` cursor pagination. No migration was added; the existing generated tsvector and GIN index are used.

- Verification: API **58 tests** passing; API typecheck/lint green; OpenAPI refreshed. Hermetic coverage includes operator-shaped input, blank-query validation, rank output, and stable tie pagination.
- Docker/Postgres is unavailable via the local socket, so real-Postgres integration and live `q=refund` fixture smoke were skipped and remain environment-dependent.

## Phase 5 — P5-23b pods + scoped API keys + rate limiting: DONE (environment-qualified)

Implemented the approved pods/keys contract: pod bootstrap requires the exact `*` scope, creates a one-time admin key, and API-created keys reject `*` and unknown scopes. Added pod/key listing, scoped creation, pod isolation, and last-active-key protection. Added Redis Lua token buckets with pod ceiling checked before per-key bucket, atomic two-bucket decrement, `429 rate_limited`, and `Retry-After`; local memory limiter is used by hermetic tests.

- Verification: API **57 tests** passing (including token-bucket math and pod/key routes); API/workers/config typecheck and lint pass; OpenAPI regenerated with five new operations.
- No migration added. Docker socket access is unavailable in this environment, so real Redis/Testcontainers and live curl smoke were not runnable; the hermetic Redis-equivalent covers burst/refill, boundary, pod ordering, and rejection behavior.

## Phase 5 — P5-22b drafts + scheduled send: DONE

Implemented the approved drafts design. API draft CRUD and `sendDraft` are wired under `/v1/inboxes/:inbox_id/drafts`, with `drafts:read`/`drafts:write` and `messages:send` scopes, idempotency inherited from the API, optimistic status-claim races, and the existing outbound service reused for delivery. Workers run a configurable 5-second interval poller (batch 20) using scheduled-row claim/update transitions (`scheduled → sending → sent|failed`); lost claims and deleted inboxes are silent skips.

- Verification: API **54 tests** pass; workers **10 tests** pass; API/workers typecheck and lint pass.
- Coverage includes past `send_at` rejection, draft edit/delete races, manual send transitions, poller claim loss, send failures, and status transitions. The workspace has no new migration (the existing `drafts` table is used).
- Live compose/Testcontainers-style infrastructure was not available as a separate dependency in this repo; the worker path is exercised with hermetic integration-shaped fakes. A live +5s smoke remains the only environment-dependent check to run if the stack is restarted.

## Phase 5 — MVP design gates APPROVED (P5-22a, P5-23a, P5-25a)

**MVP cut's three design docs are done and approved; P5-22b, P5-23b, and P5-25b are now implemented.** (Drafts unlock agent workflows first; scoped keys should exist before more routes are built against the admin key; FTS is the lowest-risk of the three and benefits from scoped-key testing.)

- **P5-22a (drafts + scheduled send): DONE.** [`docs/phase5-drafts.md`](docs/phase5-drafts.md). Interval poller (5s), optimistic-concurrency claim/edit races, `send_at`-in-the-past rejected (`400`, no coercion), inbox-delete handled by existing `ON DELETE CASCADE`. New scopes `drafts:read`/`drafts:write`.
- **P5-23a (pods + scoped keys + rate limiting): DONE.** [`docs/phase5-pods-keys.md`](docs/phase5-pods-keys.md). Pod creation gated on the exact `'*'` scope sentinel (not a new scope); `createApiKey` can never grant `'*'`. Rate limiting is **both** per-key (primary) and per-pod (secondary ceiling) Redis token buckets — `429 rate_limited` (first real use of that existing-but-unused error code) + `Retry-After`. New scopes `api_keys:read`/`api_keys:write`.
- **P5-25a (full-text search): DONE.** [`docs/phase5-search-fts.md`](docs/phase5-search-fts.md). `GET /v1/search`, reuses `messages:read`, `plainto_tsquery` only (never `to_tsquery`/string-interpolation — injection-safe by construction), `rank DESC, id DESC` stable pagination. **No migration** — `messages.search`'s tsvector + GIN index already exist.

Full original planning context (gap analysis, recommended order for all of 22–28, MVP cut rationale, open questions): [`docs/phase5-plan.md`](docs/phase5-plan.md). Design docs for the stretch tasks (P5-24 domains/DKIM, P5-26 dashboard, P5-27 Python SDK, P5-28 metrics/k6, P5-25c/d pgvector) are **not written yet** — deliberately, per this pass's scope (MVP gates only).

## Phase 4 — ALL TASKS DONE except MCP live Claude Code registration (PENDING USER OK)
- **P4-20 MCP (`apps/mcp`), P4-19 CLI (`packages/cli`), P4-21 examples (`examples/*`) are all DONE.** Full detail in TASKS.md's Phase 4 section (source of truth); this is a summary.
- **P4-20 MCP:** stdio server, exactly the 7 §2.11 tools, untrusted-content wrapping + 20k truncation + `html` dropped, deps limited to `@localmail/sdk` + `@modelcontextprotocol/sdk` + `zod` (asserted). 14/14 hermetic tests (MCP SDK in-memory transport + a fake `LocalMailClient`), typecheck/lint/build green. **Live-verified** via a standalone script spawning the built server over real stdio against the running stack: `create_inbox` (idempotent), `wait_for_email` found a curl-SMTP-delivered fixture mid-call, `reply`, `add_label`, `list_threads`, `get_thread`, an empty-inbox timeout, and a bad-inbox error — all passed. **`claude mcp add` was intentionally not run** (edits `~/.claude.json`) — ask the user first; the command is `docs/phase4-plan.md` §6.3.
- **P4-19 CLI:** `packages/cli` bin `localmail`, `commander`. All commands (`inbox create|list`, `send`, `reply`, `threads`, `tail`, `wait`) live-verified against the real stack, including `--json`, exit codes 0/1/2, Ctrl-C on `tail` (exit 0, socket closed), and an API-key-redaction sentinel test. 20/20 hermetic tests, typecheck/lint/build green.
- **P4-21 examples:** all three (`auto-reply-agent`, `otp-signup-agent`, `agent-to-agent`) are done — 27 hermetic tests total, all live smokes passed (see TASKS.md for the numbers: reply-skip on OOO/bounce/needs-human + reply+idempotent-replay on a synthetic support message; OTP verified in 183ms + client_id reuse + `--race` catch-up + clean timeout; agent-to-agent 3-message negotiation with Mailpit unchanged + `--runaway` stopped at hop 19/20).
- **A real bug was found and fixed in the already-DONE P4-18 SDK while building the CLI's `tail` command:** `packages/sdk/src/wait-for-email.ts` read `event.data.id` from WS events, but the server (`packages/events/src/publisher.ts`) only ever sends `event.data.message_id` — confirmed by reading the publisher source directly. This meant `waitForEmail`'s real-time WS-push path silently never matched (wrong field name), so it always fell back to the 5s reconcile poll — consistent with P4-18's own live-smoke note ("resolved in ~4.4s") looking like poll behavior rather than the sub-second WS behavior the design intended. The existing hermetic tests didn't catch this because their fixtures used `data: { id: ... }`, matching the bug rather than the real server shape. Fixed the field name in both the implementation and its two test fixtures; all 20 SDK tests still pass; reverified live with a 20s poll interval (to rule out the poll) — `waitForEmail` now resolves in ~200–560ms via the WS path.
- **Also found live (not a pre-existing bug, a mistake in the new example code):** `agent-to-agent`'s negotiation used `since = new Date()` captured *after* each `send`/`reply` call instead of before. Pure loopback delivery is synchronous with the HTTP response, so the message was already in the DB with a `received_at` earlier than that `since`, and `waitForEmail`'s catch-up (`after: since`) never found it — a real live timeout on first run. Fixed by capturing `since` (with a small clock-skew buffer) immediately before each send/reply, matching the same "capture `since` before triggering" guidance the OTP example's README already states. Also caught pre-live-run: `agent-to-agent/src/protocol.ts`'s acceptance regex `/I can do (\S+)/` captured a trailing period from "I can do slot-2." — the hermetic round-trip test caught this immediately; fixed to `[\w-]+`.
- **Full monorepo `pnpm check` (typecheck + lint + test) is green: 51/51 tasks.**
- **Environment for this session:** API/SMTP were already up; workers was down and was started (`pnpm --filter @localmail/workers dev`). `JEV_ENABLED=false` (rules path) for deterministic labels throughout.
- **Not done, needs the user:** live MCP registration in Claude Code (`claude mcp add`) — PENDING USER OK, per the router-phase constraint against deploying/publishing without asking.

## Phase 4 (superseded by the section above) — P4-18-api and P4-18 DONE; P4-19/20/21 not started
- **Plan:** [`docs/phase4-plan.md`](docs/phase4-plan.md). TASKS.md Phase 4 rows: **P4-18-api** DONE, **P4-18** DONE, **P4-19** CLI PLANNED, **P4-20** MCP PLANNED, **P4-21** examples PLANNED.
- **Ownership:** Claude Code plans and implements all of Phase 4. **No Cursor (`cursor-lm`).** MCP/SDK/CLI/examples are SDK-only (PLAN.md D2.4).
- **P4-18-api (DONE, 2026-09-23):** fixed all blocking findings below.
  - G1 fixed: all routes now register inside one child plugin after `@fastify/swagger`, so avvio boots swagger's `onRoute` hook first. `/docs/json` now lists all 25 operationIds.
  - G2 fixed: `PATCH /v1/inboxes/:id/messages/:message_id` (`updateMessageLabels`) added — add/remove labels, recomputes thread label union in the same transaction, does **not** emit `message.labeled`.
  - G12 fixed: `listMessages`'s `before`/`after` filters bound a raw JS `Date` against a `sql<Date>`-templated `coalesce(...)` expression, which the `postgres` driver can't encode (`TypeError [ERR_INVALID_ARG_TYPE]`, live-reproduced). Fixed with the same `::timestamptz`-cast-from-ISO-string pattern the cursor comparison already used. This was silently broken in Phase 1–3 too — nothing there exercised `after`/`before` against the real Postgres-backed store, only the in-memory test double.
  - G3–G7 additive: `MessageSummary` gained `direction`/`from`/`to`/`received_at`/`created_at`; `listMessages` gained a `direction` filter; `listInboxes` gained an exact case-insensitive `address` filter; every route now declares 4xx `ErrorResponse`; hand-written OpenAPI components replaced with real Zod-derived ones via `createJsonSchemaTransformObject`.
  - `openapi:export` script + `packages/sdk/openapi.json` (committed) + an `apps/api` drift test that regenerates the spec in memory and deep-equals it against the committed file.
  - 51/51 `apps/api` tests green (43 prior + 8 new), typecheck/lint green, no migration.
- **P4-18 (DONE, 2026-09-23):** `packages/sdk` — `openapi-typescript` generated types (`src/generated/openapi.ts`, committed) + `openapi-fetch` runtime + hand-written `LocalMail` client, resource namespaces (inboxes/threads/messages/attachments/webhooks), `subscribe()` on `ws` with header auth, `waitForEmail` (subscribe → catch-up → dedupe → `message.labeled` recheck → reconcile poll), `replyToThread`, `verifyWebhookSignature`. Zero `@localmail/*` deps (asserted by test).
  - 20/20 SDK tests green: deps assertion, retry policy (POST w/o key never retried, retried w/ key on 503, 409 never retried, GET retried on 502), multipart FormData shape, `replyToThread` (last-inbound / fallback / 404), webhook-signature vectors (accept/tamper/stale/malformed), `waitForEmail` race matrix (catch-up-before-subscribe, WS `message.received` path, outbound ignored, `labels:['otp']` resolves on `message.labeled`, WS-refused falls back to polling, timeout rejects `LocalMailTimeoutError` with no open handles — `--pool=forks` process exits cleanly). Typecheck/lint/build green.
  - **Live smoke passed end-to-end** against the real stack (API :8080, SMTP :2525, workers, Postgres/Redis/MinIO/Mailpit): created an inbox (idempotent replay on the same `client_id` returned the same inbox), delivered `fixtures/emails/02-otp-code.eml` over curl-SMTP, `waitForEmail` (no filter) resolved in ~4.4s via the catch-up+poll path with the correct message, `replyToThread` produced a reply with `in_reply_to` set to the inbound `Message-ID`, `messages.updateLabels` added `triaged`/removed `unread` (confirmed via GET — final labels `inbox, otp, triaged`), `me()` and `inboxes.resolve(address)` both verified.
- **Order:** P4-18-api → P4-18 → {P4-20 → P4-19 → P4-21} (the last three are independent, not started).
- **Environment note:** started SMTP + workers (were down at the start of this session; API, Postgres/Redis/MinIO/Mailpit were already up). Ran with `JEV_ENABLED=false` was not needed for this smoke — the rules-based classifier path ran and applied `otp`/`newsletter` labels as expected from the fixture set.

## Phase 0 — done
- Docker Compose up: postgres, redis, minio (quay.io mirror), mailpit — all healthy
- `pnpm db:migrate` ✅
- `pnpm db:seed` ✅ (pod + hashed admin key + demo inbox)
- API `pnpm --filter @localmail/api dev` ✅
  - `GET /healthz` → 200
  - `GET /docs` → 200
  - `GET /v1/inboxes` → 404 (expected; Phase 1)

## Notes
- Docker Hub `minio/minio` pulls are denied on this machine; `docker-compose.yml` uses `quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z`
- Docker CLI for automation: `$HOME/.docker/bin` (Desktop app installed; not always on default PATH)
- MinIO bucket `localmail` created via `mc`


- **P4-20 Claude MCP registration: DONE** (2026-09-23 12:02 ) — `claude mcp add localmail` (user-approved); local scope; key in ~/.claude.json only.

## Next
P5-25b is complete. Next is the next approved Phase 5 task; pgvector, domains, dashboard, SDK, and metrics stretch work remain out of scope.

## Phase 3 — P3-17 Reply-loop protection: DONE
- **Suppression point:** inbound ingest sets `message.received.suppressAgentTriggers` on RFC 3834 `Auto-Submitted: auto-replied|auto-generated|auto-notified`; `packages/events` `planEventFanout()` / `emit()` then **skips webhook deliveries, WS publish, and `jev-classify` enqueue** while still inserting the `events` audit row. Ingest also applies label `auto`, sets `skipClassify`, and emits `message.labeled` (so dashboards see `auto` without Jev).
- **Jev `auto` fallback limitation (honest):** classify runs after a normal `message.received` fan-out. We cannot retract that delivery; strongest as-built behavior is `message.labeled` with `auto`. Reply agents should not treat `message.received` alone as license to auto-reply when labels may later include `auto`. OTP remains out of scope for `auto` (design §7.1).
- Tests: core **33** (OOO/bounce fixtures → suppress + no classify signal); events **5** (`planEventFanout`); API outbound hop loop still caps at max hops **without** `Auto-Submitted`. Lint/typecheck clean.

## Phase 3 — P3-14b + P3-15: DONE
- **P3-14a** design still the source of truth: `docs/jev-classify-phase3.md`.
- New package `@localmail/jev`: one `classify()` entrypoint; live path = `@typesafe-ai/sdk` `systemOne` (Choice category + four Noul checks); batch defaults + per-question threshold re-derivation; 5s timeout; circuit breaker 5/60s→30s; UA `localmail-jev/1.0`.
- Worker queue `jev-classify`; `packages/events` `emit()` enqueues `{messageId}` on `message.received` only; skips P3-16 `skip_classify`.
- `MessageLabeledEvent` added to `MessageEvent`; labels applied per design §7.4 (`needs-human` hyphenated; `other` → no category label).
- Tests: `@localmail/jev` **7**; `@localmail/workers` **7** (incl. skip_classify). Typecheck/lint clean.
- **Live rules (`JEV_ENABLED=false`):** SMTP §9 billing → `msg_7620e48d…` `source=rules` labels `{inbox,unread,billing,urgent,needs-human}` + `message.labeled` `evt_55f630d5…`.
- **Live Jev (`JEV_ENABLED=true`):** SMTP §9 billing → `msg_1d16e55f…` `source=jev` same label subset in **282 ms** (Typesafe path worked; did not need Cloudflare UA fallback beyond setting `localmail-jev/1.0`).
- Heuristics spec: `docs/jev-rules-fallback.md` — **urgent is caught** (ASAP/urgent/etc.).

## Phase 3 / cross-cutting — X-2 + P3-16: DONE
- **X-2 Fixture set:** nine `.eml` files in `fixtures/emails/`; core parse smoke **6** tests (`fixtures-emails.test.ts`). Billing fixture matches §9 (“I was charged twice!” / refund ASAP).
- **P3-16 Allow/block:** `SENDER_BLOCK_MODE=drop|spam` (default `drop`); no migration — uses existing `sender_rules`. Match rules + `skip_classify` contract in `docs/sender-rules.md`.
  - Core tests **29** total (10 sender-rules); SMTP tests **7**. Typecheck/lint clean.
  - Live: rule `*@evil.test` → drop `550` / count unchanged; spam → `msg_fdc3d807…` labels `{spam,unread,skip_classify}`.

## Phase 2 — DONE (P2-11a/b, P2-12, P2-13a/b)
- **P2-11a Events + webhook design: APPROVED.** Doc: `docs/events-webhooks-phase2.md`.
- **P2-11b Webhook delivery worker: DONE.** New `@localmail/events` package (`createDurableEventPublisher`, `WEBHOOK_RETRY_DELAYS_MS`/`webhookBackoffDelayMs`, `createRedisConnection`); BullMQ 6.3.8 worker on queue `webhook-deliver` / job `deliver-webhook`; HMAC `X-LocalMail-Signature: t=…,v1=…` over exact `t + "." + body`; 2xx-only success, no redirects, 10s timeout; `APP_ENCRYPTION_KEY` fail-loud at API/workers bootstrap; fan-out at emit time wired into SMTP inbound + API outbound (`message.sent`).
  - Unit: `@localmail/events` 2 tests (exact backoff delays); `@localmail/workers` 5 tests (500×5 → `failed`, interim `next_retry_at`, 2xx → `delivered`, HMAC accept/reject). Touched packages remain green: api 30, smtp 4, core 13. Typecheck/lint clean across events/workers/api/smtp/core.
  - Live smoke: insert encrypted webhook → emit `message.received` → worker POSTed signed envelope; receiver verified HMAC (`ok: true`) for `evt_2f28595621f346d580afd2cdb936fa1f` with thin `{inbox_id,thread_id,message_id}` data.
  - Explicitly deferred: `(webhook_id, event_id)` unique index (design §5 gap).
- **P2-12 Webhook CRUD + test-fire + delivery log: DONE.** Routes under `/v1/webhooks` with scopes `webhooks:read`/`webhooks:write`; secret shown once on POST 201 (encrypted at rest), omitted from GET; `enqueueTestFire` forces a `webhook.test` delivery for that webhook_id ignoring enabled/event_types/inbox_ids; same BullMQ deliver path as real events.
  - API tests: **34** passing (CRUD, secret omission, scopes, pod 404 isolation, test-fire → real delivery row). Typecheck/lint clean.
  - Live smoke: create `wh_a639c347…` (`enabled:false`) → POST test → `whd_7a302d77…` / `evt_b856be59…` → worker delivered signed `webhook.test` → GET deliveries `status=delivered` `attempts=1`.
- **P2-13a WebSocket design: APPROVED.** Doc: `docs/websocket-phase2.md`.
- **P2-13b WebSocket endpoint: DONE.** `GET /v1/ws` (`@fastify/websocket`) with existing Bearer auth + `ws:connect`; `ws-hub.ts` reference-counted Redis subscribe on `localmail:ws:<pod_id>`; per-connection filters; `emit()` PUBLISHes envelope in parallel with BullMQ (test-fire excluded); protocol ping 30s / pong 10s / close `4000`.
  - API tests: **43** passing (ws-hub filters + invalid inbox/event_type; WS auth 401/403; invalid_inbox_id keeps connection open). Typecheck/lint clean.
  - Live e2e (agentmail.md §12): SMTP accept → WS `message.received` for `inb_demo` in **1 ms** (`evt_a1354144…`), well under the 1s bound.

## Phase 1 — DONE (core P1-4 → P1-10 closed; P1-7 already approved)
- Herdr LocalMail (`wA`): `claude-lm` → **P1-4a** API contract design (done, see below); `codex-lm` → **P1-7** threading engine (parallel)
- **P1-7 threading engine implemented:** header-first resolution with injected lookup and normalized-subject fallback; 11 core tests passing.
- **P1-7-review: APPROVED.** No blocking findings. Sign-off and edge-case notes (forward-as-new-thread, RFC 2047 boundary, `[list-name]` prefix ordering — deliberately deferred, already tested-and-documented, not fixed) recorded in TASKS.md under P1-7-review. One non-blocking recommendation for whoever implements P1-6/P1-8: document that the injected `lookup` callback must be scoped per-inbox.
- **P1-4b API skeleton: DONE.** Fastify Zod provider, generated OpenAPI/Swagger UI, prefix-12+scrypt authentication, request pod/key context, scope guards, contract error catalog, and persistent `Idempotency-Key` replay/conflict handling are wired for future `/v1` routes.
  - `pnpm --filter @localmail/api test` → 11 passing tests; typecheck and lint clean
  - live Docker/PostgreSQL smoke: `/healthz` 200, `/docs` 200, seeded admin key `/v1/me` 200, bad key exact `invalid_api_key` envelope 401
  - PostgreSQL confirms authenticated use updated `api_keys.last_used_at`
- **P1-5 Inboxes CRUD: DONE.** Auth-scoped create/list/get/patch/delete routes now use the Phase 1 contract, opaque cursor pagination, `agent-<6 char>` generated usernames, and `MAIL_DOMAIN` addresses.
  - `pnpm --filter @localmail/api test` → 17 passing tests (including focused CRUD, scope, collision, `client_id`, and pagination coverage); typecheck and lint clean
  - DB-level uniqueness is enforced by the existing `address`, `(pod_id, username, domain)`, and `client_id` unique indexes; creation uses `ON CONFLICT DO NOTHING`, avoiding check-then-insert races
  - live Docker/PostgreSQL curl smoke: create `201` in `0.087772s` (~88 ms, below the 100 ms target); repeated `client_id` returned the same inbox ID; list/get/patch `200`; delete `204`; post-delete get `404`; bad key `401 invalid_api_key`
- **P1-6 Inbound SMTP: DONE.** `smtp-server` listens on `2525`; `onRcptTo` performs mailbox and allow/block-policy checks before DATA; mailparser ingestion writes raw RFC822 plus attachments to MinIO, persists threads/messages with `inbox,unread`, and emits through a replaceable `message.received` interface.
  - `pnpm --filter @localmail/smtp test` → 4 passing tests; SMTP typecheck, lint, and build clean. Touched core package remains green: 11 tests plus typecheck/lint.
  - known-recipient curl SMTP smoke: `RCPT TO` → `250`, `DATA` → `354`, final acceptance → `250`; PostgreSQL contains the parsed message and attachment with labels `inbox,unread`
  - MinIO HEAD proof: raw `.eml` exists at `raw/inb_demo/msg_cdf3fe75aa7543348c02717f4e4bcc08.eml` (548 bytes, `message/rfc822`) and attachment exists (16 bytes, `text/plain`)
  - reply smoke resolved through the inbox-scoped core lookup to the original thread; both messages share `thr_2c1f32e5ca4246f3a59db49a79a16c03`, whose `message_count` is `2`
  - unknown-recipient transcript: `RCPT TO:<missing@localmail.test>` → `550 Mailbox unavailable`; client issued `QUIT` immediately, with no `DATA` command or body transfer
- **P1-8 Send/reply/forward + loopback + hop guard: DONE.** Contract routes are protected by `messages:send` and the existing POST idempotency middleware; Nodemailer handles external SMTP, while local recipients call the same shared inbound ingestor directly.
  - API tests: 22 passing; core: 13; SMTP: 4; config: 2. Typecheck and lint pass for every touched package.
  - migration `0001_clever_obadiah_stane.sql` persists `hop_count` and scopes Message-ID uniqueness to `(inbox_id, message_id_header)`, allowing one looped message to exist in sender and recipient inboxes
  - pure loopback smoke kept Mailpit at `0`; PostgreSQL showed sender `outbound/sent` and recipient `inbound/inbox,unread` rows with the same Message-ID and hop `1`
  - reply-to-reply smoke produced full `References` chains and stable per-inbox threads: both inboxes reached `message_count=3` with hop sequence `1 → 2 → 3`; Mailpit remained `0`
  - external-recipient smoke reached Mailpit through Nodemailer (`total=1`, subject `P1-8 Mailpit smoke`); replaying the same `Idempotency-Key` returned the same message with `Idempotency-Replay: true` and Mailpit stayed at `1`
  - synthetic two-inbox unit loop stopped after three deliveries at a configured max of `3`; live hop `20` reply returned `400 validation_error` with `maximum hop count 20 reached`
- **P1-9 List/get threads and messages: DONE.** Auth-scoped thread/message list and detail routes support opaque descending cursors plus label, time, sender, and unread filters; raw RFC822 bodies stream directly from MinIO.
  - API tests: 26 passing; typecheck and lint clean. Touched core package: 13 tests plus typecheck/lint clean.
  - pagination test inserts a newer message between page fetches and proves the remaining older row is returned with no duplicate or skip; timestamp ties use the message/thread ID as a deterministic cursor tie-breaker
  - focused coverage includes all filters, slim list summaries versus full message content, exact malformed-token details, fake-store raw bytes, and cross-pod/missing-resource `404` isolation across all five routes
  - live PostgreSQL smoke returned thread/message lists and details at `200`; two message pages had zero overlapping IDs; malformed cursor returned `400 validation_error`
  - live MinIO raw smoke returned `200`, `Content-Type: message/rfc822`, and the byte-exact known 548-byte `.eml` containing `Message-ID: <p16-smoke-20260923@localmail.test>`
- **P1-10 Attachments: DONE.** Multipart upload on send/reply/forward (JSON still works); MinIO + `attachments` table; HMAC signed download URLs; streaming 25 MiB cap; preview content-type allowlist.
  - Approach: multipart `payload` JSON field + `attachments` file parts; streaming `readAttachmentStream` rejects oversize mid-read with `413 payload_too_large` before full buffer; `PREVIEW_CONTENT_TYPES` drives `inline` vs attachment disposition; `createAttachmentUrlSigner` HMAC-SHA256 over pod/inbox/message/attachment/expires.
  - `pnpm --filter @localmail/api test` → **30 passing**; typecheck and lint clean (reconfirmed 2026-09-23).
  - Live multipart send → `201` `msg_f6c197d274bd4cd5923184f24c541d70`; DB row `att_ae676129ef0642469cd5199b742b8bcc` `text/plain` 39 bytes in MinIO.
  - Signed URL (`expires_in=30`) → download `200`, `Content-Disposition: inline; filename="localmail-p110-attachment.txt"`, exact 39 bytes `LocalMail P1-10 live attachment smoke.`; `expires_in=1` past expiry → `400 validation_error` `signed URL has expired`.
  - Raw endpoint `200` with `filename=localmail-p110-attachment.txt`; Mailpit total 2.
- Stack still running; API on `:8080` and inbound SMTP on `:2525`

### P1-4a — API contract design: **ready for Codex**
Doc: [`docs/api-contract-phase1.md`](docs/api-contract-phase1.md) (APPROVED checklist at top).

Covers: auth middleware (grounded in the scrypt/prefix-12 format `packages/db/src/seed.ts` already
shipped — **not argon2**, deviation from agentmail.md §13 logged in the doc), full Phase-1 error
code catalog, opaque pagination cursor format, `Idempotency-Key` semantics against the as-built
`idempotency_keys` table (with a documented concurrency limitation — no in-flight state in the
current schema), OpenAPI tag/operationId/schema-name conventions for `/docs`, and the field-level
route sketch for inboxes/threads/messages/send/reply/forward.

Also enumerates 8 concrete gaps between the Phase 0 stub (`apps/api/src/app.ts`) and P1-4b's DoD —
static `/docs` stub, no Zod type-provider wired in yet, error handler too coarse, no auth plugin,
no query/repository layer in `packages/db` beyond `createDatabase()`, etc. — so Codex isn't
guessing at what already exists vs. what P1-4b needs to add.
