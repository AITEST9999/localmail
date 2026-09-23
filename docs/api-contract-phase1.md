# P1-4a — Phase 1 API Contract

> Design-only deliverable for TASKS.md **P1-4a**. Owner: Claude. Does not implement app code — this is what P1-4b (Codex) implements against.
> Grounded in the actual Phase 0 state of the repo (schema in `packages/db/src/schema.ts`, `packages/config/src/env.ts`, `apps/api/src/app.ts`, seed's key-hashing in `packages/db/src/seed.ts`), not just the brief. Every deviation from agentmail.md is called out explicitly, not silently substituted.

## APPROVED

- [x] Auth middleware: API-key lookup/verification scheme, scope model, failure-response catalog
- [x] Error envelope: kept `{ error: { code, message } }`, full code catalog for Phase 1, refinement needed in P1-4b (gap noted)
- [x] Pagination cursor format: opaque `page_token`, matches existing DB indexes
- [x] Idempotency-Key semantics vs. `idempotency_keys` (409 vs. replay), with a documented concurrency limitation of the as-built schema
- [x] OpenAPI tags/operationId/schema-component naming for `/docs` (SDK-ready)
- [x] Route sketch for Phase 1 inbox/thread/message/send endpoints
- [x] Gaps between the Phase 0 API stub and P1-4b's DoD, enumerated so Codex doesn't have to guess

Ready for Codex — see STATUS.md.

---

## 1. Auth middleware

### Key format and lookup (grounded in what's already seeded)

`packages/db/src/seed.ts` already established the real format in use — this contract follows it rather than the `argon2` mention in agentmail.md §13 / PLAN.md §3 (see **Deviation** box below):

- Raw key string, e.g. `lm_admin_change_me` or a generated `lm_live_…`.
- `apiKeys.prefix` = **first 12 characters** of the raw key, unique-indexed (`api_keys_prefix_unique`) — this is the lookup key, not the hash.
- `apiKeys.hash` = `scrypt:<salt_b64>:<derived_b64>`, produced by `scryptSync(rawKey, salt, 64)` with a random 16-byte salt (Node's `crypto.scryptSync` default cost params: N=16384, r=8, p=1).

**Verification algorithm** (implement in a Fastify `preHandler`/plugin, decorate `request.apiKeyRow`):
1. Read `Authorization: Bearer <key>`. Missing or malformed → `401 unauthorized` (`missing_authorization`).
2. `prefix = key.slice(0, 12)`. `SELECT * FROM api_keys WHERE prefix = $1`. Not found → `401 unauthorized` (`invalid_api_key`) — same code/message as a hash mismatch, deliberately, so prefix-guessing doesn't leak which prefixes exist.
3. If `revoked_at IS NOT NULL` → `401 unauthorized` (`invalid_api_key`) — same code again, for the same reason.
4. Parse `hash` (`scrypt:<salt>:<derived>`), recompute `scryptSync(key, salt, 64)`, compare with `crypto.timingSafeEqual` (not `===` — timing side-channel). Mismatch → `401 unauthorized` (`invalid_api_key`).
5. Success → decorate `request.apiKeyRow = row`, `request.podId = row.podId`. Fire-and-forget update of `last_used_at` (don't block the response on it).

### Deviation: scrypt, not argon2

agentmail.md §13 says "Hash API keys (argon2)" and PLAN.md repeats it. **Phase 0's seed script already shipped scrypt** (Node built-in, zero new native dependency) before this contract was written. Recommendation: **keep scrypt for Phase 1.** It's already seeded data, already a reasonable KDF for this threat model (local-only, not a public multi-tenant SaaS), and switching to argon2 mid-phase would mean re-seeding and adding a native dependency (`argon2` npm package needs a compiled binding) for a security margin that doesn't change the Phase 0–3 acceptance criteria. If a real argon2 migration is wanted, it's a self-contained follow-up (seed script + this verification function, both isolated) — flag it as a Phase 5 hardening candidate, not a P1-4b blocker. **Do not silently keep calling this "argon2" in comments/docs going forward — it's scrypt.**

### Scopes

`api_keys.scopes text[]` already exists; seed grants `['*']` to the admin key. Scope check: `scopes.includes('*') || scopes.includes(requiredScope)`.

Scope names for Phase 1 routes (extends agentmail.md §2.7's examples):

| Scope | Grants |
|---|---|
| `admin` | `POST /pods`, `POST /api-keys` (not built in Phase 1, reserved) |
| `inboxes:read` | `GET /inboxes`, `GET /inboxes/:id` |
| `inboxes:write` | `POST /inboxes`, `PATCH /inboxes/:id`, `DELETE /inboxes/:id` |
| `threads:read` | `GET .../threads`, `GET .../threads/:id` |
| `messages:read` | `GET .../messages`, `GET .../messages/:id`, `.../raw` |
| `messages:send` | `POST .../messages/send`, `.../reply`, `.../forward` |
| `messages:write` | `PATCH .../messages/:id` (labels) |

The seeded admin key (`*`) satisfies all of these for local dev; per-scope keys aren't exercised until a task explicitly creates one (not in Phase 1 scope — `POST /api-keys` is a stretch item, not required for the §12 acceptance list).

### Failure-response catalog

| Situation | HTTP | `error.code` |
|---|---|---|
| No/malformed `Authorization` header | 401 | `missing_authorization` |
| Unknown prefix, revoked key, or hash mismatch | 401 | `invalid_api_key` |
| Valid key, missing required scope | 403 | `insufficient_scope` |
| Valid key, resource belongs to a different pod | 404 | `not_found` (never 403 — don't confirm existence across pod boundaries) |

Rate limiting (agentmail.md §2.7) is explicitly **not** in Phase 1 scope (brief places it at Phase 5 pods/scoped-keys work) — the `request.apiKeyRow` decorator above is what a future rate-limit plugin would key off, so nothing here needs to change when that lands.

---

## 2. Error envelope and code catalog

Keep the existing shape from `apps/api/src/app.ts` — do not change the top-level envelope:

```json
{ "error": { "code": "string", "message": "human-readable string", "details": [ /* optional, validation only */ ] } }
```

`details` is new (not in agentmail.md) — needed for Zod validation errors to be actionable. It's optional and additive, so it doesn't break the brief's contract.

| `code` | HTTP | When |
|---|---|---|
| `validation_error` | 400 | Zod schema validation failed on body/params/query. `details: [{ path, message }]` |
| `missing_authorization` | 401 | See §1 |
| `invalid_api_key` | 401 | See §1 |
| `insufficient_scope` | 403 | See §1 |
| `not_found` | 404 | Resource (or cross-pod resource) doesn't exist |
| `idempotency_key_reused` | 409 | See §4 |
| `address_taken` | 409 | Inbox `address` or `(pod_id, username, domain)` already exists |
| `payload_too_large` | 413 | Reserved for P1-10 attachments (25MB limit, agentmail.md §13) — not triggered by any Phase-1-core route |
| `rate_limited` | 429 | Reserved, not implemented in Phase 1 |
| `internal_error` | 500 | Unhandled |

### Gap: current error handler is too coarse

`apps/api/src/app.ts`'s `setErrorHandler` currently maps *every* sub-500 status to the single code `bad_request`, and there's no `bad_request` in the catalog above — it's superseded entirely. P1-4b must replace this with: (a) a small `ApiError` class (`code`, `statusCode`, `message`, optional `details`) that route handlers/plugins throw explicitly, and (b) a Zod validation error mapper (from `fastify-type-provider-zod`'s error shape) that produces `validation_error` with populated `details`. The global handler then does a direct `error.code`/`error.statusCode` passthrough for `ApiError` instances, falls back to the Zod mapper, and only defaults to `internal_error` for anything unrecognized. The current 404 `not_found` default handler (unmatched routes) is fine as-is and needs no change.

---

## 3. Pagination cursor format

Opaque, base64url-encoded JSON, not a raw offset:

```
page_token = base64url( JSON.stringify({ v: 1, sort_key: "<ISO-8601 timestamp>", id: "<row id>" }) )
```

- Sort order is always **descending** by the relevant timestamp — matches the existing indexes exactly: `threads_inbox_last_message_idx (inbox_id, last_message_at DESC)` and `messages_inbox_received_idx (inbox_id, received_at DESC)`. No ascending mode in Phase 1.
- `id` is the tie-breaker for rows sharing a timestamp (timestamps are not unique). It doesn't need to be sortable itself (Phase 0's `randomUUID()`-based IDs aren't monotonic) — it only needs to deterministically break ties within a single `sort_key` value, which any total order (e.g. plain string comparison) satisfies.
- Query shape: `WHERE inbox_id = $1 AND (sort_key, id) < ($cursor_sort_key, $cursor_id) ORDER BY sort_key DESC, id DESC LIMIT $limit + 1` — fetch one extra row to determine `next_page_token` without a second count query.
- `limit`: query param, default `50`, max `100`, `400 validation_error` above max rather than silently clamping.
- Response envelope: `{ "data": [...], "next_page_token": "string | null" }`.
- A malformed/tampered `page_token` → `400 validation_error` (`details: [{ path: "page_token", message: "invalid or expired page token" }]`), not a 500.

---

## 4. Idempotency-Key semantics

Header `Idempotency-Key` is honored on **every** mutating (`POST`) route in Phase 1, per agentmail.md §7's blanket convention — not just inbox creation (which additionally has its own `client_id` body field; the two mechanisms can coexist, see note below).

**Algorithm, per request carrying the header:**
1. `request_hash = sha256(method + ":" + path + ":" + canonicalJSON(body))`.
2. `SELECT * FROM idempotency_keys WHERE pod_id = $1 AND key = $2`.
3. **Found, `request_hash` matches** → replay: respond with the stored `response_status`/`response_body` immediately, skip the handler entirely. Add response header `Idempotency-Replay: true`.
4. **Found, `request_hash` differs** → `409 idempotency_key_reused` — the message says the key was already used with a different request body, don't guess what they meant.
5. **Not found** → run the handler; on a successful (2xx) response, insert the row (`pod_id, key, endpoint, request_hash, response_status, response_body`) before returning to the client.
6. On a non-2xx response from the handler (e.g. the handler itself 404s or 409s for an unrelated reason), **do not** store an idempotency record — only successful outcomes are memoized, so a client can safely retry a failed attempt with the same key. This is a deliberate reading of "idempotent," not stated explicitly in the brief; flagging it here so it isn't silently decided differently in code.

**`client_id` vs. `Idempotency-Key` on inbox creation:** these are two independent idempotency mechanisms per agentmail.md §2.1/§7 and both may be present. If both are given and point at different outcomes (e.g. same `Idempotency-Key` replay would return a different inbox than the one matching `client_id`), that's a client bug — Phase 1 doesn't need to detect or resolve the conflict, just don't let one mechanism silently override the other's stored response. In practice: check `Idempotency-Key` first (per the algorithm above); only if there's no key (or it's a fresh key) does the handler run and hit the `client_id` uniqueness path.

### Gap: the as-built `idempotency_keys` schema has no in-flight state

`packages/db/src/schema.ts`'s `idempotency_keys` table has `response_status`/`response_body` as `NOT NULL` — it can only represent *completed* requests, not "a request with this key is currently in flight." Two concurrent identical requests with the same fresh key will both miss the lookup (step 5 above) and both execute the handler — for a `send` endpoint, that means two emails. This is a real gap in the schema as it exists right now, not something this contract can silently paper over.

**Decision for Phase 1: accept this as a known limitation, don't fix it now.** None of agentmail.md §12's acceptance criteria exercise concurrent identical requests with the same idempotency key, and adding a `status: pending|completed` column plus a claim-then-execute pattern (`INSERT ... ON CONFLICT DO NOTHING` as a lock, checking rows-affected) is a real schema change that should go through the same review discipline as P0-3a (see AGENTS.md §5 — one schema-change owner at a time). Log it as a Phase 5 hardening follow-up rather than scope-creeping it into P1-4b. **Codex implementing P1-4b should add a one-line code comment at the lookup site pointing at this doc section, not silently "fix" the race with an ad hoc lock.**

---

## 5. OpenAPI tags / naming (SDK-ready)

Add `@fastify/swagger` + `@fastify/swagger-ui` + `fastify-type-provider-zod` in P1-4b (none of these are installed yet — see §7 gaps). Register the app with `.withTypeProvider<ZodTypeProvider>()`.

- **Tags:** `Health`, `Inboxes`, `Threads`, `Messages`, `Search` (search route itself is Phase 1 per §7's table but full-text ranking work is fine to stub/defer — the *tag* is reserved now so Phase 4's SDK generation doesn't need a naming pass later).
- **`operationId` convention** — `camelCase` verb+noun, chosen now because these become the generated SDK's method names in Phase 4 and renaming later is a breaking SDK change:

| operationId | Method | Path |
|---|---|---|
| `createInbox` | POST | `/v1/inboxes` |
| `listInboxes` | GET | `/v1/inboxes` |
| `getInbox` | GET | `/v1/inboxes/:inbox_id` |
| `updateInbox` | PATCH | `/v1/inboxes/:inbox_id` |
| `deleteInbox` | DELETE | `/v1/inboxes/:inbox_id` |
| `listThreads` | GET | `/v1/inboxes/:inbox_id/threads` |
| `getThread` | GET | `/v1/inboxes/:inbox_id/threads/:thread_id` |
| `listMessages` | GET | `/v1/inboxes/:inbox_id/messages` |
| `getMessage` | GET | `/v1/inboxes/:inbox_id/messages/:message_id` |
| `getMessageRaw` | GET | `/v1/inboxes/:inbox_id/messages/:message_id/raw` |
| `sendMessage` | POST | `/v1/inboxes/:inbox_id/messages/send` |
| `replyToMessage` | POST | `/v1/inboxes/:inbox_id/messages/:message_id/reply` |
| `forwardMessage` | POST | `/v1/inboxes/:inbox_id/messages/:message_id/forward` |
| `updateMessageLabels` | PATCH | `/v1/inboxes/:inbox_id/messages/:message_id` |

- **Schema component names:** `Inbox`, `Thread`, `Message`, `MessageSummary` (slim shape for list responses — no `html`/full `text`, just `preview`), `Pagination`, `ErrorResponse`.
- **Security scheme:** `bearerAuth` (`type: http`, `scheme: bearer`), description noting the `lm_live_…` / `lm_admin_…` prefix convention from agentmail.md §2.7.
- `/docs` serves the interactive Swagger UI; raw spec at `/docs/json` (standard `@fastify/swagger` layout) — replaces the Phase 0 static stub entirely (see §7).

---

## 6. Route sketch — Phase 1 inbox/thread/message/send

Base `/v1`, all routes behind the auth plugin from §1. Field-level contract, not full Zod source.

### `POST /v1/inboxes` — scope `inboxes:write`
Request: `{ username?: string, display_name?: string, metadata?: object, client_id?: string }` — `username` omitted → auto-generate (`agent-<6 char>` per agentmail.md §2.1). `domain` defaults to `env.MAIL_DOMAIN`, not client-settable in Phase 1 (custom domains are Phase 5).
Response `201`: `Inbox = { id, address, username, domain, display_name, metadata, client_id, created_at }`.
Errors: `409 address_taken` if `(pod_id, username, domain)` or `address` collides and no matching `client_id` replay applies.

### `GET /v1/inboxes` — scope `inboxes:read`
Query: `limit?, page_token?`. Response: `{ data: Inbox[], next_page_token }`.

### `GET /v1/inboxes/:inbox_id` — scope `inboxes:read`
Response: `Inbox`. `404 not_found` if missing or cross-pod.

### `PATCH /v1/inboxes/:inbox_id` — scope `inboxes:write`
Request: `{ display_name?, metadata? }` — `username`/`address`/`domain` immutable in Phase 1 (no rename flow specified in the brief; don't invent one).
Response: `Inbox`.

### `DELETE /v1/inboxes/:inbox_id` — scope `inboxes:write`
Response `204`. Cascades per schema FKs (`ON DELETE CASCADE` to threads/messages/etc. — already set in `packages/db/src/schema.ts`).

### `GET /v1/inboxes/:inbox_id/threads` — scope `threads:read`
Query: `labels?: string[] (repeat or comma-separated — pick comma-separated, matches querystring parsing simplicity), before?, after?, limit?, page_token?`. Response: `{ data: ThreadSummary[], next_page_token }` where `ThreadSummary = { id, subject_normalized, last_message_at, message_count, labels, preview }` (matches the `threads` row directly — no separate summary type needed here, unlike messages).

### `GET /v1/inboxes/:inbox_id/threads/:thread_id` — scope `threads:read`
Response: `{ thread: Thread, messages: MessageSummary[] }` (full thread + its messages in one call, per agentmail.md §7's "Thread with messages").

### `GET /v1/inboxes/:inbox_id/messages` — scope `messages:read`
Query: `labels?, before?, after?, sender?, unread?: boolean, limit?, page_token?`. Response: `{ data: MessageSummary[], next_page_token }`.

### `GET /v1/inboxes/:inbox_id/messages/:message_id` — scope `messages:read`
Response: full `Message` (includes `text`, `html`, `extracted_text`).

### `GET /v1/inboxes/:inbox_id/messages/:message_id/raw` — scope `messages:read`
Response: `Content-Type: message/rfc822`, raw bytes streamed from MinIO via `raw_object_key` — not JSON. Document this as the one Phase-1 route that doesn't return the standard envelope.

### `POST /v1/inboxes/:inbox_id/messages/send` — scope `messages:send`
Request: `{ to: string[], cc?, bcc?, subject: string, text?, html?, labels?: string[] }` — at least one of `text`/`html` required.
Response `201`: `Message` (direction `outbound`).
Idempotency-Key honored per §4.

### `POST /v1/inboxes/:inbox_id/messages/:message_id/reply` — scope `messages:send`
Request: `{ text?, html?, reply_all?: boolean }`. Sets `In-Reply-To`/`References` from the target message per agentmail.md §2.2 — this is P1-7's threading engine output, this route just calls it.
Response `201`: `Message`.

### `POST /v1/inboxes/:inbox_id/messages/:message_id/forward` — scope `messages:send`
Request: `{ to: string[], cc?, bcc?, text?, html? }` (prepends original as quoted content — implementation detail for P1-8, not this contract).
Response `201`: `Message`.

### `PATCH /v1/inboxes/:inbox_id/messages/:message_id` — scope `messages:write`
Request: `{ add_labels?: string[], remove_labels?: string[] }`. System labels (`inbox, sent, draft, unread, spam, trash`) are mutable through this same route in Phase 1 — no separate "system vs custom label" endpoint split, matching agentmail.md §2.5's single label model.
Response: updated `Message`.

---

## 7. Gaps between the Phase 0 stub and P1-4b's Definition of Done

Concrete, so Codex isn't guessing what "implement the contract" means on top of what already exists:

1. **`/docs` is a static JSON stub** (`apps/api/src/app.ts`), not generated OpenAPI. Replace entirely with `@fastify/swagger` + `@fastify/swagger-ui` + `fastify-type-provider-zod`, per §5. Nothing currently depends on the stub's shape, so this is a clean replacement, not a migration.
2. **No Zod type-provider wired into Fastify yet.** `createApp` uses plain `Fastify()`. P1-4b adds `.withTypeProvider<ZodTypeProvider>()` and the corresponding `setValidatorCompiler`/`setSerializerCompiler` calls before any route in §6 can use Zod schemas.
3. **Error handler is too coarse** — see the gap note at the end of §2. Needs the `ApiError` class + Zod-error mapper, not a bigger switch statement bolted onto the existing statusCode-sniffing logic.
4. **No auth plugin exists.** §1's verification algorithm is the full spec for it — build against the *actual* seeded format (scrypt, prefix-12) documented there, not agentmail.md's "argon2" mention.
5. **No query/repository layer in `packages/db` beyond the raw `createDatabase()` export.** P1-4b will write inbox/thread/message queries directly for Phase 1. Recommendation (not a hard requirement of this contract): put them in `packages/db/src/repos/*.ts` as plain exported functions taking a `Database` — not because of an abstract layering preference, but because P1-6 (inbound SMTP) needs the *same* thread-lookup/message-insert logic from a different app, and duplicating it there instead of sharing it is exactly the kind of thing that drifts.
6. **`idempotency_keys` has no in-flight state** — accepted limitation, see §4's gap note. Don't let P1-4b quietly "fix" this with an ad hoc lock; it needs its own reviewed schema change if it's ever addressed.
7. **ID generation (`randomUUID` in `seed.ts`) is not sortable.** That's fine for the cursor tie-breaker (§3 doesn't need sortable IDs, just a total order for ties) — noted only so nobody "fixes" it into a ULID mid-task under the assumption pagination needs it.
8. **`Inbox` auto-generated username format** (`agent-<6 char>`, agentmail.md §2.1) isn't implemented anywhere yet (seed hardcodes `support-bot`). P1-4b owns picking the actual generator (short random alphanumeric, collision-checked against the unique `(pod_id, username, domain)` index with a retry loop) — contract only fixes the *shape* (`username?` optional in the request), not the generator internals.

---

## Appendix — ID prefix map (extends agentmail.md §7's partial list)

| Prefix | Entity |
|---|---|
| `pod_` | pods |
| `key_` | api_keys |
| `inb_` | inboxes |
| `thr_` | threads |
| `msg_` | messages |
| `att_` | attachments |
| `draft_` | drafts |
| `wh_` | webhooks |
| `whd_` | webhook_deliveries |
| `evt_` | events |
| `rule_` | sender_rules |
| `jevd_` | jev_decisions |
| `dom_` | domains |
| `idem_` | idempotency_keys |

`seed.ts`'s `id(prefix)` helper (`${prefix}_${randomUUID().replaceAll('-', '')}`) already matches this scheme for `key_`/`pod_` — P1-4b should reuse that exact helper (move it to a shared location, e.g. `packages/db/src/id.ts`, rather than duplicating it) for every new prefix above.
