# P5-23a — Pods + Scoped API Keys + Rate Limiting: Design

> Design-only deliverable for TASKS.md **P5-23a**. Owner: Claude. Does not implement app code — this is what P5-23b (Codex) implements against.
> Grounded in the actual repo state: `packages/db/src/schema.ts`'s `pods`/`api_keys` tables (already exist — `api_keys.scopes text[]` already enforced by `requireScope()`), `apps/api/src/auth.ts` (the exact scope-check line: `scopes.includes('*') || scopes.includes(requiredScope)` — read directly, not paraphrased), `packages/db/src/seed.ts` (the only place today that creates a pod or a key — `scopes: ['*']`, scrypt-hashed per `docs/api-contract-phase1.md`'s scrypt-not-argon2 deviation), `apps/api/src/errors.ts` (`rate_limited` is already a defined, unused `ApiErrorCode`), and `apps/api/src/webhooks.ts` (the "show secret once on create, never again" pattern reused here for API keys). Resolves `docs/phase5-plan.md` §7 Q1/Q2.

## APPROVED — 2026-09-23

- [x] Route contracts for pods and API keys
- [x] Two new scopes: `api_keys:read`, `api_keys:write`
- [x] Q1 — pod-creation authorization: exact-`*`-scope requirement, documented below
- [x] Q2 — rate-limit scope: both per-key (primary) and per-pod (secondary ceiling)
- [x] Redis key scheme, env vars, `429` response shape

Ready for Codex (P5-23b).

---

## 1. Q1 — Pod creation authorization

**Decision: `POST /v1/pods` requires the caller's key to have the **exact** string `'*'` in its `scopes` array — not "every individual scope," and not a new named scope.**

Why exact `'*'`, not a new `pods:write` scope: introducing a `pods:write` scope that could itself be granted via `POST /v1/api-keys` would let any `*`-scoped key mint a new key with `pods:write`, and that new key could then create pods — which just relocates the privilege boundary without actually restricting it (whoever could create the `pods:write` key could already do everything `*` does). Reusing the existing `'*'` sentinel keeps pod creation gated on literally the same privilege level as the seed-created admin key, with no new scope string to reason about being under- or over-granted.

**Concretely:**
- `requireScope('*')` — a new, stricter check distinct from the existing `requireScope(x)` (which already treats `'*'` as satisfying *any* required scope). Implementation note for P5-23b: `apps/api/src/auth.ts`'s existing `requireScope` (line 56–57: `scopes.includes('*') || scopes.includes(requiredScope)`) cannot be reused as-is for this — calling `requireScope('*')` under that logic would make `scopes.includes('*')` and `scopes.includes('*')` the same check (fine, that part works), but the intent must be documented as "literally requires the `*` sentinel," not "requires a scope named `*`" (they're the same check, but the *meaning* — "full admin," not "a scope happens to be named asterisk" — is what P5-23b's route guard comment should say, so a future reader doesn't confuse it with a normal named scope).
- `POST /v1/api-keys` (`createApiKey`, §2) **must refuse to grant `'*'`** to any newly created key. If the request body's `scopes` includes `'*'`, reject with `400 validation_error` ("Cannot grant the `*` scope via this endpoint; only the initial seed key holds it."). This is the actual enforcement point that keeps `'*'` from silently propagating — without it, any `*`-scoped key could mint another `*`-scoped key and the "only the seed key is admin" property would erode over time.
- There is deliberately **no route to grant `'*'` to an existing key** (no "promote to admin" endpoint) in this design. If a second admin-level key is ever genuinely needed, that's a manual DB operation (or a future task), not an API surface — keeps the admin boundary auditable and matches this repo's existing "generated locally on first seed" posture for high-privilege secrets (AGENTS.md §4).

**New pod's key:** `createPod`'s response includes a freshly generated API key for the new pod with `scopes: ['*']` (that pod's own admin key — mirrors exactly what the seed script does for the local-dev pod), returned **once**, same "show once" convention as webhook secrets (`apps/api/src/webhooks.ts`) and as `createApiKey` (§2) below. This is necessary — without it, a newly created pod would have zero usable keys and no way to bootstrap itself except by going back to the original `*`-scoped caller for every single key, which defeats the point of pod isolation.

---

## 2. Routes

### `POST /v1/pods` — `createPod`
**Scope:** exact `'*'` (§1) · **Idempotency-Key:** honored

Body: `{ name: string }`. Response `201`:
```ts
{
  pod: { id: string; name: string; created_at: string };
  admin_api_key: string;   // shown once, never retrievable again
}
```

### `GET /v1/pods/:pod_id` — `getPod`
**Scope:** any key belonging to that pod (i.e. `request.podId === pod_id`, the existing per-request pod-scoping every other route already relies on — not a new mechanism). `404 not_found` for a different pod's id (never `403` — matches every existing cross-pod route behavior in this repo).

Response: `{ id, name, created_at }` — no key material, no key list (that's `listApiKeys`, §2 below).

### `POST /v1/api-keys` — `createApiKey`
**Scope:** `api_keys:write` (new) · **Idempotency-Key:** honored

Body:
```ts
{ scopes: string[] }   // must be non-empty, must not contain '*' (see §1)
```
Response `201`:
```ts
{
  id: string;
  prefix: string;
  scopes: string[];
  api_key: string;      // shown once
  created_at: string;
}
```
Always creates the key **in the caller's own pod** (`request.podId`) — there is no cross-pod key creation, ever; a key can only ever mint keys for its own pod. Validation errors (`400 validation_error`): empty `scopes` array, `scopes` containing `'*'`, or `scopes` containing a string that isn't one of the known scope names (reject unknown scopes at creation time rather than silently accepting a typo'd scope that will never match any `requireScope` check — cheap to catch here, confusing to debug later).

### `GET /v1/api-keys` — `listApiKeys`
**Scope:** `api_keys:read` (new)

Lists keys in the caller's pod only. Response fields per key: `id`, `prefix`, `scopes`, `last_used_at`, `revoked_at`, `created_at`. **Never** `hash`, **never** the raw key (matches `apps/api/src/webhooks.ts`'s existing "secret omitted from GET" pattern exactly). Standard cursor pagination.

### `DELETE /v1/api-keys/:id` — `revokeApiKey`
**Scope:** `api_keys:write`

Sets `revoked_at = now()` (matches the column that already exists and is already checked at auth time — `apps/api/src/auth.ts`'s `row.revokedAt` check). `204` on success. `404 not_found` for a different pod's key id, or a key id that doesn't exist. **A key cannot revoke itself if it would leave the pod with zero non-revoked keys** — reject with `400 validation_error` ("Cannot revoke the last active key for this pod.") if the revoke would do so; otherwise a pod could be permanently locked out via a single API call with no recovery path short of a manual DB fix. (This check does *not* apply to `'*'`-scoped keys specially — it's a blanket "don't let a pod delete its own last door" rule regardless of scope.)

---

## 3. Scopes

| Scope | Grants |
|---|---|
| `api_keys:read` | `GET /v1/api-keys` |
| `api_keys:write` | `POST /v1/api-keys`, `DELETE /v1/api-keys/:id` |
| exact `'*'` (existing sentinel, not a new named scope) | `POST /v1/pods`, plus everything else per the existing "`*` satisfies any `requireScope`" behavior |

---

## 4. Q2 — Rate limiting: both per-key and per-pod

**Decision: a per-key token bucket is the primary limit; a looser per-pod token bucket is a secondary ceiling checked in the same request.** Both live in Redis (already a Phase 2 dependency — no new infra).

**Why both, not one:** a per-key-only limit lets a caller trivially bypass the limit by minting more scoped keys (cheap — `createApiKey` has no cap of its own in this design, see open note below) and spreading load across them; a per-pod-only limit lets one noisy key inside a pod starve every other key in that same pod (e.g. one example script hammering `messages:send` blocks a completely unrelated dashboard session using a different key in the same pod). Checking both closes both gaps with one extra Redis round-trip per request — a cheap tradeoff for a local-first tool.

### Algorithm
Token bucket, checked in `apps/api`'s request pipeline as a `preHandler` (same hook style `apps/api/src/auth.ts` already uses), **after** auth (so we know `apiKeyRow.id` and `podId`) and **before** the route handler runs:

1. Check the per-pod bucket first (cheaper to fail fast on the coarser limit — no reason to also touch the per-key bucket if the pod-wide ceiling is already exhausted).
2. If the pod bucket has capacity, check the per-key bucket.
3. Both must have capacity for the request to proceed; both are decremented by 1 token on a request that proceeds (decrement happens once both checks pass — do not decrement the pod bucket and then discover the key bucket is empty, which would waste pod-wide capacity on a request that gets rejected anyway).
4. Either bucket empty → `429`, `ApiErrorCode: 'rate_limited'` (already defined in `apps/api/src/errors.ts`, currently unused — this is its first use), `Retry-After` header set to the bucket's refill interval in seconds (rounded up).

### Redis key scheme
```
ratelimit:key:<api_key_id>    — token bucket state for the per-key limit
ratelimit:pod:<pod_id>        — token bucket state for the per-pod limit
```
Implementation detail left to P5-23b (a Lua script for atomic check-and-decrement is the standard token-bucket-in-Redis pattern and avoids a race between check and decrement across concurrent requests on the same key — flagging this as the expected approach, not mandating a specific library).

### Env vars / defaults
```
RATE_LIMIT_RPS=10           # per-key sustained rate
RATE_LIMIT_BURST=20         # per-key bucket capacity
RATE_LIMIT_POD_RPS=50       # per-pod sustained rate (secondary ceiling)
RATE_LIMIT_POD_BURST=100    # per-pod bucket capacity
```
These are starting defaults for a local-first, single-developer-machine tool — generous enough not to interfere with normal agent usage (Phase 4's examples/CLI/MCP tools) while still bounding a runaway loop (e.g. the `agent-to-agent` example's own `--runaway` mode, which Phase 4 already tests hits the *hop-count* guard at 19/20 — rate limiting is a second, independent backstop, not a replacement for that guard). Not applied to `/healthz` or (once P5-28 lands) `/metrics` — matches those routes' existing unauthenticated, low-cost nature.

### Scope of enforcement
Applied to every `/v1/*` route uniformly (same blanket `onRequest`/`preHandler` scope `apps/api/src/auth.ts`'s auth plugin already uses for `/v1/` — `if (!request.url.startsWith('/v1/')) return;`). No per-route override in this design; if a specific route genuinely needs a different limit later, that's an additive follow-up, not something P5-23b needs to build a general per-route-override mechanism for now (avoid over-engineering ahead of an actual need, consistent with this repo's existing conventions — see PLAN.md §5's Redis pub/sub note for the same "don't build for a need that doesn't exist yet" instinct).

**Open note for whoever implements `createApiKey` (not blocking P5-23b, but worth flagging):** this design does not cap the *number* of keys a pod can create. If unbounded key creation turns out to be a practical concern (e.g. as a way to work around per-key rate limits by fanning out across many keys, despite the per-pod ceiling in §4 already bounding the aggregate), that's a follow-up design note, not something to solve speculatively here.

---

## 5. Test coverage this design implies (for P5-23b, informational — not the DoD itself, see TASKS.md)

- Unit: token-bucket math (burst consumption, refill-over-time, exactly-at-limit boundary, per-key vs. per-pod ordering per §4 step 1–3); `createApiKey` rejecting `'*'` and unknown scope names; `revokeApiKey` rejecting a pod's last active key.
- Integration (Testcontainers, real Redis): a scoped key with only `messages:send` gets `403 insufficient_scope` on `GET /v1/inboxes`; a key with `'*'` can call `createPod`; a key without exact `'*'` (even one with every other named scope) gets `403` on `createPod` — this specific case (many named scopes but not `'*'`) is the one most worth a dedicated test, since it's the exact confusion §1 calls out; exceeding `RATE_LIMIT_RPS` on one key yields `429` while a second key in the same pod still succeeds (proving per-key isolation) until the pod ceiling is also exceeded.
- Live smoke: create a second pod via a `*`-scoped key, receive its admin key once, create a `messages:send`-only key in that new pod, send a message with it, confirm it's `403` on an out-of-scope route.
