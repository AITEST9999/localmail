# Agent-to-agent

Two inboxes negotiate a meeting time entirely over LocalMail loopback — no
Mailpit involved, no LLM calls.

## Protocol (src/protocol.ts — pure, unit-tested)

1. **Alice** proposes three slots (`slot-1`/`slot-2`/`slot-3`).
2. **Bob** picks the first slot not in his hard-coded busy list (`slot-1`)
   and replies with it.
3. **Alice** confirms the chosen slot. Both sides stop — Bob never replies
   to a confirmation (explicit terminal state).

Three loopback messages total, all in one thread per inbox (`src/negotiate.ts`).

## `--runaway` mode (src/runaway.ts)

Both sides blindly reply to everything, ignoring the confirmation marker —
this example places no hop limit of its own. What stops it is the server's
existing `X-LocalMail-Hop-Count` guard (`SMTP_MAX_HOPS`, default 20). The
script reports the hop count it reached when the API starts returning
`400 validation_error`.

## Run it

```bash
pnpm install
pnpm --filter @localmail/example-agent-to-agent test              # hermetic protocol tests
pnpm --filter @localmail/example-agent-to-agent smoke              # normal negotiation
pnpm --filter @localmail/example-agent-to-agent smoke -- --runaway  # hop-guard demo
```

The normal smoke asserts Mailpit's message count doesn't move (pure
loopback) and that the negotiation finishes in at most 4 messages. The
`--runaway` smoke asserts the loop stops itself and reports the hop count
reached.
