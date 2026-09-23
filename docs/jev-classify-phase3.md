# P3-14a — Jev Classification Question Design

> Design-only deliverable for TASKS.md **P3-14a**. Owner: Claude. Does not implement `packages/jev` or worker code — this is what **P3-14b implements**.
> Grounded in the as-built schema (`packages/db/src/schema.ts`'s `jevDecisions` table), the as-built event union (`packages/core/src/inbound-contracts.ts`'s `MessageEvent`, already extended by P2-11b to `MessageReceivedEvent | MessageSentEvent`), the reserved `jev-classify` queue name (`apps/workers/src/index.ts`'s stub), and the actual Jev primitives available in this environment (`jev_ask`'s batched classify/check questions) rather than agentmail.md §5's illustrative `Choice`/`Noul` SDK sketch. Every deviation from §5 is called out with rationale, not silently substituted.

## APPROVED

- [x] Single `jev_ask` call — one `classify` + four `check` questions, per PLAN.md D4.1
- [x] Exact question strings and classify option descriptions
- [x] `act_above`/`review_above` starting thresholds, with rationale, per question
- [x] `jev_decisions.answers` JSON shape (five raw results + `source`; latency stays in its own existing column)
- [x] Hand-checked against all 9 of agentmail.md §11's fixture types
- [x] agentmail.md §9 smoke test mapped to its exact expected labels, with a test-assertion caveat
- [x] Gaps / implementer notes for P3-14b: timeout+circuit breaker (R5), enqueue point, label application, `message.labeled` emit, and one product-correctness catch (below)
- [x] No product scope invented beyond TASKS.md / PLAN.md / agentmail.md
- [x] Ready for implementation

---

## 1. The single `jev_ask` call

One call per inbound message, per PLAN.md D4.1: one `classify` question for category, four `check` questions (`spam`, `urgent`, `needsHuman`, `auto`) — not five separate calls, and not a fifth `otp` check (folded into category, per D4.1 and this task's own instructions).

**Deviation from agentmail.md §5, resolved per this task's explicit direction:** §5's table lists seven category options including `personal`; its own code sketch lists only six (`billing, support, sales, otp, newsletter, other`) — an internal inconsistency in the brief. Per PLAN.md D4.1 and this task's instructions, **the six-bucket list wins**. `personal` is not a seventh option; personal correspondence maps to `other`. Stated once here, not re-litigated per fixture.

**Input to Jev — content selection, decided here (not left implicit):** feed Jev `extracted_text` (the reply-stripped body, already computed by P1-6/`email-reply-parser` per agentmail.md §2.2) truncated to 4000 characters, falling back to raw `text` only if `extracted_text` is null. **Rationale:** on a long reply chain (§11's fixture, and a real risk for any back-and-forth thread), feeding Jev the full quoted history dilutes the signal for what the *current* message is actually about and wastes the 4000-character budget on already-classified content. Using `extracted_text` means classification reflects the newest message, not the thread's accumulated history.

```ts
jev.jev_ask({
  state: `From: ${from}\nSubject: ${subject}\n\n${(extractedText ?? text ?? '').slice(0, 4000)}`,
  questions: [ /* §2 */ ],
  act_above: /* per-question, §3 — jev_ask's single global act_above/review_above apply to every
               question in the batch; where a question needs a different threshold than the
               batch default, evaluate that question's verdict against its own threshold in
               application code after the call returns, rather than assuming the tool call
               itself can set five different per-question thresholds in one request */
});
```
**Note on thresholds and the batched call:** `jev_ask` takes one `act_above`/`review_above` pair for the whole batch, not per-question. Since §3 below picks different thresholds for `spam`/`auto` than for `urgent`/`needsHuman`, **call `jev_ask` with the tool's defaults (`act_above: 0.8`, `review_above: 0.5`) and re-derive each question's actual verdict in `packages/jev` from the raw returned probability against that question's own threshold from §3.** This is a real, load-bearing design decision, not a detail to leave implicit — get it wrong and every per-question threshold in §3 is silently ignored.

**SDK-call-shape caveat (flagged honestly, not glossed over):** agentmail.md §5's sketch imports `@typesafe-ai/sdk` (`Choice`/`Noul`), which is not installed anywhere in this repo (checked directly — no `package.json` references it). The `jev_ask` semantics used throughout this doc are the actual batched-question primitive available in this working environment (classify/check/score in one call, minimal added latency per extra question) — confirm the real npm package's exact call signature once it's added to `packages/jev`'s `package.json`; this doc pins the **behavioral contract** (question wording, thresholds, response shape), not an unverified SDK method signature.

---

## 2. Exact question strings

**Classify — category** (`add_none: false` — deliberate: the six options already include an exhaustive `other` catch-all, so a Jev-injected seventh "none of these" option would be redundant and would give the worker a seventh possible value its label-mapping code doesn't expect):

```
question: "What is this email primarily about?"
options: {
  billing:    "Payments, invoices, refunds, or being charged incorrectly.",
  support:    "A help request, bug report, or technical problem that needs troubleshooting.",
  sales:      "Buying interest, a quote request, a demo request, or pricing questions.",
  otp:        "A one-time verification code, a sign-in/sign-up confirmation link, or an account confirmation code.",
  newsletter: "A recurring newsletter, bulk marketing, or promotional broadcast, not addressed to the recipient personally.",
  other:      "Personal correspondence or anything that doesn't clearly fit the categories above.",
}
```

**Check — spam:**
```
question: "Is this email spam, a phishing attempt, or an unsolicited scam?"
yes_means: "This is spam, phishing, or a scam attempt and should not be treated as legitimate correspondence."
no_means:  "This is legitimate correspondence, even if it is a newsletter, receipt, or automated notification."
```

**Check — urgent:**
```
question: "Does the sender convey urgency, expecting a fast response — an active problem, a time-sensitive request, or an explicit deadline?"
yes_means: "The sender is asking for or clearly expects a prompt response."
no_means:  "There is no indication the sender expects a fast response."
```

**Check — needsHuman:**
```
question: "Does replying to or acting on this email require a human's judgment or authority, rather than something an automated agent can safely resolve on its own?"
yes_means: "A human should review this before any reply or action is taken — e.g. it involves a financial decision, a policy judgment, a complaint, or something with real consequences if handled wrong."
no_means:  "An automated agent can safely read, file, or reply to this without a human's involvement."
```

**Check — auto** (scope deliberately narrow — see the correctness note in §7, this wording is load-bearing):
```
question: "Is this an automatic reply, bounce/delivery-failure notice, or out-of-office notification — an automated response to something that was sent to the sender's address — rather than a message a person or system deliberately composed and sent with new content?"
yes_means: "This is an automatic reply-type notification (out-of-office, bounce, delivery failure, auto-acknowledgment)."
no_means:  "This is a deliberately composed message with its own content, even if it was generated by an automated system (e.g. a receipt, a verification code, or a newsletter) rather than typed by a human."
```
The `no_means` text explicitly carves out system-generated-but-purposeful mail (receipts, OTP codes, newsletters) from "auto" — see §7 for why this distinction is safety-critical, not stylistic.

---

## 3. Thresholds, per question, with rationale

`jev_ask`'s batch-level default is `act_above: 0.8`, `review_above: 0.5`. Per §1, actual verdicts are re-derived per-question against the thresholds below (call the batch with the tool's own defaults; apply these in application code against the returned probabilities):

| Question | `act_above` | `review_above` | Rationale |
|---|---|---|---|
| `category` (classify) | `0.8` (default) | `0.5` (default) | Low-stakes, easily-corrected mislabel (a wrong category is just a wrong label, not a suppressed message or a broken safety mechanism). No reason to deviate from Jev's own calibrated defaults. |
| `spam` | **`0.75`** | **`0.4`** | Asymmetric cost: a false *positive* here only suppresses/labels one message (soft, reversible — §7 notes the actual webhook-suppression feature isn't built in Phase 0–3 anyway); a false *negative* lets a phishing email reach an agent that may act on untrusted content (agentmail.md §13's own prompt-injection warning). Lower `act_above` acts on suspicion a bit more readily; lower `review_above` means more borderline cases get flagged for review instead of silently abstaining — silent inaction is the actually risky failure mode for a possible phishing email. |
| `urgent` | `0.8` (default) | `0.5` (default) | Advisory-only label (dashboard/agent hint), gates nothing destructive. No reason to deviate. |
| `needsHuman` | `0.8` (default) | `0.5` (default) | Same — advisory label, no hard gate exists on it in Phase 0–3. |
| `auto` | **`0.7`** | `0.5` (default) | This signal feeds reply-loop suppression (P3-17), where P1-8's hop-count guard (PLAN.md D4.3) is the hard backstop and this is the *secondary*, best-effort signal (PLAN.md D4.2). Biasing toward "yes, treat as auto" costs little (worst case: a genuine reply doesn't prompt an auto-reply agent — a minor inconvenience) versus biasing toward "no" (worst case: contributes to a reply loop the hop-count guard would eventually stop anyway, but later than necessary). |

All five are config-tunable per D4.1 — expose as named constants in `packages/jev`, not hardcoded inline, so they can move without a code review of the calling logic.

---

## 4. `jev_decisions.answers` JSON shape

The existing schema (`packages/db/src/schema.ts`) already has `jevDecisions.latencyMs` as its own `integer` column — **latency is not duplicated inside `answers`**; `latencyMs` is the worker's own measured wall-clock time for the whole batched call, stored once, in the column that already exists for it.

`answers` (jsonb) stores the five raw per-question results plus one `source` marker distinguishing a live Jev call from the rules fallback (§7 — the fallback isn't only for `JEV_ENABLED=false`, it's also the timeout/circuit-breaker degradation path, so this field matters even when Jev is "enabled"):

```json
{
  "source": "jev",
  "category": {
    "chosen": "billing",
    "probabilities": { "billing": 0.91, "support": 0.03, "sales": 0.01, "otp": 0.01, "newsletter": 0.01, "other": 0.03 },
    "confidence": 0.91,
    "verdict": "act"
  },
  "spam":       { "probability": 0.02, "verdict": "no" },
  "urgent":     { "probability": 0.87, "verdict": "act" },
  "needsHuman": { "probability": 0.78, "verdict": "act" },
  "auto":       { "probability": 0.04, "verdict": "no" }
}
```
`verdict` values: for the classify question, whatever `jev_ask` itself reports (act/review/abstain) against the *default* thresholds is fine to store as-is (informational); for each check question, store the **re-derived** verdict against §3's per-question threshold (`"act"`/`"review"`/`"abstain"`, or simplify to the label-relevant `"yes"`/`"no"`/`"review"` — pick one convention and use it consistently; the label-application logic in §7 only needs to know "does this cross its act threshold," so don't over-engineer a five-state enum if a boolean-plus-review-flag is simpler to consume). `source: "rules"` rows (§7) populate the same five keys with `probability`/`confidence` fields set from the heuristic (e.g. `1.0`/`0.0` for a hard keyword match, or omit the numeric fields entirely and rely on `verdict` alone) — the point is the same five top-level keys always exist, regardless of source, so nothing downstream (a Phase 5 dashboard) needs to branch on `source` to know where to look for a given label's result.

---

## 5. Hand-check against agentmail.md §11's 9 fixtures

Reasoning through what a *reasonable* answer would produce — not claiming Jev actually ran. Three of the nine fixtures are named for a **structural** property (MIME shape, thread depth, charset), not semantic content, and are called out as such rather than given a fabricated confident answer.

| Fixture | category | spam | urgent | needsHuman | auto |
|---|---|---|---|---|---|
| Billing complaint (this is agentmail.md §9's smoke test — see §6) | `billing` | no | **yes** | yes | no |
| OTP code | `otp` | no | no | no | **no** — see §7's correctness note; this is the one fixture where getting `auto` wrong breaks a real feature |
| Newsletter | `newsletter` | no | no | no | no |
| Phishing | whatever it impersonates (commonly `billing` or `support`-pretexted) | **yes** | often yes (manufactured urgency is a classic phishing pattern) | yes (flag for human review) | no |
| Out-of-office | `other` | no | no | no | **yes** |
| Bounce / delivery failure | `other` | no | no | no | **yes** |
| Multi-part with attachment | *content-dependent* — MIME structure doesn't change what the email is about; Jev never sees the attachment, only `extracted_text`/`text`. No fixed answer without the fixture's actual body copy (not yet authored per TASKS.md X-2). | — | — | — | — |
| Long reply chain | *content-dependent*, same caveat — this is exactly why §1 feeds `extracted_text`, not the full quoted thread, so whatever the *newest* message says drives the answer, not the accumulated history. | — | — | — | — |
| Non-UTF-8 charset | *content-dependent* — mailparser already decodes the charset before `text`/`html` exist (same transport-boundary precedent as RFC 2047 subject decoding, confirmed in the P1-7-review sign-off); Jev never sees raw bytes or an encoding label, so this fixture exercises P1-6's decoding, not this design. | — | — | — | — |

---

## 6. agentmail.md §9 smoke test, mapped exactly

Input: `Subject: I was charged twice!`, body `Please refund ASAP.`

- **category: `billing`** → label `billing`.
- **spam: no** → no `spam` label.
- **urgent: yes** ("ASAP" is an explicit urgency marker, comfortably above §3's threshold) → label `urgent`.
- **needsHuman: yes** (a double-charge refund is a real financial dispute — a plausible, defensible `yes`) → label `needs-human`.
- **auto: no** → no `auto` label.

Combined with the always-applied `inbox, unread` (P1-6): final label set is **`inbox, unread, billing, urgent, needs-human`**.

**Implementer note, load-bearing for the test itself:** agentmail.md §9 states the expected outcome as labels `inbox, unread, billing, urgent` — it does not claim that's the *exhaustive* set. **P3-14b's test should assert those four labels are present (subset check), not that the label array equals exactly those four** — `needs-human` is a reasonable, correct additional label for this content, and an exact-equality assertion would make the test flaky/wrong the moment a reasonable model calls `needsHuman: yes` on an email about being incorrectly double-charged. This is exactly the kind of over-strict test that would force someone to either weaken a correct model behavior or weaken a correct test — avoid the trap now.

---

## 7. Gaps / implementer notes for P3-14b

1. **Correctness note (not a gap — a decision already made, restated because it's easy to get backwards): `auto` must not fire for OTP/transactional system mail.** agentmail.md §5's table calls the `auto` label's purpose "skip agent triggers (prevents reply loops)," and P3-17's own task description says `auto`-labeled mail suppresses "webhook/WS `message.received` side effects that would prompt an auto-reply agent to respond." If `auto` fired on OTP emails (which *are* system-generated), it would suppress exactly the delivery signal `wait_for_email` depends on (agentmail.md §2.11, §10 task 21's `otp-signup-agent` example) — breaking a flagship feature. §2's `auto` question wording is deliberately scoped to reply/bounce/OOO notifications specifically, with the `no_means` text explicitly carving out "generated by an automated system... but deliberately composed with its own content" (receipts, OTPs, newsletters). **Do not broaden this question's wording during implementation to mean "any automated email" — that's the one change that would silently break OTP delivery.**

2. **Timeout + circuit breaker (PLAN.md R5), concrete values (config-tunable, not hardcoded):** 5-second timeout per `jev_ask` call. On timeout *or* any error, **fall back to the P3-15 rules path for that one message** rather than failing/retrying the job — this means P3-15's rules fallback isn't only the `JEV_ENABLED=false` path, it's also the automatic degradation path for a live-but-misbehaving Jev, unifying two fallback triggers into the one shared module PLAN.md D4.4 already calls for. Circuit breaker: after 5 consecutive failures/timeouts within a 60-second window, trip — skip calling Jev entirely (route straight to rules) for a 30-second cooldown, then retry Jev (half-open). All four numbers are starting defaults, expressed as named constants.

3. **Enqueue point from inbound — recommended integration point, not yet wired:** the `jev-classify` queue name is already reserved (`apps/workers/src/index.ts`'s stub list) but nothing enqueues to it yet. The cleanest integration point, consistent with the "one hook point" pattern P2-11b already established for webhook fan-out: extend `packages/events`'s `createDurableEventPublisher.emit()` to *also* enqueue a `jev-classify` job (`{ messageId }`) whenever `event.type === 'message.received'` — **not** for `message.sent` (outbound mail the agent itself sent doesn't need classifying). This avoids threading a second callback parameter through `packages/core/src/inbound.ts`'s `ingest()` signature; `emit()` is already the one place "something happened, dispatch consequences" lives.

4. **Label application, exact mapping (so nothing is left ambiguous):**
   - `category` → one label, only for the five specific buckets (`billing`/`support`/`sales`/`otp`/`newsletter`); **`other` adds no label** — a visible `other` tag on every uncategorized email is noise, not signal.
   - `spam` yes → label `spam`. (§5's "suppress webhook if configured" is **not required by any Phase 0–3 acceptance criterion and has no schema support today** — `webhooks` has no per-webhook or per-pod spam-suppression flag. Flagged as explicitly out of scope for P3-14b, not silently expected.)
   - `urgent` yes → label `urgent`.
   - `needsHuman` yes → label **`needs-human`** (hyphenated, per agentmail.md §5's own literal naming — note the JSON key is camelCase `needsHuman` but the *label string* is hyphenated; don't let these two spellings drift into the same casing by accident).
   - `auto` yes → label `auto`.
   - `otp` is not a separate label path — it's already covered by `category: otp` (one classify answer serving double duty, exactly as D4.1 intended).

5. **`message.labeled` emit — extends the existing event union.** Add `MessageLabeledEvent` (`{ type: 'message.labeled', podId, inboxId, threadId, messageId, labels: string[] }`) to `packages/core/src/inbound-contracts.ts`'s `MessageEvent` union, emitted by the jev-classify worker itself (after writing `jev_decisions` and updating `messages.labels`) through the same `eventPublisher.emit()` used everywhere else. This event type was **already validated as a legal WS `subscribe` value** in `docs/websocket-phase2.md` §2 (it's in that doc's "known but not-yet-emitting" type list) — no WS or webhook protocol change is needed on top of what P2-11a/P2-13a already specified; P3-14b only needs to actually emit it through the existing pipeline.

6. **Fixture files themselves don't exist yet.** `fixtures/emails/*.eml` (agentmail.md §11, TASKS.md X-2) haven't been authored — §5's three content-dependent rows can't get a real hand-check until that task lands. Not a P3-14a blocker (this doc's job is the question/threshold/shape design, which is content-independent), but P3-14b/P3-15's own tests will need those fixtures to exist first.
