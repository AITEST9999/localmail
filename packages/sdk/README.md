# @localmail/sdk

Typed client for the LocalMail API. Generated from the committed
`openapi.json` (types only — see `src/generated/openapi.ts`) plus
hand-written helpers (`waitForEmail`, `replyToThread`, `subscribe`,
`verifyWebhookSignature`). Zero `@localmail/*` dependencies (PLAN.md
Decision 2.4) — this package only talks to the API over HTTP/WS.

## Config

```ts
import { LocalMail } from '@localmail/sdk';

const lm = new LocalMail({
  baseUrl: 'http://127.0.0.1:8080', // or LOCALMAIL_API_URL, default http://127.0.0.1:8080
  apiKey: 'lm_admin_...',           // or LOCALMAIL_API_KEY — required, no silent anonymous mode
});
```

Throws `LocalMailConfigError` if no API key is available from either source.

**Admin-key limitation (G11):** Phase 4 has no `POST /v1/api-keys`, so every
example, the CLI, and the MCP server run on the full-scope `ADMIN_API_KEY`.
Scoped keys land in Phase 5 (task 23) — until then, treat any code holding
this key as trusted.

## Regenerating types

```
pnpm --filter @localmail/sdk generate
```

Regenerates `src/generated/openapi.ts` from `openapi.json` (both committed).
To refresh `openapi.json` itself after an API change, run
`pnpm --filter @localmail/api openapi:export` first — `apps/api`'s test
suite has a drift test that fails if the two get out of sync.

## `waitForEmail`

```ts
const since = new Date();       // capture BEFORE triggering the email
await triggerSignupEmail();
const message = await lm.waitForEmail(inboxId, { from: /noreply@/, since, timeoutMs: 30_000 });
```

Always pass `since` explicitly for a signup-style flow — capture it right
before the action that sends the email, not after. The default (`since:
new Date()` at call time) only works when nothing could have sent the
email before `waitForEmail` was called. See `src/wait-for-email.ts` for
the full subscribe-then-catch-up-then-poll algorithm.

## `replyToThread`

```ts
await lm.replyToThread(inboxId, threadId, { text: 'Thanks!' });
```

Replies to the last inbound message in the thread, or the last message of
any direction if there is no inbound one.
