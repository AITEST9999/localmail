# Auto-reply agent

Watches one inbox and replies to support/billing mail. Fully deterministic —
no LLM calls (a comment in `src/agent.ts` marks where one would plug in).

## How it decides (src/policy.ts)

Replies only when the message is **inbound** and its labels include
`support`, or `billing` without `needs-human` — and never when labels
include `auto`, `spam`, `needs-human`, or `skip_classify`.

It triggers on the **`message.labeled`** event, not `message.received`
(P3-17: a message may only be known to be `auto` — an out-of-office or
bounce — once labels land; treating `message.received` as license to reply
would race that).

Every reply carries `Idempotency-Key: auto-reply:<message_id>`, so if the
same `message.labeled` event is ever reprocessed (e.g. after a restart), the
API replays the first reply instead of sending a second one.

## Run it

Prerequisites: the full stack up with `JEV_ENABLED=false` for deterministic
labels (see the repo root `docs/phase4-plan.md` §6.2), and `LOCALMAIL_API_URL`
/ `LOCALMAIL_API_KEY` exported in your shell.

```bash
pnpm install
pnpm --filter @localmail/example-auto-reply-agent test    # hermetic policy tests
pnpm --filter @localmail/example-auto-reply-agent smoke    # live run against the real stack
```

The smoke script:
1. Creates a fresh inbox and starts the agent.
2. Delivers `05-out-of-office.eml`, `06-bounce.eml`, and `01-billing-complaint.eml`
   (labeled `needs-human`) — confirms Mailpit's message count doesn't move.
3. Delivers a synthetic bug-report email — confirms exactly one reply lands
   in Mailpit with the correct `In-Reply-To`.
4. Replays the same reply call with the same `Idempotency-Key` (what a
   restarted agent reprocessing the same event would do) — confirms Mailpit's
   count still doesn't move a second time.

`src/policy.test.ts`'s label sets for the 9 `fixtures/emails/*.eml` fixtures
were recorded live (2026-09-23, rules path, `JEV_ENABLED=false`) — not
guessed. None of the 9 corpus fixtures land as `support`/`billing`-without-
`needs-human`, so the live smoke uses a separate synthetic message to
exercise the reply path; the fixture table exists to prove every fixture's
*real* label set is correctly excluded.
