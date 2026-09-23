# P5-25a — Full-Text Search (FTS half): Design

> Design-only deliverable for TASKS.md **P5-25a**. Owner: Claude. Does not implement app code — this is what P5-25b (Codex) implements against. Does **not** cover the pgvector/semantic-search half (that's P5-25c, deliberately sequenced after this ships — see `docs/phase5-plan.md` §1).
> Grounded in the actual repo state: `packages/db/src/schema.ts`'s `messages.search` column (already a **generated** `tsvector` column — `to_tsvector('english'::regconfig, coalesce(subject,'') || ' ' || coalesce(text,'') || ' ' || coalesce(extracted_text,''))`, line 173–175 — and `messages_search_gin_idx`, a GIN index on it, line 186) and `apps/api/src/messages.ts`'s existing cursor-pagination pattern (reused here, not reinvented). **No schema change, no migration** — this is the lowest-risk task in Phase 5.

## APPROVED — 2026-09-23

- [x] Route contract for `GET /v1/search`
- [x] Query-building approach: `plainto_tsquery` only, parameterized — never string-interpolated
- [x] Ranking (`ts_rank`) + stable rank-then-id pagination
- [x] Scope reuse: `messages:read` (no new scope)
- [x] `rank` field added to the reused `MessageSummary` response shape

Ready for Codex (P5-25b).

---

## 1. Route

### `GET /v1/search` — `searchMessages`
**Scope:** `messages:read` (reused — searching messages is a read of messages the key can already read; no new scope, per `docs/phase5-plan.md` §3.4's reasoning)

Query params:
```ts
{
  q: string;              // required, min length 1 after trim; empty/whitespace-only → 400 validation_error
  inbox_id?: string;      // optional — omit to search across every inbox the caller's key/pod can see
  limit?: number;         // same default/max as listMessages (reuse apps/api/src/pagination.ts's existing constants)
  page_token?: string;    // opaque cursor, same encoding scheme as every other list route
}
```
Response `200`:
```ts
{
  data: Array<MessageSummary & { rank: number }>;
  pagination: { next_page_token: string | null };
}
```
Reuses the existing `MessageSummary` schema as-is (already has `direction`/`from`/`to`/`received_at`/`created_at` per the Phase 4 gap-closure, per `STATUS.md`'s P4-18-api entry — confirmed present, not assumed) plus one additive field, `rank: number` (the raw `ts_rank` score — not normalized to 0–1; callers compare ranks relative to each other within one response, not across separate calls).

Pod scoping: every result is filtered to inboxes belonging to `request.podId`, exactly like every other list route already does (no new scoping mechanism). `inbox_id`, if provided, must belong to the caller's pod or the request 404s (`not_found`) — matches the existing cross-pod-isolation convention used throughout `apps/api`.

---

## 2. Query building: `plainto_tsquery` only, never raw interpolation

**Decision: the `q` param is always passed as a bound parameter into `plainto_tsquery('english', $1)`, never concatenated into a `to_tsquery`-style raw query string.**

Why this matters: `to_tsquery` accepts operator syntax (`&`, `|`, `!`, `<->`) directly in the string, so if a caller-controlled `q` were ever passed to `to_tsquery` (or worse, string-interpolated into SQL rather than bound), malformed or adversarial input (`q=foo & (bar`) would throw a Postgres syntax error rather than degrading gracefully, and — if ever string-interpolated instead of parameterized — would be a straightforward SQL-injection vector. `plainto_tsquery` treats its input as plain text (splits on whitespace, strips punctuation-as-operators, applies `AND` between resulting lexemes) and **never errors on operator-shaped input** — `q=foo & bar` becomes a query for documents containing both "foo" and "bar" as ordinary words, not a malformed boolean expression. Concretely, the query (via whatever query-builder/ORM helper `apps/api` already uses for parameterized SQL, matching the existing pattern in `apps/api/src/messages.ts`'s `after`/`before` timestamp handling per its `::timestamptz`-cast-from-ISO-string fix noted in STATUS.md's P4-18-api entry — i.e. bind the raw string, let Postgres/Drizzle handle the cast, don't hand-build the SQL string):

```sql
SELECT *, ts_rank(search, plainto_tsquery('english', $1)) AS rank
FROM messages
WHERE inbox_id = ANY($2)                         -- pod-scoped inbox id list, or a single inbox_id filter
  AND search @@ plainto_tsquery('english', $1)
ORDER BY rank DESC, id DESC                        -- see §3 for why id, not another column
LIMIT $3
```

`q` is bound as `$1` (a plain string parameter), never concatenated. If `plainto_tsquery('english', $1)` reduces to an empty tsquery (e.g. `q` is entirely stopwords, like `q=the`), the `@@` match returns zero rows rather than erroring — that's correct, expected behavior (no crash, just an empty result set) and needs no special-cased handling in the route.

---

## 3. Ranking + stable pagination

**Problem this section resolves:** naive `ORDER BY rank DESC` pagination breaks when two rows tie on `rank` (common with short queries/short documents) — a page boundary landing mid-tie can skip or duplicate a row across pages, exactly the class of bug `apps/api/src/messages.ts`'s existing pagination test already guards against for `listMessages` (per STATUS.md's P1-9 entry: "timestamp ties use the message/thread ID as a deterministic cursor tie-breaker").

**Decision: `ORDER BY rank DESC, id DESC`**, with the opaque cursor encoding both `rank` and `id` of the last row on the current page (same opaque-cursor *mechanism* `apps/api/src/pagination.ts` already implements for other routes — extend its cursor payload shape to carry a `(rank, id)` pair instead of the single timestamp/id pairs it currently carries, rather than inventing a second cursor format). The next page's query becomes:

```sql
... WHERE (rank, id) < ($cursor_rank, $cursor_id)   -- row-wise comparison, ties broken by id
ORDER BY rank DESC, id DESC
LIMIT $3
```

This guarantees every row appears exactly once across a full pagination sweep regardless of how many rows share the same `rank`, using the same tie-breaking principle (a stable secondary sort key on `id`) this repo already applies elsewhere — not a new pagination concept, just the existing one applied to a new sort column.

---

## 4. Non-goals for this design (explicitly out of scope)

- **No query syntax beyond plain-text AND-of-terms** (no explicit `OR`/phrase-quoting/exclusion operators exposed to callers) — `plainto_tsquery` doesn't support those, and adding them would mean switching to `websearch_to_tsquery` (Postgres 11+, supports `"phrase"`, `-exclude`, `OR`) or `to_tsquery` with sanitization. **Recommendation for a future iteration, not this task:** `websearch_to_tsquery` is the more caller-friendly choice if richer query syntax is ever wanted (it's designed exactly for taking raw user search-box input safely — still parameterized, still no crash on malformed input) — flagged here as a natural upgrade path, not built now, to keep P5-25b's scope matched to what `docs/phase5-plan.md`'s MVP cut actually needs.
- **No relevance tuning beyond Postgres's default `ts_rank`** (no field-weighting like "subject matches count more than body matches," no `ts_rank_cd`, no BM25-style scoring) — the `search` column's generation expression already concatenates `subject`/`text`/`extracted_text` with equal weight (`packages/db/src/schema.ts:174`); changing that weighting would require altering the generated-column expression (a migration) and is out of scope for a route-only task.
- **No semantic/synonym matching** — that's the entire point of P5-25c/d (pgvector), deliberately not this task.

---

## 5. Test coverage this design implies (for P5-25b, informational — not the DoD itself, see TASKS.md)

- Unit: query-building against adversarial/operator-shaped input (`q=foo & (bar`, `q=foo | bar`, `q=the` (all-stopwords), empty/whitespace `q` → `400`) proving no SQL error and no injection; cursor encode/decode round-trip for the `(rank, id)` pair.
- Integration (real Postgres): insert two messages with identical `rank` for a given query, confirm pagination across a `limit=1` sweep returns both exactly once, in a stable order; confirm the existing `01-billing-complaint.eml` fixture (already used by Phase 1–3 tests, live-confirmed subject "I was charged twice!" / body mentions "refund ASAP" per agentmail.md §9) ranks for `q=refund`.
- Live smoke: `q=refund` against the seeded fixture set, confirm the billing-complaint message appears and outranks unrelated fixtures (e.g. the OTP/newsletter fixtures).
