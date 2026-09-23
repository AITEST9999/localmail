# P5-22a — Drafts + Scheduled Send: Design

> Design-only deliverable for TASKS.md **P5-22a**. Owner: Claude. Does not implement app code — this is what P5-22b (Codex) implements against.
> Grounded in the actual repo state: `packages/db/src/schema.ts`'s `drafts` table (already exists — `to`/`cc`/`subject`/`text`/`html`/`send_at`/`status` enum `draft|scheduled|sending|sent|failed`, no migration needed), `apps/api/src/outbound.ts` (existing send path, reused rather than duplicated), `apps/api/src/auth.ts` (scope-check pattern), `apps/api/src/errors.ts` (`ApiErrorCode` catalog), and `apps/api/src/idempotency.ts` (existing `Idempotency-Key` middleware, reused as-is). Expands `docs/phase5-plan.md` §3.1/§4.1 into the approved contract.

## APPROVED — 2026-09-23

- [x] Route contracts (request/response/error shapes) for all six draft routes
- [x] Two new scopes: `drafts:read`, `drafts:write`
- [x] Scheduled-send mechanism: interval poller (not BullMQ delayed jobs) — decision + rationale below
- [x] `send_at` in the past → reject, do not coerce
- [x] Mid-flight edit race (PATCH vs. worker claim) — resolved via optimistic status transition
- [x] Inbox deleted before `send_at` — resolved via `ON DELETE CASCADE` + worker no-op

Ready for Codex (P5-22b).

---

## 1. Scopes

| Scope | Grants |
|---|---|
| `drafts:read` | `GET /v1/inboxes/:inbox_id/drafts`, `GET /v1/inboxes/:inbox_id/drafts/:draft_id` |
| `drafts:write` | `POST`, `PATCH`, `DELETE` on drafts |

`sendDraft` reuses the existing `messages:send` scope — sending is sending, regardless of whether the message originated as a draft (matches `docs/phase5-plan.md` §3.1's reasoning; do not add a third scope for this).

---

## 2. Routes

All routes are under `/v1/inboxes/:inbox_id/drafts`, follow the existing `apps/api/src/inboxes.ts`/`messages.ts` conventions: Zod request/response schemas, `operationId` in camelCase, `{ error: { code, message, details? } }` on failure, pod-scoped 404 isolation (a draft belonging to another pod's inbox 404s, never 403 — matches every existing route's cross-pod behavior).

### `POST /v1/inboxes/:inbox_id/drafts` — `createDraft`
**Scope:** `drafts:write` · **Idempotency-Key:** honored (existing middleware, `apps/api/src/idempotency.ts`)

Request body:
```ts
{
  thread_id?: string;        // reply-draft; must belong to this inbox, 404 if not
  to: string[];               // required, min 1
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  send_at?: string;           // ISO-8601; omit = plain draft, no scheduling
}
```
Response `201`: full draft row (`Draft` schema — mirrors `drafts` table columns, camelCase). `status` is `'draft'` if `send_at` omitted, `'scheduled'` if `send_at` provided and valid (see §4 for validation).

### `GET /v1/inboxes/:inbox_id/drafts` — `listDrafts`
**Scope:** `drafts:read`

Standard cursor pagination, same shape as `listMessages` (`page_token`, `limit`, `Pagination` response wrapper). Filter: `status?` query param (e.g. `?status=scheduled` to see what's pending).

### `GET /v1/inboxes/:inbox_id/drafts/:draft_id` — `getDraft`
**Scope:** `drafts:read` · `404 not_found` if missing/cross-pod.

### `PATCH /v1/inboxes/:inbox_id/drafts/:draft_id` — `updateDraft`
**Scope:** `drafts:write`

Body: any subset of `to`/`cc`/`subject`/`text`/`html`/`send_at` (including `send_at: null` to un-schedule back to a plain draft).

**Allowed only when `status = 'draft'` or `status = 'scheduled'`.** If `status` is `'sending'`, `'sent'`, or `'failed'` → `409`-shaped error, code `validation_error` (existing catalog has no `conflict` code; reuse `validation_error` with a clear message — do not add a new `ApiErrorCode` for one route, per the "don't over-engineer" convention already used elsewhere in this repo), message: `"Draft has already been sent or is currently sending and can no longer be edited."`

**Race handling (mid-flight PATCH vs. worker claim):** the poller (§4) claims a row with `UPDATE drafts SET status = 'sending' WHERE id = $1 AND status = 'scheduled' RETURNING *`. `updateDraft` performs its own conditional update: `UPDATE drafts SET ... WHERE id = $1 AND status IN ('draft', 'scheduled') RETURNING *`. If zero rows come back (because the worker won the race and flipped status to `'sending'` in between the read and the write), `updateDraft` returns the `409`-shaped `validation_error` above — same response a normal "already sending" PATCH would get, no special-cased retry logic needed. This is a plain optimistic-concurrency check, not a new locking primitive.

### `DELETE /v1/inboxes/:inbox_id/drafts/:draft_id` — `deleteDraft`
**Scope:** `drafts:write`

Same conditional-delete pattern: `DELETE FROM drafts WHERE id = $1 AND status IN ('draft', 'scheduled') RETURNING id`. Zero rows → `409`-shaped `validation_error`, same message pattern as above ("...and can no longer be deleted"). `204` on success.

### `POST /v1/inboxes/:inbox_id/drafts/:draft_id/send` — `sendDraft`
**Scope:** `messages:send` · **Idempotency-Key:** honored

No body (or an empty object). Two cases:

- **No `send_at` was ever set (or draft is currently `status='draft'`):** send immediately through the existing `apps/api/src/outbound.ts` path, exactly as if the caller had called `POST .../messages/send` with the draft's fields. On success, update the draft row `status = 'sent'` and return the created **message** (not the draft) as the response body — matches what `POST .../messages/send` already returns, so callers don't need a different response shape depending on how the send was triggered.
- **Draft is `status='scheduled'`:** this endpoint is a manual "send now instead of waiting" override. Conditional update `UPDATE drafts SET status='sending' WHERE id=$1 AND status='scheduled' RETURNING *` (same optimistic-concurrency pattern as `updateDraft`/`deleteDraft` — if the poller already claimed it in the same instant, this returns the same `409`-shaped conflict rather than double-sending), then proceeds exactly like the immediate-send case above.

`status='sending'`/`status='sent'`/`status='failed'` when called → `409`-shaped `validation_error` ("Draft is already sending, has been sent, or previously failed to send.").

---

## 3. `send_at` in the past → reject

**Decision: reject with `422`-shaped `validation_error` at `createDraft`/`updateDraft` time. Do not silently coerce to "send now."**

Rationale: coercion hides a caller bug (a clock-skew or off-by-one-unit mistake in computing `send_at`) behind an immediate send that looks like it worked. An agent composing a draft with a bad `send_at` should get a clear, immediate error it can fix, not mail sent earlier than it thought it scheduled. Validation: `send_at <= now()` (server clock, at request-validation time, not DB-insert time — a few hundred ms of clock skew between the request landing and the row committing is not the case this guards against; a `send_at` that's already in the past *at request time* is) → `422 validation_error`, message: `"send_at must be in the future."` Exact HTTP status: this repo's existing error catalog doesn't distinguish 422 from 400 elsewhere (`validation_error` maps to `400` throughout `apps/api/src/errors.ts`) — **use `400`, not `422`, for consistency with every other route's `validation_error`.** (Correcting the TASKS.md row's "422" phrasing here — the actual repo convention is 400 for `validation_error`, and P5-22b should follow the existing convention, not introduce a new status code for one route.)

---

## 4. Scheduled-send mechanism: interval poller

**Decision: interval poller in `apps/workers`, not BullMQ delayed jobs.**

Implementation shape:
- A `setInterval`-driven loop (or the equivalent recurring-job pattern already used elsewhere in `apps/workers`, if one exists — P5-22b should match whatever convention is already there rather than introducing a second scheduling primitive) running every **5 seconds** (configurable via `SCHEDULED_SEND_POLL_INTERVAL_MS`, default `5000` — matches the plan's "every ~5s" framing).
- Each tick: `SELECT id FROM drafts WHERE status = 'scheduled' AND send_at <= now() ORDER BY send_at ASC LIMIT 20` (batch cap so one worker tick can't try to claim thousands of rows at once — 20 is a reasonable starting cap for a local-first tool; not a hard architectural constraint, just a sane default), then for each id, the claim-and-send sequence:
  1. `UPDATE drafts SET status = 'sending' WHERE id = $1 AND status = 'scheduled' RETURNING *` — this is the sole concurrency guard. If it returns zero rows, another poller tick (or a concurrent `sendDraft` manual-override call, §2) already claimed it; skip silently, no error.
  2. On successful claim, call the same send logic `sendDraft` uses (shared function, not duplicated) using the row returned by the `UPDATE ... RETURNING`, not a fresh read (avoids a second read-then-act race).
  3. On send success: `status = 'sent'`.
  4. On send failure (e.g. Nodemailer/Mailpit error): `status = 'failed'`, and — matching this repo's existing pattern of storing failure detail (`webhook_deliveries.last_error`) — consider whether `drafts` needs a `last_error` column of its own. **Not adding one in this design**: the `drafts` table as already migrated in has no such column, and adding one is a schema change this design-only task should not silently introduce (see AGENTS.md §5 — one migration author per phase, and this isn't that author). If P5-22b's implementer finds `status='failed'` with no detail insufficient, that's a legitimate reason to flag a follow-up schema review rather than add a column ad hoc.

**Why a poller over BullMQ delayed jobs** (per `docs/phase5-plan.md` §4.1's open question, resolved here): a BullMQ delayed job would need to be updated or removed whenever a draft's `send_at` is edited via `updateDraft` (§2) — that's an extra synchronization point between the drafts table and the queue that the poller doesn't need, since the poller always reads current `send_at` off the row itself. The poller is also simpler to reason about for a local-first, single-instance deployment (no need to worry about a delayed job surviving a Redis restart, no `removeOnComplete`/job-id bookkeeping). The cost — up to ~5s of latency between `send_at` and actual send — is acceptable for this project's scope (agentmail.md doesn't specify a scheduled-send latency SLA).

---

## 5. Inbox deleted before `send_at`

**Decision:** `drafts.inbox_id` already has `ON DELETE CASCADE` to `inboxes` (confirmed in `packages/db/src/schema.ts:214`) — deleting an inbox deletes its scheduled drafts automatically at the DB level. No application code needs to handle "draft exists but inbox doesn't" as a steady-state case, because that state can't persist.

The one edge case worth naming explicitly: the poller reads a batch of draft ids (§4 step 1), and *between* that read and the claim-UPDATE (§4 step 2), the inbox (and cascaded draft) could be deleted. The claim-UPDATE (`WHERE id = $1 AND status = 'scheduled'`) naturally returns zero rows in that case too (the row no longer exists) — same "skip silently" path as the concurrent-claim case, no special-cased handling needed. Log at `debug` level when a claimed-batch id yields zero rows on the UPDATE (covers both "someone else claimed it" and "it was deleted" — distinguishing the two isn't necessary for correctness, only for debugging, and a debug-level log is enough for that).

---

## 6. Test coverage this design implies (for P5-22b, informational — not the DoD itself, see TASKS.md)

- Unit: status-transition matrix (`draft→scheduled→sending→sent`, `draft→scheduled→sending→failed`, attempted edits/deletes at each terminal/in-flight state); `send_at`-in-the-past rejection; the optimistic-update-returns-zero-rows path for `updateDraft`/`deleteDraft`/`sendDraft`.
- Integration (Testcontainers): a draft scheduled `+2s` out is picked up by the poller within one or two ticks and actually sent (assert against the same loopback/Mailpit mechanism `apps/api/src/outbound.test.ts` already uses); a concurrent `sendDraft` manual-override racing the poller results in exactly one send, not two.
- Live smoke: schedule a draft `+5s` out via the real API, confirm delivery in Mailpit/loopback without further calls.
