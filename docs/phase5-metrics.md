# P5-28a — Metrics + Structured Logging + k6 Load Test: Design

> Design-only deliverable for TASKS.md **P5-28a**. Owner: Claude. Does not implement app code — this is what P5-28b (Codex) implements against. Deliberately last in Phase 5 (`docs/phase5-plan.md` §1) — every other Phase 5 surface (P5-22b drafts, P5-23b pods/keys/rate-limiting, P5-24b domains, P5-25b FTS, P5-26b dashboard scaffold) is confirmed DONE per STATUS.md, so this design instruments a system that already has all of Phase 5's real surfaces in it, not a hypothetical future one.
> Grounded in the actual repo state: `apps/api/src/app.ts` (Fastify's built-in `logger: true` option, confirmed directly — this is pino under the hood, matching agentmail.md §3's tech-stack table; no separate logger setup exists to point at), `apps/api/src/ws-hub.ts` (the real connection-tracking structure — `connectionsByPod: Map<string, Set<WsConnectionState>>`, read directly, the natural source for a WS-connection gauge), `apps/api/src/rate-limit.ts` (`consumeBucket`/`createRedisRateLimiter`/`createMemoryRateLimiter`, read directly — the exact functions a 429 metric hooks into), `apps/workers/src/runtime.ts` (the real BullMQ queue list, `['jev-classify', 'webhook-deliver', 'scheduled-send', 'ws-broadcast']`, plus P5-25d's future `embed-message` per `docs/phase5-search-semantic.md`), and `apps/api/src/errors.ts` (the full `ApiErrorCode` catalog, used to derive error-code label values rather than inventing a parallel taxonomy). No `prom-client` dependency exists yet anywhere in the repo (confirmed — this is greenfield).

## APPROVED — 2026-09-23

- [x] Full metric list (name, type, labels) for HTTP requests, BullMQ queue depths, WS connections, rate-limit rejections
- [x] `/metrics` auth decision: unauthenticated, same posture as `/healthz` — with rationale and an explicit mitigation for the one real risk that creates
- [x] Structured logging conventions + redaction rules (API keys, webhook secrets, DKIM keys never logged)
- [x] k6 script plan: 1,000 inboxes / 10,000 messages, `k6/` directory, targets the real API

Ready for Codex (P5-28b).

---

## 1. Metrics

All metrics are exposed via `prom-client` (new dependency — `apps/api` and `apps/workers` both need it; `apps/smtp` too, for its own request/message counters, per §1.4) at `GET /metrics` in `apps/api` (§2), with `apps/workers`/`apps/smtp` either exposing their own `/metrics` port (if they ever run as separate processes reachable independently) or — simpler for this local-first, single-`pnpm dev`-tree setup — pushing their metrics into a shared `prom-client` `Registry` that `apps/api`'s `/metrics` endpoint serves, **if** all three processes share memory (they don't — each is a separate Node process per `pnpm dev`'s turbo-parallel setup). **Decision: each process (`apps/api`, `apps/workers`, `apps/smtp`) exposes its own `/metrics` on its own port**, not a single aggregated endpoint — simpler (`prom-client`'s default `Registry` per-process, no cross-process aggregation plumbing needed) and matches how a real Prometheus scrape config would target this stack anyway (one target per process). `apps/api`'s `/metrics` is the one named explicitly in `docs/phase5-plan.md` §3.7 and in TASKS.md's DoD; `apps/workers`/`apps/smtp` get the same treatment for completeness but are not separately called out in every DoD line below (implied, not re-derived per metric).

Naming convention: `localmail_<subsystem>_<noun>_<unit>` (Prometheus's own naming convention — `_total` suffix for counters, `_seconds`/`_bytes` for histograms with the actual unit, no unit suffix for gauges), a `localmail_` prefix throughout so these never collide with the standard Node/process default metrics `prom-client` also exposes (`process_cpu_seconds_total` etc. — kept, not disabled, since they're free and useful).

### 1.1 HTTP (apps/api)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `localmail_http_requests_total` | Counter | `method`, `route`, `status_code` | `route` is the Fastify **route template** (`/v1/inboxes/:inbox_id/threads`), never the raw interpolated URL — this is the one label choice with a real PII/cardinality consequence, spelled out in §1.5. |
| `localmail_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Default `prom-client` bucket boundaries are a reasonable start (`0.005` to `10`s) — P5-28b should confirm they cover this API's actual latency range (sub-100ms per the Phase 1 acceptance criterion) rather than blindly accepting the library default without checking. |
| `localmail_http_requests_rate_limited_total` | Counter | `scope` (`key` \| `pod`) | Incremented at the exact point `apps/api/src/rate-limit.ts`'s bucket check rejects a request (§4's Q2 per-key/per-pod distinction from `docs/phase5-pods-keys.md`) — `scope` says which bucket rejected it, so a dashboard can tell "one noisy key" apart from "pod-wide ceiling hit." |

### 1.2 BullMQ queue depth/health (apps/workers)

One gauge, labeled by queue name, rather than one gauge per queue — keeps this metric additive-by-construction as queues are added (P5-25d's future `embed-message` queue needs no new metric definition, just a new label value):

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `localmail_queue_jobs` | Gauge | `queue` (`jev-classify`\|`webhook-deliver`\|`scheduled-send`\|`ws-broadcast`\|...), `state` (`waiting`\|`active`\|`delayed`\|`failed`) | Sourced from BullMQ's own `Queue.getJobCounts()` (already the right primitive — no need to hand-roll counting), polled on an interval (recommend every 5s, matching `docs/phase5-drafts.md` §4.1's own scheduled-send poll interval — reuse that cadence rather than picking a third arbitrary number) rather than pushed per-job-event, since a gauge naturally represents "current state," and polling `getJobCounts()` is cheap and simple compared to keeping a live increment/decrement in sync with BullMQ's own internal state transitions. |
| `localmail_queue_job_duration_seconds` | Histogram | `queue`, `outcome` (`success`\|`failure`) | Measured around each queue's existing job handler (e.g. `jev-classify`'s handler in `apps/workers/src/classify.ts`, `scheduled-send`'s in `scheduled-send.ts`) — wrap the existing handler body, don't restructure it. |

### 1.3 WebSocket (apps/api)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `localmail_ws_connections` | Gauge | none | Sourced directly from `apps/api/src/ws-hub.ts`'s existing `connectionsByPod: Map<string, Set<WsConnectionState>>` — sum of every set's size, updated at the same points that map is already mutated (connection open/close, read directly at lines tracking `.set()`/`.delete()`) rather than a separate counting mechanism that could drift out of sync with the real map. **No `pod_id` label** — see §1.5, this is exactly the kind of label that turns a small gauge into an unbounded-cardinality one if a label is added per-tenant on a self-serve multi-pod system (P5-23's pods feature makes pod count caller-controlled, not a fixed small set). |

### 1.4 SMTP (apps/smtp)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `localmail_smtp_messages_received_total` | Counter | `outcome` (`accepted`\|`rejected_unknown_recipient`\|`rejected_blocked`) | Sourced from the existing `RCPT TO`-time accept/reject decision (PLAN.md §5's "reject at `RCPT TO`, not after `DATA`" — the exact point this counter increments). |

### 1.5 Cardinality / PII discipline — the actual design decision here, not boilerplate

The one real risk in this section is a label that silently becomes high-cardinality or leaks identifying data through the label set itself (a metric label is effectively a small, semi-permanent log line stored by every scrape, and Prometheus-style systems degrade badly under high-cardinality labels regardless of PII concerns). Concretely enforced in every metric above:

- **`route` is always the Fastify route *template*, never the interpolated path.** `GET /v1/inboxes/:inbox_id` (the template) is a label with maybe 40 possible values across the whole API; `GET /v1/inboxes/inb_a1b2c3...` (the interpolated path, if it were used instead) would create a new label value — and a new time series — per distinct inbox ID ever queried, which is both a real cardinality problem and a data-shape that happens to leak inbox IDs into a metrics endpoint. Fastify exposes the matched route template on `request.routeOptions.url` (or the equivalent for whatever Fastify version is pinned — P5-28b should confirm the exact API against the installed version, same "confirm against the installed version, don't assume" discipline `docs/phase5-domains.md` §5 already established for Nodemailer) — use that, never `request.url`.
- **No `pod_id`, `api_key_id`, `inbox_id`, `email_address`, or `domain` ever appears as a label**, on any metric in this design. Every one of those is either unbounded cardinality (pod/key/inbox counts are caller-controlled via P5-23's `createPod`/`createApiKey`) or directly identifying (an email address or custom domain name is real, if synthetic, PII/identifying data by this project's own framing — agentmail.md §13 already treats email content as sensitive). If per-pod metrics are ever genuinely needed (e.g. "which pod is generating the most traffic"), that's a query best answered by application-level logging + a log aggregator, not a Prometheus label — flagged as a non-goal in §5, not solved here.
- **No raw API keys, webhook secrets, or DKIM private keys anywhere near a metric label** — this overlaps with §3's logging redaction rules but is worth restating here specifically because it's a *different* channel (metrics, not logs) that could just as easily leak the same secrets if someone reflexively added `api_key: request.apiKeyRow.prefix` as a "helpful" label. **Not even the key `prefix`** (which isn't secret on its own, but there's no legitimate metrics use case for it that isn't better served by log-based investigation) — keep the metrics surface minimal and free of anything resembling a credential.

---

## 2. `/metrics` auth: unauthenticated, same posture as `/healthz`

**Decision: `GET /metrics` requires no `Authorization` header, exactly like `GET /healthz` already doesn't (confirmed by reading `apps/api/src/app.ts`/`auth.ts` — the auth plugin's `onRequest` hook explicitly short-circuits on `if (!request.url.startsWith('/v1/'))`, and neither `/healthz` nor `/metrics` would live under `/v1/`).**

**Rationale:** this is a local-first, single-developer-machine tool (agentmail.md §1's own framing, restated throughout every Phase 5 design doc so far) — the realistic threat model is "something else on this machine, or something on this machine's LAN if a developer's `API_PORT` happens to be more broadly bound than `localhost`, reads aggregate request-count/latency/queue-depth numbers," not "an internet-facing attacker." That's a materially different bar than the data `/v1/*` routes protect (actual pod-scoped mail content, API keys). Requiring auth on `/metrics` would also mean either (a) inventing a metrics-specific credential (a new secret to manage, generate, and keep out of git — real cost, agentmail.md §4's secrets-discipline overhead applied to something that doesn't need it), or (b) requiring a real LocalMail API key just to scrape metrics, which is awkward for a standard Prometheus scrape config (most setups expect a bare HTTP GET, not bearer-token auth wired into `scrape_configs`) and would mean rotating/revoking a key (§2, `docs/phase5-pods-keys.md`) could silently break metrics collection as a side effect — a surprising coupling between two unrelated concerns.

**The actual mitigation for the one real risk this creates (§1.5's own point, restated as the direct consequence of this auth decision):** since `/metrics` is unauthenticated, it must never expose anything an authenticated route wouldn't already expose more directly, and — the stricter bar — must never expose anything at all beyond aggregate counts/timings. §1.5's cardinality/PII rules are not a nice-to-have alongside this decision; they are the actual security boundary this decision relies on. If a future metric ever needs a label that could carry identifying data, that's the point at which `/metrics` auth should be revisited, not something to solve preemptively now with unneeded auth machinery.

---

## 3. Structured logging + redaction rules

**Base:** Fastify's built-in logger (`logger: true` in `apps/api/src/app.ts`, confirmed directly — this is pino, already the project's logger per agentmail.md §3's tech-stack table; `apps/workers`/`apps/smtp` should use a plain `pino()` instance directly with the same config, since they're not Fastify apps). No new logging library — this section is about *conventions on top of* the existing pino setup, not a new one.

### 3.1 Redaction — the hard requirement

**Never log:** raw API keys (any `Bearer ...` header value, any `api_key`/`admin_api_key` response field), webhook secrets, DKIM private keys (plaintext or the `encryptSecret`-wrapped ciphertext — the ciphertext alone isn't exploitable without `APP_ENCRYPTION_KEY`, but logging it is still needless exposure of secret material and bad practice regardless), the `DASHBOARD_SESSION_SECRET`-encrypted session cookie value, `Authorization` headers verbatim.

**Mechanism:** pino's built-in `redact` option (an array of paths to redact from logged objects, e.g. `req.headers.authorization`, `res.headers['x-localmail-signature']`) applied at logger-construction time in every process (`apps/api`, `apps/workers`, `apps/smtp`) — not a manual "remember to strip this" discipline at every call site, which is exactly the kind of rule that erodes over time as new log statements get added by people who didn't read this doc. Fastify's own request/response auto-logging (already active via `logger: true`) needs its `redact` config set explicitly; any hand-written `logger.info(...)` call elsewhere in the codebase that might include a request/response object should rely on the same redact config rather than manually omitting fields, so there's one enforcement point, not many.

**Verification, not just policy:** this repo already has a precedent for testing this exact property — the CLI's existing "API-key-redaction-sentinel test" (per STATUS.md's P4-19 entry: "an API-key-redaction sentinel test"). P5-28b's DoD (already written into TASKS.md) should extend that same pattern server-side: a hermetic test that sends a request with a real-shaped API key, captures the actual log output, and asserts the key string never appears in it — a policy statement in this doc is not the enforcement mechanism, that test is.

### 3.2 Request-id propagation

Fastify's built-in request-id generation (`req.id`, already present via `logger: true`, no new code needed for its *existence*) should be **threaded through to BullMQ job payloads** when a request enqueues a job (e.g. `sendDraft` triggering an immediate send, or ingest enqueuing `jev-classify`/`embed-message`) — add a `requestId?: string` field to job payloads, logged by the worker's own job handler. This is what makes "a request came in, it enqueued a job, the job did X" traceable across the `apps/api` → `apps/workers` process boundary in the log stream, which otherwise has no correlating identifier at all. Not a hard requirement for every job type (a poller-claimed scheduled-send job, for instance, has no originating request to propagate from — that's fine, `requestId` is simply absent/`null` for those).

### 3.3 Structured fields, not string interpolation

Every log call should pass fields as a structured object (pino's native style: `logger.info({ messageId, inboxId, outcome }, 'jev-classify completed')`), not string-interpolated (`logger.info(\`jev-classify completed for ${messageId}\`)`) — this isn't a new rule invented here, it's already how `apps/workers/src/runtime.ts`'s existing log lines are written (confirmed by reading them: `` `jev-classify ${job.data.messageId} skipped (${outcome.reason})` `` is actually the *inconsistent* case worth flagging — **P5-28b should convert these existing string-interpolated worker log lines to structured fields** as part of applying this convention consistently, not just apply it to new code going forward and leave the existing ones as a stray inconsistency).

---

## 4. k6 load test

**Location:** new top-level `k6/` directory (matches `docs/phase5-plan.md` §7's own naming, and this repo's existing top-level-directory convention — `examples/`, `fixtures/`, `docs/`, `k6/` fits the same pattern, not nested under `apps/` or `packages/` since it's neither a shippable app nor a library).

**Target:** the real running API (`LOCALMAIL_API_URL`, same env-var convention as the CLI/dashboard — no k6-specific naming invented), never an in-process mock — a load test that doesn't exercise real Postgres/Redis/MinIO connection pooling, real network I/O, and the real rate-limiter (P5-23b) isn't actually testing what agentmail.md §10 task 28 asks for.

**Scenario (per agentmail.md §10 task 28's own spec — 1,000 inboxes, 10,000 messages):**

1. **Setup phase** (k6 `setup()` function, runs once before the load stages): create 1,000 inboxes via `POST /v1/inboxes` (using `client_id` for idempotent re-runs — the existing mechanism, not a k6-specific dedup scheme), using a `*`-scope admin key seeded ahead of time (not committed to the k6 script — read from an env var, same secrets discipline as everywhere else).
2. **Load phase:** deliver 10,000 messages, distributed across the 1,000 inboxes, via a mix that reflects real usage rather than one synthetic shape:
   - **Majority via `POST /v1/inboxes/:id/messages/send`** (the API path, not raw SMTP — simpler to drive from k6's HTTP-only model; k6 has no native SMTP protocol support, and standing up a separate SMTP-capable load-test tool just for this one path is more machinery than this task's stretch-priority status justifies. **Explicit accepted limitation, not silently glossed over:** this means the k6 run primarily load-tests `apps/api`'s outbound/loopback path, not `apps/smtp`'s inbound `RCPT TO`/`DATA` handling under load — if inbound-SMTP-specific load behavior is ever a real concern, that's a follow-up task with a different tool (e.g. a `swaks`-driving script run in parallel, or a dedicated SMTP load tool), not something this k6 script should awkwardly bolt on.
   - Interleaved with a smaller volume of `GET /v1/search` and `GET /v1/inboxes/:id/threads` calls (read-path load, not just write-path), reflecting that a real agent workload reads at least as often as it sends.
3. **Metrics/thresholds** (k6's own `thresholds` config, checked automatically at run end — pass/fail, not just a report to eyeball):
   - `http_req_duration{endpoint:send}`: `p(95) < 500ms` (generous relative to the Phase 1 acceptance bar of <100ms for inbox *creation* specifically — sending involves more work: MIME build, DB writes, event fan-out — this number is a starting point for P5-28b to tune against real measurements, not a number transcribed from an existing benchmark).
   - `http_req_duration{endpoint:search}`: `p(95) < 300ms`.
   - `http_req_failed`: `rate < 0.01` (under 1% error rate across the whole run — a real ceiling, not "zero tolerance," since a k6 run this size against a local single-instance Postgres/Redis is expected to occasionally hit a rate-limit `429` if the load profile isn't carefully tuned against P5-23b's configured `RATE_LIMIT_*` env values, which is itself useful information the run should surface, not hide).
4. **Teardown:** none required — created inboxes/messages are left in place (this is a local dev/test database, not a shared environment with a cleanup obligation; re-running the script is idempotent for the inbox-creation step via `client_id`, and message sends are naturally additive across runs, which is fine for a load-test dataset).

**What this k6 run is explicitly for:** surfacing whether Phase 5's additive surfaces (rate limiting, drafts' scheduled-send poller, FTS, the domains/DKIM signing path if exercised) hold up under a realistic volume — not a formal capacity-planning exercise for a production deployment this project explicitly isn't (agentmail.md §1's non-goals: no public deliverability, no billing/usage plans — this is a local dev tool's load test, sized to catch regressions, not to certify a production SLA).

---

## 5. Non-goals for this design (explicitly out of scope)

- **No per-pod/per-key metrics dimension** — §1.5 already covers why (unbounded cardinality, caller-controlled counts via P5-23). If per-tenant usage visibility is ever genuinely needed, that's a log-aggregation/query concern, not a new Prometheus label added retroactively to every metric in this doc.
- **No distributed tracing (OpenTelemetry spans, trace propagation beyond the request-id threading in §3.2)** — this is a single-machine, single-instance-per-process local tool; full distributed tracing is infrastructure sized for a problem (many replicated instances, real network hops between independently-scaled services) this project doesn't have, per its own "100% local" framing.
- **No alerting/paging configuration** — this design produces metrics a human can look at (or wire into their own Grafana/Prometheus if they choose to), not an on-call system. Out of scope for a local dev tool.
- **No SMTP-protocol-level k6 load** (§4's explicit accepted limitation) — flagged, not solved, in this pass.
- **No metrics-endpoint auth revisited beyond what §2 already resolves** — if a future metric genuinely needs an identifying label, that's the trigger to revisit `/metrics` auth, not something to solve speculatively now.

---

## 6. Test coverage this design implies (for P5-28b, informational — not the DoD itself, see TASKS.md)

- Unit: the redaction-sentinel test (§3.1) proving no API-key-shaped string appears in captured log output across `apps/api`/`apps/workers`/`apps/smtp`; a cardinality-shaped test asserting `route` label values are always route templates, never interpolated paths, for a representative sample of routes including at least one with a path param.
- Integration: `/metrics` returns valid Prometheus exposition format (parseable by `prom-client`'s own registry or a minimal manual check) with every metric named in §1 present after exercising at least one request/job/WS-connection/rate-limit-rejection of each kind.
- k6: the full scenario in §4, run against a real local stack, with results (actual p95s, actual error rate, actual rate-limit-429 count if any) recorded in STATUS.md — the real numbers, not this design doc's starting-point thresholds, are the ones that matter once P5-28b actually runs it.
