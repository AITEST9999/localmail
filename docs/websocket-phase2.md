# P2-13a — WebSocket Protocol + Pub/Sub Fan-Out Design

> Design-only deliverable for TASKS.md **P2-13a**. Owner: Claude. Does not implement app code — this is what **P2-13b implements** (implementation owner for this run: Cursor `cursor-lm`, same as P2-11b/P2-12).
> Grounded in the as-built P2-11b code, not just the brief: `packages/events/src/publisher.ts` (`createDurableEventPublisher`), `packages/events/src/redis.ts` (`createRedisConnection`), and `apps/api/src/app.ts`'s actual wiring (confirmed by reading it directly — `createDurableEventPublisher(ownedDatabase.db, redis)` already receives a **live, non-subscribe-mode `Redis` instance**, not bare connection options, which changes what P2-13b needs to build versus reuse). Every addition beyond agentmail.md §7's three message shapes is justified, not just asserted.

## APPROVED

- [x] Message shapes — confirmed subscribe/subscribed/event from agentmail.md §7; added `error` (required by this task's own core DoD item); relies on WS-protocol ping/pong instead of a fourth JSON message type; no `unsubscribe` type (justified)
- [x] Invalid `inbox_id` behavior — the core DoD item, fully specified
- [x] WS-upgrade auth — Bearer header at the HTTP-upgrade stage, reusing the existing auth plugin verbatim; new `ws:connect` scope
- [x] Redis channel naming + publisher-side wiring — reuses P2-11b's existing `emit()` and its existing Redis connection, zero new connections on the publish side
- [x] Filter semantics — inbox_ids/event_types omitted-vs-empty-vs-explicit, applied per-connection
- [x] Fan-out sequence from SMTP ingest → Redis → WS client, meeting the 1s acceptance bound
- [x] Gaps vs. current codebase for P2-13b
- [x] Ready for Cursor (`cursor-lm`)

---

## 1. Message shapes

**Confirmed as-is from agentmail.md §7** (no change to these three):
```json
→ { "type": "subscribe", "inbox_ids": ["inb_…"], "event_types": ["message.received"] }
← { "type": "subscribed" }
← { "type": "event", "event": { "...": "same envelope as the webhook payload" } }
```
The `event` field's shape is **exactly** `docs/events-webhooks-phase2.md`'s webhook envelope (§1/§3 of that doc: `{ id, type, created_at, pod_id, data }`, thin `data`) — one envelope, two delivery mechanisms. Do not construct a second, WS-specific event shape.

**One additive change to `subscribed`, justified:** echo the *resolved* filter back, not just the bare `{"type":"subscribed"}`:
```json
← { "type": "subscribed", "inbox_ids": null, "event_types": null }
```
(`null` = "all," per §5's filter semantics.) Rationale: without this, a client that omits `inbox_ids` has no way to confirm from the wire protocol whether that meant "all inboxes" or "the server silently defaulted to nothing" — cheap to add, backward compatible (same `type`, additive fields), and consistent with `docs/api-contract-phase1.md`'s general posture of not leaving a client to infer server-side defaults.

**New message type: `error`** (this task's core DoD item forces this — see §2):
```json
← { "type": "error", "code": "invalid_inbox_id", "message": "..." }
```
Codes: `invalid_inbox_id` (§2), `invalid_event_type` (an `event_types` entry outside the known Phase 2 type list — reject explicitly, don't silently ignore a typo), `invalid_message` (the inbound WS frame isn't valid JSON, or has no recognized `type` field). All three are **recoverable** — see §2 for why the connection stays open rather than closing.

**No `unsubscribe` message type.** A second `subscribe` message **replaces** the connection's active filter entirely (not additive/merged) — this covers "change what I'm watching" with the one message type the brief already defined, instead of adding a fourth. A client that wants to stop receiving everything can send `subscribe` with `event_types: []` (§5: explicit empty array = none) or simply close the connection. Deferred because no agentmail.md §12 acceptance criterion needs anything more granular.

**Ping/pong: rely on the WebSocket protocol's own ping/pong frames, not a JSON message type.** `@fastify/websocket`'s underlying `ws` library sends these at the frame level, invisible to the three JSON message types above. Server sends a ping every **30s**; if no pong is received within **10s** of that ping, the server closes the connection with app-specific close code **4000** (documented below — RFC 6455 reserves 4000–4999 for application use). This guards against a connection silently dying behind a NAT/proxy without needing a client-visible `{"type":"ping"}` JSON message that every client would have to special-case.

**Close codes** (server-initiated only — a client can close for any reason it wants):
| Code | Meaning |
|---|---|
| `1000` | Normal closure (client requested it, or graceful) |
| `1001` | Server shutting down |
| `4000` | Ping/pong keepalive timeout (§1) |

Auth/scope failures never reach a close code — they're rejected at the HTTP-upgrade stage (§3), before a WebSocket connection exists at all.

---

## 2. Invalid `inbox_id` in a `subscribe` message — the core DoD item

**Behavior:** reject the **entire** subscribe request (not a partial accept of the valid IDs), respond `{ "type": "error", "code": "invalid_inbox_id", "message": "..." }`, and **keep the connection open** — the client can send a corrected `subscribe` message on the same connection. Do not close the socket.

**Why reject the whole request instead of partial-accepting the valid ones:** silently dropping an unrecognized ID and accepting the rest hides a client bug (a typo'd `inbox_id`) behind a successful-looking `subscribed` response. This matches the general posture already established in `docs/api-contract-phase1.md` (validation errors surface `details`, they don't get silently coerced into "best effort").

**Why keep the connection open instead of closing it:** an invalid subscribe is a recoverable client-side mistake, exactly like a `400 validation_error` on a REST route — REST doesn't revoke the API key or terminate the session over a bad request body, and a WS connection shouldn't either. Closing would also make interactive debugging (a client iterating on filter values) needlessly expensive (full reconnect + re-auth per typo).

**"Invalid" means one of two things, and both get the identical error — no existence leak:**
1. The `inbox_id` doesn't exist at all.
2. The `inbox_id` exists but belongs to a **different pod** than the one the connection authenticated as.

These must be indistinguishable to the client, for the same reason `docs/api-contract-phase1.md` §1 already established for REST 404s: confirming "it exists, just not yours" leaks cross-pod information. Check membership with the same `podId`-scoped query pattern already used everywhere else in the API (`store.findInboxById(request.podId, inboxId)` — reuse it, don't write a second existence check).

**`event_types` gets the same treatment, one validation list:** an entry not in the **full** documented type list from `docs/events-webhooks-phase2.md` §1 (`message.received`, `message.sent`, `message.delivered`, `message.bounced`, `message.labeled`, `thread.created`, `domain.verified`) is `invalid_event_type`, rejecting the whole subscribe the same way. Note this list is **not** "only the types Phase 2 actually emits" — subscribing to `message.labeled` (Phase 3) or `domain.verified` (Phase 5) today is valid and simply never fires yet, exactly like a webhook already can subscribe to an event type with zero current producers (`docs/events-webhooks-phase2.md` §2 doesn't type-constrain `webhooks.event_types` at the DB level either — same posture, carried through here). Only a genuinely unrecognized string (typo, made-up type) is rejected. **`webhook.test` is excluded from this list** — it's a diagnostic type for the webhook test-fire path (P2-12), not something a live WS subscriber should ever request or receive (§5).

---

## 3. Auth on WS upgrade

**Mechanism: `Authorization: Bearer <key>` header on the WS upgrade HTTP request** — identical scheme to every REST route, verified by the identical code path.

- `apps/api/src/auth.ts`'s `authPlugin` already gates every request where `request.url.startsWith('/v1/')` via an `onRequest` hook (checked directly — this is exact, existing code, not a plan). Since the route is `/v1/ws` per agentmail.md §7, **this hook already covers it with zero changes** — `@fastify/websocket` runs Fastify's normal `onRequest`/`preHandler` hooks before completing the WS handshake, and a hook that throws (as `authPlugin` does on a bad key) makes Fastify send a normal HTTP error response and **never upgrades the connection** — no socket is ever opened for an unauthenticated client.
- Add a `preHandler: requireScope('ws:connect')` on the route, same pattern as every other scoped route (`docs/api-contract-phase1.md` §1's table gets one new row: `ws:connect` → `GET /v1/ws`). The seeded admin key (`scopes: ['*']`) already satisfies it with no seed changes.
- Failure responses are **the same two codes REST already uses** — `missing_authorization` / `invalid_api_key` (401) for a bad key, `insufficient_scope` (403) for a valid key missing the scope — returned as ordinary HTTP responses at the upgrade attempt, not as a WS-level `error` message (there is no WebSocket connection yet at that point for a JSON message to travel over).

**Deliberately deferred: no query-string API-key fallback** (e.g. `?api_key=...`), even though browsers' native `WebSocket` API can't set custom headers and some WS deployments use a query param for exactly that reason. agentmail.md's stated primary users are agents/SDKs/CLIs (Node-capable clients that *can* set upgrade headers, unlike browser JS), and the Phase 5 dashboard is explicitly "for debugging/admin only" (agentmail.md §1), not a reason to put API keys in URLs (which land in access logs and proxy logs) today. If a browser-based client is ever needed, the right fix is a short-lived one-time WS ticket issued over authenticated REST — not a bare API key in a query string — and that's a Phase 5 design question, not this one.

---

## 4. Redis pub/sub: channel naming and publisher-side wiring

**Channel name:** `localmail:ws:<pod_id>` — one channel per pod (PLAN.md §5's decision, carried through unchanged; per-inbox channels were explicitly deferred there as unneeded for local MVP volume, and nothing in Phase 2 changes that call).

**Who publishes — and the key finding that simplifies this task:** reading `apps/api/src/app.ts` directly (not assuming from the brief) shows `createDurableEventPublisher(ownedDatabase.db, redis)` is already called with a **live `Redis` client instance** (`createRedisConnection(env.REDIS_URL)`), not bare `ConnectionOptions` — that same client is reused as BullMQ's queue connection today. A non-subscribe-mode ioredis connection can freely issue `PUBLISH` alongside other commands. **This means P2-13b needs zero new Redis connections on the publish side** — extend `packages/events/src/publisher.ts`'s `emit()` to call `queueConnection.publish(channel, JSON.stringify(envelope))` using the exact same parameter it already receives, right after the DB transaction in `emit()` commits (in parallel with, not blocking on, the BullMQ enqueue loop that follows it — publishing to Redis and enqueueing webhook-delivery jobs are independent fan-outs of the same committed event, neither should wait on the other).

Because `apps/api` and `apps/smtp` **already** construct their `createDurableEventPublisher` instance and wire it into both the inbound ingestor (`message.received`) and the outbound service (`message.sent`) — confirmed directly in `app.ts` — extending the one shared `emit()` function means **both** event types start reaching WS subscribers with no changes at either call site. This is the same "one shared pipeline, not two" property `docs/events-webhooks-phase2.md` §7 already established for webhook test-fire.

**`payload`/envelope reused as-is:** publish the identical `{ id, type, created_at, pod_id, data }` envelope already being built for the webhook HMAC signature (§3 of the events/webhooks doc) — construct it once inside `emit()`, use it for both the webhook body and the WS publish, don't rebuild it twice.

**`webhook.test` events are never published to Redis.** The test-fire path (P2-12) reuses `emit()`'s webhook fan-out machinery but is not a "real" event a live agent inbox client should see pushed to it — guard the publish call on `event.type !== 'webhook.test'`, or (simpler, decide this) route test-fire through a narrower internal function that skips the publish step entirely rather than adding a type-check inside the general `emit()` path. Either is acceptable; the behavioral requirement is that test-fire never reaches a WS client.

**Who subscribes:** `apps/api` only (the WS server lives there; `apps/smtp` and `apps/workers` never need to subscribe to anything). This **does** need one new, dedicated ioredis connection — a connection in Redis subscribe mode can't issue any other command, so it must be separate from the existing publish/BullMQ connection. Construct it once at `app.ts` bootstrap (same `createRedisConnection(env.REDIS_URL)` helper, second call), close it in the same `onClose` hook pattern already used for the existing Redis client.

**Subscribe/unsubscribe is reference-counted per pod**, not "subscribe to every pod forever": when the first WS connection for a given `pod_id` is accepted, call `.subscribe('localmail:ws:<pod_id>')` on the shared subscriber connection; when the last connection for that pod closes, `.unsubscribe(...)`. A small in-process module (e.g. `apps/api/src/ws-hub.ts`) owns this bookkeeping (`Map<podId, Set<connectionState>>`) plus the actual per-connection filter matching (§5) — this is new code, not something to bolt onto `auth.ts` or `messages.ts`.

---

## 5. Filter semantics

Mirrors `docs/events-webhooks-phase2.md` §2's `webhooks.inbox_ids` semantics exactly, so the two subscription models (webhooks, WS) behave identically for the same input shape:

| Field value on `subscribe` | Meaning |
|---|---|
| Omitted / `null` | **All** (all inboxes in the pod, or all known event types) |
| Explicit array with entries | Exactly those (validated per §2) |
| Explicit empty array `[]` | **None** — matches nothing. Deliberate: an empty allow-list is a degenerate provided array, not a synonym for "all." This is also the documented way to "unsubscribe from everything without closing the connection" (§1). |

Filtering happens **in the API process**, per connection, after a message arrives from the coarse per-pod Redis channel — Redis pub/sub here is pod-granularity only; inbox/event-type narrowing is application-level, not a Redis subscription pattern. For each inbound pub/sub message: look up the set of locally-connected sockets for that `pod_id`; for each socket, check its currently-active filter (from its most recent `subscribe`, per §1) against the event's `inbox_id` and `type`; send `{"type":"event","event":...}` only to sockets that pass.

---

## 6. Fan-out sequence: SMTP ingest → Redis → WS client (meeting the 1s bound, agentmail.md §12)

No new hook points — this rides entirely on P2-11b's already-shipped wiring plus §4's one addition to `emit()`:

1. `swaks` → `apps/smtp` → existing `onData`/`onRcptTo` handling (P1-6, unchanged) → `ingestor.ingest(raw, inbox)` (`packages/core/src/inbound.ts`, unchanged).
2. `ingest()` persists the message, then calls `eventPublisher.emit({ type: 'message.received', ... })` — `eventPublisher` here is already the real `createDurableEventPublisher` instance wired at `apps/smtp` bootstrap (P2-11b), not a stub.
3. Inside `emit()` (`packages/events/src/publisher.ts`, existing + §4's addition): one DB transaction inserts the `events` row and the matching `webhook_deliveries` rows, commits; **then**, in parallel:
   - `queueConnection.publish('localmail:ws:<pod_id>', envelopeJson)` (§4, new) — sub-millisecond against a local Redis.
   - The existing per-delivery BullMQ `queue.add(...)` loop (P2-11b, unrelated to this path, runs independently).
4. `apps/api`'s dedicated subscriber connection (§4) receives the pub/sub message, looks up locally-connected sockets for that pod (§4/§5), applies each one's filter (§5), and sends `{"type":"event","event":envelope}` down every matching socket.
5. **Budget check against the 1s acceptance bound (agentmail.md §12):** step 3's DB transaction is the same shape already measured at <100ms for inbox creation (P1-5's live smoke); PUBLISH and the in-process filter-and-send loop are sub-millisecond for a local, single-node deployment. Total added latency beyond "message is already persisted" is negligible — the bound is met with wide margin, dominated entirely by the DB transaction that already has to happen regardless of WS.

---

## 7. Gaps between the current codebase and P2-13b's DoD

1. **No `@fastify/websocket` dependency anywhere** — not in `apps/api/package.json`, not registered in `app.ts`. P2-13b adds and registers it.
2. **No WS route, no connection-tracking hub exists.** `apps/api/src/ws-hub.ts` (or equivalent — naming is P2-13b's call, the responsibilities in §4/§5 are not) is new code.
3. **`packages/events/src/publisher.ts`'s `emit()` has no Redis-publish call today** — confirmed by reading it directly; it does the DB transaction and the BullMQ enqueue loop only. §4's addition is a real code change to existing, already-shipped P2-11b code, not new-territory-only.
4. **No second Redis connection for subscribe-mode exists** — the one live `Redis` client in `apps/api/src/app.ts` today is used for BullMQ + (after §4) publish; a subscribe-mode connection is additive, not a repurposing of that one (ioredis constraint: a subscribed connection can't run other commands).
5. **No `ws:connect` scope exists** in `apps/api/src/auth.ts`'s scope checks or `docs/api-contract-phase1.md`'s table — this doc adds the row (§3); P2-13b is what actually gates the route with it.
6. **`docker-compose.yml`'s `SMTP_MAX_HOPS`/hop-count precedent aside, there's no existing precedent in this repo for a second ioredis connection with a distinct lifecycle** (subscribe-mode) — P2-13b's `onClose` hook for it should follow the exact same pattern already used for the existing Redis client and the BullMQ queue (`app.addHook('onClose', ...)`, checked directly in `app.ts`), not invent a different shutdown convention.

---

Ready for Cursor (`cursor-lm`).
