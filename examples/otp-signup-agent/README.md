# OTP signup agent

Demonstrates `waitForEmail` for a verification-code flow, with a tiny
in-process "fake signup service" standing in for a real product backend.

## Pieces

- `src/fake-signup-service.ts` — sends a 6-digit code over SMTP :2525 with
  `nodemailer` (example-only dependency), exactly like a real external
  sender would. `verify(code)` checks it.
- `src/extract-code.ts` — pure regex extraction, unit-tested against
  `fixtures/emails/02-otp-code.eml`'s real body text.
- `src/agent.ts` — the flow: `inboxes.create({client_id})` → capture `since`
  → trigger signup → `waitForEmail({from, since})` → `extractCode` →
  `service.verify(code)`. No LLM calls.

## Run it

```bash
pnpm install
pnpm --filter @localmail/example-otp-signup-agent test    # hermetic extractCode tests
pnpm --filter @localmail/example-otp-signup-agent smoke    # live run against the real stack
```

The smoke script:
1. Runs the full signup flow and prints `verified in N ms`.
2. Runs it again with the same `client_id` — confirms the same inbox comes back.
3. Runs with `--race` semantics (the signup email is sent *before*
   `waitForEmail` is called) — confirms it still resolves, through the SDK's
   catch-up path rather than the WS push path.
4. Runs with a sender filter that can never match — confirms a clean
   `LocalMailTimeoutError` after the configured timeout, with no hanging
   handles (the process exits on its own).
