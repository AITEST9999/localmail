# P5-25c — Semantic Search (pgvector half): Design

> Design-only deliverable for TASKS.md **P5-25c**. Owner: Claude. Does not implement app code, does not write a migration — this is what P5-25d (Codex, sole migration author per AGENTS.md §5) implements against. Sequenced after P5-25b (FTS, already DONE per STATUS.md) — semantic search is additive on top of FTS, not a replacement (`docs/phase5-plan.md` §1).
> Grounded in the actual repo state: `packages/db/src/schema.ts` (no `pgvector`/`vector` column exists yet — confirmed by reading the schema file directly, only the `messages.search` tsvector column from P5-25b), `apps/workers/src/runtime.ts` (the real BullMQ queue list — `['jev-classify', 'webhook-deliver', 'scheduled-send', 'ws-broadcast']`, read directly, not assumed — plus `classify.ts`'s existing worker shape, reused as the template for the new embedding worker), `docker-compose.yml` (the four existing services — postgres, redis, minio, mailpit — read directly to match its exact healthcheck/restart-policy conventions for any new optional service), and `docs/phase5-search-fts.md` (P5-25a/b's approved FTS contract, whose route/scope/pagination conventions this design extends rather than duplicates). Resolves `docs/phase5-plan.md` §7 Q7.

## APPROVED — 2026-09-23

- [x] Q7 — embedding model, dimension, inference location: local ONNX model in `apps/workers`, no external service dependency by default (Ollama is optional, not required)
- [x] Migration plan: `vector` extension + `messages.embedding` column, `hnsw` index
- [x] API shape: `mode=semantic` param on the existing `GET /v1/search` (not a separate endpoint)
- [x] Embedding generation: enqueued on `message.received` alongside `jev-classify`, plus a backfill job for pre-existing rows
- [x] Explicit latency budget

Ready for Codex (P5-25d) — but P5-25d must not start until P5-25b (already done) has been in real use, per the phase-order rationale in `docs/phase5-plan.md` §1 (already satisfied — FTS is DONE per STATUS.md).

---

## 1. Q7 — Embedding model, dimension, inference location

**Decision: run inference locally inside `apps/workers`, using a small ONNX sentence-embedding model bundled/downloaded once at build/setup time — not a hosted embeddings API, and not a *required* Ollama dependency.**

### Why not a hosted API
agentmail.md §1 frames this whole project as "100% local... no real domain or DNS required," and §2.9 specifically says "optional semantic search (pgvector + local embeddings)" — "local" is already the brief's own word, not an inference of this design. Calling out to a hosted embeddings API (OpenAI, Cohere, etc.) would be the one place in the entire stack that silently requires real internet access and a second API key, breaking that framing for a feature explicitly labeled "local" in the source brief. Ruled out.

### Why local ONNX, not a required Ollama service
Two credible local options exist: (a) an in-process embedding model run directly inside the Node.js `apps/workers` process (via `@xenova/transformers` / `onnxruntime-node` — pure-npm, no separate service, no Docker Compose entry needed), or (b) a separate Ollama service (per `docker-compose.yml`'s existing pattern) that `apps/workers` calls over HTTP. **Decision: (a) is the default; (b) is documented as an optional, swappable backend, not built as a required dependency in this pass.**

Rationale: adding a fifth `docker-compose.yml` service is a real increase in this project's "one command to start everything" cost (agentmail.md §9's `docker compose up -d && pnpm dev` acceptance bar) for a *stretch* feature (`docs/phase5-plan.md` explicitly scopes pgvector as stretch, sequenced after the MVP). An in-process ONNX model needs no new service, no new port, no new healthcheck — it's a `pnpm install`-time dependency exactly like every other npm package `apps/workers` already has. Ollama remains a reasonable **alternative backend** for someone who already runs it and wants a larger/different model, but this design does not make the base `docker compose up -d` flow depend on it — see §5 for exactly how that optionality is expressed in code, not just in this doc.

### Model and dimension
**`Xenova/all-MiniLM-L6-v2`** (a widely-used, small — ~23M parameter, ~90MB — sentence-transformers model, ONNX-exported for `@xenova/transformers`), **384-dimensional** output vectors. Chosen for: it's the single most common "default" local embedding model in the current ecosystem (meaning good tooling support and lots of prior art to debug against, lowering implementation risk for P5-25d), small enough to download once and run comfortably on CPU with no GPU requirement (important — this is meant to run on a developer's laptop via `pnpm dev`, not a GPU box), and 384 dimensions keeps the `pgvector` index (§2) small and the `hnsw`/`ivfflat` build cheap relative to a 1536-dim model. If a future need justifies a larger/more accurate model, the dimension is a migration-level decision (the `vector(384)` column's width is fixed at creation) — not something P5-25d should treat as freely swappable later without a new migration.

### Where inference runs
Inside `apps/workers`, as a new BullMQ worker on a new queue `embed-message` (added to the existing queue list in `apps/workers/src/runtime.ts`, which today reads `['jev-classify', 'webhook-deliver', 'scheduled-send', 'ws-broadcast']` — confirmed by reading that file directly), following the exact same shape `classify.ts`'s `jev-classify` worker already establishes (job payload `{ messageId: string }`, load the message, do the work, write the result, no cross-worker shared state). The model is loaded once per worker process (module-level singleton, lazy-initialized on first job — not per-job), matching how a real embedding pipeline should behave and avoiding a multi-hundred-millisecond model-load cost on every single message.

---

## 2. Migration plan (for P5-25d to implement — not implemented here)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE messages ADD COLUMN embedding vector(384);

CREATE INDEX messages_embedding_hnsw_idx ON messages
  USING hnsw (embedding vector_cosine_ops);
```

**Column placement: on `messages` directly, not a separate table.** A separate `message_embeddings` table was considered — it would keep the (relatively heavy, nullable-until-computed) vector data physically apart from the frequently-read `messages` row — but `messages.search` (P5-25b's tsvector column) already lives directly on `messages` with no separate table, and consistency with that precedent (both are "derived, async-computed search-support columns on the same row") outweighs the marginal storage-locality benefit of splitting it out. `embedding` is nullable (no `NOT NULL`) — a message with no embedding yet (not-classified, or the backfill hasn't reached it) is a normal, expected state, not an error state (mirrors `jev_decisions` similarly having no row for a `skip_classify` message).

**Index type: `hnsw`, not `ivfflat`.** `pgvector` supports both approximate-nearest-neighbor index types. `ivfflat` requires choosing a `lists` parameter tuned to the expected row count *at index-build time* and degrades if the table grows well past that estimate without a rebuild; `hnsw` has no such build-time-row-count tuning parameter, builds incrementally as rows are inserted (no bulk "reindex after every N inserts" operational burden), and has become the generally-recommended default for `pgvector` for exactly this "don't want to think about tuning" reason. For a local-first tool with an unpredictable, developer-driven message count, `hnsw`'s "no cardinality guess required" property matters more than `ivfflat`'s marginally faster build time at large N. `vector_cosine_ops` (cosine similarity) is the standard distance function for sentence-embedding models including `all-MiniLM-L6-v2`, which is trained/normalized for cosine similarity specifically — not an arbitrary choice.

**Sole migration author:** per AGENTS.md §5 and this task's own dependency line in TASKS.md, whoever implements P5-25d owns this migration exclusively — no other pane should be generating a Drizzle migration concurrently while this one is in flight.

---

## 3. API shape: `mode=semantic` on the existing `GET /v1/search`

**Decision: extend the existing `GET /v1/search` route (P5-25a/b, already implemented) with an optional `mode` query param, rather than adding a second, separate search endpoint.**

```
GET /v1/search?q=...&mode=fts|semantic&inbox_id=...&limit=...&page_token=...
```

- `mode` omitted or `mode=fts` → **exactly today's behavior**, unchanged (`plainto_tsquery`/`ts_rank`, per `docs/phase5-search-fts.md`). This is a strictly additive, backward-compatible change — no existing caller's behavior changes.
- `mode=semantic` → `q` is embedded (using the same model as §1, run inline in the API request path — see latency note in §5) into a 384-dim query vector, then matched against `messages.embedding` via `pgvector`'s `<=>` cosine-distance operator: `ORDER BY embedding <=> $query_vector LIMIT ...`. Rows with `embedding IS NULL` (not yet backfilled/classified) are implicitly excluded (a `NULL <=> vector` comparison doesn't match, no explicit `WHERE embedding IS NOT NULL` needed but harmless to add for clarity).

**Why one endpoint with a mode switch, not two endpoints:** both modes answer the same conceptual question ("find messages matching this text") over the same resource (`messages`), take the same `inbox_id`/pagination params, and return the same base shape — the only real difference is the ranking mechanism and what the rank number means. Two endpoints would mean duplicating every pagination/scoping/auth concern P5-25a already designed once. A single endpoint with a `mode` switch is also the shape that makes "semantic is additive to FTS, not a replacement" (`docs/phase5-plan.md` §1) literally true in the API surface, not just true in the roadmap narrative.

**Response shape — `rank` field's meaning changes with `mode`, documented explicitly rather than left implicit:**
```ts
{
  data: Array<MessageSummary & { rank: number; mode: 'fts' | 'semantic' }>;
  pagination: { next_page_token: string | null };
}
```
`mode=fts` → `rank` is `ts_rank`'s score (as today, unbounded, compare-within-one-response only, per `docs/phase5-search-fts.md` §1). `mode=semantic` → `rank` is `1 - cosine_distance` (so higher is still "more relevant," matching the FTS convention of higher-is-better rather than flipping sign conventions between modes, which would be a confusing inconsistency for any caller handling both modes generically). The **`mode` field is added to every result row** specifically so a caller mixing result sets (or just logging results) doesn't have to separately remember which query produced which rows — a small addition, cheap to include, avoids a real confusion.

**No combined "hybrid" ranking (RRF/weighted-merge of both modes) in this design** — see §6 non-goals. `mode` is a switch, not a blend, for this first pass.

**Scope: reuses `messages:read`**, same as `mode=fts` today — no new scope for semantic mode; it's still "reading messages," just ranked differently.

**Pagination cursor:** the existing `(rank, id)` cursor shape from `docs/phase5-search-fts.md` §3 generalizes directly — `rank` there was `ts_rank`'s float; here it's `1 - cosine_distance`'s float. Same tie-breaking-by-`id` mechanism, same opaque encoding, **must also encode which `mode` produced the cursor** (a `mode=fts` cursor fed into a `mode=semantic` request, or vice versa, should `400 validation_error` rather than silently compare incompatible rank scales — this is the one genuinely new pagination-safety rule this design adds on top of P5-25a's existing cursor mechanism, and P5-25d must implement it, not skip it as an edge case).

---

## 4. Embedding generation: on-ingest enqueue + backfill

**On ingest (steady state):** the existing inbound-ingest path already enqueues `jev-classify` on `message.received` (per STATUS.md's P3-14b entry: `packages/events`' `emit()` enqueues on `message.received` only, skipping `skip_classify`). This design adds a second, independent enqueue of `embed-message` (§1) at the **same** trigger point (`message.received`), **not** chained after `jev-classify` completes — the two are unrelated computations (text embedding vs. Jev's label classification) and should not serialize behind each other; running them as sibling jobs off the same event, not a pipeline, keeps them independently retryable and keeps a slow/failed classify from blocking search indexing or vice versa. `embed-message`'s job payload is just `{ messageId }`, same shape as `jev-classify`'s. Unlike `jev-classify`, `embed-message` has **no `skip_classify`/allow-block interaction** — embedding is purely a search-indexing concern, not a triage decision, so even a `sender_rules`-blocked-and-stored-as-spam message still gets embedded (it should still be findable by search; spam filtering and search indexing are different concerns and this design keeps them decoupled rather than silently coupling them by reusing `skip_classify`'s gate).

**Backfill (one-time, for messages that existed before this migration lands):** a standalone script (not a BullMQ worker — this only needs to run once, at deploy/upgrade time, not as steady-state infrastructure) that pages through `messages WHERE embedding IS NULL ORDER BY id` in batches (e.g. 100 at a time), computes embeddings, and updates rows — same batching-cap instinct `docs/phase5-drafts.md` §4's poller already uses for its own claim query, applied here to avoid one giant unbounded query against a potentially large table. This script is P5-25d's responsibility to write (e.g. `apps/workers/src/backfill-embeddings.ts`, run manually via `pnpm --filter @localmail/workers backfill:embeddings`, not auto-run on every worker boot — an explicit, deliberate operation, not something that silently kicks off and competes with live traffic).

**Failure handling:** if embedding a specific message fails (model error, unexpected content), the job fails and BullMQ's normal retry/failure bookkeeping applies (same posture `jev-classify` already has, per its own circuit-breaker/timeout design in `docs/jev-classify-phase3.md`, referenced but not re-specified here) — a message simply stays `embedding IS NULL` and is excluded from semantic search results (§3) until it succeeds, exactly the same graceful-degradation shape `jev_decisions` already has for messages with no Jev decision.

---

## 5. Latency budget

**Explicit budget, since this is the one place local ONNX inference could silently become a UX problem if unbounded:**

- **Ingest-time embedding (async, off the request path):** no hard deadline — it happens in a BullMQ worker after `message.received` has already fanned out to webhooks/WS, exactly like `jev-classify` today. A target of **under 500ms per message** on typical developer hardware (CPU-only, `all-MiniLM-L6-v2` is well within this range for short email-length text — this is an expectation to validate empirically in P5-25d, not a hard-verified number in this design pass, since no code was run to measure it here) is reasonable but not a blocking correctness requirement, since nothing downstream waits synchronously on it.
- **Query-time embedding (`mode=semantic` request path, synchronous):** **this one is on the request's critical path** and needs a real budget. Target: **under 200ms added latency** for embedding the query string itself (a single short string, much cheaper than the ingest-time batch-of-message-bodies case) on top of the existing `GET /v1/search` request. If this budget is missed in practice during P5-25d's implementation, the fallback is **not** to silently degrade `mode=semantic` — surface it as a real finding (e.g. "query-time inference is too slow for the request path on this hardware, consider a warm/pre-loaded model instance or a persistent embedding micro-service") rather than have this design's implementer quietly accept a multi-second `mode=semantic` response. The module-level lazy-singleton model load (§1) matters specifically here: after the first request in a worker/API process's lifetime, subsequent query embeddings should not pay any model-load cost, only actual inference cost.
- **Where query-time embedding runs:** in `apps/api` (the request-handling process), not by round-tripping to `apps/workers` over a queue (a queue round-trip would add its own latency and complexity for a synchronous request-response need) — this means `apps/api` also needs the ONNX inference capability available in-process for this one path, a real architectural note for P5-25d: either duplicate the small model-loading utility into a shared location both `apps/api` and `apps/workers` can import (candidate: a new `packages/embeddings` package, mirroring how `packages/jev` was split out in PLAN.md Decision 2.3 for a similar "shared capability used by more than one app" reason), or accept the dependency-boundary cost of `apps/api` depending directly on the same npm package `apps/workers` uses. **Recommend a new `packages/embeddings` package** — matches this repo's own established precedent (Decision 2.3's reasoning: shared, swappable-backend capability behind one package boundary, not duplicated or reached into across app boundaries) rather than inventing a new pattern for this one case.

---

## 6. Non-goals for this design (explicitly out of scope)

- **No hybrid/blended ranking (RRF or weighted merge) of FTS and semantic results** — `mode` is a switch between two independent ranking strategies, not a combined score, in this first pass (§3). A hybrid mode is a natural future enhancement once both modes are independently proven, not part of this design.
- **No required external service (Ollama or otherwise)** — the base `docker compose up -d && pnpm dev` flow (agentmail.md §9) must keep working with zero new services; Ollama-as-swappable-backend is a documented option, not a default dependency (§1).
- **No embedding of attachments, HTML content, or anything beyond the same `subject`/`text`/`extracted_text` fields `messages.search`'s tsvector already concatenates** — keeps the two search modes indexing the same conceptual content, which also makes "the same query behaves differently across modes because of what text was searched" a false concern to worry about.
- **No re-embedding on message edit** — messages in this schema are effectively immutable after ingest/send (no `updateMessage` route touches body content, only labels), so there's no "stale embedding" problem to design around.
- **No cross-message-language handling beyond whatever `all-MiniLM-L6-v2`'s own (primarily English-trained, per its model card) behavior naturally provides** — consistent with `messages.search`'s own `to_tsvector('english', ...)` choice (P5-25b) already assuming English content; not a new limitation introduced by this design, just an existing one carried forward consistently.

---

## 7. Test coverage this design implies (for P5-25d, informational — not the DoD itself, see TASKS.md)

- Unit: embedding-vector shape/dimension assertion (always exactly 384 floats); the `mode`-mismatched-cursor rejection (§3); the backfill script's batching (a synthetic 250-row fixture processes in 3 batches of 100/100/50, not one giant query).
- Integration (real Postgres with `pgvector` enabled via Testcontainers): a semantically-related-but-keyword-dissimilar query (e.g. `q=money back` against the existing billing-complaint fixture whose actual text is "I was charged twice!... refund ASAP," per agentmail.md §9 — no literal "money back" string present) returns that message via `mode=semantic` but does **not** necessarily rank it via `mode=fts` — this is the one test that actually proves semantic search is doing something FTS can't, and should be written as a real assertion, not a smoke check; `embedding IS NULL` rows are correctly excluded from `mode=semantic` results.
- Live smoke: ingest a fixture, confirm `embed-message` populates `messages.embedding` within the async budget (§5); run the money-back-style query live and confirm the semantic result; measure actual query-time embedding latency against the 200ms budget (§5) and record the real number in STATUS.md rather than this design doc's estimate.
