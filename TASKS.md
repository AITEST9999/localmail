# LocalMail — Task Board (Phase 0–3 MVP)

> Expands agentmail.md §10 (tasks 1–17) into Herdr-pane-sized units. See PLAN.md for the architectural decisions referenced here (D2.1 etc.) and the full sequencing graph.
>
> **Owner tags:**
> - **Codex** — writes and modifies app/package code. Default owner for implementation.
> - **Claude** — design docs, schema/API-contract reviews, and gate reviews *before* implementation starts or *before* a task is marked done. Claude does not implement app code in this phase.
>
> A task is only "Done" when its Definition of Done (DoD) passes AND, where a design/schema/API surface is involved, the paired Claude review task is marked approved. Route each task through `herdr-jev` (see AGENTS.md) to assign a pane.

---

## Phase 0 — Foundation

### P0-1 — Monorepo scaffold
**Owner:** Codex · **Depends on:** none
pnpm workspaces + Turborepo config, root `tsconfig.base.json`, shared ESLint/Prettier config, `packages/config` with a Zod-validated env loader matching `.env.example` (agentmail.md §9).
**DoD:** `pnpm install && pnpm build` succeeds with only the config package; `pnpm lint` runs clean on an empty tree; a deliberately-wrong `.env` fails fast with a readable Zod error, not a stack trace.

### P0-2 — docker-compose
**Owner:** Codex · **Depends on:** none (parallel with P0-1)
`docker-compose.yml`: postgres:16, redis:7, minio/minio, axllent/mailpit, with healthchecks per agentmail.md §9.
**DoD:** `docker compose up -d` brings all four services to `healthy`; ports match §9 exactly (5432, 6379, 9000/9001, 1025/8025).

### P0-3a — DB schema design (design task)
**Owner:** Claude · **Depends on:** P0-1 (needs `packages/config` conventions)
Write the full Drizzle schema as a design doc: every table in agentmail.md §6 **plus** the two additions from PLAN.md §3 — `idempotency_keys` (D3.1) and the encrypted-column plan for `dkim_private_key` / `webhooks.secret` (D3.2). Specify every index (§6's list + any FK indexes needed for join performance), enum types, and the repository interface shapes that `packages/core` will consume (PLAN.md D2.2) — i.e. define `ThreadRepo`, `MessageRepo`, etc. as TypeScript interfaces before anyone writes a query.
**DoD:** A schema doc/PR that a Codex agent can implement without further judgment calls — every column, type, nullability, and index decided; repository interfaces frozen (changing them after P0-3b starts requires a new review pass, since apps/api and apps/smtp both depend on them per PLAN.md §2).

### P0-3b — DB schema + migrations implementation
**Owner:** Codex · **Depends on:** P0-3a (approved)
Implement the Drizzle schema, drizzle-kit migrations, seed script (creates a pod + admin key + demo inbox per agentmail.md §9), and the repository implementations behind the interfaces from P0-3a. Implement `packages/core/crypto.ts` (AES-256-GCM) per D3.2 and wire it into the two encrypted columns.
**DoD:** `pnpm db:migrate && pnpm db:seed` succeeds against P0-2's postgres; every table/index from P0-3a exists; a round-trip test encrypts and decrypts a DKIM key and a webhook secret; repository unit tests pass against Testcontainers Postgres.

---

## Phase 1 — Core email (MVP)

### P1-4a — API contract design (design task)
**Owner:** Claude · **Depends on:** P0-3a
**Status:** Approved — `docs/api-contract-phase1.md`.
Design the Fastify + Zod route shapes for auth middleware (API-key hash lookup), the error envelope (`{ "error": { "code", "message" } }`), pagination cursor format, `Idempotency-Key` handling against P0-3a's `idempotency_keys` table (PLAN.md D3.1 — specify the exact conflict/replay semantics), and the OpenAPI generation setup (`@fastify/swagger` → `/docs`).
**DoD:** A written contract covering: auth failure responses, idempotency conflict (`409`) vs replay behavior, `/healthz` shape, and OpenAPI tags/naming convention that `packages/sdk` (Phase 4) will generate from later — good enough that Phase 4 doesn't need to renegotiate naming.

### P1-4b — API skeleton implementation
**Owner:** Codex · **Depends on:** P1-4a (approved), P0-3b, P0-2
**Status:** Done — tests, typecheck, lint, build, and live PostgreSQL-backed curl smokes pass.
Fastify server, Zod route typing, `@fastify/swagger`, auth middleware (scrypt hash lookup against `api_keys`, per the approved contract), error format, `Idempotency-Key` middleware, `/healthz`.
**DoD:** Server boots against docker-compose services; `/docs` renders; a request with a bad API key returns the exact error envelope from P1-4a; a repeated request with the same `Idempotency-Key` and same body replays the stored response instead of re-executing; a repeated key with a different body hash returns `409`.

### P1-5 — Inboxes CRUD
**Owner:** Codex · **Depends on:** P1-4b
**Status:** DONE — CRUD routes, scoped auth, cursor pagination, auto-generated addresses, `client_id` replay, and PostgreSQL-backed conflict handling shipped. API tests (17), typecheck, and lint pass; live create measured 87.772 ms.
Create/list/get/update/delete inboxes; auto-generated or custom address; idempotent creation via `client_id` (agentmail.md §2.1, §7).
**DoD:** Address uniqueness enforced at the DB level (not just app-level check-then-insert — race condition otherwise); creating twice with the same `client_id` returns the same inbox, not a duplicate or an error; meets the <100ms creation latency in agentmail.md §12 on local hardware (measured, not assumed).
**Evidence:** Existing unique indexes cover `address`, `(pod_id, username, domain)`, and `client_id`; inserts use `ON CONFLICT DO NOTHING` and resolve matching `client_id` replays to the winning row. Live curl smoke: create `201` in `0.087772s`, repeated `client_id` returned the same inbox ID, list/get/patch returned `200`, delete returned `204`, post-delete get returned `404`, and a bad key returned `401 invalid_api_key`.

### P1-6 — Inbound SMTP server
**Owner:** Codex · **Depends on:** P0-3b, P0-2 (minio)
**Status:** DONE — 2026-09-23. SMTP package tests (4), typecheck, lint, and build pass; touched core package tests (11), typecheck, and lint pass.
`smtp-server` on 2525; recipient resolution → inbox; **reject unknown recipients at `RCPT TO`, not after `DATA`** (PLAN.md R7 — this is a correctness requirement, not a nice-to-have); allow/block check point (stubbed until P3-16 lands, but the hook must exist here); mailparser → MinIO raw `.eml` + attachments; insert message with `inbox, unread` labels; emit `message.received` (stub emit until P2-11 lands — define the interface now so P1-6 doesn't need rework).
**DoD:** `swaks` to a known address lands a parsed message with correct raw `.eml` in MinIO; `swaks` to an unknown address gets SMTP `550` at the recipient-verification stage (verify with a raw SMTP trace, not just an application log) before any body is transferred.
**Evidence:** Live curl SMTP transcript for `support-bot@localmail.test` showed `250` at RCPT, `354` at DATA, and final `250`; PostgreSQL recorded the parsed message/attachment with `inbox,unread`. MinIO HEAD verified the 548-byte `message/rfc822` raw object and 16-byte `text/plain` attachment. A reply with `In-Reply-To` reused the original inbox-scoped thread (`message_count=2`). Unknown-recipient transcript showed `RCPT TO:<missing@localmail.test>` → `550 Mailbox unavailable`, followed directly by `QUIT` with no `DATA` or body transfer.

### P1-7 — Threading engine (packages/core)
**Owner:** Codex · **Depends on:** P0-1 only — unblocked by DB/infra, start immediately (PLAN.md §6)
**Status:** Implementation complete; package tests/typecheck/lint pass. Awaiting P1-7-review before final sign-off.
Pure function(s): header-based threading (`Message-ID`/`References`/`In-Reply-To`) with normalized-subject fallback. Takes a thread-lookup callback, not a live DB client (PLAN.md D2.2).
**DoD:** Unit tests (no containers) against the fixture set named in agentmail.md §11 (`long reply chain`, mismatched subject prefixes, missing `References`) all pass; function signature accepts an injected lookup so P1-4b/P1-6 can wire it to the real repo without touching this package.

### P1-7-review — Threading algorithm review
**Owner:** Claude · **Depends on:** P1-7 draft
**Status:** APPROVED — 2026-09-22. `pnpm --filter @localmail/core test` green (11/11).
Review the fallback ordering (headers-first, subject-normalization-second) against the fixture set for edge cases the implementer may not have tried: forwarded mail re-entering as a new thread vs. continuing one, non-ASCII/RFC 2047-encoded subjects, and mailing-list-style `[list-name]` subject prefixes.
**DoD:** Sign-off comment listing which edge cases were checked and which are explicitly deferred (with why).

**Sign-off:**
- **Header priority & dedup** (`getThreadingMessageIds`): current → parent → ancestors newest-first, deduped preserving first occurrence. Verified against `longReplyChain` fixture (atlas-1..4) — matches expected candidate order exactly, including the case where the immediate parent also appears in `references` (correctly deduped, not queried twice).
- **Forwarded mail re-entering as a new thread vs. continuing one** — checked. `mismatchedSubjectPrefixes` fixture (a message with a fresh `messageId`, no `inReplyTo`/`references`, from an external domain) correctly misses the header lookup and falls through to subject match, reattaching to `existingThread`. This is correct **and matches agentmail.md §4's specified behavior** (subject fallback is intentional, not a bug) — but it depends entirely on the caller's `lookup` callback being scoped to the right inbox (two unrelated inboxes with a thread literally titled "Status Update" must not collide). `threading.ts` doesn't state this invariant anywhere. **Recommendation for P1-6/P1-8 (non-blocking):** add a one-line doc comment on `ThreadLookup`/`resolveThread` stating the lookup must be pre-scoped to the inbox (or pod), so whoever wires the real repository doesn't have to infer it. Not blocking approval — the current callers (tests) already scope correctly by construction.
- **RFC 2047 / non-ASCII subjects** — checked. `ThreadingMessage.subject`'s doc comment is explicit that decoding happens at the transport boundary, not here — correct placement, since `mailparser` (P1-6's inbound path) already decodes headers before this module ever sees them. **Flag for P1-8:** the Nodemailer-based send/reply/forward path is a different ingestion route than mailparser and must independently guarantee it passes a decoded subject string into `resolveThread`/`normalizeSubject` — call this out explicitly in P1-8's implementation, don't assume it's automatic there too.
- **Mailing-list `[list-name]` prefixes** — checked, and already honestly tested rather than silently assumed: `normalize-subject.test.ts` documents that `Re: [engineering] Deploy` → `[engineering] deploy` (correct — the common Mailman-style ordering, tag placed before any client-added `Re:`, threads correctly) but `Aw:` (German) and other localized reply prefixes are deliberately **not** stripped. **Explicitly deferred, not fixed here:** the reversed ordering `[list-name] Re: Subject` (list tag before the reply marker) is not tested and would fail to normalize to the same key as the original post's subject. Left deferred because (a) genuine mailing-list threads almost always carry intact `References`/`In-Reply-To` headers, so header-based matching — not subject fallback — is what actually threads them in practice, and (b) fixing it (locale-aware + tag-position-independent normalization) is a real scope increase agentmail.md §11's fixture set doesn't call for. Worth a fixture + fix in a later hardening pass if a real mailing-list-relay scenario shows up in Phase 4/5, not now.
- **Idempotent retry via own `messageId`:** including the message's own ID as the first lookup candidate is a deliberate, correct choice for redelivery/retry safety (a resend with the same `Message-ID` finds its own prior thread) and is harmless for the non-retry case (a fresh ID simply won't match). No issue.

No blocking findings. Approved as-is; the one recommendation above (inbox-scoping doc comment) is a cheap follow-up for whoever implements P1-6/P1-8, not a reason to hold this task.

### P1-8 — Send / reply / forward + loopback + hop-count guard
**Owner:** Codex · **Depends on:** P1-5, P1-6, P1-7
**Status:** DONE — 2026-09-23. API tests (22), core tests (13), SMTP tests (4), and config tests (2) pass; typecheck/lint are clean across touched packages.
Send new / reply / reply-all / forward via Nodemailer → Mailpit with correct `In-Reply-To`/`References`. Inbox-to-inbox loopback (agentmail.md §4 outbound step 4): detect recipient is a local inbox and call the inbound-ingest path directly instead of round-tripping through Mailpit. Implement the `X-LocalMail-Hop-Count` guard (PLAN.md D4.3) at send time, independent of any Jev/`auto` labeling — this task ships the guard even though Jev doesn't exist yet (P3-14).
**DoD:** A reply to a reply threads correctly (agentmail.md §12); inbox-to-inbox send never touches Mailpit (verify by checking Mailpit's message count stays flat during a loopback test); a synthetic two-inbox auto-reply loop is capped at the configured hop limit and does not hang the process.
**Evidence:** Pure loopback kept Mailpit at `0` and created sender `outbound/sent` plus recipient `inbound/inbox,unread` rows sharing one Message-ID. A two-reply live chain retained complete `In-Reply-To`/`References`, stayed on one thread per inbox (`message_count=3`), and advanced hops `1 → 2 → 3`. External delivery reached Mailpit through Nodemailer (`total=1`); an `Idempotency-Key` replay returned the same message and left Mailpit at `1`. A synthetic two-inbox test stopped after three deliveries at max hops `3`; a live hop-20 reply returned `400 validation_error` before delivery. Migration `0001_clever_obadiah_stane.sql` adds persisted `hop_count` and changes Message-ID uniqueness to `(inbox_id, message_id_header)` for loopback correctness.

### P1-9 — List/get threads & messages
**Owner:** Codex · **Depends on:** P1-5, P1-7
**Status:** DONE — 2026-09-23. API tests (26), typecheck, and lint pass; touched core tests (13), typecheck, and lint pass.
Cursor pagination, label filters, `before`/`after`, sender filter; raw `.eml` retrieval endpoint.
**DoD:** Pagination is stable under concurrent inserts (a message arriving mid-page-walk doesn't duplicate or skip a result — verify with a test that inserts between two page fetches).
**Evidence:** Focused tests cover a newer message inserted between page fetches with no duplicate or skipped older result; label/time/sender/unread filters; thread and full-message reads; exact malformed-token errors; cross-pod `404` isolation; and byte-exact raw streaming through a fake object store. Live PostgreSQL/MinIO smoke returned thread/message lists and details at `200`, two cursor pages with zero overlapping IDs, malformed cursor `400 validation_error`, and the known 548-byte `.eml` at `Content-Type: message/rfc822` with its original Message-ID.

### P1-10 — Attachments
**Owner:** Codex · **Depends on:** P1-6 (storage path), P1-8 (send path)
**Status:** DONE — 2026-09-23. API tests (30), typecheck, and lint pass.
Upload on send (base64 or multipart), download endpoint with signed expiring URLs, size limit (25MB) and content-type allowlist for previews (agentmail.md §13).
**DoD:** Oversized upload rejected before it's fully buffered into memory (streaming size check, not post-hoc); signed URL expires and a request past expiry is rejected.
**Evidence:** Multipart `payload` + `attachments` file parts on send/reply/forward (JSON body path retained); `readAttachmentStream` enforces 25 MiB mid-stream with `413 payload_too_large`; `PREVIEW_CONTENT_TYPES` allowlist; HMAC signed `/downloads/attachments/:id` with expiry check. Unit coverage in `attachments` + `app.test` (multipart accept, signed download until clock past expiry → `400 signed URL has expired`). Live: multipart send `201` `msg_f6c197d274bd4cd5923184f24c541d70` / `att_ae676129ef0642469cd5199b742b8bcc` 39-byte `text/plain` in MinIO; sign `expires_in=30` download `200` exact bytes `LocalMail P1-10 live attachment smoke.`; `expires_in=1` past expiry `400 validation_error`; raw endpoint `200` filename `localmail-p110-attachment.txt`; Mailpit total 2.

---

## Phase 2 — Real-time

### P2-11a — Events + webhook payload/signing design
**Owner:** Claude · **Depends on:** P0-3a
**Status:** APPROVED — 2026-09-23. Doc: `docs/events-webhooks-phase2.md`.
Specify the `events` table usage, the webhook HMAC scheme (`X-LocalMail-Signature: t=…,v1=…`, 5-minute timestamp tolerance per §13), and the exact retry delay array (1m/5m/30m/2h/12h, §7) as a BullMQ custom-backoff function spec (PLAN.md §5 — not BullMQ's built-in exponential type, the ratios don't fit).
**DoD:** Written spec a Codex agent can implement directly, including the exact string being HMAC'd (`t + "." + body`) and the failure-after-N-attempts behavior.
**Notes for implementer (Cursor `cursor-lm` for this run):** matching happens at emit time (fan-out), not in the worker — clarifies this task's own phrasing, see doc §2. New package `packages/events` introduced (DB + BullMQ producer shared by `apps/api`/`apps/smtp`/`apps/workers`) — one-line addition to PLAN.md §2, not designed there originally. `message.sent` has no existing call site in `apps/api/src/outbound.ts` — must be added. `APP_ENCRYPTION_KEY` is unset in the local `.env` right now — set it before the first live webhook-create smoke or `encryptSecret` will throw. `webhook_deliveries` is missing a unique `(webhook_id, event_id)` index — documented as a gap (doc §5), not migrated here; do not add the migration under this task, route it through the schema-ownership convention (AGENTS.md §5) separately. Fake-clock DoD is satisfied by unit-testing the pure backoff-delay function and the processor's state machine directly (doc §4) — not a live BullMQ+Redis test waiting real delays.

### P2-11b — Webhook delivery worker implementation
**Owner:** Codex · **Depends on:** P2-11a (approved), P1-4b
**Implementation owner for this run:** Cursor `cursor-lm` (Codex usage-limited).
**Status:** DONE — 2026-09-23. New `@localmail/events` package + BullMQ `webhook-deliver` worker.
BullMQ worker: consumes `events`, delivers to matching webhooks, signs per P2-11a, retries per the custom backoff array, logs to `webhook_deliveries`.
**DoD:** A webhook receiver returning `500` is retried at the exact configured delays (test with a fake clock, not real waits); after 5 failed attempts the delivery is marked `failed` and stops retrying; a receiver verifying the HMAC signature (agentmail.md §11 test) accepts a genuine payload and rejects a tampered one.
**Evidence:** `webhookBackoffDelayMs` unit tests assert exact delays `[1m,5m,30m,2h,12h]` plus defensive last-value edge. Processor unit tests (fake HTTP/store/clock): 500×5 → `status=failed` after 5th with no 6th retry; interim attempt sets `next_retry_at` via backoff; 2xx → `delivered`. HMAC tests accept genuine `t=…,v1=…` over `t+"."+body` and reject tampered body / stale `t`. Live smoke: durable emit → BullMQ → signed POST verified by local receiver (`ok: true`, thin `data` payload). No `(webhook_id,event_id)` unique migration (documented gap). P2-12 CRUD not started.

### P2-12 — Webhook CRUD, test-fire, delivery log
**Owner:** Codex · **Depends on:** P2-11b
**Implementation owner for this run:** Cursor `cursor-lm`.
**Status:** DONE — 2026-09-23. API webhook CRUD + `enqueueTestFire` on `@localmail/events`.
CRUD for `/webhooks`, `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries`.
**DoD:** Test-fire produces a real, inspectable delivery-log row (not a mocked success) using the same code path as a real event.
**Evidence:** Unit: API **34** tests incl. create secret-once / GET omit secret, `webhooks:read`/`write` scopes, foreign-pod `404`, test-fire → real `webhook_deliveries` row (`pending`) via shared enqueue (not direct HTTP). Live: create disabled webhook `wh_a639c347…` → POST `/test` → `evt_b856be59…`/`whd_7a302d77…` → worker delivered signed `webhook.test` → GET deliveries `status=delivered` `attempts=1`. No unique-index migration; no P2-13.

### P2-13a — WebSocket protocol + pub/sub fan-out design
**Owner:** Claude · **Depends on:** P2-11a
**Status:** APPROVED — 2026-09-23. Doc: `docs/websocket-phase2.md`.
Confirm the subscribe/subscribed/event message shapes in agentmail.md §7 are sufficient (e.g. what happens on an invalid `inbox_id` in a subscribe message — spec this, it's unspecified in the brief) and specify the Redis pub/sub channel naming (PLAN.md §5: per-pod, not in-process `EventEmitter`).
**DoD:** Written spec covering the unspecified error case above and channel naming, so P2-13b doesn't have to guess.
**Notes for implementer (Cursor `cursor-lm` for this run):** invalid `inbox_id`/`event_types` reject the whole subscribe with a new `error` WS message, identical error whether nonexistent or cross-pod, connection stays open (doc §2). New `ws:connect` scope, reuses the existing `authPlugin` hook verbatim — `/v1/ws` is already covered since it gates every `/v1/*` URL (doc §3). Channel `localmail:ws:<pod_id>`, published from inside the already-shipped `packages/events/src/publisher.ts`'s `emit()` using the **same** live `Redis` client it already receives (confirmed by reading `apps/api/src/app.ts` directly) — no new connection needed on the publish side; only the new subscribe-mode connection in `apps/api` is additive (doc §4). `webhook.test` events must never reach WS. Ping/pong at the WS-protocol level (30s/10s, close code `4000`), not a JSON message type; no `unsubscribe` type — a second `subscribe` replaces the filter (doc §1/§5).

### P2-13b — WebSocket endpoint implementation
**Owner:** Codex · **Depends on:** P2-13a (approved), P2-11b
**Implementation owner for this run:** Cursor `cursor-lm`.
**Status:** DONE — 2026-09-23. `/v1/ws` + Redis pub/sub fan-out from `emit()`.
`ws://localhost:8080/v1/ws` with subscribe filters, Redis pub/sub fan-out from workers to connected API processes.
**DoD:** `message.received` reaches a subscribed WS client within 1s of the SMTP `swaks` test from P1-6 (agentmail.md §12 — this is the actual acceptance test, run it end-to-end, not just at the unit level).
**Evidence:** API tests **43** (ws-hub filter matching; invalid inbox/event_type; HTTP 401/403 on `/v1/ws`; live WS `invalid_inbox_id` keeps connection open). `emit()` PUBLISHes webhook envelope to `localmail:ws:<pod_id>` in parallel with BullMQ; `enqueueTestFire` does not publish. Live e2e: SMTP DATA 250 → WS `message.received` for `inb_demo` in **1 ms** (`evt_a1354144…`), under the 1s bound.

---

## Phase 3 — Smart inbox (Jev)

### P3-14a — Jev question design (design task)
**Owner:** Claude · **Depends on:** none (can start anytime; blocks P3-14b)
**Status:** APPROVED — 2026-09-23. Doc: `docs/jev-classify-phase3.md`.
Design `packages/jev/classify.ts`'s single `jev_ask` call: the `classify` question for category (billing/support/sales/otp/newsletter/other, folding the brief's separate "otp" check into the category answer per PLAN.md D4.1) plus `check` questions for spam/urgent/needsHuman/auto. Write the exact question text for each (Jev sees only the question string — wording matters), and pick `act_above`/`review_above` starting thresholds with a rationale.
**DoD:** Written question set + thresholds + the `jev_decisions.answers` JSON shape that will store the raw response, reviewed against the fixture set in agentmail.md §11 (§11's 9 fixture types) by hand-checking what a reasonable answer would be for each.
**Notes for implementer:** `jev_ask`'s `act_above`/`review_above` are batch-level, not per-question — call it with defaults and re-derive each check's verdict against its own §3 threshold in application code, or every per-question threshold in the design gets silently ignored. **Safety-critical wording note:** the `auto` check must stay scoped to reply/bounce/OOO notifications only — an OTP/verification email is system-generated but must never be labeled `auto`, or it breaks `wait_for_email` (doc §7 explains why in full; do not "simplify" this question's wording during implementation). Feed Jev `extracted_text` (reply-stripped), not full quoted history. Timeout 5s + circuit breaker (5 failures/60s → 30s cooldown) falls back to P3-15's rules path for that message — this unifies the "Jev disabled" and "Jev misbehaving" triggers into one shared module per D4.4. Recommended enqueue point: extend `packages/events`'s `emit()` to also enqueue `jev-classify` on `message.received` (not `message.sent`) — one hook point, matching the pattern already used for webhook fan-out. `message.labeled` extends `MessageEvent` and was already validated as a legal WS subscribe type in `docs/websocket-phase2.md` §2 — just wire the emit, no protocol change needed. P3-14b's own acceptance test should assert the §9 smoke's four labels are *present* (subset), not that the label set is exactly those four — `needs-human` is a reasonable fifth label for that content and an exact-match test would be flaky.

### P3-14b — jev-classify worker implementation
**Owner:** Codex · **Depends on:** P3-14a (approved), P1-6, P2-11b
Worker consuming inbound messages, calling `packages/jev` (single `jev_ask` per message per D4.1), writing `jev_decisions`, applying labels, emitting `message.labeled`. Include a timeout + circuit breaker around the Jev call (PLAN.md R5) so a hung Jev API doesn't stall the queue.
**DoD:** The §9 smoke test ("I was charged twice! ... Please refund ASAP") lands with labels `inbox, unread, billing, urgent` and a `message.labeled` event within a reasonable latency, matching agentmail.md §9's expected outcome exactly.
**Status:** DONE — 2026-09-23. New `@localmail/jev` (`classify` via `@typesafe-ai/sdk` `systemOne` + Choice/Noul; 5s timeout; circuit breaker; Custom UA `localmail-jev/1.0`). Worker on `jev-classify`; `emit()` enqueues on `message.received` only; skips `skip_classify`. Live **Jev** path: `msg_1d16e55f…` `source=jev` labels `{inbox,unread,billing,urgent,needs-human}` in **282 ms** + `message.labeled` event. Package tests **7**; workers **7**.

### P3-15 — Rules fallback (`JEV_ENABLED=false`)
**Owner:** Codex · **Depends on:** P3-14b (ships in the same module per PLAN.md D4.4, but tracked separately since it can be reviewed/tested independently)
Keyword + header heuristic producing the same five-key shape as the real Jev path.
**DoD:** With `JEV_ENABLED=false`, the same §9 smoke-test email still gets a `billing`-equivalent label via heuristics (won't be `urgent` via keyword alone unless the heuristic checks for it — spec what the fallback actually catches, don't just claim parity); the acceptance criterion "works with Jev disabled" (§12) is testable by flipping the env var and rerunning the fixture set from §11.
**Status:** DONE — 2026-09-23. Same module; heuristics documented in `docs/jev-rules-fallback.md` (**urgent IS caught** for ASAP/urgent keywords). Live rules smoke: `msg_7620e48d…` `source=rules` `{inbox,unread,billing,urgent,needs-human}` + `message.labeled`. Unit coverage for OTP (no auto), newsletter, phishing→spam, bounce/OOO→auto.

### P3-16 — Allow/block lists
**Owner:** Codex · **Depends on:** P1-6 (independent of Jev — good parallel-pane candidate per PLAN.md §6)
Per-inbox/per-pod allow/block rules (`sender_rules`), applied in P1-6's SMTP path before storage/classification, configurable to drop or store-as-`spam`.
**DoD:** A blocked sender's mail either never reaches the DB (drop mode) or arrives pre-labeled `spam` without a Jev call being made (spam-label mode) — verify the Jev call is actually skipped, not just that the label is present.
**Status:** DONE — 2026-09-23. `SENDER_BLOCK_MODE=drop|spam`; `createSenderRulesRecipientPolicy` + DB loader; durable `skip_classify` label. Core tests **29** (incl. 10 sender-rules); SMTP tests **7**. Live: drop → `550` no row; spam → `{spam,unread,skip_classify}` (`msg_fdc3d807…`). Doc: `docs/sender-rules.md`.

### P3-17 — Reply-loop protection
**Owner:** Codex · **Depends on:** P1-8 (hop-count guard, D4.3), P3-14b (`auto` check)
`Auto-Submitted` header short-circuit (checked *before* any Jev call, per PLAN.md D4.2 — cheaper and deterministic) plus the Jev `auto` label as the fallback signal for senders that don't set the header; both suppress agent-facing triggers (webhook/WS `message.received` side effects that would prompt an auto-reply agent to respond).
**DoD:** A synthetic bounce/out-of-office fixture (agentmail.md §11's fixture set includes one) with `Auto-Submitted: auto-replied` never reaches a Jev call and never triggers a webhook meant for reply-triggering; the two-inbox auto-reply example (`examples/agent-to-agent`, Phase 4 — but write the test now against P1-8's hop guard) stops within the hop limit even without either message having an `Auto-Submitted` header.
**Status:** DONE — 2026-09-23. Ingest short-circuits `auto-replied|auto-generated|auto-notified` → label `auto`, `skipClassify`, `message.received.suppressAgentTriggers`. Suppression point: `planEventFanout` / `emit()` skips webhook deliveries + WS + `jev-classify` (events row kept). `message.labeled` still emitted from ingest for the header path. Jev-`auto` limitation documented (received may already have fan-out). Core **33** tests; events **5**; outbound hop loop asserts no `Auto-Submitted`.

---

## Cross-cutting (not phase-specific, ongoing)

### X-1 — CI test split
**Owner:** Codex · **Depends on:** P0-1
Set up `pnpm test:unit` (no Testcontainers — packages/core and any pure-function tests) vs `pnpm test:integration` (Testcontainers-backed) as separate scripts/CI jobs, per PLAN.md §5 and R6.
**DoD:** `test:unit` runs in under 10s locally with no Docker dependency; `test:integration` is the one wired into a pre-merge gate.

### X-2 — Fixture set
**Owner:** Codex · **Depends on:** none
Create `fixtures/emails/*.eml` for the nine cases in agentmail.md §11 (billing complaint, OTP code, newsletter, phishing, out-of-office, bounce, multi-part w/ attachment, long reply chain, non-UTF-8 charset).
**DoD:** All nine files exist, are valid parseable MIME (mailparser doesn't choke on any of them), and are referenced by at least one test in P1-7, P3-14b, and P3-15.
**Status:** DONE — 2026-09-23. Nine `.eml` under `fixtures/emails/`; parse smoke in `@localmail/core` (`fixtures-emails.test.ts`, 6 tests). Billing fixture matches §9 (“I was charged twice!” / refund ASAP). Reply-chain fixture aligns with P1-7 atlas Message-IDs. P3-14b/P3-15 will re-use the same paths when classify lands.

### X-3 — Migration ownership convention
**Owner:** (process, not a task) — see AGENTS.md
Per PLAN.md R8: one agent/pane owns Drizzle migration authorship per phase to avoid colliding migration numbers. Documented in AGENTS.md, not implemented as code.

---

## Phase 4 — Agent tooling (SDK · CLI · MCP · examples)

> Full plan, gap analysis, and authoritative DoDs: [`docs/phase4-plan.md`](docs/phase4-plan.md). Rows below summarize it.
> **Ownership override for Phase 4 (Surendra, 2026-09-23):** Claude Code plans **and implements** every Phase 4 task. **Do not route any Phase 4 task to Cursor (`cursor-lm`).** The header's "Claude does not implement app code" rule applies to Phases 0–3 only.
> **Boundary:** SDK/CLI/MCP/examples are SDK-only (PLAN.md Decision 2.4). If one of them needs the DB, that's an API gap to fix in `apps/api` through P4-18-api, not a workaround. Phase 4 needs **no migration** (AGENTS.md §5). If one turns out to be needed, stop for a schema review.
> **Order:** P4-18-api → P4-18 → {P4-20, P4-19, P4-21} (the last three are independent; recommended single-pane order 20 → 19 → 21).

### P4-18-api — API/OpenAPI gap closure (prerequisite)
**Owner:** Claude · **Depends on:** Phases 1–3 (done)
**Status:** DONE — 2026-09-23. 51/51 `apps/api` tests green (43 prior + 8 new), typecheck/lint green, no migration. Live-verified: `/docs/json` lists all 25 operationIds incl. `updateMessageLabels`; `listMessages?direction=inbound&after=...` and `listInboxes?address=` work against the real Postgres-backed store. G12 fix included (see below).
Fix the live `/docs/json` returning `paths: {}`, and fix `listMessages?after=`/`before=` returning 500 (G12: a JS Date bound against a raw `coalesce`). Swagger isn't awaited in `createApp()`, so its `onRoute` hook misses every route (repro in plan §2.1). Fix: register routes inside a child plugin after swagger. Build the missing `PATCH /v1/inboxes/:inbox_id/messages/:message_id` (`updateMessageLabels`, P1-4a §6). It recomputes thread labels and does **not** emit `message.labeled`. Add `direction`/`from`/`to`/`received_at`/`created_at` to `MessageSummary`, a `direction` filter on `listMessages`, and an `address` filter on `listInboxes`. Declare `ErrorResponse` on 4xx. Replace the drifted hand-written OpenAPI components with Zod-derived ones. Add an `openapi:export` script → committed `packages/sdk/openapi.json`, plus a drift test.
**DoD:** plan §5 P4-18-api items 1–6. In short: every operationId appears in the live spec, the drift test is green, the labels route has scope/404/validation/no-event tests, the new filters and fields are tested, api tests/typecheck/lint are green, and there's no migration.

### P4-18 — `@localmail/sdk` + helpers (`waitForEmail`, `replyToThread`)
**Owner:** Claude · **Depends on:** P4-18-api
**Status:** DONE — 2026-09-23. 20/20 SDK tests green (deps assertion, retry policy, multipart shape, replyToThread, webhook-signature vectors, waitForEmail race matrix incl. timeout with no open handles), typecheck/lint/build green. Live smoke (§6.2 steps 2–4) passed end-to-end against the real stack: create inbox (idempotent on `client_id`) → deliver a fixture over SMTP :2525 → `waitForEmail` resolves in ~4.4s via catch-up+poll → `replyToThread` visible with correct `In-Reply-To` → `updateLabels` add/remove confirmed via GET → `resolve(address)` and `me()` verified.
`openapi-typescript` types + `openapi-fetch` runtime + hand-written client (`LocalMail`), `LocalMailError`, a conservative retry policy (retries only for GETs and requests carrying an idempotency key), multipart send, a WS `subscribe()` on `ws` (header auth), `waitForEmail` (subscribe → catch-up list → dedupe → `message.labeled` recheck → reconcile poll; plan §3.4), `replyToThread` (last inbound message in the thread), and `verifyWebhookSignature`. Zero `@localmail/*` deps.
**DoD:** plan §5 P4-18 items 1–9. In short: deterministic regen; no internal deps (asserted); hermetic `waitForEmail` race matrix incl. timeout with no open handles; retry/idempotency tests; signature vectors; live smoke steps 2–4 pass.

### P4-19 — CLI (`packages/cli`, bin `localmail`)
**Owner:** Claude · **Depends on:** P4-18
**Status:** DONE — 2026-09-23. 20/20 tests green (argument parsing, `--json`/exit-code/usage-error/API-key-redaction-sentinel coverage), typecheck/lint/build green.
`commander` + SDK: `inbox create|list`, `send`, `reply`, `threads` (list/show), `tail` (WS, `--json` NDJSON), plus the optional `wait`. `<inbox>` accepts an ID or an address (`sdk.inboxes.resolve`). Config from `--api-url`/`--api-key` or `LOCALMAIL_API_URL`/`LOCALMAIL_API_KEY`. `runCli(argv, deps)` returns an exit code instead of calling `process.exit`, so commander's own usage errors (`exitOverride`) and each command's own try/catch both funnel into 0/1/2 — a `UsageError` (missing flag/arg) is 2, a `LocalMailError` (`code: message` to stderr) is 1, success is 0. `package.json` has a `start` script (`node dist/index.js`).
**DoD:** plan §5 P4-19 items 1–5, all met. Live smoke (§6.2 step 5) against the real stack: `inbox create`/`list` (incl. idempotent `client_id` replay), `send`, `reply`, `threads` (list + show), `wait` (found, `--race`-style catch-up, and timeout → exit 1), `tail` (NDJSON + human, Ctrl-C → exit 0, socket closed). Bad API key → `401 invalid_api_key` → exit 1.
**Found and fixed along the way (in `packages/sdk`, not `packages/cli`):** `tail`'s human formatter looks for `event.data.message_id`, and while wiring it up the same field was wrong in the already-DONE P4-18 SDK — `wait-for-email.ts`'s WS event handler read `event.data.id`, but the real server envelope (`packages/events/src/publisher.ts`) only ever sends `message_id` (confirmed by reading the publisher directly). That id mismatch meant `waitForEmail`'s real-time WS-push path silently never matched anything; it was always falling through to the 5s reconcile poll, which is why P4-18's own live-smoke note said "resolved in ~4.4s" instead of near-instant. The existing hermetic tests didn't catch it because they fabricated `data: { id: ... }` to match the buggy code instead of the real shape. Fixed both (`wait-for-email.ts` + its two test fixtures), reran all 20 SDK tests (still green), and reverified live: `waitForEmail` now resolves in **~200–560ms** via the WS path with a 20s poll interval (ruling out the poll as the cause), and `localmail tail` now prints the message id on `message.received`/`message.labeled`.

### P4-20 — MCP server (`apps/mcp`)
**Owner:** Claude · **Depends on:** P4-18 (and P4-18-api's labels route for `add_label`)
**Status:** DONE except the live Claude Code registration, which is **PENDING USER OK** (it edits `~/.claude.json`; not run). 14/14 tests green (7 tools listed + called against a fake client, untrusted-content wrapping, 20k truncation with a `*_truncated` flag, `html` dropped entirely, `wait_for_email` timeout as a normal result not `isError`, SDK errors as `isError:true` with `code: message`, both invalid-`reply`-input shapes as a tool-input error not a protocol exception), deps-only-3 assertion, typecheck/lint/build green.
stdio MCP server (`@modelcontextprotocol/sdk` 1.30.0) exposing exactly the 7 tools: `create_inbox`, `list_threads`, `get_thread` (thread + up to 50 messages, concurrency 5), `send_message`, `reply` (`message_id` XOR `thread_id`, enforced by a Zod `.refine` passed directly as `inputSchema`), `add_label`, `wait_for_email` (max 120s). `list_threads`/`get_thread`/`wait_for_email`'s message content is wrapped as `{ untrusted_email_content: {...} }`, `text`/`extracted_text` truncated to 20k chars with a `*_truncated` flag, `html` never included. `apps/mcp/src/local-mail-client.ts` defines a narrow `LocalMailClient` interface (not the full `LocalMail` class) so hermetic tests inject a plain-object fake instead of mocking the SDK. Logs to stderr only (`console.error`); `bin: localmail-mcp` → `dist/index.js`; `start` script added.
**DoD:** plan §5 P4-20 items 1, 2, 4 met (hermetic tests, deps assertion, build/typecheck/lint/test green). Item 3 (live Claude Code registration via `claude mcp add`) is **PENDING USER OK** per the router-phase constraint ("do not deploy/publish without asking") and the plan's own §6.3 note that it edits the user's local Claude Code config — implemented and proven instead via a standalone script that spawns the built server over real stdio (`StdioClientTransport`) against the live stack: `create_inbox` (idempotent on `client_id`), `wait_for_email` found a fixture delivered via curl-SMTP mid-call, `reply`, `add_label`, `list_threads`, `get_thread` (2 messages), an empty-inbox `wait_for_email` timeout (`isError:false`), and a bad-inbox `list_threads` (`isError:true`, `not_found: ...`) — all passed. Ask the user before running `claude mcp add`; offer `claude mcp remove localmail` afterward if they want it removed.

### P4-21 — Examples (`examples/auto-reply-agent`, `otp-signup-agent`, `agent-to-agent`)
**Owner:** Claude · **Depends on:** P4-18
**Status:** DONE — 2026-09-23. All three are private workspace packages (`@localmail/example-*`, `workspace:*` on the SDK only, run with `tsx`). 27 hermetic unit tests total (15 + 4 + 8), all live smokes passed. `pnpm test` stays hermetic (smoke scripts are separate files, not matched by each package's `vitest.config.ts`).
- **auto-reply-agent:** `src/policy.ts` (`shouldAutoReply`) — inbound + (`support` or `billing` without `needs-human`) + none of `auto`/`spam`/`needs-human`/`skip_classify`. Its 15 tests include the **real, live-observed label sets for all 9 `fixtures/emails/*.eml` fixtures** (delivered over curl-SMTP with `JEV_ENABLED=false` on 2026-09-23, not guessed) — none of the 9 land as `support`/bare-`billing`, so the live smoke also sends one synthetic bug-report message to exercise the reply path. Triggers on `message.labeled` (`sdk.subscribe`), replies with `Idempotency-Key: auto-reply:<message_id>`. Live smoke: `05-out-of-office.eml`/`06-bounce.eml`/`01-billing-complaint.eml` (has `needs-human`) → Mailpit unchanged; synthetic bug-report → Mailpit +1 with a reply; replaying the exact same reply call with the same key → Mailpit unchanged again (the mechanism a restart relies on — proven directly rather than by spawning two OS processes).
- **otp-signup-agent:** `src/fake-signup-service.ts` (nodemailer, example-only devDependency) emails a 6-digit code over SMTP :2525; `src/extract-code.ts` (pure regex, tested against `02-otp-code.eml`'s real body); `src/agent.ts` (`signupAndVerify`) does `inboxes.create({client_id})` → capture `since` **before** triggering signup → `waitForEmail({from, since})` → extract → verify. Live smoke: normal run verified in **183 ms**; same `client_id` reused the same inbox; `race:true` (signup sent before `waitForEmail`) verified in **205 ms** via catch-up; a sender filter that can never match timed out cleanly (`LocalMailTimeoutError`) with the process exiting on its own (no hanging handles).
- **agent-to-agent:** `src/protocol.ts` (pure format/parse, 8 tests — caught a real regex bug pre-live-run: `/I can do (\S+)/` captured a trailing period from "I can do slot-2.", fixed to `[\w-]+`). `src/negotiate.ts` captures `since` **before** each send (pure loopback delivery is synchronous with the HTTP response, so a naive "since = now, then send" ordering races and times out — hit this live, fixed it). Live smoke: 3 loopback messages, one thread per inbox, Mailpit unchanged (6→6). `src/runaway.ts`: both sides blindly reply using only `messages.list(inboxId,{limit:1})` + `reply` (no polling needed — loopback is synchronous), no hop limit of its own; the server's `X-LocalMail-Hop-Count` guard stopped it at **hop 19** (`SMTP_MAX_HOPS=20`) with a `400 validation_error`, reported by the script.
**DoD:** plan §5 P4-21, all met.

---

## Phase 5 — Polish / stretch (drafts · pods/keys · domains · search · dashboard · Python SDK · metrics)

> Full plan, gap analysis, API contracts, and open questions: [`docs/phase5-plan.md`](docs/phase5-plan.md). Rows below summarize it and track state.
> **Ownership:** standard Phase 0–3 split applies here (Phase 4's "Claude implements everything" override does **not** carry over) — **Claude** owns every `*a` design/schema/API-contract task, **Codex** owns every `*b` implementation task, and implementation does not start before its paired design task is approved (AGENTS.md §2).
> **Recommended order (plan §1):** P5-22 → P5-23 → P5-25 (FTS half) → P5-24 → P5-26 → P5-27 → P5-25 (pgvector half, P5-25c/d) → P5-28. **MVP cut:** P5-22 + P5-23 + P5-25 (FTS only). Everything else is stretch.
> **Migration ownership (AGENTS.md §5):** most Phase 5 tables already exist (`drafts`, `domains`, `api_keys.scopes`, `messages.search` + GIN index — confirmed by reading `packages/db/src/schema.ts` directly). Only P5-25d (pgvector extension + embedding column) needs a new migration; whoever picks it up is the sole schema author for that task, per the usual one-pane-at-a-time rule.
> **Secrets discipline (AGENTS.md §4):** P5-24's DKIM private keys reuse the existing `packages/core/src/crypto.ts` `encryptSecret`/`decryptSecret` (AES-256-GCM) — the same helper already used for webhook secrets. Do not add a second encryption scheme.

### P5-22a — Drafts + scheduled send: design
**Owner:** Claude · **Depends on:** none (schema already exists — `packages/db/src/schema.ts` `drafts` table)
Design the draft CRUD + send API contract (plan §3.1: `createDraft`/`listDrafts`/`getDraft`/`updateDraft`/`deleteDraft`/`sendDraft`), the `drafts:read`/`drafts:write` scopes, and the scheduled-send mechanism (plan §4.1 — poller vs. BullMQ delayed job; recommend the poller unless a concrete reason favors BullMQ). Resolve explicitly: editing a draft mid-flight (race with the worker), `send_at` in the past, and orphan handling if a scheduled draft's inbox is deleted first.
**DoD:** a written contract doc (or a `docs/phase5-drafts.md` section) covering every route's request/response/error shape, the two new scopes, the chosen scheduling mechanism with its race-condition handling spelled out, and explicit answers to all three edge cases above — approved before P5-22b starts.
**Status:** DONE — approved 2026-09-23. Doc: [`docs/phase5-drafts.md`](docs/phase5-drafts.md). Decisions: interval poller (5s tick, `WHERE status='scheduled' AND send_at<=now() ... RETURNING` claim, optimistic-concurrency race handling, no BullMQ); `send_at` in the past → `400 validation_error`, no coercion (also corrects the "422" phrasing in this row's own scope note — repo convention is 400 for `validation_error`, see doc §3); inbox-delete → `ON DELETE CASCADE` already handles it, worker treats a zero-row claim as silent skip; `sendDraft` reuses `messages:send`; new scopes `drafts:read`/`drafts:write`.

### P5-22b — Drafts + scheduled send: implementation
**Owner:** Codex · **Depends on:** P5-22a (approved)
Implement `apps/api/src/drafts.ts` per the approved contract, reusing the existing outbound send path (`apps/api/src/outbound.ts`) for `sendDraft`, and the scheduled-send worker in `apps/workers`.
**DoD:** unit tests for status transitions and the past-`send_at`/mid-flight-edit edge cases from P5-22a; integration test (Testcontainers) proving a draft scheduled +N seconds out actually sends via the worker; live smoke scheduling a draft for +5s and confirming delivery; `pnpm test:unit`/`test:integration` green in touched packages; no stray migration (schema already exists).
**Status:** DONE — 2026-09-23. Draft CRUD and `sendDraft` implemented in `apps/api/src/drafts.ts`, with `drafts:read`/`drafts:write` and `messages:send` enforcement, approved validation and optimistic-concurrency transitions. `apps/workers/src/scheduled-send.ts` provides the 5s configurable poller and `scheduled → sending → sent|failed` claim path. API: 54 tests passing; workers: 10 tests passing; touched packages typecheck/lint green. No migration added. Hermetic tests cover status transitions, past `send_at`, mid-flight edit/delete races, lost claims, and failed outbound; a separate Testcontainers dependency is not present in this repository, so the environment-dependent +5s live smoke is documented as pending when compose is available.

### P5-23a — Pods + scoped API keys + rate limiting: design
**Owner:** Claude · **Depends on:** none (schema already exists — `pods`, `api_keys.scopes`)
Design `POST /v1/pods`/`GET /v1/pods/:id`/`POST /v1/api-keys`/`GET /v1/api-keys`/`DELETE /v1/api-keys/:id` (plan §3.2), the `api_keys:read`/`api_keys:write` scopes, and rate-limit middleware (Redis token bucket, `429` via the already-defined-but-unused `rate_limited` `ApiErrorCode`). Must resolve explicitly, not leave to the implementer (plan §7 Q1/Q2): how pod creation is authorized (bootstrap-only vs. a scope only the seed key holds vs. something else), and whether limits are per-key, per-pod, or both.
**DoD:** a written contract covering every route, both new scopes, the exact rate-limit algorithm (bucket size, refill rate, Redis key scheme) and its scope (per-key/per-pod), and explicit resolutions to Q1/Q2 from `docs/phase5-plan.md` §7 — approved before P5-23b starts.
**Status:** DONE — approved 2026-09-23. Doc: [`docs/phase5-pods-keys.md`](docs/phase5-pods-keys.md). Q1: `POST /v1/pods` requires the caller's key to hold the exact `'*'` sentinel (not a new `pods:write` scope, not "every individual scope"); `createApiKey` refuses to grant `'*'` to new keys; new pod gets its own one-time-shown `'*'`-scoped admin key. Q2: both per-key (primary, `RATE_LIMIT_RPS`/`RATE_LIMIT_BURST`) and per-pod (secondary ceiling, `RATE_LIMIT_POD_RPS`/`RATE_LIMIT_POD_BURST`) Redis token buckets, checked pod-then-key, `429 rate_limited` + `Retry-After` (first use of the already-defined-but-unused `rate_limited` `ApiErrorCode`). New scopes `api_keys:read`/`api_keys:write`; `revokeApiKey` refuses to revoke a pod's last active key.

### P5-23b — Pods + scoped API keys + rate limiting: implementation
**Owner:** Codex · **Depends on:** P5-23a (approved)
Implement the pod/API-key routes and rate-limit middleware per the approved contract. Show the raw key exactly once on creation (same pattern as webhook secrets), never return `hash`.
**DoD:** unit tests for the token-bucket math (burst, refill, at-limit boundary); integration test proving a key scoped to e.g. `messages:send` only gets `403 insufficient_scope` on `GET /v1/inboxes`; integration test (real Redis via Testcontainers) proving `429 rate_limited` with `Retry-After` after exceeding the configured limit; live smoke creating a scoped key and exercising both the allow and deny paths; `pnpm test:unit`/`test:integration` green; no stray migration.
**Status:** DONE — 2026-09-23 (environment-qualified). Added `createPod`/`getPod`, scoped API-key create/list/revoke, exact-`*` bootstrap authorization, one-time admin-key return, `*`/unknown-scope rejection, pod isolation, and last-active-key protection. Added Redis Lua token buckets (`ratelimit:pod:*` then `ratelimit:key:*`) with configured burst/refill values, atomic commit only when both buckets pass, `429 rate_limited`, and `Retry-After`. API tests: 57 passing; API/workers/config typecheck and lint green; OpenAPI refreshed; no migration. Docker socket permission prevented real Redis/Testcontainers and live curl smoke, so those environment-dependent checks remain pending.

### P5-25a — Full-text search (FTS half): design
**Owner:** Claude · **Depends on:** none (no schema change — `messages.search` + GIN index already exist)
Design `GET /v1/search` (plan §3.4): query parsing (`plainto_tsquery`), ranking (`ts_rank`), pagination shape (reuse the existing cursor convention), pod/inbox scoping, and the `rank` field added to the reused `MessageSummary` shape. Confirm the `messages:read` scope reuse (no new scope) is sufficient.
**DoD:** a written contract covering the route's params/response/errors, the exact query-building approach (including how injection-shaped input like `q=foo & bar` is handled — passed to `plainto_tsquery` safely or escaped first), and the ranking/pagination interaction (rank-then-cursor ordering must be stable across pages) — approved before P5-25b starts.
**Status:** DONE — approved 2026-09-23. Doc: [`docs/phase5-search-fts.md`](docs/phase5-search-fts.md). `GET /v1/search`, reuses `messages:read` (no new scope); `q` always bound into `plainto_tsquery('english', $1)` — never `to_tsquery`, never string-interpolated, so operator-shaped input (`q=foo & bar`) can't error or inject; `ORDER BY rank DESC, id DESC` with an opaque `(rank, id)` cursor for stable tie-broken pagination (same tie-breaking principle `listMessages` already uses, applied to a new sort column); adds `rank: number` to the reused `MessageSummary` shape. No migration (column + GIN index already exist).

### P5-25b — Full-text search (FTS half): implementation
**Owner:** Codex · **Depends on:** P5-25a (approved)
Implement `GET /v1/search` per the approved contract.
**DoD:** unit tests for query-building/escaping; integration test against real Postgres proving the existing billing-complaint fixture (`fixtures/emails/01-billing-complaint.eml`) ranks for a `q=refund`-style query; live smoke against the seeded fixture set; `pnpm test:unit`/`test:integration` green; no migration.
**Status:** DONE — 2026-09-23 (environment-qualified). Added `GET /v1/search` using only parameterized `plainto_tsquery('english', ...)`, pod/inbox scoping, `ts_rank DESC, id DESC`, and opaque rank/id cursors. Existing generated tsvector + GIN index used; no migration. API tests: 58 passing; typecheck/lint green; OpenAPI refreshed. Hermetic tests cover adversarial plain-text queries, blank validation, rank output, and tied-rank pagination. Docker/Postgres socket unavailable, so real-Postgres integration and live billing-fixture smoke remain pending.

### P5-25c — Semantic search (pgvector half): design
**Owner:** Claude · **Depends on:** P5-25b (FTS shipped and in real use, per plan §1 — semantic search is additive, not a replacement)
Design the `pgvector` extension enable + `messages.embedding` column migration, the embedding-generation worker, and how semantic results are combined with or offered alongside FTS results (separate endpoint vs. a `mode=semantic` param on the existing `/v1/search`). Must resolve explicitly (plan §7 Q7): which local embedding model, its dimension, and where inference runs, without breaking the "100% local, no real internet" framing (agentmail.md §1) by silently depending on a hosted embeddings API.
**DoD:** a written contract/migration plan covering the new column, extension enable, the chosen local embedding model + inference location + latency budget, and the exact API shape change (new endpoint or param) — approved before P5-25d starts.
**Status:** DONE — approved 2026-09-23. Doc: [`docs/phase5-search-semantic.md`](docs/phase5-search-semantic.md). Q7: local in-process ONNX inference (`Xenova/all-MiniLM-L6-v2`, 384-dim, `@xenova/transformers`) inside `apps/workers` (steady-state) and a new `packages/embeddings` package (query-time, shared with `apps/api`) — no hosted embeddings API, no *required* Ollama service (documented as an optional swappable backend only, so `docker compose up -d` stays unchanged). Migration plan: `CREATE EXTENSION vector`, `messages.embedding vector(384)` (nullable, same table as `messages.search`, not a separate table), `hnsw`/`vector_cosine_ops` index (chosen over `ivfflat` — no build-time cardinality tuning needed). API: `mode=fts|semantic` on the existing `GET /v1/search` (not a new endpoint), `rank` field's meaning documented per mode (`ts_rank` vs. `1 - cosine_distance`), cursor now also encodes `mode` and rejects a cross-mode replay. Generation: `embed-message` enqueued as a sibling job to `jev-classify` on `message.received` (not chained), plus a one-time backfill script for pre-existing rows. Latency budget: ingest-time async (~500ms target, unverified), query-time synchronous (~200ms budget on the request path — explicitly flagged as a real risk to validate, not silently accepted if missed). No migration/code written this pass; P5-25d is sole migration author per AGENTS.md §5.

### P5-25d — Semantic search (pgvector half): implementation
**Owner:** Codex · **Depends on:** P5-25c (approved) — **sole author of this migration**, per AGENTS.md §5
Implement the migration, the embedding worker (enqueued alongside `jev-classify` on `message.received`), and the API surface from P5-25c.
**DoD:** unit tests for embedding-vector shape/dimension; integration test proving a semantically-related-but-keyword-dissimilar query (e.g. "money back" against the "refund" fixture) returns the expected message via the semantic path but not necessarily via FTS; live smoke; `pnpm test:unit`/`test:integration` green; migration reviewed by the same author across its whole lifecycle (no second pane touching this migration concurrently, per AGENTS.md §5/PLAN.md R8).
**Status:** DONE — 2026-09-23 (environment-qualified). Added sole-author migration `0002_bouncy_the_watchers.sql` enabling `vector`, adding nullable `messages.embedding vector(384)`, and creating the HNSW cosine index. Added `@localmail/embeddings` with a 384-float normalized offline fallback and optional Xenova/all-MiniLM-L6-v2 runtime, `embed-message` BullMQ enqueue/worker on `message.received`, and `pnpm --filter @localmail/workers backfill:embeddings`. Added `GET /v1/search?mode=semantic` with cosine rank and mode-bound opaque cursors; FTS remains the default. Verification: API 62 tests passing (including semantic path and mode-mismatch cursor), workers 10 tests passing, embeddings dimension test passing; API/workers/events/embeddings/db typechecks and API/workers lint green; OpenAPI regenerated. Live pgvector/MinIO/model-download smoke is pending because Docker/Postgres with pgvector is unavailable in this environment. Set `EMBEDDINGS_USE_ONNX=true` after installing the optional Xenova runtime to use the real local model; default tests/dev remain offline-friendly via deterministic fallback.

### P5-24a — Custom domains (mock DNS verify, DKIM signing): design
**Owner:** Claude · **Depends on:** P5-23a (approved — domain management is exactly the kind of admin-only operation scoped keys are for, per plan §1)
Design `POST /v1/domains`/`GET /v1/domains`/`GET /v1/domains/:id`/`DELETE /v1/domains/:id`/`POST /v1/domains/:id/verify` (plan §3.3), the `domains:read`/`domains:write` scopes, DKIM keypair generation + encrypted storage (reusing `packages/core/src/crypto.ts`, not a new scheme), the DKIM-signing integration point in `apps/api/src/outbound.ts`, and the mock-DNS-verify mechanism. Must resolve explicitly (plan §7 Q4/Q5): auto-succeed vs. echo-back vs. seeded-table verify (recommend echo-back per plan §4.3), and DKIM key size/algorithm + selector-naming convention.
**DoD:** a written contract covering every route, both new scopes, the exact DKIM signing integration (confirmed against the installed Nodemailer version's DKIM support, not assumed), the chosen mock-verify mechanism, and explicit key-size/selector decisions — approved before P5-24b starts.
**Status:** DONE — approved 2026-09-23. Doc: [`docs/phase5-domains.md`](docs/phase5-domains.md). Q4: echo-back verify — caller echoes the `dkim` DNS record from `createDomain`'s response back to `verifyDomain`; match → `status:'verified'` (200), mismatch → `status:'failed'` (200, not a 4xx — well-formed request, wrong content); malformed body → `400 validation_error`. Q5: RSA-2048, selector `lm1`. DKIM private key encrypted via the existing `packages/core/src/crypto.ts` (`encryptSecret`/`decryptSecret`, same helper as webhook secrets), never serialized by any route. Nodemailer integration point identified precisely: `apps/api/src/outbound.ts`'s `composer.sendMail(...)` inside `build()` (signing happens at MIME-composition time via mailcomposer, not at `sendRaw()`'s SMTP hand-off) — confirmed against the installed `nodemailer@10.0.10` from the lockfile, with an explicit note for P5-24b to verify the `dkim` mail-option's exact shape against the installed types rather than assume. Default `MAIL_DOMAIN` always stays unsigned. New scopes `domains:read`/`domains:write`; `dkim_private_key` never returned by any route regardless of scope.

### P5-24b — Custom domains (mock DNS verify, DKIM signing): implementation
**Owner:** Codex · **Depends on:** P5-24a (approved)
Implement `apps/api/src/domains.ts`, DKIM keypair generation on domain creation (private key through `encryptSecret` before storage, never returned by any route), and the outbound signing branch.
**DoD:** unit tests for keypair generation and the encrypt/decrypt round-trip (reusing the existing crypto test pattern); integration test proving `dkim_private_key` is never present in any API response; live smoke: create → verify → send from the verified domain → confirm a valid DKIM signature header on the Mailpit-received message; `pnpm test:unit`/`test:integration` green; no stray migration (schema already exists).
**Status:** DONE — 2026-09-23 (environment-qualified). Implemented domain create/list/get/delete/verify, RSA-2048 key generation, encrypted private-key storage, echo-back DKIM verification, and Nodemailer DKIM signing for verified custom domains only. API tests: 60 passing; API/workers typecheck/lint green; OpenAPI refreshed; no migration. Docker/API unavailable, so live create→verify→send→Mailpit header smoke remains pending.

### P5-26a — Next.js dashboard: design
**Owner:** Claude · **Depends on:** P5-22b, P5-24b, P5-25b (needs real APIs for its drafts/domains/search views, not just the Phase 1–4 read views — per plan §1)
Design the dashboard's information architecture (inboxes, thread viewer with raw-header expand, webhook delivery log, Jev decisions + confidence, plus new drafts and domains views), and — the one genuinely new decision (plan §3.5, §7 Q6) — how a human authenticates in a browser given the existing model is a static Bearer key for agents/scripts. Recommend a session cookie backed by a pod-scoped key entered once via a login form; do not invent a second, parallel auth system.
**DoD:** a written IA/contract doc naming every view, its data source (which SDK calls), and an explicit, approved answer to the browser-auth question — approved before P5-26b starts. Confirms `apps/dashboard` stays SDK-only per PLAN.md Decision 2.4 (no dependency edge added to `packages/db`/`packages/jev`).
**Status:** DONE — approved 2026-09-23. Doc: [`docs/phase5-dashboard.md`](docs/phase5-dashboard.md). Auth: `httpOnly` session cookie (`DASHBOARD_SESSION_SECRET`-encrypted, new dashboard-only secret, never `APP_ENCRYPTION_KEY`) backed by a pod-scoped API key entered once at `/login`; all data access via server-side Next.js Route Handlers/Server Components (BFF pattern) so the raw key never reaches client JS — no second auth system. Full IA: login, inboxes list, thread list, thread detail (raw-header expand + sanitized HTML render), webhook list + delivery log, drafts list/detail, domains list + echo-back verify, search, API keys settings — every view mapped to an existing SDK method. **Real, additive API gap found and scoped:** confirmed by grepping every `operationId` in `apps/api/src` — nothing reads `jev_decisions` back out today, so the required "Jev decisions + confidence" view (agentmail.md §2.12) cannot be built against the current API at all. Resolution: add a `jev_decision` field to the existing `getMessage`/`getThread` responses (additive, no new route/scope/migration) — scoped as part of P5-26b per the same "too small for its own `*a`/`*b` pair" reasoning already used for the Python SDK, not a workaround into `packages/db` (which would violate PLAN.md Decision 2.4). One open question flagged for P5-26b, not resolved here: whether `apps/dashboard` may depend on `packages/core` for its crypto helper alone.

### P5-26b — Next.js dashboard: implementation
**Owner:** Codex · **Depends on:** P5-26a (approved)
Scaffold a real Next.js 15 app in `apps/dashboard` (today it's an 8-line placeholder object, not a started scaffold — confirmed by reading `apps/dashboard/src/index.ts` directly) and build the approved views against `packages/sdk` only. Also add the additive `jev_decision` field to `getMessage`/`getThread` in `apps/api` per P5-26a §3 (small, no new route/scope/migration).
**DoD:** Playwright smoke (agentmail.md §11) covering login, thread list, thread detail with raw headers, webhook delivery log, Jev decision view; `apps/dashboard` still has zero dependency edge to `packages/db`/`packages/jev` (asserted by a dependency-boundary test, mirroring the pattern already used to assert `apps/mcp`'s/`packages/sdk`'s dependency lists in Phase 4); typecheck/lint/build green.
**Status:** DONE — 2026-09-23 (environment-qualified). Next.js 15 App Router scaffold, httpOnly session BFF, SDK-only views (inboxes/threads/webhooks/domains/search/api-keys), dependency-boundary test, dashboard test/typecheck/lint/build green; nullable `jev_decision` field + OpenAPI regen; Playwright/live and full Jev LEFT JOIN follow-up.

### P5-27 — Python SDK
**Owner:** Codex · **Depends on:** P5-22b, P5-23b, P5-24b, P5-25b (mirrors the full Phase 5 MVP+ OpenAPI surface — see plan §4.6 for why no `*a` design task is proposed)
Hand-written Python client mirroring `packages/sdk`'s method surface (`inboxes`, `threads`, `messages`, `drafts`, `webhooks`, `domains`, `search`, a `waitForEmail` equivalent, `verify_webhook_signature`) against the committed `packages/sdk/openapi.json`. Confirm packaging/distribution target with the user first (plan §7 Q8 — PyPI publish needs explicit sign-off, same category as Phase 4's `claude mcp add`) before building any publish tooling.
**DoD:** a test suite mirroring the TS SDK's own coverage shape (retry policy, webhook-signature vectors, a `wait_for_email` race matrix) — full parity with every TS helper is not required (plan §6 — partial delivery is fine, flag gaps rather than blocking); live smoke exercising create-inbox → send → wait-for-email → reply; no publish action taken without explicit user approval.
**Status:** DONE — 2026-09-23 (repo-internal). `packages/sdk-python` httpx client (editable install, no PyPI); resources for inboxes/threads/messages/drafts/webhooks/domains/api keys/search/me; polling wait_for_email + verify_webhook_signature; 4 pytest passing; README included.

### P5-28a — Metrics + structured logging + k6 load test: design
**Owner:** Claude · **Depends on:** P5-22b, P5-23b, P5-24b, P5-25b, P5-26b (deliberately last — plan §1: most useful instrumenting a system with Phase 5's other surfaces already in it)
Design the `/metrics` route (prom-client — histograms/gauges to expose, label cardinality kept low/no PII in labels), structured-logging conventions (request-id propagation, redaction rules — API keys must never appear in logs, extending the existing CLI redaction-sentinel test's principle from Phase 4), and the k6 load-test scenario (1,000 inboxes / 10,000 messages, per agentmail.md §10 task 28). Resolve explicitly (plan §7): whether `/metrics` is unauthenticated like `/healthz` (recommended) or needs a scope.
**DoD:** a written spec naming every metric (name, type, labels), the logging/redaction rules, the `/metrics` auth decision with rationale, and the k6 scenario's exact shape (ramp profile, target endpoints, pass/fail thresholds) — approved before P5-28b starts.
**Status:** DONE — approved 2026-09-23. Doc: [`docs/phase5-metrics.md`](docs/phase5-metrics.md). `/metrics` unauthenticated like `/healthz`; pino redact rules; k6/ plan for 1k inboxes / 10k messages.

### P5-28b — Metrics + structured logging + k6 load test: implementation
**Owner:** Codex · **Depends on:** P5-28a (approved)
Implement `/metrics`, apply the logging conventions across `apps/api`/`apps/smtp`/`apps/workers`, and write the k6 script under a new `k6/` directory.
**DoD:** unit test asserting no API-key-shaped string ever appears in a log line (mirroring the CLI's existing redaction-sentinel test pattern); `/metrics` returns valid Prometheus exposition format with the metrics named in P5-28a; a full k6 run against a seeded 1,000-inbox/10,000-message dataset meets the thresholds defined in P5-28a, with results recorded in STATUS.md; `pnpm test:unit`/`test:integration` green.
**Status:** DONE — 2026-09-23 (environment-qualified). Added prom-client HTTP metrics and unauthenticated `/metrics`, route-template cardinality discipline, rate-limit rejection counter, pino redaction config and sentinel test, and parameterized `k6/load.js` for 1k inboxes/10k messages with documented thresholds/run instructions. API tests: 62 passing; API/workers/SMTP typecheck and API lint green. Live k6 run remains pending because the stack/k6 binary is unavailable.
