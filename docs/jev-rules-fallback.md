# P3-15 — Rules fallback heuristics

Keyword/header path inside `@localmail/jev` (`classifyWithRules`). Same five-key
`answers` shape as live Jev (`source: "rules"`).

## What it catches

| Signal | Triggers |
|---|---|
| **category `billing`** | charge/charged, invoice, refund, payment, billing |
| **category `otp`** | verification code, one-time, OTP, confirm account, “code is” + digits |
| **category `newsletter`** | newsletter, unsubscribe, weekly digest, promotional |
| **category `sales`** | quote request, demo request, pricing |
| **category `support`** | bug report, technical problem/issue, troubleshoot, help request |
| **category `other`** | none of the above (no category label applied) |
| **spam yes** | phishing cues: verify password/credit card, account locked, click-here+verify, lookalike brand |
| **urgent yes** | asap, urgent, immediately, right away, deadline (**includes §9 “ASAP”**) |
| **needs-human yes** | refund/complaint/dispute/charged twice/legal/policy, **or** billing+urgent |
| **auto yes** | `Auto-Submitted: auto-replied\|auto-generated\|auto-notified`, or bounce/OOO markers (MAILER-DAEMON, undelivered, out of office). **Never** OTP/newsletter by generation alone. |

## Explicit non-parity with live Jev

- Does **not** claim model-quality category judgment on ambiguous mail.
- `urgent` **is** caught for ASAP/urgent keywords (so §9 billing smoke gets `billing` + `urgent` with `JEV_ENABLED=false`).
- Structural fixtures (multipart, charset) are content-dependent — heuristics only see decoded text.
