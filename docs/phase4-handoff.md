# Phase 4 handoff — 2026-09-23

Phase 4 (agentmail.md §10 tasks 18–21) is **complete**. Full task-by-task
evidence is in `TASKS.md`'s Phase 4 section (source of truth) and
`STATUS.md`. This file is a short pointer for whoever/whatever picks up next.

## What shipped this session (P4-20 → P4-19 → P4-21)

| Task | What | Evidence |
|---|---|---|
| P4-20 | `apps/mcp` — stdio MCP server, 7 tools | 14/14 hermetic tests, live stdio smoke against the real stack |
| P4-19 | `packages/cli` — bin `localmail` | 20/20 hermetic tests, live smoke of every command |
| P4-21 | `examples/{auto-reply-agent,otp-signup-agent,agent-to-agent}` | 27 hermetic tests, all live smokes passed |

`pnpm check` (typecheck + lint + test) is green across all 51 workspace
tasks in the monorepo.

## One thing intentionally not done

**P4-20's live Claude Code registration** (`claude mcp add localmail ...`)
was **not run** — it edits the user's `~/.claude.json`, and the router-phase
instructions for this session said not to deploy/publish anything without
asking first. The command is in `docs/phase4-plan.md` §6.3. The MCP server
itself is fully built, tested, and live-verified by other means (a
standalone script using the MCP SDK's own `StdioClientTransport` to spawn
`apps/mcp/dist/index.js` and drive all 7 tools against the running stack —
see TASKS.md's P4-20 row for the exact sequence). Ask the user, then run the
`claude mcp add` command from §6.3 if they say yes.

## Two real bugs found and fixed along the way

1. **`packages/sdk/src/wait-for-email.ts`** (part of the already-"DONE"
   P4-18): its WS event handler read `event.data.id`, but the server
   (`packages/events/src/publisher.ts`) only ever sends
   `event.data.message_id`. This silently broke `waitForEmail`'s real-time
   WS-push path — it always fell back to the 5s reconcile poll instead.
   Found while wiring up the CLI's `tail` command (which has the same bug,
   also fixed) and confirmed by reading the publisher source directly, not
   guessed. Fixed in the implementation and its two hermetic test fixtures
   (which had fabricated `data: { id: ... }`, matching the bug rather than
   the real envelope). Re-verified live: `waitForEmail` now resolves in
   ~200–560ms via WS instead of ~4.4s via polling.
2. **`examples/agent-to-agent`**, live on first run: the negotiation
   captured `since = new Date()` *after* each `send`/`reply` instead of
   before. Pure loopback delivery is synchronous with the HTTP response, so
   the message was already persisted with an earlier `received_at`, and
   `waitForEmail`'s catch-up never found it. Fixed by capturing `since`
   immediately before each send (matching the pattern the OTP example's
   README already documents). A separate regex bug in the same example
   (`/I can do (\S+)/` capturing a trailing period) was caught by the
   hermetic test before any live run.

## Phase 5 candidates (agentmail.md §10, tasks 22–28)

Not started, no design docs written yet. In the brief's order:

22. Drafts + scheduled send
23. Pods + scoped API keys + rate limiting — note: every Phase 4
    surface (SDK/CLI/MCP/examples) currently runs on the admin key
    (`*` scope) per an accepted limitation (plan §2.3 G11). Scoped keys
    would let each example/tool request only the scopes it needs.
24. Custom domains (mock DNS verify, DKIM signing)
25. Full-text search; then pgvector semantic search
26. Next.js dashboard (inboxes, thread viewer, webhook log, Jev decisions) —
    `apps/dashboard` already exists as a scaffold
27. Python SDK
28. Metrics + structured logging + load test (k6: 1,000 inboxes, 10k messages)

Per AGENTS.md's convention, a design task (`*a`, Claude-owned) should
precede implementation for anything touching the API surface, schema, or a
new cross-cutting concern (23's rate limiting, 24's DKIM) before an
implementation task starts.

## Runtime state as of this handoff

Docker Compose (postgres/redis/minio/mailpit) up. API (`:8080`), SMTP
(`:2525`), and workers all running with `JEV_ENABLED=false`. No migrations
were added this session.
