# Phase 4 — Agent Tooling Plan (SDK · CLI · MCP · Examples)

> Planning deliverable for Phase 4 (agentmail.md §10 tasks 18–21, §2.11). **Plan only, no code changes.**
> Owner: **Claude Code** plans this phase and implements all of it (Surendra's constraint, 2026-09-23). **Do not use Cursor (`cursor-lm`)** for any Phase 4 task. This replaces the Phase 0–3 "Codex implements / Claude reviews" split, but only for Phase 4.
> Everything here is based on the repo as it stands on 2026-09-23 and on the **live** OpenAPI document from `GET /docs/json`. I read the live spec by starting `pnpm --filter @localmail/api dev` myself, because at the time of planning nothing was listening on :8080 or :2525, even though the handoff said they were up. Compose services (postgres/redis/minio/mailpit) were healthy.

---

## 0. Summary

- **The live OpenAPI spec has no paths** (`"paths": {}`). Every route is served, but none of them appear in `/docs/json`, so the SDK can't be generated from the spec until this is fixed. The cause is confirmed (§2.1) and the fix is small.
- **`add_label` has no API route.** `PATCH /v1/inboxes/:inbox_id/messages/:message_id` (`updateMessageLabels`) is in the P1-4a contract but was never built.
- Four small additive API gaps make the helpers much simpler: `MessageSummary` lacks `direction`/`from`/timestamps, `listMessages` has no `direction` filter, `listInboxes` has no `address` filter, and no route declares its error responses.
- None of these fixes need a **schema migration**, so AGENTS.md §5 migration ownership isn't triggered.
- All of this goes into a prerequisite task, **P4-18-api**. After it: P4-18 SDK, then P4-19 CLI / P4-20 MCP / P4-21 examples, which are independent of each other.

---

## 1. Constraints this plan respects

| Constraint | Source | How it shows up |
|---|---|---|
| MCP, CLI, dashboard: **SDK only, no DB/queue access** | PLAN.md Decision 2.4 | `packages/sdk` has **zero** internal deps (not even `@localmail/config`; that's a server env loader). `packages/cli` depends on `sdk` only. `apps/mcp` depends on `sdk` only. Examples depend on `sdk` only. If any of them needs a DB side door, that's an API gap and gets fixed in `apps/api` (P4-18-api), not worked around. |
| `TYPESAFE_API_KEY` never leaves workers | AGENTS.md §4 | No Phase 4 package reads it. The auto-reply example uses the labels the workers already applied; it never calls Jev itself. |
| No Cursor; Claude owns all of Phase 4 | Surendra, 2026-09-23 | Owner tag on every Phase 4 row is `Claude`. |
| One migration author per phase | AGENTS.md §5 | Phase 4 needs **no** migration. If one turns out to be needed, stop and get a schema review first. |
| Nothing published or deployed without asking | Router instructions | `@localmail/*` packages stay `"private": true`. No npm publish. Registering the MCP server in Claude Code (`claude mcp add`) changes the user's config, so it's a step that needs the user's OK (§6.3). |
| Email bodies are untrusted input | agentmail.md §13 | The MCP tool descriptions and results mark message content as untrusted data (§5 P4-20). |

---

## 2. OpenAPI gap analysis (live `/docs/json` vs. as-built routes vs. §2.11 needs)

### 2.1 What the live spec contains

```
openapi 3.0.3 · info "LocalMail API" 0.1.0
components.schemas: Inbox, Thread, Message, MessageSummary, Pagination, Webhook, WebhookDelivery, ErrorResponse
components.securitySchemes: bearerAuth
paths: {}          ← empty
```

**Root cause (confirmed with a minimal repro):** `createApp()` in `apps/api/src/app.ts` is synchronous and calls `app.register(swagger, …)` **without awaiting it**, then defines routes directly with `app.get(...)` / `registerInboxRoutes(app, …)`. `@fastify/swagger` collects routes through an `onRoute` hook that is only installed once the plugin has loaded. By then every route already exists, so none are captured. Repro run in `apps/api`:

```
await swagger: false  paths: []
await swagger: true   paths: [ '/x' ]
```

### 2.2 Route inventory vs. what Phase 4 needs

Operation IDs are taken from the route files (`inboxes.ts`, `messages.ts`, `webhooks.ts`, `ws.ts`, `app.ts`). All follow the P1-4a camelCase convention, so they carry over as SDK method names once the spec is fixed.

| operationId | Route | In live spec? | Needed by |
|---|---|---|---|
| `getHealth` | `GET /healthz` | ✗ (G1) | CLI `doctor` / smoke |
| `getCurrentApiKey` | `GET /v1/me` | ✗ (G1) | SDK config check, CLI `whoami` |
| `createInbox` / `listInboxes` / `getInbox` / `updateInbox` / `deleteInbox` | `/v1/inboxes[/:id]` | ✗ (G1) | MCP `create_inbox`, CLI `inbox create\|list` |
| `listThreads` / `getThread` | `/v1/inboxes/:id/threads[/:thread_id]` | ✗ (G1) | MCP `list_threads`/`get_thread`, CLI `threads`, `replyToThread` |
| `listMessages` / `getMessage` / `getMessageRaw` | `/v1/inboxes/:id/messages[...]` | ✗ (G1) | `waitForEmail`, MCP |
| `sendMessage` / `replyToMessage` / `forwardMessage` | `POST …/send`, `…/reply`, `…/forward` | ✗ (G1) | MCP `send_message`/`reply`, CLI `send`/`reply` |
| `getAttachmentDownloadUrl` / `downloadAttachment` | `…/attachments/:attachment_id` | ✗ (G1) | SDK (thin wrapper) |
| `createWebhook` / `listWebhooks` / `getWebhook` / `updateWebhook` / `deleteWebhook` / `listWebhookDeliveries` / `testFireWebhook` | `/v1/webhooks…` | ✗ (G1) | SDK (thin wrapper) |
| `connectWebSocket` | `GET /v1/ws` | ✗ (G1) | Hand-written SDK WS client (G9) |
| **`updateMessageLabels`** | `PATCH /v1/inboxes/:id/messages/:message_id` | **route doesn't exist (G2)** | MCP `add_label` |
| `/v1/search`, drafts, domains, lists, pods, api-keys | — | not built | Phase 5, **out of scope** |

### 2.3 Gaps, with decisions

| # | Gap | Severity | Decision (implemented in P4-18-api unless noted) |
|---|---|---|---|
| **G1** | `paths: {}`: swagger isn't awaited, so no routes are captured | **Blocker** | Keep `createApp()` synchronous: register swagger first, then register **all routes inside one child plugin** (`app.register(async (i) => { …routes… })`). avvio then loads swagger (and installs its hook) before the route plugin runs. This fixes it without making `createApp` async, which would break every `createApp()` caller and test. Add a test: `app.ready()` → `app.swagger().paths` contains every operationId in §2.2 (except `updateMessageLabels` until G2 lands in the same task). |
| **G2** | No `updateMessageLabels` route | **Blocker for MCP `add_label`** | Build it exactly as P1-4a §6 specifies: body `{ add_labels?: string[], remove_labels?: string[] }` (at least one non-empty), scope `messages:write`, pod-scoped 404, returns the full `Message`. In the same transaction, recompute `threads.labels` as the union of its messages' labels, so thread-level `unread` stays correct. **Does not emit `message.labeled`**, which stays reserved for classifier output. Otherwise an agent editing labels could trigger the auto-reply example (P4-21) on its own edit. Label strings: `z.string().min(1).max(64)`, max 20 per call. No migration (the `labels text[]` column already exists). |
| **G12** | **`GET …/messages?after=<iso>` always returns 500** (observed live 2026-09-23, 15 of 15 requests; the same URL without `after` returns 200). Error: `TypeError … "string" argument must be of type string … Received an instance of Date` from `postgres` `bytes.js`. In `apps/api/src/store.ts` `listMessages`, `sortAt` is a raw `sql\`coalesce(received_at, sent_at, created_at)\``, so `gt(sortAt, query.after)` binds a JS `Date` with no column type to encode it. `before` uses the same path and is very likely broken too. `listThreads` compares a real column and isn't affected. | **Blocker for `waitForEmail` catch-up** | Bind as ISO string with an explicit cast (`sql\`${sortAt} > ${query.after.toISOString()}::timestamptz\``, same for `before`). Regression tests: `after`, `before`, and `after`+cursor against **real Postgres** (the fake store can't reproduce a driver-encoding bug; run it in the integration split or as a live smoke). |
| **G3** | `MessageSummary` only has `id, thread_id, subject, preview, labels` | High | Add `direction`, `from`, `to`, `received_at`, `created_at` (additive, and the store already selects them). `replyToThread` needs `direction` to pick the latest *inbound* message. `waitForEmail` and CLI `threads` need `from`/timestamps. Without this, every summary needs an N+1 `getMessage`. |
| **G4** | `listMessages` has no `direction` filter | High | Add `direction=inbound\|outbound` query param. `waitForEmail` has to ignore the agent's own outbound rows (loopback puts an `outbound` row in the sender's inbox). |
| **G5** | `listInboxes` can't look up by address | Medium | Add `address` query param (exact, case-insensitive). The CLI (`tail support-bot@localmail.test`, as in agentmail.md §9) and MCP accept an address or an ID. Without this, the SDK has to page through every inbox. |
| **G6** | Routes only declare 2xx responses. `ErrorResponse` is defined but never referenced | Medium | Add a shared `errorResponses` map (400/401/403/404/409/413 → `ErrorResponse`) to every `/v1` route schema so the generated types include the error envelope. The SDK still maps errors by hand (§3.3); this just makes the spec honest. |
| **G7** | The hand-written `openApiComponentSchemas` in `app.ts` has drifted from the real Zod shapes (e.g. component `Message` has 8 fields, the real response has 21) | Medium | Delete the hand-written components. Register the real Zod schemas as named components with `createJsonSchemaTransformObject` (available in the installed `fastify-type-provider-zod@4.0.2`) and have routes `$ref` them. Named SDK types (`Inbox`, `Message`, …) then come straight from the spec. Fallback if `$ref` wiring gets hairy: derive SDK type aliases from operation response types; don't hand-sync. |
| **G8** | Multipart send (`payload` + `attachments` file parts) and binary responses (`getMessageRaw`, `downloadAttachment`) aren't described in the spec | Low (documented) | **No API change.** The SDK hand-writes those three methods (FormData / `Response` stream) and documents why. |
| **G9** | `GET /v1/ws` shows up as a plain GET, and Node's global `WebSocket` can't send an `Authorization` header (the WS auth scheme from websocket-phase2 §3) | Low (documented) | Generated code ignores `connectWebSocket`. The SDK ships a hand-written `subscribe()` built on the `ws` package (already in the lockfile, 8.21.3), which supports custom upgrade headers. No API change. |
| **G10** | Search, drafts, domains, lists, pods, api-keys routes | Out of scope | Phase 5. The SDK doesn't stub them. |
| **G11** | Admin key only: `POST /v1/api-keys` doesn't exist, so agents can't get a narrower-scoped key | Accepted limitation | Examples, CLI, and MCP run on `ADMIN_API_KEY` (`*`). Written down in each README. Scoped keys come in Phase 5 (task 23). |

**Deferred on purpose (not a gap):** returning full message bodies from `getThread` (an `?expand=messages` param). MCP `get_thread` fetches each message (N+1, max 50, concurrency 5). That's fine locally, and it keeps the API surface unchanged. Add `expand` later if it shows up as a hot spot.

### 2.4 Spec-as-artifact (keeps Decision 2.4 intact)

`packages/sdk` must not import `apps/api`. So:

1. `apps/api` gets a script `openapi:export` (`tsx src/export-openapi.ts`). It builds the app with the existing in-memory test options (fake store/outbound/publisher, `wsSubscriber: null`, a dummy encryption key), so **no Postgres, Redis, or MinIO** is needed. It calls `app.ready()` and writes `app.swagger()` to `packages/sdk/openapi.json` (pretty-printed, sorted keys).
2. `packages/sdk` has `generate`: `openapi-typescript openapi.json -o src/generated/openapi.ts`. Both files are **committed**, so the SDK builds without a running API.
3. **Drift gate:** an `apps/api` unit test regenerates the spec in memory and deep-equals it against `packages/sdk/openapi.json`. If it fails, re-run `openapi:export`. Changing an API route without updating the SDK then shows up in `pnpm test`.

---

## 3. SDK design (P4-18)

### 3.1 Generation approach: `openapi-typescript` + `openapi-fetch`

| Option | Verdict |
|---|---|
| **`openapi-typescript` (types) + `openapi-fetch` (~6 KB runtime)** | **Chosen.** The generated file is types only. The runtime is a thin typed `fetch`. Hand-written helpers sit on top. Regenerating never overwrites hand-written code. |
| orval / openapi-generator full client | Rejected: heavy generated runtime, awkward to extend with WS/multipart helpers, and noisy diffs on regen. |
| Hand-written client, no codegen | Rejected: agentmail.md §10 task 18 says "OpenAPI → SDK", and that's the reason operationIds were fixed in P1-4a. |

Runtime deps: `openapi-fetch`, `ws`. Dev dep: `openapi-typescript`. It runs on Node 20+ (the repo is on 22.23.2) and uses global `fetch`.

### 3.2 Public surface

```ts
const lm = new LocalMail({ baseUrl?, apiKey?, fetch?, timeoutMs? });
// baseUrl  ← opts | LOCALMAIL_API_URL | "http://127.0.0.1:8080"
// apiKey   ← opts | LOCALMAIL_API_KEY | throws LocalMailConfigError (no silent anonymous mode)

lm.me()
lm.inboxes.create({ username?, display_name?, metadata?, client_id? }, { idempotencyKey? })
lm.inboxes.list({ limit?, pageToken?, address? })   // + lm.inboxes.iterate() async iterator over pages
lm.inboxes.get(id) / update(id, patch) / delete(id)
lm.inboxes.resolve(idOrAddress)                     // "inb_…" → get; contains "@" → list({address}) → 404 if none
lm.threads.list(inboxId, { labels?, before?, after?, limit?, pageToken? }) / iterate(...)
lm.threads.get(inboxId, threadId)
lm.messages.list(inboxId, { labels?, before?, after?, sender?, unread?, direction?, limit?, pageToken? }) / iterate(...)
lm.messages.get / getRaw (→ Response) / send / reply / forward / updateLabels(inboxId, messageId, { add?, remove? })
lm.messages.send(inboxId, { …, attachments?: Array<{ filename, content: Blob|Uint8Array, contentType? }> })  // multipart when attachments present
lm.attachments.getUrl(...) / download(...)
lm.webhooks.create/list/get/update/delete/deliveries/test(...)
lm.subscribe({ inboxIds?, eventTypes?, signal? }) → AsyncIterable<LocalMailEvent>  // WS, auto-reconnect w/ backoff
// helpers
lm.waitForEmail(inboxId, opts) → Promise<Message>
lm.replyToThread(inboxId, threadId, { text?, html?, replyAll? }, { idempotencyKey? }) → Promise<Message>
// standalone
verifyWebhookSignature({ secret, header, body, toleranceSec = 300, now? }) → boolean
```

- `Date` arguments are serialized with `toISOString()`. The API's `after`/`before` are `z.string().datetime()` and reject other formats.
- `labels` arrays are serialized comma-separated, matching the as-built `parseLabels`.
- Exported types (`Inbox`, `Thread`, `Message`, `MessageSummary`, `LocalMailEvent`, …) come from the generated components (G7).

### 3.3 Errors and retries

- Non-2xx → `LocalMailError { status, code, message, details?, requestId? }`, parsed from the `{ error: { code, message, details } }` envelope. A body that isn't JSON → `code: 'http_error'`.
- **Idempotency:** every mutating call accepts `idempotencyKey`. The SDK does **not** auto-generate one per call: a fresh key on each attempt gives no protection, and a key that's reused silently is surprising. Instead, the SDK retries **only** requests that carry a caller-supplied `idempotencyKey`, plus GETs: up to 2 retries with jittered backoff on network errors, 502, 503, and 504. A POST without a key is never retried. That's the double-send hazard from PLAN.md R3.
- No retry on 409 `idempotency_key_reused`. That error is a caller bug and gets surfaced as-is.

### 3.4 `waitForEmail`: algorithm (race-free)

```ts
waitForEmail(inboxId, {
  from?: string | RegExp, subject?: string | RegExp, labels?: string[],   // all AND-ed
  match?: (m: Message) => boolean,
  since?: Date,            // default: call time. Signup flows should capture `since` BEFORE triggering the email.
  timeoutMs = 60_000, pollIntervalMs = 5_000, signal?,
}) → Promise<Message>      // rejects LocalMailTimeoutError (carries `since`, `inboxId`) on timeout
```

1. **Subscribe first.** Open `subscribe({ inboxIds:[inboxId], eventTypes:['message.received','message.labeled'] })` and wait for the `subscribed` ack, with a 3s cap. If the WS fails, go to polling-only mode; the result is the same, just slower.
2. **Then catch up.** Page through `messages.list(inboxId, { after: since, direction: 'inbound' })`. Anything that arrived between `since` and the subscription gets checked here. Doing it in this order (subscribe, then list) closes the gap where a message lands between "list" and "subscribe".
3. **Candidate check** (by ID, each ID checked once; a `seen` set drops duplicate events): the cheap filters run on summary fields first (`from`, `subject`, `labels`, thanks to G3). If they pass, fetch the full message with `messages.get` and run `match`. The first message that passes wins.
4. **`labels` filter:** when `labels` is set (e.g. `['otp']`), a message that fails only on labels is **re-checked when its `message.labeled` event arrives** (the event data includes `labels`, per `packages/events/src/publisher.ts`). This is the "otp label → wait_for_email resolves faster" behaviour from agentmail.md §5, without polling.
5. **Reconcile poll:** re-run the step 2 catch-up every `pollIntervalMs` **even while WS is connected**. It's cheap, and it covers the cases where WS never fires: P3-17-suppressed mail gets no WS `message.received`, and a Redis pub/sub message can be dropped during a reconnect.
6. Always clean up (close WS, clear timers) on resolve, reject, or `signal` abort.

Tests for each branch are listed in §6.1.

### 3.5 `replyToThread`

`threads.get(inboxId, threadId)`. Messages come back in ascending time order (`listThreadMessages` orders by `coalesce(received_at, sent_at, created_at) ASC, id ASC`). Pick the **last message with `direction === 'inbound'`** (G3). If there is none, pick the last message of any direction, so a follow-up to your own sent mail still threads. Then call `messages.reply(inboxId, thatId, …)`. It's a thin helper; threading headers are still built server-side by P1-7/P1-8.

---

## 4. Dependency order

```
P4-18-api  (G1–G7 API/OpenAPI fixes + openapi:export + drift test)       apps/api only, no migration
    │
P4-18      (SDK: generated types + client + waitForEmail/replyToThread + subscribe + verifyWebhookSignature)
    │
    ├── P4-19  CLI       (packages/cli)      ┐
    ├── P4-20  MCP       (apps/mcp)          ├ independent of each other; touch disjoint dirs
    └── P4-21  Examples  (examples/*)        ┘  (P4-21 needs only the SDK, not CLI/MCP)
```

Recommended order for one Claude pane: **18-api → 18 → 20 → 19 → 21.** MCP comes before CLI because it has the most agent-facing value and it's the first real consumer of `waitForEmail` under a tool-call timeout. If two Claude panes are available, 19/20/21 can run in parallel after 18. File ownership doesn't overlap, and none of them edits `apps/api` or the SDK. **If one of them needs an SDK or API change, it goes back through P4-18 / P4-18-api instead of being patched locally.**

---

## 5. Task specs and DoDs

Also added to TASKS.md (Phase 4 section). The DoDs here are the source of truth; TASKS.md summarizes them.

### P4-18-api: API/OpenAPI gap closure (prerequisite)
**Scope:** G1–G7 from §2.3, in `apps/api` only. `openapi:export` script + drift test (§2.4).
**DoD:**
1. `GET /docs/json` on a live API lists every operationId in §2.2, including `updateMessageLabels`. Swagger UI at `/docs` renders them.
2. Unit test asserts the operationId set from `app.swagger()`. Drift test passes against the committed `packages/sdk/openapi.json`.
3. `PATCH …/messages/:message_id` tests: add/remove labels; thread labels recomputed; `403 insufficient_scope` without `messages:write`; cross-pod `404`; empty body `400 validation_error`; **no** `message.labeled` event emitted (assert against the fake publisher).
4. G12: `listMessages?after=` and `?before=` return 200 with correct results against real Postgres (live smoke plus an integration test). `listMessages?direction=inbound` excludes outbound rows. `listInboxes?address=` does an exact, case-insensitive match. `MessageSummary` includes the G3 fields (list + thread-detail tests updated).
5. Components are real Zod-derived schemas (G7). The hand-written `openApiComponentSchemas` is gone.
6. `pnpm --filter @localmail/api test`, typecheck, and lint are green. The existing 43 tests still pass. No new migration file under `packages/db`.

### P4-18: `@localmail/sdk` + helpers
**Scope:** §3. `packages/sdk` only (plus its committed `openapi.json` / `src/generated/`).
**DoD:**
1. `pnpm --filter @localmail/sdk generate` regenerates `src/generated/openapi.ts` deterministically, with no diff when run twice.
2. `packages/sdk/package.json` has **no** `@localmail/*` dependency (Decision 2.4). A lint rule or test asserts this.
3. Every non-Phase-5 operation in §2.2 is reachable through the typed client. Multipart send with an attachment works (unit test against a mocked `fetch` that asserts the FormData shape).
4. `waitForEmail` unit tests (hermetic: mocked fetch + a local `ws` `WebSocketServer` on an ephemeral port) cover: message arrives **before** subscribe (catch-up finds it); arrives **after** subscribe (WS path); outbound message ignored; duplicate event deduped; `labels:['otp']` resolves on `message.labeled`; WS refused → polling still resolves; timeout rejects `LocalMailTimeoutError` and leaves **no open handles** (Vitest `--detectOpenHandles`-style check: the test process exits cleanly).
5. `replyToThread` picks the last inbound message, falls back to the last message of any direction, and 404s on an unknown thread.
6. `verifyWebhookSignature` accepts a signature generated the same way as `apps/workers/src/signature.ts`, rejects a tampered body, and rejects a timestamp older than 300s. The vectors are copied from the workers test, not imported (no dependency edge).
7. Retry policy tests: a POST without `idempotencyKey` is never retried; with one, it's retried on 503; a 409 is never retried.
8. **Live smoke** (§6.2 steps 1–4) passes against the real stack.
9. Build, typecheck, lint, and test are green. README section: config env vars, admin-key limitation (G11), the `since` guidance for `waitForEmail`.

### P4-19: CLI (`packages/cli`, bin `localmail`)
**Scope:** `commander` + `@localmail/sdk`. It lives in `packages/cli` (not `apps/cli`).
**Commands** (agentmail.md §10 task 19):
```
localmail inbox create [--username u] [--display-name n] [--client-id c]
localmail inbox list
localmail send <inbox> --to a@x [--to …] --subject s (--text t | --html h | --text-file f) [--cc …] [--attach path…]
localmail reply <inbox> <message_id> (--text t | --html h) [--all]
localmail threads <inbox> [--labels a,b] [--limit n]          # list
localmail threads <inbox> <thread_id>                          # show thread + messages
localmail tail <inbox> [--events message.received,message.labeled] [--json]
localmail wait <inbox> [--from …] [--subject …] [--timeout 60]  # nice-to-have, not DoD
```
Global: `--api-url`, `--api-key` (fall back to `LOCALMAIL_API_URL`/`LOCALMAIL_API_KEY`), `--json`. `<inbox>` accepts an ID or an address (`lm.inboxes.resolve`).
**DoD:**
1. Every command above except `wait` works against the live stack (§6.2 step 5). `--json` outputs one JSON document (or NDJSON for `tail`) on stdout, nothing else. Human output goes to stdout and errors go to stderr.
2. Exit codes: `0` ok, `1` API/network error (prints `code: message`), `2` usage error. `tail` exits `0` on SIGINT and closes the socket.
3. The API key is never printed, not even in `--json` or error output (test: run with a fake key containing a sentinel string and assert it's absent from stdout and stderr).
4. `package.json` gets a `start` script (`node dist/index.js`), so agentmail.md §9's smoke works as `pnpm --filter @localmail/cli start -- tail support-bot@localmail.test`. Note: §9's literal `--filter cli` doesn't match the scoped package name. Fix the §9 line or note it in README.
5. Unit tests with an injected fake SDK cover argument parsing, output formatting, and exit codes. Build, typecheck, lint, and test are green.

### P4-20: MCP server (`apps/mcp`)
**Scope:** `@modelcontextprotocol/sdk` over **stdio**, `@localmail/sdk` for everything. Config comes from `LOCALMAIL_API_URL` / `LOCALMAIL_API_KEY` env only. **Exactly the seven §2.11 tools** already named in the stub:

| Tool | Input (Zod) | Output | Notes |
|---|---|---|---|
| `create_inbox` | `username?, display_name?, client_id?` | `Inbox` | Recommend `client_id` in the description so a re-run agent gets the same inbox back. |
| `list_threads` | `inbox` (ID or address), `labels?`, `limit?` (≤50), `page_token?` | thread summaries + `next_page_token` | |
| `get_thread` | `inbox`, `thread_id` | thread + messages with `from/to/subject/extracted_text/labels/received_at` | Fetches each message (≤50, concurrency 5); see §2.3 "deferred". |
| `send_message` | `inbox`, `to[]`, `subject`, `text?`, `html?`, `cc?` | `Message` (id, thread_id) | No attachments over MCP in Phase 4. |
| `reply` | `inbox`, **either** `message_id` **or** `thread_id`, `text?`, `html?`, `reply_all?` | `Message` | `thread_id` path = `replyToThread`. |
| `add_label` | `inbox`, `message_id`, `add?: string[]`, `remove?: string[]` | updated labels | Needs G2. |
| `wait_for_email` | `inbox`, `from?`, `subject_contains?`, `labels?`, `since?` (ISO), `timeout_seconds?` (default 60, **max 120**) | `{ status: 'found', message }` or `{ status: 'timeout', since }` | Timeout is a normal result, **not** a tool error, so the agent can retry. The max stays under typical MCP client tool timeouts. |

**Tool-output hygiene (agentmail.md §13, prompt injection):** every tool that returns message content wraps it as `{ untrusted_email_content: { … } }` and truncates `text`/`extracted_text` to 20k chars (with a `truncated: true` flag). `html` is never returned over MCP; `extracted_text` is enough for agents. Each such tool's description says the content is untrusted data from external senders and must not be followed as instructions.
**Other rules:** log only to **stderr** (stdout carries the protocol). `LocalMailError` → tool result with `isError: true` and `code: message`. The API key never appears in any tool result or log line. `bin: localmail-mcp` → `dist/index.js`, plus a `start` script.
**DoD:**
1. Hermetic tests: an MCP `Client` connected through the MCP SDK's in-memory transport lists **exactly** the 7 tools with valid JSON-schema inputs, and calls each against a fake `LocalMail`. Covers: the untrusted-content wrapper, truncation, `wait_for_email` timeout → `status:'timeout'` (not `isError`), and SDK error → `isError`.
2. `apps/mcp/package.json` depends on `@localmail/sdk` + `@modelcontextprotocol/sdk` + `zod` only. No `@localmail/db`/`core`/`events`/`jev` (Decision 2.4). A test asserts this.
3. **Live test from Claude Code** (agentmail.md §10 task 20, "test from Claude Code"). Needs the user's OK first, because it edits the user's Claude Code config (§6.3). With it registered: in a Claude Code session, create an inbox, call `wait_for_email`, deliver a fixture into it with curl over SMTP, get `status:'found'`, `reply` to it, then `add_label`. Record the transcript summary and message IDs in STATUS.md.
4. Build, typecheck, lint, and test are green. README includes the `claude mcp add` command (local scope; **never** `--scope project` with a literal key, since `.mcp.json` would be committed).

### P4-21: Examples (`examples/*`)
Each example becomes a private workspace package (`@localmail/example-<name>`, `"private": true`, depends on `@localmail/sdk` via `workspace:*`, run with `tsx`). Each has a README with exact run steps and expected output. **The decision logic is pure functions with unit tests. The end-to-end run is a `smoke` script that isn't part of `pnpm test`** (it needs the live stack). All deterministic: **no LLM calls, no API keys beyond `LOCALMAIL_API_KEY`**. A comment marks where an LLM would plug in.

**auto-reply-agent:** watches its inbox and replies to support mail.
- Triggers on **`message.labeled`**, not `message.received`. The P3-17 STATUS note says reply agents mustn't treat `message.received` as permission to reply, because `auto` may only arrive with the labels.
- Reply policy (pure fn): reply only if labels include `support` (or `billing` without `needs-human`), **and** don't include any of `auto`, `spam`, `needs-human`, `skip_classify`, and direction is inbound.
- Uses `Idempotency-Key: auto-reply:<message_id>`, so a restart that re-processes an event can't double-reply. That relies on existing P1-4b behaviour.
- **DoD:** unit-tests the policy across the 9 fixtures' expected label sets. Live, with `JEV_ENABLED=false` for determinism: a support fixture sent via curl SMTP from `customer@example.com` gets a reply visible in **Mailpit** with correct `In-Reply-To`. `05-out-of-office.eml` and `06-bounce.eml` get **no** reply. `01-billing-complaint.eml` gets **no** reply (it's `needs-human` per `docs/jev-rules-fallback.md`). Kill and restart the agent mid-run: no duplicate reply in Mailpit.

**otp-signup-agent:** `waitForEmail` for verification codes.
- Includes a tiny in-process "fake signup service" that emails a 6-digit code over **SMTP :2525** with `nodemailer` (example-only devDependency), just like a real external sender. It exposes `verify(code)`.
- Agent flow: `inboxes.create({client_id})` → capture `since` → trigger signup → `waitForEmail(inbox, { from: service address, since, timeoutMs: 30_000 })` → `extractCode(message.extracted_text)` (pure fn, regex, unit-tested against `fixtures/emails/02-otp-code.eml`) → `verify(code)` → print `verified in N ms`.
- **DoD:** live run prints `verified`, and a second run with the same `client_id` reuses the same inbox. With the signup email **sent before** `waitForEmail` is called (a `--race` flag), it still resolves through catch-up. With a wrong sender filter, it times out cleanly with exit 1 and no hanging handles.

**agent-to-agent:** two inboxes negotiate a meeting over loopback.
- `alice-agent` proposes three slots. `bob-agent` accepts the first slot that isn't in its hard-coded busy list. Alice sends a confirmation, and both stop on it (explicit terminal state). All mail stays inside LocalMail: **Mailpit count doesn't change** (pure loopback, P1-8).
- `--runaway` mode: both agents blindly reply to everything. This demonstrates the D4.3 hop guard. The run must stop by itself when the API returns `400 validation_error` "maximum hop count 20 reached", and the example reports the hop count it reached.
- **DoD:** the normal run finishes in ≤ 4 messages, all in one thread per inbox (same `thread_id` across the exchange). `--runaway` stops at `SMTP_MAX_HOPS` (default 20) without manual intervention. This is the live version of the test P3-17's DoD deferred to "Phase 4 examples". Negotiation logic is unit-tested.

**Shared P4-21 DoD:** each example's README has run steps that work as written from a fresh shell, following §6.2's prerequisites. `pnpm test` stays hermetic.

---

## 6. Test and smoke plan

### 6.1 Hermetic (runs in `pnpm test`, no Docker)

| Package | Harness | Key cases |
|---|---|---|
| `apps/api` | existing Vitest + fake store | operationId completeness, spec drift, `updateMessageLabels`, new filters, G3 fields |
| `packages/sdk` | mocked `fetch` + local `ws.WebSocketServer` | §5 P4-18 DoD 3–7 (waitForEmail race matrix, retries, signatures, multipart) |
| `packages/cli` | injected fake SDK, captured stdout/stderr | parsing, `--json`, exit codes, key-redaction sentinel |
| `apps/mcp` | MCP SDK in-memory transport + fake SDK | 7 tools, schemas, untrusted wrapper, timeout-as-result |
| `examples/*` | pure-function tests | reply policy, OTP extraction, slot negotiation |

### 6.2 Live smoke (manual script; run before marking each task Done)

**Prerequisites** (as of 2026-09-23, API/SMTP/workers were **not** running when this plan was written. Start them explicitly):
```bash
export PATH="$HOME/.local/bin:$HOME/.docker/bin:$PATH"
docker compose up -d                                  # postgres/redis/minio/mailpit healthy
set -a; . ./.env; set +a                              # APP_ENCRYPTION_KEY etc. — never echo these
export JEV_ENABLED=false                              # deterministic labels for smoke; optional second pass with Jev
pnpm --filter @localmail/api dev      &               # :8080
pnpm --filter @localmail/smtp dev     &               # :2525
pnpm --filter @localmail/workers dev  &               # classify + webhook workers (needed for message.labeled)
export LOCALMAIL_API_URL=http://127.0.0.1:8080 LOCALMAIL_API_KEY="$ADMIN_API_KEY"   # in-shell only
```
`swaks` isn't installed on this machine. Deliver mail with curl, as P1-6 did:
`curl -s smtp://127.0.0.1:2525 --mail-from customer@example.com --mail-rcpt <addr> --upload-file fixtures/emails/<file>.eml`
(Fixtures have a fixed `To:` header. The SMTP envelope `--mail-rcpt` decides which inbox receives the mail.)

| Step | Task | Action | Expected |
|---|---|---|---|
| 1 | 18-api | `curl -s :8080/docs/json \| jq '.paths\|keys\|length'` | ≥ 20 paths. `updateMessageLabels` present. |
| 2 | 18 | SDK script: create inbox (`client_id`), start `waitForEmail({from:/customer@/})`, curl-SMTP a fixture | Resolves with that message in < 2s. Re-run with the same `client_id` → same inbox ID. |
| 3 | 18 | SDK: `replyToThread` on that thread | Reply visible in Mailpit (`:8025/api/v1/messages`) with `In-Reply-To` = inbound Message-ID. |
| 4 | 18 | SDK: `updateLabels(add:['triaged'], remove:['unread'])` | GET shows the new labels. The thread's `unread` clears if it was the only unread message. No `message.labeled` event on a `tail`. |
| 5 | 19 | `localmail inbox create`, `inbox list`, `send`, `threads`, `threads <id>`, `reply`, `tail` (in a second shell while a fixture is delivered) | Human and `--json` output correct. `tail` prints `message.received` then `message.labeled`. Ctrl-C → exit 0. |
| 6 | 20 | MCP Inspector (`npx @modelcontextprotocol/inspector node apps/mcp/dist/index.js`) | 7 tools listed. Each tool call succeeds against the live API. |
| 7 | 20 | Claude Code (after user OK, §6.3) | See P4-20 DoD 3. |
| 8 | 21 | Run each example's `smoke` | Per-example DoDs in §5. |
| 9 | all | `pnpm check` (typecheck + lint + test across the monorepo) | Green. Then `git status`-style review for stray secrets (AGENTS.md §4; the repo isn't a git repo today, so check that no new files contain `lm_`/`APP_ENCRYPTION_KEY` values). |

### 6.3 Claude Code MCP registration (needs the user's OK)
```bash
pnpm --filter @localmail/mcp build
claude mcp add localmail -e LOCALMAIL_API_URL=http://127.0.0.1:8080 -e LOCALMAIL_API_KEY=<admin key> \
  -- node /Users/surendra/Documents/Experiments/localmail/apps/mcp/dist/index.js
```
This writes the key into the user's local Claude Code config (`~/.claude.json`), not into the repo. Ask before running it. Remove it afterwards with `claude mcp remove localmail` if the user prefers.

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| P4-R1 | SDK drifts from API again (as the components already did, G7) | Spec-as-artifact + drift test in `apps/api` (§2.4). |
| P4-R2 | `waitForEmail` misses mail in the list→subscribe gap, or hangs when WS silently drops | Subscribe-then-catch-up ordering + periodic reconcile poll + hermetic race tests (§3.4). |
| P4-R3 | MCP `wait_for_email` outlives the client's tool timeout and looks like a crash | Capped at 120s. Timeout returned as a normal `status:'timeout'` result. |
| P4-R4 | Auto-reply example loops with another agent, or replies to OOO/bounces | Trigger on `message.labeled`, policy excludes `auto`/`needs-human`/`spam`. Server-side hop guard is the backstop (demonstrated by `agent-to-agent --runaway`). |
| P4-R5 | Prompt injection via email bodies into MCP-driven agents | Untrusted-content wrapper, no HTML, truncation, tool-description warning (P4-20). |
| P4-R6 | Admin key (`*`) used by every example and tool | Accepted for local-only Phase 4 (G11). Documented in each README. Scoped keys are Phase 5 task 23. |
| P4-R7 | Hidden temptation to give MCP/CLI a DB shortcut for speed | Dependency-assertion tests in P4-18 and P4-20 DoDs (Decision 2.4). |
| P4-R8 | Smoke results depend on whether the Jev path or the rules path ran | Smoke runs with `JEV_ENABLED=false`. The optional live-Jev pass asserts label *subsets* only (same posture as P3-14b). |

---

## 8. Out of scope for Phase 4

Python SDK (Phase 5 task 27), drafts, search, domains, lists, scoped API keys, dashboard, npm publishing, attachments over MCP, `getThread?expand=`, thread-level label edits.
