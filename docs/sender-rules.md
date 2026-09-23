# Sender allow/block lists (P3-16)

Implementation note for `sender_rules` + SMTP `RecipientPolicy`. No schema migration.

## Config

`SENDER_BLOCK_MODE=drop|spam` (default `drop`) in `@localmail/config`.

| Mode | Blocked sender |
|---|---|
| `drop` | `550` at `RCPT TO` — never reaches DATA / DB |
| `spam` | Accepted; persisted with labels `spam`, `unread`, `skip_classify` |

`skip_classify` (`CLASSIFY_SKIP_LABEL` in `@localmail/core`) is the durable signal that future `jev-classify` must not run. `PersistInboundMessage.skipClassify` mirrors it for in-process hooks.

## Pattern matching (MVP)

- Exact: `alice@spam.com` (case-insensitive)
- Domain wildcard: `*@spam.com` or `@spam.com`
- Bare domain: `spam.com` (same as `*@spam.com`)

Allow matches override block matches; inbox-scoped rules preferred over pod-wide (`inbox_id` null).
