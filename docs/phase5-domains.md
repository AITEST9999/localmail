# P5-24a — Custom Domains (Mock DNS Verify, DKIM Signing): Design

> Design-only deliverable for TASKS.md **P5-24a**. Owner: Claude. Does not implement app code — this is what P5-24b (Codex) implements against.
> Grounded in the actual repo state as of this pass: `packages/db/src/schema.ts`'s `domains` table (already exists — `domain`, `status` enum `pending|verified|failed`, `dkim_private_key text`, `dns_records jsonb`, no migration needed), `packages/core/src/crypto.ts` (AES-256-GCM `encryptSecret`/`decryptSecret`, already in production use by `apps/api/src/webhooks.ts` for webhook secrets — reused here, not reimplemented), `apps/api/src/outbound.ts` (read directly — the exact Nodemailer integration point is identified in §4, not assumed), `apps/api/package.json` (`nodemailer: ^10.0.10`, confirmed from the lockfile, not guessed), and `docs/phase5-pods-keys.md`/`docs/phase5-drafts.md` (the two approved MVP design docs, whose conventions — scope tables, route contract shape, "show secret once," pod-scoped 404 isolation — this doc follows for consistency). Resolves `docs/phase5-plan.md` §7 Q4/Q5.

## APPROVED — 2026-09-23

- [x] Route contracts for domains (create/list/get/delete/verify)
- [x] Two new scopes: `domains:read`, `domains:write`
- [x] Q4 — mock DNS verify mechanism: echo-back, documented below
- [x] Q5 — DKIM key size/algorithm + selector convention: RSA-2048, documented below
- [x] DKIM keypair generation + encrypted storage (reusing `packages/core/src/crypto.ts`, no new scheme)
- [x] Exact Nodemailer DKIM integration point in `apps/api/src/outbound.ts`

Ready for Codex (P5-24b).

---

## 1. Scopes

| Scope | Grants |
|---|---|
| `domains:read` | `GET /v1/domains`, `GET /v1/domains/:id` |
| `domains:write` | `POST /v1/domains`, `DELETE /v1/domains/:id`, `POST /v1/domains/:id/verify` |

No scope ever grants read access to `dkim_private_key` — see §3, that field is never serialized by any route, regardless of scope. This matches the existing precedent set for webhook secrets (`apps/api/src/webhooks.ts`: secret shown once on create, omitted from every subsequent GET) and for API keys (`docs/phase5-pods-keys.md` §2: `listApiKeys` never returns `hash`).

---

## 2. Q5 — DKIM key size / algorithm / selector convention

**Decision: RSA-2048, selector `lm1`.**

- **Algorithm/size: RSA-2048.** DKIM's spec (RFC 6376) and every major real-world verifier (Gmail, Outlook, etc.) support RSA out of the box; Ed25519 DKIM (RFC 8463) is valid but has materially spottier verifier support in the wild, and this project's own framing is "simulated/stubbed for v1, not real deliverability" (agentmail.md §1) — there's no benefit here to picking the less-universally-supported algorithm just because it's newer. 2048 bits is the current practical minimum recommended for DKIM (1024-bit DKIM keys are widely deprecated/rejected by modern verifiers); 4096 bits is unnecessary key-generation/signing overhead for a local-first tool with no real deliverability requirement. Generated via Node's built-in `crypto.generateKeyPair('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })` — no new dependency, matches the "Node built-in, zero new native dependency" precedent `packages/core/src/crypto.ts` already set for AES-GCM.
- **Selector: `lm1`.** A DKIM selector is an arbitrary label that namespaces the DNS TXT record (`<selector>._domainkey.<domain>`) so a domain can rotate keys or run multiple signers without collision. `lm1` (LocalMail, key generation 1) is short, unambiguous, and leaves room for a future `lm2` if key rotation is ever added (not in this design's scope — see §6 non-goals) without needing a new naming scheme later. Fixed per-domain at creation time, stored as part of `dns_records` (§3) rather than a separate column — it's DNS-record metadata, not a standalone concern.

---

## 3. Routes

Conventions match `docs/phase5-pods-keys.md`/`docs/phase5-drafts.md`: Zod schemas, camelCase `operationId`, `{ error: { code, message, details? } }`, pod-scoped 404 isolation, cursor pagination on lists.

### `POST /v1/domains` — `createDomain`
**Scope:** `domains:write` · **Idempotency-Key:** honored

Body: `{ domain: string }` (a bare domain name, e.g. `mail.example.test` — validated as a syntactically plausible hostname, not checked against real DNS in any way; this project never talks to real DNS, per agentmail.md §1's non-goal).

Server-side, on create:
1. Generate an RSA-2048 keypair (§2).
2. Encrypt the PEM private key via `encryptSecret` (existing helper, `APP_ENCRYPTION_KEY`-derived, same as webhook secrets) before it ever touches a `.insert()` call — the plaintext private key must not exist in application memory any longer than the single `generateKeyPair` → `encryptSecret` step requires, and must never be logged (matches AGENTS.md §4's secrets discipline).
3. Build `dns_records` (stored as-is in the existing `jsonb` column, returned verbatim in the response):
   ```json
   {
     "mx": { "type": "MX", "host": "@", "value": "localmail.test", "priority": 10 },
     "spf": { "type": "TXT", "host": "@", "value": "v=spf1 include:localmail.test ~all" },
     "dkim": { "type": "TXT", "host": "lm1._domainkey", "value": "v=DKIM1; k=rsa; p=<base64 SPKI public key, no headers/footers/newlines>" },
     "dmarc": { "type": "TXT", "host": "_dmarc", "value": "v=DMARC1; p=none; rua=mailto:dmarc@localmail.test" }
   }
   ```
   (Exact `mx`/`spf`/`dmarc` placeholder values are illustrative — P5-24b should keep them consistent with whatever `MAIL_DOMAIN`/outbound-relay convention already exists elsewhere in the repo rather than inventing new ones; the `dkim` record's shape is the one that matters for this design, since it's the one `verify` actually checks per §4.)
4. Insert the `domains` row: `status: 'pending'`, `dkim_private_key: <encrypted>`, `dns_records: <as above>`.

Response `201`: the domain row **including `dns_records`** (the caller needs these to "publish," even simulated) but **never `dkim_private_key`**, encrypted or not — that field is write-only from the API's perspective, set once at creation and never serialized in any response, ever.

### `GET /v1/domains` — `listDomains`
**Scope:** `domains:read` · Pod-scoped, standard cursor pagination. Response fields per domain: `id`, `domain`, `status`, `dns_records`, `created_at`. No `dkim_private_key`.

### `GET /v1/domains/:id` — `getDomain`
**Scope:** `domains:read` · `404 not_found` for a different pod's domain or a missing id. Same field set as `listDomains`'s items.

### `DELETE /v1/domains/:id` — `deleteDomain`
**Scope:** `domains:write` · `204` on success, `404 not_found` for cross-pod/missing. No special-cased "can't delete a verified domain" restriction — deleting a verified domain simply means future sends from that domain fall back to unsigned (see §4), which is a safe, non-destructive degradation, not a reason to block the delete.

### `POST /v1/domains/:id/verify` — `verifyDomain`
**Scope:** `domains:write` · See §4 for the mechanism. Response: the updated domain row (`status` now `verified` or `failed`).

---

## 4. Q4 — Mock DNS verify: echo-back

**Decision: `POST /v1/domains/:id/verify` requires the caller to echo back the exact `dns_records` the domain was created with (or a defined required subset); the server compares the echoed value against what's stored and sets `status` accordingly.**

Why echo-back over the alternatives (per `docs/phase5-plan.md` §4.3's three options): auto-succeed is a no-op that can't catch an agent misreading or mis-publishing the records it was given — since this project has no real DNS to check against, echo-back is the only one of the three options that actually *exercises* anything (did the caller correctly read and round-trip what `createDomain` returned), which is squarely in line with agentmail.md's "teach agents to do real things locally" framing. A seeded `mock_dns_records` table is unnecessary machinery — it would need a human/test to populate it out-of-band, adding a second source of truth for the same JSON blob `domains.dns_records` already holds, for no behavioral gain over just comparing against that column directly.

**Request body:**
```ts
{ dns_records: Record<string, unknown> }   // caller's echo of what it believes is "published"
```

**Comparison rule — required subset, not byte-exact:** the check compares only the **`dkim`** record (host + value) between the echoed body and the stored `dns_records.dkim`. Rationale: DKIM is the one record this design actually signs mail with (§5) and is therefore the one whose correctness has a real behavioral consequence (an agent that echoes back a stale/wrong DKIM value and gets `verified` anyway would then have "verified" outbound signing silently fail integrity checks against the *published* key — a real bug this check exists to catch). Requiring byte-exact equality on `mx`/`spf`/`dmarc` too adds verification friction with no corresponding behavioral payoff in this design (nothing else in Phase 5 reads or enforces those records), so they're accepted but not strictly checked — deliberately narrower than "echo literally everything," which would just be busywork for the caller.

- **Match** (echoed `dkim.host` and `dkim.value` equal the stored values, exact string compare — no normalization/whitespace-trimming beyond what JSON parsing already does) → `status: 'verified'`.
- **Mismatch** (echoed `dkim` present but doesn't match) → `status: 'failed'`. This is a **`200`** response with `status: 'failed'` in the body, **not a `4xx`** — the request itself was well-formed (valid JSON, right shape), it's the *content* that didn't match, which is a legitimate outcome for this endpoint to report, not a client error. (Contrast with a request missing the `dns_records` field entirely, or where it's not an object at all — that's a genuine `400 validation_error`, a malformed request, distinct from a well-formed-but-wrong verification attempt.)
- Re-verifying an already-`verified` domain is allowed (idempotent — re-checks the same comparison, stays `verified` if still matching) — no special-cased "already verified" error, since there's no reason to forbid re-checking.

---

## 5. DKIM signing integration point in `apps/api/src/outbound.ts`

**Confirmed by reading the file directly** (not assumed): `apps/api/src/outbound.ts`'s `createNodemailerOutboundTransport` builds two separate Nodemailer transports —

- `composer` (`nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })`), used in `build(mail)` to turn a `LocalMail`-internal mail object into a fully-composed raw MIME `Buffer` via `composer.sendMail(toNodemailerOptions(mail))`.
- `smtp` (a real SMTP transport to `options.host`/`options.port`), used in `sendRaw(raw, envelopeFrom, recipients)` to hand that already-built raw buffer off to Mailpit/an external relay.

**DKIM signing must happen in `build()`, at the `composer.sendMail(...)` call — not in `sendRaw()`.** This is a Nodemailer/mailcomposer property, not a design choice: DKIM signing is applied during MIME message assembly (`mailcomposer`, which every Nodemailer transport — including `streamTransport` — uses internally to build the message), not at SMTP hand-off time. By the time `sendRaw()` receives `raw`, the message is already a finished byte buffer; signing after that point would require re-parsing and re-serializing the MIME message, which is exactly the kind of extra complexity avoided by signing at the one point (`build()`) where Nodemailer already does it natively.

**Concrete change for P5-24b:** `createNodemailerOutboundTransport`'s `build(mail)` needs a way to know, per-call, whether the sending inbox's domain is a `verified` custom domain and — if so — the decrypted DKIM private key + selector to pass. The cleanest shape, consistent with this transport already being a plain function taking `mail`: extend `toNodemailerOptions(mail)`'s output (or `build`'s signature) to conditionally include Nodemailer's own `dkim` mail-option:
```ts
dkim: {
  domainName: '<verified domain>',
  keySelector: 'lm1',
  privateKey: '<decrypted PEM>',
}
```
passed as part of the `sendMail` call's options when (and only when) the sending address's domain matches a `status: 'verified'` row in `domains` for the caller's pod. Nodemailer resolves and applies this itself during composition — no manual DKIM-header construction needed in application code. **Confirm against the installed `nodemailer@10.0.10`'s docs/types during P5-24b** (the `dkim` mail-option has existed in Nodemailer since well before major version 10 and is expected to still be supported, but this design intentionally does not claim to have run it — P5-24b's implementer should verify the option name/shape against the actual installed types before wiring it in, per this doc's own "confirm against the installed version, don't assume" instruction).

**Default `MAIL_DOMAIN` stays unsigned, always.** No signing branch runs for the baseline `MAIL_DOMAIN` (agentmail.md's default, unverified-by-design domain) — only messages sent from an inbox whose domain matches a `verified` custom-domain row get the `dkim` option added at all. Where the domain lookup happens: the sending inbox's `domain` column (already on every `inboxes` row) is compared against `domains.domain WHERE status = 'verified' AND pod_id = <inbox's pod>` — a lookup P5-24b adds at the call site that invokes `build()`, not inside `outbound.ts`'s transport factory itself (keeps the transport factory free of a live DB dependency, consistent with how the rest of `apps/api` already separates route/store logic from the Nodemailer wrapper).

---

## 6. Non-goals for this design (explicitly out of scope)

- **No real DNS is ever queried or published** — per agentmail.md §1's existing non-goal; the "verify" endpoint (§4) is a self-contained echo-check against `domains.dns_records`, never an actual DNS lookup.
- **No DKIM key rotation** — a domain gets exactly one keypair at creation, generated once, never regenerated in place. If rotation is ever wanted, that's a new design (new selector, e.g. `lm2`, alongside the old one during a transition window) — not something P5-24b should build speculatively now.
- **No inbound DKIM/SPF/DMARC verification** — this design only covers *signing outbound* mail from a verified custom domain; it does not add any check on inbound mail's DKIM/SPF/DMARC status. That's a separate, unscoped feature, not implied by agentmail.md §10 task 24's wording ("Custom domains (mock DNS verify, DKIM signing)" — signing, not verifying inbound).
- **No per-domain DKIM signing toggle** — if a domain is `verified`, its outbound mail is always signed; there's no "verified but don't sign" state. Simpler than adding a second independent flag with no clear use case.

---

## 7. Test coverage this design implies (for P5-24b, informational — not the DoD itself, see TASKS.md)

- Unit: RSA-2048 keypair generation produces a valid PEM pair; `encryptSecret`/`decryptSecret` round-trips the private key correctly (reusing the exact test pattern `packages/core/src/__tests__/crypto.test.ts` already established for webhook secrets); the `dkim` mail-option is included in `toNodemailerOptions`'s output if and only if the sending domain is verified.
- Integration: `createDomain` response never contains `dkim_private_key` in any form; `getDomain`/`listDomains` responses likewise; `verifyDomain` with a matching echoed `dkim` record → `status: 'verified'`; with a mismatched one → `status: 'failed'`, `200` not `4xx`; with a missing/malformed `dns_records` body → `400 validation_error`.
- Live smoke: `createDomain` → echo the returned `dns_records` back to `verifyDomain` → `verified` → send a message from an inbox on that domain → inspect the Mailpit-received message's raw headers for a `DKIM-Signature` header with `d=<domain>` and `s=lm1`; send from the default `MAIL_DOMAIN` in the same session and confirm **no** `DKIM-Signature` header is present.
