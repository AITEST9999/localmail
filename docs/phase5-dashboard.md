# P5-26a — Next.js Dashboard: Design

> Design-only deliverable for TASKS.md **P5-26a**. Owner: Claude. Does not implement app code — this is what P5-26b (Codex) implements against.
> Grounded in the actual repo state: `apps/dashboard/src/index.ts` (read directly — an 8-line placeholder object, `{ name, framework: 'Next.js 15 (planned)', status: 'stub' }`, no Next.js dependency, no `app/`/`pages/` directory — this is a from-scratch app, not a resume of started work), `apps/dashboard/package.json` (only `build`/`lint`/`test`/`typecheck` scripts, no framework deps yet), the full live `operationId` list in `apps/api/src` (enumerated in §2 — read directly via grep, not assumed), and PLAN.md Decision 2.4 (`apps/dashboard` has no dependency edge to `packages/db`/`packages/jev` — SDK-only, same as any external agent). Resolves `docs/phase5-plan.md` §7 Q6 / §3.5.

## APPROVED — 2026-09-23

- [x] Browser auth: session cookie backed by a pod-scoped API key, via Next.js Route Handlers (BFF pattern) — no second auth system
- [x] Full information architecture: every view named, mapped to SDK methods
- [x] One required, additive API gap identified and scoped (Jev-decision data has no route today) — flagged as part of this design, not discovered mid-implementation
- [x] Stack/scaffold shape, `package.json` deps, env vars, Playwright smoke plan

Ready for Codex (P5-26b).

---

## 1. Browser auth: session cookie backed by a pod-scoped key, via BFF route handlers

**Decision: a login form takes a raw LocalMail API key, the Next.js server exchanges/validates it once, and issues an `httpOnly` session cookie of its own. The dashboard's own server-side Route Handlers hold the real Bearer key and proxy SDK calls; the browser never sees the raw API key again after login.**

This is not a second auth system — it's the same Bearer-key model every other LocalMail client uses (CLI, MCP, examples), fronted by the one piece those don't need: a way for a human's browser session to carry that key across page loads without putting it in `localStorage`/a non-`httpOnly` cookie (both readable by any injected script — and this repo's own security notes, agentmail.md §13, already flag "email bodies are untrusted input," i.e. XSS-shaped risk from rendered message content is a real concern for exactly this app, not a hypothetical one).

**Flow:**
1. **Login page** (`/login`, unauthenticated route): a form posting `{ api_key: string }` to a Next.js Route Handler, `POST /api/session`.
2. **`POST /api/session`** (server-side only): calls `sdk.me()` (existing `GET /v1/me`-backed SDK method — confirmed live-tested in Phase 4's SDK smoke, per STATUS.md) with the submitted key. If it succeeds, the server:
   - Encrypts the raw API key using a dashboard-local secret (`DASHBOARD_SESSION_SECRET`, a new env var, generated the same "local-only, `.env`-first" way as `APP_ENCRYPTION_KEY` — AGENTS.md §4's convention, a new dashboard-scoped secret, not a reuse of `APP_ENCRYPTION_KEY` itself, since that key is workers/API-only per AGENTS.md §4's structural rule and the dashboard must never share it).
   - Sets an `httpOnly`, `Secure` (in production; allowed over `http://localhost` in dev per Next.js's own cookie-security handling), `SameSite=Lax` cookie (`localmail_session`) containing the encrypted key + the pod id + an issued-at timestamp.
   - If `sdk.me()` fails (`401`), returns `401` to the login form with the same `invalid_api_key` message the API itself gives — no separate error vocabulary invented.
3. **Every subsequent page load / Route Handler call**: Next.js middleware (or each Route Handler individually — implementer's choice in P5-26b, not a design-level fork) reads `localmail_session`, decrypts the key server-side, and either (a) attaches it as the `Authorization: Bearer` header on the outbound SDK call the Route Handler makes, or (b) redirects to `/login` if the cookie is missing/invalid/expired.
4. **Client components never receive the raw key.** All data fetching goes through the dashboard's own Route Handlers (`/api/inboxes`, `/api/threads/:id`, etc. — thin proxies to `packages/sdk` calls made server-side) or Next.js Server Components fetching directly server-side (same effect — key never crosses to client JS). This is the standard Next.js "BFF" (backend-for-frontend) pattern, not a new architecture invented for this app.
5. **Logout**: `POST /api/session/logout` (or `DELETE /api/session`) clears the cookie. No server-side session store/table is needed — the cookie itself *is* the session state (encrypted key + pod id), so logout is just "stop sending the cookie," consistent with not adding new persistent storage for a debug/admin tool (agentmail.md §1's "dashboard is for debugging/admin only" non-goal).
6. **Session expiry**: cookie `Max-Age` set to a fixed window (recommend 24h — long enough not to be annoying for a local debug tool, short enough that a stale session doesn't linger indefinitely). No refresh-token complexity; re-login with the same key is cheap and expected for a local tool.

**Why this over the alternatives:** a bare non-`httpOnly` cookie or `localStorage` holding the raw key is readable by any script running on the page — and this app renders untrusted email content (subjects/bodies from real or synthetic inbound mail) by design, which is exactly the class of surface where an XSS-shaped bug (even an accidental one, e.g. a missed `sanitize-html` call — agentmail.md §13 already calls this out as a required control) would leak the key directly if it were client-readable. Routing everything through server-side Route Handlers means a rendering bug in the message-body view can't exfiltrate the API key even in the worst case, because the key was never present in the browser's JS context to begin with.

---

## 2. Information architecture — every view, mapped to SDK methods

All data access is `packages/sdk` calls made server-side (Route Handlers / Server Components), per PLAN.md Decision 2.4 — **zero** dependency edge added to `packages/db` or `packages/jev`. The full live `operationId` list (read directly from `apps/api/src/*.ts` via grep, current as of this pass — Phase 5 MVP + P5-24b domains are all already implemented per STATUS.md): `getHealth`, `createInbox`/`listInboxes`/`getInbox`/`updateInbox`/`deleteInbox`, `listThreads`/`getThread`, `listMessages`/`getMessage`/`getMessageRaw`/`sendMessage`/`replyToMessage`/`forwardMessage`/`updateMessageLabels`, `getAttachmentDownloadUrl`/`downloadAttachment`, `createWebhook`/`listWebhooks`/`getWebhook`/`updateWebhook`/`deleteWebhook`/`testFireWebhook`/`listWebhookDeliveries`, `createDraft`/`listDrafts`/`getDraft`/`updateDraft`/`deleteDraft`/`sendDraft`, `createPod`/`getPod`, `createApiKey`/`listApiKeys`/`getCurrentApiKey`/`revokeApiKey`, `createDomain`/`listDomains`/`getDomain`/`deleteDomain`/`verifyDomain`, `searchMessages`, `connectWebSocket`.

| View | Route | Data source | Notes |
|---|---|---|---|
| **Login** | `/login` | `POST /api/session` → `sdk.me()` | §1. Unauthenticated; the only page reachable without a session. |
| **Inboxes list** | `/inboxes` | `sdk.inboxes.list()` | Table: address, display name, created_at. Row click → thread list for that inbox. Create-inbox form → `sdk.inboxes.create()`. |
| **Thread list** | `/inboxes/:inbox_id/threads` | `sdk.threads.list(inbox_id, { labels, before, after, page_token })` | Filters mirror the existing API filters exactly (no dashboard-invented filter the API doesn't support) — label chips, date range. Cursor-paginated ("load more", not numbered pages, matching the API's own cursor model rather than faking offset pagination on top of it. |
| **Thread detail** | `/inboxes/:inbox_id/threads/:thread_id` | `sdk.threads.get(...)` (thread + messages) | Message list within the thread; each message expandable to raw headers via `sdk.messages.getRaw(...)` (a `<details>`/expand panel showing the raw `.eml` — read-only, agentmail.md §2.12's "raw headers" requirement). Reply/forward actions call `sdk.messages.reply()`/`sdk.messages.forward()` server-side. **Message bodies (`text`/`html`) are untrusted content** (agentmail.md §13) — `html` rendered through `sanitize-html` (already an agentmail.md §13-mandated control) before display; this is a hard requirement of this view, not optional polish. |
| **Message → Jev decision** | inline on thread detail, per message | **New, additive API surface — see §3** | Confidence + per-label verdict, shown next to each message's labels. |
| **Webhook list** | `/webhooks` | `sdk.webhooks.list()` | Create/edit/delete forms; secret shown once on create (existing SDK/API behavior — dashboard doesn't re-display it after creation, matching the API's own "never again" guarantee). |
| **Webhook delivery log** | `/webhooks/:webhook_id/deliveries` | `sdk.webhooks.listDeliveries(webhook_id)` | Status, attempts, `last_error`, `next_retry_at` — direct table over the existing route, no dashboard-side computation. "Test fire" button → `sdk.webhooks.testFire(webhook_id)`. |
| **Drafts list/detail** | `/inboxes/:inbox_id/drafts` , `/inboxes/:inbox_id/drafts/:draft_id` | `sdk.drafts.list/get/create/update/delete/send(...)` | Status badge (`draft`/`scheduled`/`sending`/`sent`/`failed`); a scheduled draft shows its `send_at`; edit form disabled once `status` leaves `draft`/`scheduled` (matches the API's own 409-shaped rejection from `docs/phase5-drafts.md` §2 — the UI should preemptively grey out the form rather than let a user submit into a guaranteed error, but the API's own check remains the actual enforcement point). |
| **Domains list/detail** | `/domains` | `sdk.domains.list/get/create/delete/verify(...)` | Shows `dns_records` (MX/SPF/DKIM/DMARC) for the caller to "publish" (simulated); status badge (`pending`/`verified`/`failed`); "Verify" button posts the echo-back body (`docs/phase5-domains.md` §4) — pre-filled from the same `dns_records` the page already has, since the dashboard is the one client that can trivially do the echo correctly (a good demonstration of the mechanism for a human, even though real agents doing this programmatically is the actual use case). **Never shows `dkim_private_key`** — the API never returns it, so there's nothing to accidentally leak here, but calling it out explicitly since it's a security-relevant view. |
| **Search** | `/search?q=...&inbox_id=...` | `sdk.search(q, { inbox_id, page_token })` | Uses P5-25b's `GET /v1/search` (already implemented per STATUS.md) — results show `rank`, same cursor-pagination "load more" pattern as thread lists. |
| **API keys** | `/settings/api-keys` | `sdk.apiKeys.list/create/revoke(...)` | Only reachable if the logged-in session's key has `api_keys:read`/`api_keys:write` — a plain scope check on the session (the dashboard doesn't need its own permission model beyond "does this key have the scope," per agentmail.md §1's "dashboard is admin/debug tooling" non-goal already ruling out a bespoke multi-role system). New-key secret shown once, in the same "copy now, it won't be shown again" pattern the API itself already enforces. |

---

## 3. Required, additive API gap: Jev decisions have no route today

**Confirmed by reading the repo directly, not assumed:** grepping every `operationId` currently registered in `apps/api/src/*.ts` (full list in §2) and grepping for `jev_decisions`/`jevDecisions` across `apps/api/src` returns **zero matches**. The `jev_decisions` table exists (`packages/db/src/schema.ts`, `messageId`/`answers`/`latencyMs`) and is written by the Phase 3 classify worker, but **nothing in `apps/api` ever reads it back out.** agentmail.md §2.12 explicitly requires the dashboard to show "Jev label decisions + confidence" — this view cannot be built against today's API surface at all, not even as a client-side workaround, because PLAN.md Decision 2.4 forbids `apps/dashboard` from touching `packages/db` directly (the correct response to "the dashboard needs a DB shortcut" is exactly this: it's an API gap, fix it in `apps/api`, per Decision 2.4's own stated rationale, not a workaround).

**Resolution — a small, additive, non-breaking API change, scoped as part of P5-26b (not a separate `*a`/`*b` pair; see rationale below):** add a `jev_decision` field to the existing `getMessage`/`getThread` response shapes (a nested object: `{ answers: Record<string, unknown>; latency_ms: number; created_at: string } | null` — `null` when `JEV_ENABLED=false` was in effect for that message, i.e. no Jev call was made, matching the existing rules-fallback path's honest "no Jev decision exists" state rather than fabricating one). This is purely additive to an existing, already-scoped (`messages:read`) response — no new route, no new scope, no migration (the `jev_decisions` table already exists; this is a `LEFT JOIN` in the existing query). Scoped inside P5-26b rather than as its own `*a`/`*b` pair because it's a single-field, single-query addition to an existing route with an existing scope, not a new cross-cutting concern or schema change — the same reasoning `docs/phase5-plan.md` §4.6 already used to justify no `*a` task for the Python SDK applies here.

**Why not a workaround instead:** the alternative — the dashboard reading `jev_decisions` directly via a DB connection some other way — would violate PLAN.md Decision 2.4's explicit, structural boundary (no dependency edge from `apps/dashboard` to `packages/db`) for the sake of one view, exactly the failure mode Decision 2.4 was written to force into visibility rather than let happen quietly (PLAN.md: "if `apps/mcp`/`apps/dashboard` ever need a DB shortcut, that's a sign the task is mis-scoped — flag it rather than adding the dependency"). This design flags it, per that instruction, and resolves it as an API fix instead.

---

## 4. Stack / scaffold

- **Framework:** Next.js 15, App Router (matches agentmail.md §3's tech-stack table and PLAN.md's existing framing — not a new choice, just the first time it's actually scaffolded).
- **New `apps/dashboard/package.json` deps:** `next` (15.x), `react`/`react-dom` (19.x, Next 15's peer requirement), `@localmail/sdk` (`workspace:*` — the **only** internal dependency, per Decision 2.4), `sanitize-html` (message `html` rendering, agentmail.md §13's mandated control — same library the brief's own tech-stack table names for this exact purpose), a CSS approach (Tailwind, per agentmail.md §3's stack table — no new choice needed here either). No `zod`/`@localmail/db`/`@localmail/jev`/`@localmail/config` — the dashboard has no server env beyond `LOCALMAIL_API_URL` and `DASHBOARD_SESSION_SECRET` (below), read with plain `process.env`, not the shared Zod env loader (that loader is a `packages/config` convenience for the server-side apps that already depend on it — pulling it in here just for two env vars would add a dependency edge for no real benefit, and Decision 2.4 doesn't require `packages/config` specifically, only `packages/db`/`packages/jev`).
- **Env vars:**
  - `LOCALMAIL_API_URL` (existing convention, matches the CLI's `LOCALMAIL_API_URL`/SDK's base-URL config — same name, no new naming scheme).
  - `DASHBOARD_SESSION_SECRET` (new — encrypts the session cookie's embedded API key, §1; generated locally, `.env`-only, never committed, same discipline as every other secret per AGENTS.md §4).
- **Directory shape (App Router):** `app/login/page.tsx`, `app/(authenticated)/inboxes/...`, `app/(authenticated)/webhooks/...`, `app/(authenticated)/domains/...`, `app/(authenticated)/settings/api-keys/page.tsx`, `app/api/session/route.ts` (+ `logout`), plus one Route Handler per SDK-backed data need under `app/api/...` where a client-side fetch (not a Server Component) is actually needed (e.g. "load more" pagination interactions) — Server Components should be preferred wherever the data doesn't need client-side interactivity, minimizing how much goes through the Route Handler layer at all.
- **Dependency-boundary test:** a hermetic test (mirroring the pattern already used to assert `apps/mcp`'s and `packages/sdk`'s dependency lists in Phase 4, per STATUS.md) asserting `apps/dashboard/package.json`'s dependencies contain no `@localmail/db`/`@localmail/jev` entry — this is the actual enforcement mechanism for Decision 2.4, not just a convention in this doc.

---

## 5. Playwright smoke plan (agentmail.md §11)

Matches the "UI: Playwright, Dashboard smoke" row in agentmail.md's testing-strategy table:

1. Login with a valid key → redirected to `/inboxes`; login with an invalid key → error shown, stays on `/login`.
2. Inboxes list shows the seeded demo inbox; click through to its thread list.
3. Thread list shows at least one thread (seed a fixture message beforehand, e.g. via `fixtures/emails/01-billing-complaint.eml` delivered over SMTP as part of test setup — reusing the existing fixture set rather than inventing new test data); open thread detail; expand raw headers; confirm the expanded raw view matches the message's actual `Message-ID` (a real content check, not just "did a panel open").
4. Webhook delivery log shows a delivery row after a test-fire.
5. A message with a stored Jev decision (rules-fallback or live Jev path — whichever fixture already produces `billing`+`urgent` labels per Phase 3's existing fixture behavior, documented in `docs/jev-rules-fallback.md`) shows its confidence/verdict on the thread detail view — this is the one Playwright check that also exercises §3's new `jev_decision` field end-to-end.
6. Create a draft, schedule it, confirm its status badge; create and verify a domain via the echo-back flow (§2's Domains view), confirm status flips to `verified`.
7. Logout clears the session; a subsequent visit to `/inboxes` redirects back to `/login`.

---

## 6. Non-goals for this design (explicitly out of scope)

- **No multi-user roles/permissions beyond "does this session's key have the scope"** — agentmail.md §1 already scopes the dashboard as debug/admin tooling, not a human-facing product; a bespoke RBAC layer on top of the existing scope model would be over-engineering for that stated purpose.
- **No dashboard-side caching/state-sync layer** (no client-side global store, no optimistic-update reconciliation) — every view re-fetches from the API on navigation/interaction, matching the "thin BFF over the real API" framing in §1; this repo's WS pub/sub infrastructure exists for other consumers (Phase 2) and nothing here requires the dashboard to subscribe to live updates for its first version (a live-updating thread view via `sdk.subscribe()` is a reasonable future enhancement, not part of this design).
- **No session refresh/rotation mechanism** — a session simply expires after its fixed window (§1) and the user re-logs in; no silent-refresh complexity for a local debug tool.
- **No new encryption scheme** — `DASHBOARD_SESSION_SECRET` is a new *secret*, but its use (AES-GCM encrypt/decrypt of a small payload) should reuse `packages/core/src/crypto.ts`'s existing `encryptSecret`/`decryptSecret` if `apps/dashboard` is allowed to depend on `packages/core` for this narrow purpose, or a direct `node:crypto` equivalent if that dependency edge is judged undesirable — **explicit open question for P5-26b**, not resolved here: does adding a `packages/core` dependency to `apps/dashboard` (for crypto only, not the transport/threading logic Decision 2.2 scoped `packages/core` around) violate the spirit of Decision 2.4, or is it fine since `packages/core` isn't `packages/db`/`packages/jev`? Flagging rather than silently picking one.

---

## 7. Test coverage this design implies (for P5-26b, informational — not the DoD itself, see TASKS.md)

- Unit: session-cookie encrypt/decrypt round-trip; `sanitize-html` actually strips a script-tag-bearing synthetic message body before render (a real XSS-shaped fixture, not just an empty-string check).
- Dependency-boundary test: `apps/dashboard/package.json` has no `@localmail/db`/`@localmail/jev` entry (§4).
- Integration: the new `jev_decision` field on `getMessage`/`getThread` (§3) — present and correct for a rules-fallback-classified message, `null` for a message ingested with `skip_classify`.
- Playwright: the full smoke sequence in §5, against the real stack.
