# LocalMail — Implementation Plan (Phase 0–3 MVP)

> Companion to [agentmail.md](./agentmail.md) (the product brief) and [TASKS.md](./TASKS.md) (the task board).
> Scope: Phases 0–3 only — foundation, core email, real-time, smart inbox. Phases 4–5 (SDK/CLI/MCP/dashboard/domains/search) are referenced only where they constrain package boundaries now, so we don't have to reshape things later.

---

## 1. Ground rules for this plan

- No app code in this pass — this document, TASKS.md, and AGENTS.md are the deliverables.
- Optimize for **parallel agents in separate Herdr panes** touching disjoint files. Package boundaries below exist mainly to make that safe, not for architectural purity.
- Every decision here that isn't already fixed by agentmail.md is called out explicitly as a **Decision**, with the alternative considered and why it lost.

---

## 2. Package boundaries and dependency graph

Repo layout is fixed by agentmail.md §8. What agentmail.md doesn't specify is *who is allowed to import whom*. That's the actual mechanism that keeps parallel agents from colliding or building a tangle:

```
packages/config   ← no internal deps (tsconfig, eslint, zod env schema)
packages/db       ← config
packages/core     ← config, db (types only, no live queries — see Decision 2.2)
packages/jev      ← config              (new package, not in §8 — see Decision 2.3)
packages/sdk      ← config              (generated client; zero server deps)
packages/cli      ← sdk

apps/api          ← config, db, core
apps/smtp         ← config, db, core
apps/workers      ← config, db, core, jev
apps/mcp          ← sdk only
apps/dashboard    ← sdk only
```

**Decision 2.1 — apps never import other apps.**
`apps/api`, `apps/smtp`, `apps/workers` share no code directly; everything shared lives in `packages/core` or `packages/db`. This is what lets one agent own `apps/smtp` and another own `apps/api` in the same afternoon without touching each other's files. The one exception the brief creates is inbound/outbound *loopback* (§4 Outbound flow step 4) — resolved in Decision 4.1 below by putting the shared logic in `packages/core`, not by importing across apps.

**Decision 2.2 — `packages/core` is transport-and-infra-free.**
Threading, MIME building, label/rule matching, DKIM signing, and the inbound-ingest pipeline are plain functions operating on typed inputs (headers, parsed MIME, a thread-lookup callback). They do not import Fastify, BullMQ, `smtp-server`, or a live DB client — only `packages/db`'s *types* (row shapes) and a repository *interface* it defines. Concretely:

- `packages/db` exports typed repositories (`ThreadRepo`, `MessageRepo`, …) — never raw Drizzle query builders — so `packages/core` can accept a repository as a parameter and tests can pass an in-memory fake instead of Testcontainers.
- This is why task 7 (threading engine) can be fully unit-tested with Vitest fixtures and no Postgres, and why it can start on day one — see the sequencing graph in §6.

Alternative considered: let `apps/api` and `apps/workers` each import Drizzle directly and duplicate query logic. Rejected — every schema change would require touching N call sites instead of one repository, and it removes the ability to unit-test core logic without Testcontainers, which is the single biggest CI-speed lever we have (§8 risk R6).

**Decision 2.3 — Jev gets its own package, not a raw SDK import in `apps/workers`.**
agentmail.md §5 sketches the classify call inline in `apps/workers/src/jev-classify.ts`. We instead put the actual Jev calls behind `packages/jev`, which owns:

- The five-question batched call (see §4 below — this is where the real available primitives, not the brief's illustrative SDK, matter).
- The `JEV_ENABLED=false` → rules-fallback branch (task 15), so callers never branch on the flag themselves.
- Confidence-threshold policy (`act_above`/`review_above`) in one place, tunable without touching the worker.

Reasoning: `apps/dashboard` (Phase 5) will want to *read* `jev_decisions` rows but must never hold `TYPESAFE_API_KEY` (agentmail.md §13, §5's "never send the API key to clients"). Isolating the client in its own package makes that a lint-enforceable boundary (`apps/dashboard` simply has no dependency edge to `packages/jev`) instead of a code-review convention someone forgets.

**Decision 2.4 — `apps/mcp` and `apps/dashboard` are SDK-only, zero DB/queue access.**
Both are Phase 4/5, but fixing this boundary now (in the plan, not the code) means Phase 4 doesn't have to retrofit anything: the MCP server and dashboard talk to `apps/api` exactly like an external agent would. This is also the cheapest way to guarantee the REST API is actually sufficient for agent use — if the MCP server needed a side door into the DB, that would mean the API is incomplete.

---

## 3. Data model additions to agentmail.md §6

The brief's schema (§6) is a strong start but is missing two things the MVP acceptance criteria (§12) actually require:

**Decision 3.1 — add an `idempotency_keys` table.**
§7 conventions require an `Idempotency-Key` header on POST, and §2.1 wants idempotent inbox creation via `client_id`. A unique `client_id` column on `inboxes` handles *that one endpoint*, but the general `Idempotency-Key` convention (message send, drafts, webhooks) needs somewhere to store "I already processed this key, here's the response I gave last time." Without it, a retried `send` during a flaky webhook delivery double-sends mail.

```
idempotency_keys (id, pod_id, key UNIQUE(pod_id, key), endpoint, request_hash,
                   response_status, response_body jsonb, created_at)
```
Lookup: on any POST with an `Idempotency-Key`, check `(pod_id, key)`; if found and `request_hash` matches, replay `response_body`/`response_status` instead of re-executing. If found with a different `request_hash`, `409 Conflict`.

**Decision 3.2 — encrypt DKIM private keys and webhook secrets at rest.**
§6 stores `dkim_private_key` and §6 `webhooks.secret` as plain columns; §13 only mentions hashing API keys. A DKIM private key or webhook HMAC secret sitting in plaintext in Postgres is a bigger blast radius than an API key (it lets someone forge signed mail / forge webhook payloads pod-wide). Add a thin `packages/core/crypto.ts` (AES-256-GCM, key from `APP_ENCRYPTION_KEY` env var, generated into `.env` on first `pnpm db:seed`) and store ciphertext in those two columns. This is a few hours of work in task 3/task 24 and closes an easy real hole — not deferred to "Phase 5 hardening."

No other schema changes; the rest of §6 is left as specified.

---

## 4. Jev integration — grounded in the actual primitives

agentmail.md §5's code sketch imports a `TypeSafeClient` with `Choice`/`Noul` question types. The Jev tools actually available in this environment are `jev_check` (single yes/no → probability + act/review/abstain verdict), `jev_classify` (pick one of N options), `jev_score` (ordered scale), and — importantly — **`jev_ask`**, which batches multiple independent questions over one state in a single forward pass "with almost no added latency." That's a direct match for §5's table of six decisions (spam, category, urgent, needs-human, auto, otp), and it's a better fit than six separate calls:

**Decision 4.1 — `packages/jev/classify.ts` issues exactly one `jev_ask` call per inbound message**, with one `classify` question (category, `add_none: true` isn't needed since agentmail.md already has an `other` bucket) and four `check` questions (spam, urgent, needsHuman, auto). `act_above`/`review_above` thresholds are read from config so they can be tuned per-pod later without a code change. The `otp` label agentmail.md lists as its own decision folds into the `category: otp` classify answer rather than a fifth check — one fewer question per call, same information.

Storage: `jev_decisions.answers` stores the raw `jev_ask` response (all five verdicts + confidences + latency), so the dashboard (Phase 5) can show confidence per label without re-deriving it.

**Decision 4.2 — reply-loop protection (task 17) is not purely a Jev feature.**
The `auto` check gives a probabilistic signal, but the RFC 3834 `Auto-Submitted` header (already in scope per §13) is a hard, cheap, deterministic check and should short-circuit *before* the Jev call — skip classification's `needsHuman`/webhook-trigger side effects entirely for anything with `Auto-Submitted: auto-replied|auto-generated`, regardless of what Jev would say. Jev's `auto` check is the fallback for senders that don't set the header. This also matters for cost: don't spend a Jev call on something already deterministically known to be a bounce.

**Decision 4.3 — inbox-to-inbox loopback needs a hop-count guard independent of Jev.**
This is a gap in agentmail.md, not a restatement of it: §4's outbound step 4 ("if recipient is another LocalMail inbox, loop back directly to inbound — agent-to-agent email!") combined with two auto-reply agents (§8's `examples/agent-to-agent`) can produce an unbounded reply chain *before* either message is ever labeled `auto` by Jev, because Jev only runs after ingest, and by then the reply may already have been sent. Add `X-LocalMail-Hop-Count` (or reuse `References` length) checked at *outbound send time* in `packages/core`, capped (e.g. 20), independent of and earlier than Jev/`auto`-label logic. This is called out again as Risk R2 in §8 and folded into task 8, not task 17, because it has to exist before Jev classification runs at all.

**Decision 4.4 — `JEV_ENABLED=false` fallback (task 15) lives in the same module, not a parallel code path.**
`packages/jev/classify.ts` exports one function; internally it branches once at the top (config flag) between the real `jev_ask` call and a keyword/header heuristic (reuses the same five-key return shape so callers — the worker, the `jev_decisions` writer — never know which path ran). This keeps the fallback from silently drifting out of sync with the real schema, which is the way these flags usually rot.

---

## 5. Other implementation decisions

**Webhook backoff (task 11).** The retry schedule in §7 (1m, 5m, 30m, 2h, 12h) is not a clean exponential ratio (×5, ×6, ×4, ×6) — don't reach for BullMQ's built-in `exponential` backoff type. Use a custom backoff function keyed on `attemptsMade` against a hardcoded delay array. Five attempts, then mark `failed` and stop, per §7.

**WebSocket fan-out (task 13).** Match the architecture diagram's dedicated `ws-broadcast` worker: API processes hold the actual WS connections, but the *fact* that an event happened is published via Redis pub/sub (one channel per pod, or per inbox if fan-out volume ever demands it — not needed for local MVP), not an in-process `EventEmitter`. This isn't over-engineering for a single-instance local deployment — it's what makes `message.received → WS within 1s` (§12) testable in isolation from the HTTP/WS layer, and it's the only version of this that doesn't have to be rewritten if `apps/api` ever runs as more than one process.

**SMTP relay safety (task 6).** Reject unknown recipients at `RCPT TO` (SMTP-command time), not after `DATA` + parse. Accepting the body for a domain you're going to bounce anyway is exactly the shape of an open relay, even on `localhost` — and it's free to get right the first time (`smtp-server`'s `onRcptTo` hook exists for this).

**Testcontainers cost (task 4 onward).** Split `pnpm test:unit` (packages/core, no containers, runs in every pane on every save) from `pnpm test:integration` (Testcontainers-backed, apps/api + apps/smtp routes). Agents in Herdr panes should default to the unit split for their inner loop; integration tests run before a task is marked done, not on every keystroke. This is a workflow convention, documented in AGENTS.md, not a schema/code decision.

---

## 6. Sequencing / critical path

Numbers refer to agentmail.md §10 task numbers.

```
                 ┌─ 1 (monorepo scaffold) ─┬─ 2 (docker-compose)  [independent, parallel pane]
                 │                          │
                 │                          └─ 3 (db schema + idempotency_keys + crypto)
                 │
                 ├─ 7 (threading engine, packages/core — pure, unblocked by 2/3) ── starts immediately after 1
                 │
   1 ────────────┴─ 4 (API skeleton) ── needs 1, 3, 2(local pg)
                       │
                       ├─ 5 (inboxes CRUD) ── needs 4
                       │
                       └─ 6 (inbound SMTP) ── needs 3, 2(minio); can run parallel to 4/5 in its own pane
                             │
                 7 ──────────┼── 8 (send/reply/forward + loopback + hop-count guard, Decision 4.3)
                 5 ──────────┘        needs 5, 6, 7
                             │
                             ├─ 9 (list/pagination) ── needs 5, 7
                             └─ 10 (attachments) ── needs 6 (storage path), 8 (send path)

   3, 4 ─── 11 (events + webhook worker, backoff array) ── needs 3, 4
                 │
                 ├─ 12 (webhook CRUD + delivery log) ── needs 11
                 └─ 13 (WS endpoint + Redis pub/sub) ── needs 11

   6 ──┬── 14 (jev-classify worker, packages/jev, jev_ask) ── needs 6 (message.received), 11 (message.labeled event)
       ├── 15 (rules fallback) ── same module as 14, ship together
       └── 16 (allow/block lists) ── needs 6; independent of Jev, can start as soon as 6 lands

   8, 14 ── 17 (reply-loop protection: Auto-Submitted short-circuit + auto label) ── needs 8's hop-count guard (4.3) and 14's auto check
```

**Parallelization notes for Herdr pane assignment:**
- Panes that can start on day one with zero infra dependency: task 1, and — the moment `packages/config`/`packages/db` types exist — task 7 (threading, pure functions).
- Task 2 (docker-compose) and task 3 (schema) can run in parallel panes; they only rendezvous at task 4.
- Tasks 6 and 4/5 are a natural two-pane split (SMTP ingest vs. REST CRUD) — they don't share files, only the DB schema and `packages/core` repository interfaces, which should be frozen (reviewed, see TASKS.md) before either starts.
- Task 16 (allow/block) is a good "extra pane" task to soak up capacity in parallel with 14/15, since it doesn't touch Jev at all.

---

## 7. Acceptance mapping

Each agentmail.md §12 MVP checkbox is covered by tasks: docker/env → 1,2; inbox creation latency → 5 + DB indexes (§6); swaks → correct thread → 6,7; reply headers round-trip → 7,8; inbox-to-inbox → 8 (Decision 4.1/4.3); webhook+WS within 1s → 11,12,13; retry+delivery log → 11,12; Jev labels + disabled fallback → 14,15; tests green/lint clean → applies to every task's Definition of Done (TASKS.md); no secrets/keys hashed → 4 (API key hashing), 3.2 (DKIM/webhook secret encryption, Decision 3.2).

---

## 8. Risks

| # | Risk | Mitigation | Where it's handled |
|---|---|---|---|
| R1 | Threading breaks on missing `References`, `Re:`/`Fwd:` locale variants, mailing-list subject prefixes | Normalized-subject fallback (already in §4) + fixture set from §11 (`long reply chain` fixture) drives task 7's tests | Task 7 |
| R2 | Two LocalMail agents auto-replying loop indefinitely *before* Jev ever labels either message `auto` | Hop-count guard at outbound send time, independent of Jev | Decision 4.3, task 8 |
| R3 | `Idempotency-Key` convention (§7) has no backing table beyond inbox `client_id` → retried POSTs double-send mail or double-fire webhooks | `idempotency_keys` table | Decision 3.1, task 3 |
| R4 | DKIM private keys / webhook secrets stored plaintext — pod-wide forgery blast radius if DB is ever exposed (e.g. copied for debugging) | AES-GCM encryption at rest via `packages/core/crypto.ts` | Decision 3.2, tasks 3/24 |
| R5 | Jev API slow/unavailable stalls the classify queue, backing up inbound mail processing | Timeout + circuit breaker in `packages/jev`; `JEV_ENABLED=false` deterministic fallback already required by brief | Decision 4.4, tasks 14/15 |
| R6 | Testcontainers-backed integration tests make the inner dev loop slow across many parallel Herdr panes | `packages/core` is infra-free and unit-testable without containers (Decision 2.2); `test:unit`/`test:integration` split | §2, §5 |
| R7 | SMTP server becomes an inadvertent open/probe-able relay | Reject at `RCPT TO`, not after `DATA` | §5, task 6 |
| R8 | Multiple agents editing Drizzle migrations concurrently → colliding migration numbers/merge conflicts | Single-owner lane for schema changes per phase (task 3 owns Phase 0–3 schema; later schema changes go through the same reviewer) — an ownership convention, not a technical fix | AGENTS.md workflow section |
| R9 | Webhook retry schedule (1m/5m/30m/2h/12h) doesn't fit BullMQ's built-in exponential backoff, easy to implement wrong | Custom backoff function over a hardcoded delay array, tested directly | §5, task 11 |
| R10 | `apps/mcp`/`apps/dashboard` end up needing a DB shortcut that reveals the REST API is incomplete | SDK-only dependency boundary (Decision 2.4) forces this to surface as an API gap, not a workaround, during Phase 4 | Decision 2.4 |

---

## 9. Explicitly out of scope for this plan

Phases 4–5 (SDK/CLI/MCP, drafts, pods/scoped keys/rate limiting, custom domains + real DKIM verify, search/pgvector, dashboard, Python SDK, load test) are not planned in detail here beyond the package boundaries in §2, which are chosen so those phases don't require restructuring. They get their own planning pass when Phase 0–3 is closer to acceptance.
