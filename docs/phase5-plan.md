# Phase 5 — Polish / Stretch Plan (Drafts · Pods/Keys · Domains · Search · Dashboard · Python SDK · Metrics)

> Planning deliverable for Phase 5 (agentmail.md §10 tasks 22–28). **Plan only, no code, no migrations.**
> Owner of this doc: **Claude Code** (design/schema/API-contract tasks per AGENTS.md §2). **Codex implements** every `*b` task after its `*a` design is approved, per the repo's standing Phase 0–3 split (Phase 4's "Claude implements everything" override does not apply here — no such override was given for Phase 5).
> Grounded in the repo as it stands on 2026-09-23: `packages/db/src/schema.ts` (read directly), `apps/api/src/*` route files (read directly — no domains/pods/drafts/search routes exist yet), `packages/core/src/crypto.ts` (read directly — AES-256-GCM helpers already exist and are used by `apps/api/src/webhooks.ts`), `apps/dashboard/src/index.ts` (a one-file stub, not a Next.js app yet), STATUS.md, PLAN.md, `docs/phase4-plan.md` / `docs/phase4-handoff.md`, and AGENTS.md. I did not start any server for this pass (planning-only constraint) and made no live API calls.

---

## 0. Summary

The schema in `packages/db/src/schema.ts` was built ahead of Phases 1–3's actual needs and **already covers most of Phase 5's storage**: `drafts` (with `send_at`/`status` enum including `scheduled`/`sending`/`sent`/`failed`), `domains` (with `dkim_private_key`, `dns_records jsonb`, `status` enum), `api_keys.scopes` (already an array, already enforced by `requireScope()`), and `messages.search` (a **generated `tsvector` column with a GIN index already in place** — full-text search needs no schema change at all, just a route). What's genuinely greenfield is: no `pods`/`api_keys` management routes exist (only the seed script inserts one pod + one admin key), no rate limiting exists anywhere (though `rate_limited` is already a defined `ApiErrorCode` in `apps/api/src/errors.ts` — reserved but unused), no `apps/api/src/domains.ts` exists, no DKIM message-signing code exists, no draft routes exist, no search route exists, `apps/dashboard` is a one-file stub (not a Next.js app), and there is no `packages/sdk-python` or metrics/k6 tooling.

**Recommended ship order (see §1 for reasoning):**
1. **P5-22 Drafts + scheduled send** — MVP. Unlocks agent workflows (draft-then-send) that examples/agents already want.
2. **P5-23 Pods + scoped API keys + rate limiting** — MVP. Removes the accepted Phase 4 limitation (every SDK/CLI/MCP/example call runs on the `*`-scope admin key — plan §2.3 G11 in `docs/phase4-plan.md`).
3. **P5-25 (FTS half only) Full-text search** — MVP. The `messages.search` column and its GIN index already exist; this is close to "just add a route."
4. **P5-24 Custom domains (mock DNS verify, DKIM signing)** — stretch. Should land before anyone is tempted to treat outbound mail as publicly deliverable.
5. **P5-26 Next.js dashboard** — stretch. Needs 22–25's APIs to exist first to have something to render; `apps/dashboard` today is a placeholder object, not a scaffolded Next.js app, so this is a from-scratch app, not a resume.
6. **P5-27 Python SDK** — stretch, trails the TS SDK by design (mirrors an already-stable OpenAPI spec, lowest risk of the remaining tasks).
7. **P5-25 (pgvector half)** — stretch, explicitly sequenced after FTS ships and is in real use (semantic search is additive on top of, not a replacement for, FTS).
8. **P5-28 Metrics + structured logging + k6 load test** — last. Most useful once Phase 5's other surfaces exist to generate load against, and it's the task most likely to reveal issues introduced by 22–27 rather than pre-empt them.

**MVP cut for "Phase 5 done enough to call it a release":** P5-22, P5-23, P5-25 (FTS only, not pgvector). Everything else (P5-24, P5-26, P5-27, pgvector, P5-28) is explicitly stretch and can ship independently in any order after the MVP cut, respecting each task's own dependencies below.

---

## 1. Why this order (not agentmail.md's raw 22→28 sequence)

| Task | Why here, not earlier/later |
|---|---|
| 22 (drafts) | No dependency on anything else in Phase 5; schema already exists; unblocks nothing in Phase 5 itself but is the cheapest task to ship and immediately useful to agents composing multi-step sends. Ships first so there's a second "everything's already DONE" precedent before the two bigger design tasks (23, 24). |
| 23 (pods/keys/rate limit) | Explicitly called out in `docs/phase4-handoff.md` as removing an accepted limitation (G11: every Phase 4 surface runs on the admin key). The longer this waits, the more Phase 5 surfaces (drafts routes, domains routes, search) get built and tested against the admin key instead of scoped keys, which is backwards — new scopes should exist *before* new routes need scope-gating decisions made for them. Also, rate limiting is the one thing here that's genuinely load-bearing infrastructure (protects Postgres/Redis from a runaway agent), so it belongs early, not "when there's time." |
| 25 FTS half | The tsvector column and its GIN index are **already migrated in** (`messages_search_gin_idx`, `packages/db/src/schema.ts:186`). This is the single lowest-risk task in the phase — no migration, no new external dependency, no design ambiguity beyond query/ranking conventions. Doing it before the dashboard means the dashboard's search UI (26) has something real to call instead of a route built in the same pass as its UI. |
| 24 (domains/DKIM) | agentmail.md's non-goals (§1) already say SPF/DKIM/DMARC are simulated/stubbed for v1 — this task is that simulation. It's ordered after 22/23/25 because it's the largest single design surface in Phase 5 (DNS record shape, DKIM keypair generation, signing integration into the existing outbound path in `apps/api/src/outbound.ts`) and benefits from scoped keys (23) existing first, since domain management is exactly the kind of admin-only operation scoped keys were built for. |
| 26 (dashboard) | Genuinely needs 22–25's APIs to exist — a thread viewer, webhook log, and Jev-decision viewer are all read-only against APIs Phase 1–4 already shipped, but a drafts UI and a domains/DKIM UI need 22 and 24 to exist first, and `apps/dashboard` today has none of Next.js scaffolded (see §3.5) so this is real from-scratch work, not integration. |
| 27 (Python SDK) | Mirrors an OpenAPI spec that's more stable the later this runs — every prior task in this list adds paths to `packages/sdk/openapi.json`. Running it last among the "additive SDK" tasks means one regen instead of several. Lowest technical risk of everything left (thin wrapper, same pattern as `packages/sdk`'s TS client), so it doesn't need to be early to hedge risk. |
| 28 (metrics/k6) | Explicitly last: metrics are more useful instrumenting a system with drafts/domains/rate-limiting/search already in it (so the load test and dashboards reflect real Phase 5 surfaces, not just Phase 0–4), and a k6 load test run before Phase 5's routes exist would need to be re-run anyway once they land. |

---

## 2. Gap analysis vs. as-built (read directly, not assumed)

| Area | As-built today | What Phase 5 needs to add |
|---|---|---|
| **Drafts** | `packages/db/src/schema.ts:207` `drafts` table exists in full (`to`/`cc`/`subject`/`text`/`html`/`send_at`/`status` enum `draft\|scheduled\|sending\|sent\|failed`). **No `bcc` column** (agentmail.md §2.3 doesn't mention `bcc` on drafts either — consistent, not a gap). No `apps/api/src/drafts.ts` route file. No scheduled-send worker/queue. | Draft CRUD + send routes; a `scheduled-send` BullMQ worker (or a poll-based cron, see §4.4) that promotes `status: scheduled` rows past `send_at` into real outbound messages via the existing `apps/api/src/outbound.ts` send path. |
| **Pods / scoped keys / rate limiting** | `pods` table exists (`id`, `name`, `created_at` only — no per-pod settings/limits columns). `api_keys.scopes` is already `text[]`, already enforced (`requireScope()` in `apps/api/src/auth.ts:54`, 9 scopes currently in use — see §4.2). Only the seed script (`packages/db/src/seed.ts`) creates a pod + a `*`-scope admin key; **no route creates a second pod or a second, narrower-scoped key.** `rate_limited` is already a defined `ApiErrorCode` (`apps/api/src/errors.ts:11`) but nothing throws it — reserved and unused. | `POST /v1/pods` (bootstrap-only or admin-scoped), `POST /v1/api-keys` (create scoped key, show secret once — same pattern webhook secrets already use), `DELETE /v1/api-keys/:id` (revoke), and a rate-limit middleware keyed on `api_key.id` (or `pod_id` as a coarser fallback) backed by Redis (already a Phase 2 dependency, no new infra). |
| **Custom domains / DKIM** | `domains` table exists in full (`domain`, `status` enum `pending\|verified\|failed`, `dkim_private_key text`, `dns_records jsonb`). `packages/core/src/crypto.ts` already has `encryptSecret`/`decryptSecret` (AES-256-GCM) and is **already used by `apps/api/src/webhooks.ts`** for webhook secrets — the exact pattern PLAN.md Decision 3.2 asks for on `dkim_private_key` too, but nothing calls it for domains yet because no domains route exists at all. No DKIM keypair generation, no DKIM signing step in the outbound send path, no mock-DNS verify endpoint. | `apps/api/src/domains.ts` (CRUD + `POST /v1/domains/:id/verify`), DKIM keypair generation (Node `crypto.generateKeyPair('rsa', ...)`) on domain creation with the private key passed through `encryptSecret` before storage, a DKIM-signing step wired into `apps/api/src/outbound.ts`'s existing Nodemailer send path (only for messages sent from a `verified` domain), and a mock DNS table (see §4.3) for the verify endpoint to check against. |
| **Search** | `messages.search` is a **generated tsvector column with a GIN index already migrated in** (`packages/db/src/schema.ts:173-186`, `messages_search_gin_idx`). No `pgvector` extension, no embedding column, no `GET /v1/search` route. | A `GET /v1/search` route using Postgres `@@`/`ts_rank` against the existing column — no migration for the FTS half. The pgvector half (embeddings column, `pgvector` extension enable, embedding-generation worker) is new schema and genuinely stretch — scoped separately (P5-25c/d) so it doesn't block the FTS route. |
| **Dashboard** | `apps/dashboard/src/index.ts` is an 8-line placeholder object (`{ name, framework: 'Next.js 15 (planned)', status: 'stub' }`). `package.json` has `build`/`lint`/`test`/`typecheck` scripts but **no Next.js dependency, no `next.config`, no `app/` or `pages/` directory** — this is not a started scaffold, it's a package-boundary placeholder. Per PLAN.md Decision 2.4, `apps/dashboard` has **no dependency edge to `packages/jev` or `packages/db`** — it must talk to `apps/api` via `packages/sdk`, same as any external agent. | Real Next.js 15 app scaffold, SDK-only data access, read views for inboxes/threads/webhook log/Jev decisions (all backed by existing APIs), plus new views for drafts (22) and domains (24) once those ship. |
| **Python SDK** | Nothing exists (`packages/sdk-python` doesn't exist). `packages/sdk/openapi.json` (committed, Phase 4) is the source of truth to generate/hand-write against. | New `packages/sdk-python` (or a separate top-level `python/` — see open question in §7), mirroring the TS SDK's method surface (not a 1:1 codegen requirement — see §4.6). |
| **Metrics/logging/k6** | `pino` is already the logger (per agentmail.md §3's tech stack table — used throughout `apps/api`, `apps/smtp`, `apps/workers`; not independently re-verified in this pass beyond the tech-stack doc, since it's not a Phase 5-specific gap). No `prom-client`, no `/metrics` route, no k6 scripts anywhere in the repo. | `/metrics` route (prom-client, request duration/count histograms, queue depth gauges), structured-logging conventions doc (request-id propagation, redaction rules — API keys must never appear in logs, per the CLI's existing redaction-sentinel test in Phase 4), and a `k6/` directory with a 1,000-inbox/10,000-message load script. |

---

## 3. API contracts for new surfaces

Conventions match `docs/api-contract-phase1.md` and the live pattern in `apps/api/src/*.ts`: Zod schemas, `operationId` in camelCase, cursor pagination (`page_token`/`limit`) for lists, `{ error: { code, message, details? } }` on failure, `Idempotency-Key` honored on every POST that creates a resource (reuses the existing `idempotency_keys` table/middleware in `apps/api/src/idempotency.ts` — no new idempotency infra needed).

### 3.1 Drafts (P5-22)

| Method | Path | operationId | Scope |
|---|---|---|---|
| POST | `/v1/inboxes/:inbox_id/drafts` | `createDraft` | `drafts:write` (new scope) |
| GET | `/v1/inboxes/:inbox_id/drafts` | `listDrafts` | `drafts:read` (new scope) |
| GET | `/v1/inboxes/:inbox_id/drafts/:draft_id` | `getDraft` | `drafts:read` |
| PATCH | `/v1/inboxes/:inbox_id/drafts/:draft_id` | `updateDraft` | `drafts:write` |
| DELETE | `/v1/inboxes/:inbox_id/drafts/:draft_id` | `deleteDraft` | `drafts:write` |
| POST | `/v1/inboxes/:inbox_id/drafts/:draft_id/send` | `sendDraft` | `messages:send` (reuse — sending is sending, regardless of origin) |

Request/response shapes mirror the existing `messages/send` body (`to`/`cc`/`subject`/`text`/`html`/`thread_id?`) plus `send_at?: string (ISO-8601)`. `sendDraft` with no `send_at` sends immediately through the existing outbound path and sets `status: 'sent'`; with `send_at` in the future, sets `status: 'scheduled'` and returns immediately (202-style semantics on a 200, matching the rest of the API's non-use of 202 elsewhere) — the scheduled-send worker (§4.4) does the actual send later. `updateDraft` on a `scheduled`/`sending`/`sent` draft is a `409`-shaped `validation_error` (can't edit what's already queued/sent) — exact wording is a design decision for P5-22a, not this doc.

**Error cases to design explicitly in P5-22a:** editing a draft mid-flight (race between the worker picking it up and a PATCH), `send_at` in the past (reject at `422` or coerce to "send now" — pick one, document why), and what happens to a `scheduled` draft if its inbox is deleted before `send_at` (orphan cleanup — likely `ON DELETE CASCADE` already handles the row, but the worker needs to handle "draft's inbox no longer exists" gracefully either way).

### 3.2 Pods / API keys / rate limiting (P5-23)

| Method | Path | operationId | Scope |
|---|---|---|---|
| POST | `/v1/pods` | `createPod` | admin-only (see open question §7 — how is "admin" distinguished from "has `*` scope on *a* pod"?) |
| GET | `/v1/pods/:pod_id` | `getPod` | any key scoped to that pod |
| POST | `/v1/api-keys` | `createApiKey` | `api_keys:write` (new scope) — body includes `scopes: string[]`, response includes the raw key **once** (same "show once" pattern as webhook secrets) |
| GET | `/v1/api-keys` | `listApiKeys` | `api_keys:read` (new scope) — never returns `hash`, only `prefix`/`scopes`/`last_used_at`/`revoked_at` |
| DELETE | `/v1/api-keys/:id` | `revokeApiKey` | `api_keys:write` |

**Rate limiting** is middleware, not a route. Design question for P5-23a: token-bucket in Redis keyed on `api_key.id`, default limit configurable via env (e.g. `RATE_LIMIT_RPS`, `RATE_LIMIT_BURST`), `429` with `ApiErrorCode: 'rate_limited'` (already defined) and a `Retry-After` header. Whether limits are per-key or per-pod (a pod with many keys could still overwhelm shared Postgres/Redis even if each key is individually under limit) is a P5-23a design decision, not assumed here — flagged again in §7.

### 3.3 Custom domains (P5-24)

| Method | Path | operationId | Scope |
|---|---|---|---|
| POST | `/v1/domains` | `createDomain` | `domains:write` (new scope) — generates DKIM keypair server-side, encrypts private key via `packages/core/crypto.ts` (existing helper), returns `dns_records` (MX/SPF/DKIM TXT/DMARC) the caller would need to set on a real DNS provider (simulated — see §5 non-goals) |
| GET | `/v1/domains` | `listDomains` | `domains:read` (new scope) |
| GET | `/v1/domains/:id` | `getDomain` | `domains:read` — never returns `dkim_private_key`, encrypted or not |
| DELETE | `/v1/domains/:id` | `deleteDomain` | `domains:write` |
| POST | `/v1/domains/:id/verify` | `verifyDomain` | `domains:write` — checks the mock DNS table (§4.3), flips `status: pending → verified\|failed` |

Outbound signing: `apps/api/src/outbound.ts`'s send path, when the sending inbox's domain matches a `verified` custom domain, decrypts the DKIM private key and signs the MIME message before handing it to Nodemailer (most Nodemailer setups can do this via `dkim: { privateKey, keySelector, domainName }` on the transport config — confirm against the installed Nodemailer version during P5-24b, not assumed here). Messages sent from the default `MAIL_DOMAIN` (unverified, agentmail.md's baseline) are **not** DKIM-signed — that's the existing, unchanged behavior.

### 3.4 Search (P5-25, FTS half)

| Method | Path | operationId | Scope |
|---|---|---|---|
| GET | `/v1/search?q=…&inbox_id=…&limit=…&page_token=…` | `searchMessages` | `messages:read` (reuse — searching messages is reading messages) |

Query: `plainto_tsquery('english', q)` against `messages.search` (already indexed), `ORDER BY ts_rank(search, query) DESC`, same cursor-pagination shape as `listMessages`. Response shape reuses `MessageSummary` (already has `direction`/`from`/`to`/timestamps per the Phase 4 gap-closure, per `STATUS.md`'s P4-18-api entry) plus a `rank: number` field. Scoping to `inbox_id` is optional (agentmail.md §2.9 implies pod-wide search is in scope — a pod-wide query still needs to filter through the caller's key's accessible inboxes, which is already how every other list route in `apps/api` works via the auth-context pod filter).

### 3.5 Dashboard (P5-26)

Not a REST surface of its own — it's a consumer of every API above plus the existing Phase 1–4 surface, via `packages/sdk` only (PLAN.md Decision 2.4 — `apps/dashboard` has zero dependency edge to `packages/db`/`packages/jev`). One new thing the dashboard needs that doesn't exist yet: **a way to authenticate as a human in a browser**, since the existing auth model is a static Bearer API key meant for agents/scripts. P5-26a must decide this explicitly (a dashboard-only session cookie backed by a pod-scoped key entered once via a login form is the most consistent option with the existing model — do not invent a second auth system). Read-only views (inboxes, thread viewer with raw-header expand, webhook delivery log, Jev decisions + confidence) need no new API beyond what exists today; the drafts and domains views depend on P5-22/P5-24 shipping first.

### 3.6 Python SDK (P5-27)

Not a new API surface — a new client. Mirrors `packages/sdk`'s public method surface (`inboxes.*`, `threads.*`, `messages.*`, `drafts.*`, `webhooks.*`, `domains.*`, `search()`, `subscribe()`/`waitForEmail` equivalent, `verifyWebhookSignature`) against the same committed `packages/sdk/openapi.json`. Design question for whoever scopes this (no `*a` design task proposed here — see §4.6 for why): hand-written idiomatic client (matching the TS SDK's approach — `openapi-typescript`/`openapi-fetch` there, `httpx` + hand-written types or `openapi-python-client` here) vs. raw codegen. Recommend hand-written, matching the TS SDK's own precedent, since `waitForEmail`'s WS-subscribe-then-poll logic (Phase 4's trickiest piece, and the one place a real bug was found and fixed per `STATUS.md`) doesn't come free from any OpenAPI codegen tool.

### 3.7 Metrics (P5-28)

| Method | Path | Purpose |
|---|---|---|
| GET | `/metrics` | Prometheus exposition format (prom-client) — request duration/count by route+status, BullMQ queue depth/active/failed gauges (webhook-deliver, jev-classify, scheduled-send), WS connection count |

Not versioned under `/v1` (metrics endpoints conventionally sit outside API versioning, same as `/healthz` already does). No auth scope — matches `/healthz`'s existing unauthenticated pattern, but P5-28a should confirm this is acceptable for a local-first tool (no PII in metric labels — route templates, not raw paths with IDs) rather than assuming it.

---

## 4. Design notes / worker & queue needs

### 4.1 Drafts scheduled-send worker
New BullMQ queue `scheduled-send`, or — cheaper for a local-first tool — a simple interval poller in `apps/workers` querying `drafts WHERE status = 'scheduled' AND send_at <= now()`, claiming rows with `UPDATE ... SET status = 'sending' WHERE id = ... AND status = 'scheduled' RETURNING *` (optimistic-lock pattern, avoids a second worker double-sending the same draft — no new locking primitive needed). P5-22a should pick one approach explicitly; a BullMQ delayed job (scheduled at creation time with the exact delay) is more precise but means a draft's `send_at` can't be edited without also updating/removing the queued job, which the interval-poller approach sidesteps for free. Recommend the poller for v1 (simpler, matches the "not over-engineering for local-first" instinct already used elsewhere in this repo — e.g. PLAN.md §5's Redis pub/sub note) unless P5-22a's author finds a concrete reason BullMQ's delay is needed.

### 4.2 Scopes to add
Existing scopes in use today (read directly from `apps/api/src/*.ts` `requireScope()` calls): `inboxes:read`, `inboxes:write`, `messages:read`, `messages:send`, `messages:write`, `threads:read`, `webhooks:read`, `webhooks:write`, `ws:connect`. Phase 5 adds: `drafts:read`, `drafts:write`, `domains:read`, `domains:write`, `api_keys:read`, `api_keys:write`. `search` reuses `messages:read` rather than adding a `search:read` scope — one fewer scope to reason about, and searching is a read of messages the key can already read.

### 4.3 Mock DNS table
A `dns_records` JSONB blob already exists per-domain (schema, unused). P5-24a needs to decide the mock verify mechanism: does `POST /v1/domains/:id/verify` (a) always succeed after a fixed delay (simplest — matches "local-first, no real DNS" framing), (b) require the caller to echo back the exact `dns_records` values as a query/body param (closer to how real DNS verification round-trips, more useful as a teaching tool for agents), or (c) check against a seeded `mock_dns_records` table a human/test can populate to simulate propagation delay or failure. Recommend (b) — no new table, and it's the option that actually exercises "did the agent read the records I gave it" rather than being a no-op `200`.

### 4.4 DKIM signing integration point
`apps/api/src/outbound.ts` is the single existing send path (also used by drafts' `sendDraft`, per §3.1 reusing it rather than duplicating). DKIM signing is one conditional branch added there — decrypt-and-sign if the sending domain is `verified`, no-op otherwise — not a new pipeline.

### 4.5 pgvector (P5-25 stretch half)
New `messages.embedding vector(N)` column (dimension depends on the chosen local embedding model — agentmail.md §2.9 says "local embeddings", consistent with the no-real-internet framing; a small sentence-transformers-class model run in `apps/workers` is the natural fit, not an external embeddings API), `pgvector` extension enable (new migration — single schema owner per AGENTS.md §5, same convention as every prior phase), and an embedding-generation worker enqueued alongside `jev-classify` on `message.received`. Explicitly scoped separately (P5-25c design / P5-25d impl) so FTS isn't blocked waiting on an embedding-model decision.

### 4.6 Why no `*a` design task for Python SDK
Every other Phase 5 task either touches the schema, adds new API surface, or introduces a new cross-cutting concern (rate limiting, DKIM) — the three triggers AGENTS.md §2 names for routing a design task to a Claude pane first. The Python SDK adds none of those: it's a client mirroring an already-designed, already-committed OpenAPI spec. A single Codex-owned task (P5-27) is proposed instead of a `*a`/`*b` pair; if whoever picks it up finds a real design fork (e.g. sync vs. async client, which package manager/build tool), that's small enough to resolve in the task itself rather than needing a separate approved design doc first.

---

## 5. Test strategy

| Level | What |
|---|---|
| Unit | Draft status transitions (draft→scheduled→sending→sent, and the reject-mid-flight-edit case); rate-limit token-bucket math (burst, refill, exactly-at-limit boundary); DKIM keypair generation + signature verification against a known-good DKIM library/fixture; FTS query building (`plainto_tsquery` escaping — test injection-shaped input like `q=foo & bar` doesn't error); mock-DNS-verify record-matching logic. |
| Integration (Testcontainers) | Draft send-at-future → poller worker picks it up → message appears in Mailpit/loopback, exactly like an immediate send; scoped-key 403 on out-of-scope routes (extend the existing `insufficient_scope` test pattern from Phase 1); rate-limit 429 after N requests in a window, using a real Redis via Testcontainers (already a Phase 2 dependency in the test stack); domain create → verify → send → confirm the Mailpit-received message has a valid DKIM signature header. |
| Live smoke | Same shape as every prior phase's STATUS.md entries: schedule a draft for +5s, confirm it sends; create a scoped key with only `messages:send`, confirm it can send but gets `403` on `GET /v1/inboxes`; create+verify a domain, send through it, confirm DKIM header in Mailpit; run `q=refund` against the existing fixture set (billing complaint fixture from Phase 1–3) and confirm it ranks first. |
| Dashboard (Playwright, per agentmail.md §11) | Smoke: log in, see the demo inbox's thread list, open a thread, see raw headers, see the webhook delivery log, see a Jev decision with confidence — all against the real stack, no mocked API. |
| k6 (P5-28) | 1,000 inboxes / 10,000 messages per agentmail.md §10 task 28's own spec — script lives under a new `k6/` directory, targets the real API against a seeded dataset, not a synthetic in-memory fake. |

---

## 6. Non-goals / accepted limitations

- **DKIM/DNS remain simulated, not real**, per agentmail.md §1's existing non-goal — P5-24 does not attempt real SPF/DMARC alignment checking or actual DNS record publication. The mock-DNS-verify mechanism (§4.3) is explicitly a local teaching/testing tool, not a real domain-verification flow.
- **Rate limiting is per-key/per-pod in a single Postgres/Redis instance**, not a distributed rate limiter — consistent with the rest of the repo's "100% local, docker-compose" framing (agentmail.md §1). Don't over-build this for a multi-region deployment that doesn't exist.
- **The dashboard is admin/debug tooling, not a human-facing product**, per agentmail.md §1's existing non-goal — P5-26 does not need a polished multi-user permission model beyond "logged in with a pod-scoped key or not."
- **pgvector semantic search is explicitly stretch, sequenced after FTS**, not a parallel/competing feature — don't let it block or reorder the MVP cut.
- **Python SDK does not need feature parity on day one** with every TS SDK helper (e.g. a Python `waitForEmail` is valuable but if it slips, the rest of the SDK shipping without it is still useful) — flag partial delivery rather than blocking the whole task on the hardest helper.
- **No billing/usage plans** — pods/scoped keys here are about capability isolation and abuse protection (rate limiting), not the start of a metered-billing system, per agentmail.md §1's existing non-goal.

---

## 7. Risks + open questions Codex must not invent answers for

| # | Question | Why it needs a human/design-doc answer, not an implementer's guess |
|---|---|---|
| Q1 | How is "admin" distinguished for `POST /v1/pods` — a special bootstrap-only mode, a `pods:write` scope only the seed-created key ever gets, or something else? | Getting this wrong either lets any scoped key spin up new pods (a real isolation bypass) or makes pod creation impossible outside the seed script (blocking the whole point of task 23). This is exactly the kind of cross-cutting auth decision AGENTS.md §2 says should go through a Claude design pane before implementation starts. |
| Q2 | Rate limit scope: per-`api_key.id`, per-`pod_id`, or both (a tighter per-key limit inside a looser per-pod ceiling)? | Changes the Redis key scheme and the 429 semantics; picking wrong means either an easy multi-key bypass (per-key only) or one noisy key starving every other key in the same pod (per-pod only). |
| Q3 | Scheduled-send worker: BullMQ delayed jobs vs. interval poller (§4.1)? | Changes whether editing a draft's `send_at` after scheduling requires touching a queued job — a real behavioral difference, not just an implementation detail. |
| Q4 | Mock DNS verify mechanism: auto-succeed, echo-back, or seeded table (§4.3)? | Changes what the verify endpoint actually tests/teaches — auto-succeed is a no-op that could hide a real bug in how an agent reads `dns_records`. |
| Q5 | DKIM key size / algorithm (RSA-2048 vs. Ed25519) and selector-naming convention? | Needs to match what real-world DKIM verifiers (and this repo's own future verify-side tooling, if any) expect — an arbitrary choice here is a compatibility risk if this project is ever pointed at a real inbox for a demo. |
| Q6 | Dashboard auth: session cookie backed by a pod-scoped key (recommended in §3.5) vs. something else? | A second, parallel auth system would violate the "one auth model" simplicity this repo has kept since Phase 1 — worth a deliberate decision, not an implementer's shortcut. |
| Q7 | pgvector embedding model: which local model, what dimension, and where does inference run (in `apps/workers`, a new process, or an external local server like Ollama)? | Directly affects infra (docker-compose services), latency budget, and whether "100% local, no real internet" (agentmail.md §1) is actually maintained if a model needs to be downloaded from a registry at build/run time. |
| Q8 | Python SDK packaging/distribution: does it ship to PyPI (a publish action, needs explicit user sign-off per this session's standing constraint), or stay repo-internal (installable via `pip install -e` / a local wheel) for now? | This is a "don't deploy/publish without asking" question, same category as Phase 4's `claude mcp add` — flag before Codex builds packaging tooling that assumes a publish target. |

---

## 8. TASKS.md cross-reference

Full task rows (owners, dependencies, concrete DoDs, status) are in `TASKS.md`'s new **## Phase 5** section: `P5-22a/b` through `P5-28a/b`, plus `P5-25c/d` for the pgvector stretch half. This doc is the design rationale; TASKS.md is the state tracker, per AGENTS.md §7 ("AGENTS.md describes the workflow, TASKS.md tracks state" — same split applies to this plan doc and TASKS.md).
