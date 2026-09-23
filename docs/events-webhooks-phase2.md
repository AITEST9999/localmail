# P2-11a — Events + Webhook Payload/Signing Design

> Design-only deliverable for TASKS.md **P2-11a**. Owner: Claude. Does not implement app code — this is what **P2-11b implements** (implementation owner for this run: **Cursor `cursor-lm`** — Codex is usage-limited until ~12:05 PM ET).
> Grounded in the as-built repo, same discipline as `docs/api-contract-phase1.md`: `packages/db/src/schema.ts` (`events`, `webhooks`, `webhook_deliveries`), `packages/core/src/inbound-contracts.ts` (`MessageEventPublisher` stub), `packages/core/src/inbound.ts` (its one real call site), `apps/api/src/outbound.ts` (which has **no** event-publisher hook at all yet), `apps/workers/src/index.ts` (a stub constant, no BullMQ/ioredis anywhere in the repo yet), and `packages/core/src/crypto.ts` (`encryptSecret`/`decryptSecret`, currently unused by any real code). Every deviation from agentmail.md's illustrative examples is called out explicitly, not silently substituted.

## APPROVED

- [x] `events` table usage — insertion point, ID prefix, `payload` vs. HTTP `data` shape, Phase 2 event-type list
- [x] Webhook matching — fan-out-at-emit-time decision, exact match predicate
- [x] HMAC signing — exact algorithm, exact signed string, headers, 5-minute tolerance, verify steps
- [x] BullMQ custom backoff — exact delay array, attempt counting, failure-after-5, HTTP success criteria, fake-clock test strategy
- [x] `webhook_deliveries` logging — row lifecycle, `last_error` format, uniqueness (schema gap identified, not fixed)
- [x] Secret handling — encryption at rest, generation, create-vs-GET exposure
- [x] Scope / API sketch for P2-12, including the test-fire "same code path" requirement
- [x] Gaps between the current stub and P2-11b's DoD, enumerated
- [x] Ready for Cursor (`cursor-lm`)

---

## 1. `events` table usage

### Insertion point

One `events` row per Phase-2 event type, inserted **inside the same function that also does the webhook-matching fan-out** (§2) — not by the SMTP/API request handler directly, and not deferred to the worker. See §7 for exactly where this function lives.

- **`message.received`**: inserted at the end of `packages/core/src/inbound.ts`'s `ingest()`, at the exact point it already calls `eventPublisher.emit(...)` (line ~118) — that call site doesn't move, only what's behind the `MessageEventPublisher` interface changes (§7).
- **`message.sent`**: **new call site.** `apps/api/src/outbound.ts`'s `createOutboundMessageService` currently takes no `eventPublisher` at all (confirmed — grep shows zero references to `MessageEventPublisher`/`emit(` in that file). P2-11b must add an `eventPublisher` parameter to `CreateOutboundMessageServiceOptions` and call `eventPublisher.emit({ type: 'message.sent', ... })` once the outbound message row is persisted, for **every** send/reply/forward — including the loopback path (loopback already separately triggers `message.received` on the recipient side via `ingestor.ingest()`; the sender side still needs its own `message.sent`).

### ID prefix and payload shape

- ID: `evt_<uuid32>` via the shared `createId('evt')` helper already exported from `packages/db` (the same helper `store.ts` already imports — reuse it, don't reintroduce a local one).
- `events.payload` (jsonb column) stores **only the event-specific `data` sub-object**, not the full webhook envelope — `id`, `type`, `created_at`, `pod_id` are already columns on the `events` row itself, so duplicating them inside `payload` too is redundant denormalization. The full webhook body (§3) is reconstructed at delivery time by combining the row's own columns with `payload` as `data`.
- **Deviation from agentmail.md §7's example payload:** the brief's illustrative webhook body nests a full `"message": { "...": "..." }` object inside `data`. Phase 2 ships a **thin** event instead:
  ```json
  { "inbox_id": "inb_…", "thread_id": "thr_…", "message_id": "msg_…" }
  ```
  for both `message.received` and `message.sent`. Rationale: embedding full message content (text/html/attachment metadata) in every `events.payload` row and every outbound webhook POST bloats storage and payload size, and unconditionally pushes full email content (including attachment refs) to whatever third-party URL a pod owner configures. A thin event plus `GET /v1/inboxes/:id/messages/:message_id` (already built, P1-9) is the more scalable and more conservative default. If a future phase wants a `full` delivery mode, that's an additive opt-in on the webhook subscription, not a Phase 2 concern — not designed here.

### Event types for Phase 2

| Type | Emitted from | Status |
|---|---|---|
| `message.received` | `packages/core/src/inbound.ts` (existing call site, extended payload per above) | **Required, Phase 2** |
| `message.sent` | `apps/api/src/outbound.ts` (new call site — gap, see §8) | **Required, Phase 2** |
| `webhook.test` | `POST /webhooks/:id/test` (P2-12) | **Required, Phase 2** — synthetic, see §7 |
| `message.delivered` | — | **Deferred.** Nothing in the stack currently produces an external delivery confirmation (Mailpit is a catcher, not a real MTA giving delivery receipts) — there's no signal to attach this to yet. Revisit if/when a real outbound relay with delivery callbacks exists (not a Phase 0–3 concern per agentmail.md's non-goals). |
| `message.bounced` | — | **Deferred**, same reason plus: bounce detection requires parsing NDR/bounce mail back through the inbound path and correlating it to the original send, which isn't built (no task in Phase 0–3 covers it). |
| `message.labeled` | — | **Deferred to Phase 3** (P3-14, Jev classification — the event exists once that worker exists; not this task's concern). |
| `thread.created` | — | **Deferred.** Not required by any Phase 0–3 acceptance criterion (agentmail.md §12); low-value to build ahead of demand. |
| `domain.verified` | — | **Deferred to Phase 5** (custom domains aren't built). |

### `emit()` becomes a durable insert + enqueue

`MessageEventPublisher.emit(event)` is reimplemented (not just re-pointed) as, in one DB transaction:
1. Insert the `events` row (id, `pod_id`, `type`, `payload`, `created_at`).
2. Query `webhooks` for matches (§2).
3. Insert one `webhook_deliveries` row per match (`status: 'pending'`, `attempts: 0`, `next_retry_at: null`).
4. Commit.
5. **After** commit succeeds, enqueue one BullMQ job per inserted delivery row onto the **`webhook-deliver`** queue (name already reserved in `apps/workers/src/index.ts`'s stub — reuse it, don't invent a second queue name) — `queue.add('deliver-webhook', { deliveryId }, { jobId: deliveryId, attempts: 5, backoff: { type: 'custom' } })`. Job data is just the delivery ID; the worker re-reads everything else from Postgres (single source of truth, no stale/duplicated payloads sitting in Redis).

This function needs both DB access and a BullMQ `Queue` producer, but is called from `apps/api` (outbound send) and `apps/smtp` (inbound receive) — both apps, neither of which may import the other or duplicate this logic (PLAN.md Decision 2.1). See §7 for where it lives.

**Known limitation, not fixed here:** if step 5 (the enqueue) fails after step 4 (the commit) already succeeded — e.g., Redis is briefly unreachable — the `webhook_deliveries` rows exist as `pending` with no corresponding BullMQ job, and nothing will ever pick them up. There's no reconciliation sweep in Phase 2. This is the same class of accepted gap as `docs/api-contract-phase1.md` §4's idempotency-key race: not exercised by any agentmail.md §12 acceptance criterion, and a periodic "requeue stale pending deliveries" sweep is a reasonable Phase 5 hardening item, not a P2-11b blocker. Flag it in a code comment at the enqueue call site; don't build a sweep now.

---

## 2. Webhook matching

**Decision: match at emit time (fan-out), not in the worker.** The worker only ever processes one already-resolved delivery per job — it never re-derives "who should get this." This is the better fit for the existing schema: `webhook_deliveries` carries its own `attempts`/`status`/`next_retry_at` per row, which only makes sense if retry state is already per-(webhook, event), not per-event-batch. It also keeps the sub-1-second `message.received` acceptance path (agentmail.md §12) fast — the expensive-ish part (matching + row inserts) happens once, synchronously, against local Postgres (milliseconds), and the worker's job is then just "sign and POST one row," not "look up who to tell."

This is a **clarification of TASKS.md P2-11b's description** ("BullMQ worker: consumes `events`, delivers to matching webhooks") — read that as "the pipeline this worker is part of consumes events and delivers to matching webhooks," not "the worker process itself performs the matching query." Making this explicit now so P2-11b's implementer doesn't have to guess which reading was intended.

**Match predicate** (SQL-shaped, exact):
```sql
SELECT * FROM webhooks
WHERE pod_id = $event.pod_id
  AND enabled = true
  AND $event.type = ANY(event_types)
  AND (inbox_ids IS NULL OR $event.inbox_id = ANY(inbox_ids))
```
- `enabled = false` → never matches, regardless of everything else.
- `event_types` membership is exact-string match against the type list in §1's table (no wildcards in Phase 2 — agentmail.md doesn't ask for wildcard subscriptions and the column is a plain `text[]`).
- `inbox_ids IS NULL` means "all inboxes in this pod" (agentmail.md §2.6's stated semantics); a non-null array scopes to just those inboxes.

---

## 3. HMAC signing

**Exact algorithm**, matching agentmail.md §7/§13 to the letter:

- Header: `X-LocalMail-Signature: t=<unix_seconds>,v1=<hex>`
- Signed string: `` `${t}.${body}` `` where `body` is the **exact raw JSON byte sequence sent on the wire** — computed once, signed, and sent without any re-serialization in between. Concretely: the worker builds the JSON string first (`JSON.stringify(envelope)`), computes the signature over `t + "." + jsonString`, and sends that identical string as the request body (not `JSON.stringify` called a second time, which could reorder keys or change whitespace and invalidate the signature the sender itself just computed).
- Algorithm: `HMAC-SHA256(secret, signedString)`, hex-encoded. `secret` = the **decrypted** raw `webhooks.secret` for this webhook (see §6).
- Also sent: `X-LocalMail-Event-Id: <events.id>` (agentmail.md §7) and `Content-Type: application/json`.
- `t` = Unix seconds at the moment of signing (i.e., of this delivery attempt — **not** the event's `created_at`; a retried delivery gets a fresh `t` on each attempt, since the tolerance window in §3's verify steps is relative to send time, not event time).

**Envelope** (the JSON that becomes `body` above):
```json
{
  "id": "evt_…",
  "type": "message.received",
  "created_at": "2026-09-23T14:03:11.000Z",
  "pod_id": "pod_…",
  "data": { "inbox_id": "inb_…", "thread_id": "thr_…", "message_id": "msg_…" }
}
```
(`created_at` is the `events` row's own timestamp — when the event happened — distinct from `t` in the signature header, which is when this particular delivery attempt is being signed.)

**Verify steps** (document literally this way in `examples/webhook-receiver` and any Phase 2 tests, per agentmail.md §11/§13):
1. Parse `t` and `v1` out of `X-LocalMail-Signature`.
2. Reject if `abs(now_unix_seconds - t) > 300` (5-minute tolerance, agentmail.md §13) — **before** checking the signature, so a stale replayed request is rejected cheaply.
3. Recompute `HMAC-SHA256(secret, t + "." + rawRequestBody)` — the verifier must use the **raw bytes** of the request body exactly as received (not a re-parsed-then-re-stringified version — same reasoning as the sender side), hex-encode, and compare to `v1` with a constant-time comparison (`crypto.timingSafeEqual`, same pattern already used in `apps/api/src/auth.ts` and `attachments.ts` — don't use `===`).
4. Accept only if both the tolerance check and the signature match pass.

---

## 4. BullMQ custom backoff

**Exact delay array**, per agentmail.md §7 and PLAN.md §5 (not BullMQ's built-in `exponential` type — the ratios (×5, ×6, ×4, ×6) don't fit a clean exponential curve):

```ts
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000,      // attempt 1 failed → wait 1m before attempt 2
  300_000,     // attempt 2 failed → wait 5m before attempt 3
  1_800_000,   // attempt 3 failed → wait 30m before attempt 4
  7_200_000,   // attempt 4 failed → wait 2h before attempt 5
  43_200_000,  // attempt 5 failed → give up (see below)
] as const;

export function webhookBackoffDelayMs(attemptsMade: number): number {
  return WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1] ?? WEBHOOK_RETRY_DELAYS_MS.at(-1)!;
}
```
`attemptsMade` is BullMQ's own 1-indexed count of attempts already made when a job fails (i.e., `attemptsMade === 1` after the first failure). This pure function is what gets unit-tested directly (see fake-clock note below) — it takes no BullMQ types and has no I/O.

**Wiring into BullMQ:** job options are `{ attempts: 5, backoff: { type: 'custom' } }`, with a custom backoff strategy registered on the `Worker` (BullMQ exposes this as a `settings.backoffStrategy(attemptsMade, type, err, job)` function returning a delay in ms — confirm the exact registration call against whichever BullMQ version P2-11b pins in `apps/workers/package.json`; **this repo has zero BullMQ code today** so there's no existing convention to match, and BullMQ's backoff-registration API has shifted across major versions — verify against the installed version's own types/docs before wiring, don't copy this signature blind). The behavioral contract below is what must hold regardless of the exact BullMQ call shape:

- 5 total attempts, delays exactly as above between them.
- **After the 5th failed attempt**, BullMQ marks the job permanently failed (no 6th attempt) — at that point the processor must set `webhook_deliveries.status = 'failed'`, `next_retry_at = null`. Detect "this was the last attempt" via `job.attemptsMade === job.opts.attempts` (both are BullMQ-provided) at the point the processor is about to re-throw/report failure.
- **Success** (§4's HTTP criteria) at any attempt → `status = 'delivered'`, `last_error = null`, `next_retry_at = null`. Stop — no further attempts even if `attempts < 5` were used.

**Attempt counting vs. `webhook_deliveries.attempts`:** the DB column is our own observability mirror, not what drives retry scheduling — BullMQ's internal `job.attemptsMade` is authoritative for scheduling. At the **start** of every processor invocation (before the HTTP call), increment `webhook_deliveries.attempts` and set `status = 'delivering'`. If the two counters ever diverge by one (e.g., a crash between the HTTP call and the DB update), that's an accepted, non-blocking observability gap — not exercised by any §12 acceptance criterion.

**HTTP success criteria:** **2xx only** (200–299). 3xx is treated as a failure, not success, and redirects are **not followed automatically** — configure the HTTP client for manual/no-redirect handling. This is a deliberate default: `webhooks.url` is arbitrary pod-owner-supplied input, and silently following a redirect it returns is exactly the shape of an SSRF footgun, even though full SSRF hardening (blocking internal IP ranges, etc.) is out of scope for a local-only tool. A 10-second request timeout applies to every attempt; a timeout counts as a failure and retries per the same schedule (guards against a hung receiver holding a worker concurrency slot indefinitely — same class of safeguard as PLAN.md's Jev timeout/circuit-breaker requirement).

**Fake-clock test strategy (the actual DoD requirement — "test with a fake clock, not real waits"):** BullMQ does not expose a clean in-process fake clock for delayed jobs (delays are scheduled against Redis time). Do **not** attempt a real BullMQ+Redis integration test that waits 12 real hours, and do not attempt to fake Redis's clock. Instead:
1. Unit-test `webhookBackoffDelayMs` directly — pure function, no mocks needed, assert the exact five values plus the "5th attempt onward returns the last value" edge (defensive; BullMQ shouldn't call it past `attempts: 5`, but the function shouldn't throw if it somehow does).
2. Unit-test the **processor function** in isolation (extract it as a plain function taking `{ deliveryId, attemptsMade, maxAttempts }` plus injected `store`/`httpClient`/`clock` — not a real `Job` object) driven with a fake HTTP client returning 500 repeatedly, calling it five times with `attemptsMade` 1→5, and asserting: `attempts` increments each call, `status` stays `pending`/`delivering` transitions correctly, `last_error` is set, and only on the 5th call does `status` become `failed`. This tests the actual retry-state-machine logic the DoD cares about without touching BullMQ's scheduler at all.
3. A single, separate live-integration smoke (real Redis, real BullMQ, real receiver) is fine for proving the wiring works end-to-end with real (short) delays — but that's a manual/CI smoke, not how the "5 attempts, mark failed" behavior itself gets proven; that proof lives in (2).

---

## 5. `webhook_deliveries` logging

**Row lifecycle** — one row per `(webhook_id, event_id)` pair, created once at fan-out (§1 step 3) and mutated in place across every attempt (not one row per attempt):

| State | `status` | `attempts` | `last_error` | `next_retry_at` |
|---|---|---|---|---|
| Created (fan-out) | `pending` | `0` | `null` | `null` |
| Attempt in flight | `delivering` | incremented at start of this attempt | unchanged until this attempt resolves | unchanged |
| Attempt failed, more retries left | `pending` | (as incremented above) | this attempt's error, truncated to 500 chars | `now + webhookBackoffDelayMs(attempts)` (informational — BullMQ's internal scheduling is authoritative, this is for the delivery-log UI in Phase 5) |
| Attempt failed, was the 5th | `failed` | `5` | this attempt's error, truncated to 500 chars | `null` |
| Attempt succeeded | `delivered` | (as incremented above) | `null` (clear any prior failure) | `null` |

`last_error` format: `"HTTP <status> <statusText>"` for a non-2xx response, `"request timed out after 10000ms"` for a timeout, or `` `fetch failed: ${error.message}` `` for a network-level error — always truncated to 500 characters before storing (a Postgres `text` column has no hard limit, but an unbounded error body from an attacker-influenced receiver shouldn't be allowed to bloat a row indefinitely).

**Uniqueness — schema gap, not fixed here:** `packages/db/src/schema.ts`'s `webhook_deliveries` table has no unique constraint on `(webhook_id, event_id)`. Nothing in the schema itself currently prevents two delivery rows for the same pair (e.g., if the fan-out transaction in §1 were ever accidentally run twice for the same event). **Do not migrate this in P2-11b** — per this task's constraints, schema gaps get documented, not silently patched. Recommend a follow-up: `uniqueIndex('webhook_deliveries_webhook_event_unique').on(table.webhookId, table.eventId)`, owned by whoever holds schema-change ownership for Phase 2 (AGENTS.md §5's one-owner-at-a-time convention), reviewed the same way P0-3a was.

---

## 6. Secret handling

- **Per-webhook secret**, not a shared app secret — distinct from `ATTACHMENT_SIGNING_KEY` (P1-10's single shared HMAC key for signed download URLs). Each `webhooks` row gets its own randomly generated secret at creation (P2-12: `crypto.randomBytes(32).toString('hex')` — 64 hex chars, plenty of entropy for an HMAC key).
- **Encrypted at rest** using the existing `encryptSecret`/`decryptSecret` (`packages/core/src/crypto.ts`, AES-256-GCM, PLAN.md Decision 3.2) — `webhooks.secret` stores the ciphertext (`v1:<iv>:<authTag>:<ciphertext>`, the format `crypto.ts` already produces), not the raw secret.
- **Decode `APP_ENCRYPTION_KEY` once at process bootstrap**, in both `apps/api` (needed for webhook create/rotate in P2-12) and `apps/workers` (needed to decrypt before signing every delivery) — not per-request/per-job. **Fail loudly at startup** if `APP_ENCRYPTION_KEY` is unset or the wrong length, via `decodeEncryptionKey`'s existing validation — don't defer the failure to the first webhook create/delivery attempt.
- **Create-vs-GET exposure:** the raw secret is returned **only** in the `201` response body of `POST /webhooks` (agentmail.md-standard "shown once" UX, matching §13's API-key precedent — `POST /api-keys` isn't built yet, but the same posture applies here). `GET /webhooks/:id` and `GET /webhooks` **omit the `secret` field entirely** from the response schema — not masked/redacted, not present at all. There is no "reveal secret again" or "show last 4 chars" affordance in Phase 2; if a pod owner loses it, the only path is rotating (delete + recreate, or a future `POST /webhooks/:id/rotate-secret` — not designed here, not required by any Phase 2 task).

---

## 7. Scope / API sketch for P2-12

Brief, so CRUD doesn't renegotiate naming (same posture as `docs/api-contract-phase1.md` §5).

**New package: `packages/events`.** The durable-insert-plus-enqueue function from §1 needs both DB access and a BullMQ `Queue` producer, and is called from both `apps/api` (outbound send) and `apps/smtp` (inbound receive) — neither app may import the other or duplicate this logic (PLAN.md Decision 2.1), and it can't live in `packages/core` (infra-free per Decision 2.2 — BullMQ is infra) or `packages/db` (keeps that package persistence-only). `packages/events` depends on `packages/db` + `bullmq`; `apps/api`, `apps/smtp`, and `apps/workers` all depend on it. Exports `createDurableEventPublisher(db, queueConnection): MessageEventPublisher` (§1) plus the shared `WEBHOOK_RETRY_DELAYS_MS`/`webhookBackoffDelayMs` from §4, so the enqueue side and the worker side agree on the exact same constants by import, not by copy-paste. This is a one-line addition to PLAN.md §2's package graph, not a re-architecture — flagging it here since PLAN.md predates this package's existence.

**Scopes** (extends `docs/api-contract-phase1.md` §1's table):

| Scope | Grants |
|---|---|
| `webhooks:read` | `GET /webhooks`, `GET /webhooks/:id`, `GET /webhooks/:id/deliveries` |
| `webhooks:write` | `POST /webhooks`, `PATCH /webhooks/:id`, `DELETE /webhooks/:id`, `POST /webhooks/:id/test` |

Test-fire requires `webhooks:write` (not a separate scope) — it performs a real side effect (a real HTTP POST, a real `webhook_deliveries` row), so it belongs with the other mutating actions, not with read-only access.

**operationIds** (same camelCase convention as Phase 1): `createWebhook`, `listWebhooks`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `testFireWebhook`, `listWebhookDeliveries`.

**Test-fire must use the same delivery code path as real events (TASKS.md P2-12 DoD) — exact mechanism:** `POST /webhooks/:id/test` does **not** call the receiver's URL directly or fabricate a fake "delivered" log row. It calls the same `createDurableEventPublisher` function from §1/§7, with a synthetic `webhook.test` event (§1's type table) — **except** the fan-out step (§2) is replaced with a single hardcoded match: exactly the one `webhook_id` from the route param, **regardless of that webhook's own `enabled`/`event_types`/`inbox_ids` filters** (you're explicitly testing *this* webhook, on purpose, even if it's currently disabled or not subscribed to `webhook.test` — there's no reason a pod owner would have `webhook.test` in their `event_types` list). Everything downstream — the `webhook_deliveries` row, the BullMQ enqueue, the worker's signing/HTTP/retry logic — is the identical code the real fan-out path uses. This is what makes it "the same code path," literally, not just similar.

---

## 8. Gaps between the current stub and P2-11b's DoD

1. **`apps/workers` is a stub constant** (`workerService = { name, queues, status: 'stub' }`, `apps/workers/src/index.ts`) — no real BullMQ `Worker`, no `Queue`, nothing. P2-11b is the first real code in this app.
2. **No `bullmq` or `ioredis`/Redis-client dependency exists anywhere in the repo** (checked every `package.json` — none). P2-11b adds `bullmq` to `apps/workers` and to the new `packages/events` (§7); confirm the installed version's backoff-registration API before wiring (§4's caveat) rather than assuming a specific call signature.
3. **`MessageEventPublisher` only models `message.received`.** `apps/api/src/outbound.ts` has zero references to it — `message.sent` has no call site to extend, it needs to be added (§1). Extending the interface to a `MessageEvent` union (or adding a second method) is part of this task's implementation, not a pre-existing seam to reuse as-is.
4. **`webhooks.secret`/`encryptSecret`/`decryptSecret` have no real call sites yet** — the crypto helpers exist and are unit-tested in isolation (`packages/core/src/__tests__/crypto.test.ts`) but nothing in `apps/api` or `apps/workers` calls them today. P2-11b/P2-12 are the first consumers.
5. **`APP_ENCRYPTION_KEY` is optional in `packages/config/src/env.ts` and is unset in the actual local `.env` right now** (confirmed — grep found zero occurrences). Decrypting/encrypting will throw immediately the first time it's attempted unless someone sets it locally (`.env.example` already has the right generation hint as a comment: `openssl rand -base64 32`). Fail at process bootstrap (§6), and make sure the local dev setup docs/`.env` actually get a real value before P2-11b's live smoke test, or the first webhook create will throw.
6. **No repository/store functions exist for `events`, `webhooks`, or `webhook_deliveries`** — `apps/api/src/store.ts`'s `ApiStore` interface (checked directly) only covers API keys, idempotency, inboxes, threads, messages, and attachments so far. P2-11b/P2-12 add these.
7. **`webhook_deliveries` has no unique constraint on `(webhook_id, event_id)`** — documented as a schema gap in §5, not fixed here per this task's constraints.
8. **`packages/events` doesn't exist yet** — this doc is its first specification (§7); P2-11b creates it.

---

Ready for Cursor (`cursor-lm`).
