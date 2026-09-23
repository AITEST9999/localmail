# AGENTS.md — Working with Herdr + agent-router + Jev on LocalMail

> How multiple coding agents share this repo through Herdr, how routing and command-gating use Jev, and where secrets are allowed to live. Pairs with PLAN.md (architecture) and TASKS.md (the actual task board, with Claude/Codex ownership tags).
>
> **Flag up front:** Herdr, `herdr-jev`, and `jev-gate` are external tools (agentmail.md §14 links to their repos) that this doc did not inspect directly — no CLI was run against them while writing this. Everything below is the *convention this repo commits to*; treat exact flag names/output formats as needing a one-time confirmation against each tool's own `--help`/README before anyone automates around them. Where this doc references Jev's actual request/response shape (§4), that part *is* grounded in the live tool schemas available in this environment (`jev_ask`, `jev_check`, `jev_classify`, `jev_score`, `jev_triage`), not guessed.

---

## 1. What each piece is doing

- **Herdr** — the terminal multiplexer that holds one pane per agent (Claude or Codex) working this repo. A pane maps roughly 1:1 to a TASKS.md row.
- **agent-router / `herdr-jev`** — routes a task to a pane using Jev to help decide *which* agent/pane a task should go to (e.g., steering design/schema/API tasks toward a Claude pane and implementation toward a Codex pane, per the ownership tags already assigned in TASKS.md).
- **`jev-gate`** — sits in front of shell command execution inside a pane and uses Jev to approve/flag commands (e.g., distinguishing a routine `pnpm test` from something that touches `git push --force` or drops a database) before they run.

The task board (TASKS.md) already assigns owners; `herdr-jev` is the mechanism for actually getting a task from the board into the right pane, not for deciding ownership from scratch.

---

## 2. Pane assignment: routing tasks through `herdr-jev`

Bind `herdr-jev` to `prefix + j` (agentmail.md §10) inside Herdr. Workflow per task:

1. Pick the next unblocked task from TASKS.md (respect PLAN.md §6's dependency graph — don't start P1-8 before P1-5/P1-6/P1-7 are done, etc.).
2. Trigger `herdr-jev` (`prefix + j`) and hand it the task ID and owner tag (Claude or Codex) from TASKS.md. It should open or select a pane and load that agent with the task's description, DoD, and dependencies.
3. **Design/schema/API-contract tasks (the `*a` tasks in TASKS.md, e.g. P0-3a, P1-4a, P2-11a, P3-14a) go to a Claude pane first.** Do not route the paired implementation task (`*b`) to a Codex pane until the design task's DoD is met and reviewed — TASKS.md is explicit about this dependency for a reason: several of these (repository interfaces, the webhook HMAC scheme, the Jev question wording) are expensive to change once two other tasks depend on them.
4. Implementation tasks go to a Codex pane once their design prerequisite is approved.
5. Review-only tasks (e.g. P1-7-review) go to a Claude pane after the implementer's draft exists — these don't block the *next* task starting, only the *current* one being marked Done.

If `herdr-jev`'s routing suggestion disagrees with TASKS.md's explicit owner tag, TASKS.md wins — the tags were chosen deliberately (design/review work stays with Claude, implementation with Codex) and aren't meant to be re-litigated per task by the router.

---

## 3. `jev-gate`: run in dry-run first, on every new pane type

Before letting any pane's commands auto-execute, run `jev-gate` in **dry-run mode** for that pane. Dry-run should log what it *would* approve, flag, or block without actually enforcing — the point is to watch a session or two of real commands from that agent (a Codex implementation pane looks very different from a Claude review pane) and confirm the gate's calibration matches what this repo actually needs blocked, before it starts silently approving or silently blocking things.

Concretely, for this repo, the commands worth specifically watching for during dry-run:
- Anything touching `docker compose down -v` or a raw `psql ... DROP` (would nuke local Postgres data — not catastrophic locally, but wastes a seed cycle for whoever's on the next task).
- `drizzle-kit push`/migration-generation commands run from more than one pane at once (this is exactly the migration-collision risk in PLAN.md R8 — `jev-gate` dry-run is a good place to *notice* two panes both about to generate a migration in the same window, even though the actual fix is the ownership convention in §5 below, not the gate).
- Anything that would write to `.env` (secrets — see §4).
- `git push --force` on anything, and any `rm -rf` outside a pane's own scratch area.

Only flip a pane from dry-run to enforcing once you've watched it handle a normal task-sized batch of commands and agree with its calls. Re-run dry-run again if a pane's task type changes significantly (e.g. the same Codex pane moves from "implementing the SMTP server" to "writing Testcontainers integration tests" — different command shapes, worth a fresh look).

---

## 4. Secrets discipline

- **`TYPESAFE_API_KEY` (the real key backing Jev calls) lives only in `apps/workers`' environment.** It is never read by `apps/api`, `apps/dashboard`, `apps/mcp`, or anything that ships to a client. This isn't just an env-file convention — PLAN.md Decision 2.4 makes it structural: `apps/dashboard` and `apps/mcp` have no dependency edge to `packages/jev` at all, so there's no import path by which they *could* reach the key even by accident. If a task ever seems to need Jev access from one of those apps, that's a sign the task is mis-scoped — flag it rather than adding the dependency.
- `ADMIN_API_KEY` and `APP_ENCRYPTION_KEY` (PLAN.md Decision 3.2, backing DKIM-key/webhook-secret encryption at rest) follow the same rule: workers/API-server-side only, generated into a local `.env` on first seed, never committed. `jev-gate` dry-run (§3) should be watched specifically for any command that would print or write these into a file `git status` would pick up.
- Before any commit or PR from any pane, run `git status` and eyeball anything that looks like it could be `.env`, a seeded API key, or a private key file, even if the filename looks innocuous — same discipline as any other repo, just worth restating here because this repo *specifically* generates secrets locally on first run (`pnpm db:seed`) rather than starting with none.

---

## 5. Migration / schema ownership (PLAN.md R8)

Only one pane authors Drizzle migrations at a time per phase. In practice: whoever holds P0-3a/P0-3b (Phase 0–3 schema) is the sole author of schema changes until that task is Done; if a later task in Phase 1–3 needs a schema tweak, it goes back through a short Claude schema-review (same shape as P0-3a) rather than having the implementing pane generate its own migration ad hoc. This is a process rule enforced by whoever is routing tasks via `herdr-jev`, not something `jev-gate` can catch reliably on its own (two migrations generated a few minutes apart in different panes will each look individually fine to a command gate).

---

## 6. `herdr-real` vs. local/interactive use

When Herdr is driven **non-interactively** — a CI job, a scheduled routine, anything kicking off panes without a human watching — invoke `herdr-real` explicitly rather than whatever thin/interactive entrypoint is used for local development. Confirm this against Herdr's own docs before wiring it into any automation (per the flag at the top of this file), but treat "automation uses `herdr-real`, humans use the interactive entrypoint" as the working assumption for this repo until proven otherwise, and don't let a CI script fall back to the interactive path silently if `herdr-real` isn't found — fail loudly instead, since a silent fallback is exactly the kind of thing that's hard to notice went wrong.

---

## 7. Definition of Done, tied to TASKS.md

A task is Done when:
1. Its own DoD (in TASKS.md) passes.
2. If it's an implementation task with a paired design task (`*b` following `*a`), the design task was approved *before* implementation started, not retrofitted after.
3. `pnpm test:unit` passes in the pane's own package; `pnpm test:integration` passes before merge (PLAN.md §5 — don't block the inner loop on Testcontainers, but don't skip it before calling something Done either).
4. `git status` was checked for stray secrets (§4) before any commit.

Update TASKS.md's task row (not this file) with status as work progresses — AGENTS.md describes the workflow, TASKS.md tracks state.
