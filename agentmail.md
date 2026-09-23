# LocalMail — An Email Inbox API for AI Agents (runs locally)

> A self-hosted, local-first project inspired by [AgentMail](https://www.agentmail.to/).
> Goal: give every AI agent its own real inbox that it can create, send from, receive into, and react to — through a REST API, SDK, CLI, WebSocket stream, webhooks, and an MCP server.
> Built to be developed in **Herdr** with multiple coding agents, with **TypeSafe Jev** doing fast triage (routing tasks, labeling mail, gating commands).

---

## 1. Project summary

| | |
|---|---|
| **What** | API-first email platform where agents (not humans) are the primary users |
| **Where it runs** | 100% on your machine via Docker Compose — no real domain or DNS required |
| **Who uses it** | Your coding / browser / support agents (Claude Code, Codex, Hermes, custom scripts) |
| **Core loop** | `create inbox → receive email → event fires → agent reads thread → agent replies` |
| **Jev's role** | Classify every inbound message (spam, intent, urgency, needs-human) in <500 ms and label it before the agent sees it |

### Goals
- Create an inbox in one API call (`support-bot@localmail.test`)
- Full two-way email: send, receive, reply, forward, with correct threading
- Real-time delivery to agents via webhooks **and** WebSockets
- Multi-tenant isolation (pods) and scoped API keys
- First-class agent tooling: TypeScript SDK, CLI, MCP server
- Smart inbox powered by Jev (auto labels, spam filter, priority)

### Non-goals (v1)
- Public internet deliverability (SPF/DKIM/DMARC are **simulated/stubbed**, see Phase 5)
- Human-facing webmail as a primary product (dashboard is for debugging/admin only)
- Billing, usage plans

---

## 2. Features

### 2.1 Inboxes
- Create / list / get / update / delete inboxes
- Auto-generated address (`agent-7f3k@localmail.test`) or custom username
- Display name, metadata (JSON), `client_id` for idempotent creation
- Inbox belongs to exactly one **pod** (tenant)

### 2.2 Messages & threads
- **Send** new message (to/cc/bcc, subject, text, html, attachments, labels)
- **Reply** / **reply-all** / **forward** — sets `In-Reply-To` + `References` correctly
- **Receive** inbound mail via a local SMTP server (port 2525)
- Auto-threading by `Message-ID` / `References` headers, fallback to normalized subject
- List messages & threads with filters: labels, before/after, sender, unread, pagination (cursor)
- Get raw `.eml` for any message
- Extracted fields: `text`, `html`, `extracted_text` (reply stripped of quoted history), `preview`

### 2.3 Drafts
- Create / update / list / delete drafts
- Send a draft (converts to message)
- Scheduled send (`send_at`)

### 2.4 Attachments
- Upload with message send (base64 or multipart)
- Store in object storage (MinIO), metadata in DB
- Download by ID; signed, expiring URLs

### 2.5 Labels
- System labels: `inbox`, `sent`, `draft`, `unread`, `spam`, `trash`
- Custom labels per inbox (add/remove on message or thread)
- **Smart labels via Jev** (see §5)

### 2.6 Real-time events
- **Webhooks**: register URL + event types; HMAC-SHA256 signed payloads; retries with exponential backoff; delivery log
- **WebSockets**: `ws://localhost:8080/v1/ws` — subscribe to inboxes / event types; live push
- Event types:
  - `message.received`
  - `message.sent`
  - `message.delivered`
  - `message.bounced`
  - `message.labeled` (from Jev)
  - `thread.created`
  - `domain.verified`

### 2.7 Pods (multi-tenancy) & auth
- Pod = isolated tenant (inboxes, keys, webhooks, domains)
- API keys: `lm_live_…`, hashed at rest, scoped to pod, optional scope list (`inboxes:read`, `messages:send`, …)
- Rate limiting per key

### 2.8 Allow / block lists
- Per inbox or per pod: allow or block senders/domains (`*@spam.com`)
- Blocked mail stored with `spam` label or dropped (configurable)

### 2.9 Search
- Full-text search over subject/body (Postgres `tsvector`)
- Optional semantic search (pgvector + local embeddings) — Phase 5

### 2.10 Custom domains (simulated)
- Add domain → returns required DNS records (MX, SPF, DKIM, DMARC)
- Local "verify" endpoint that checks a mock DNS table → `domain.verified` event
- DKIM signing of outbound mail with a generated key pair

### 2.11 Agent tooling
- **TypeScript SDK** (`@localmail/sdk`)
- **Python SDK** (optional, Phase 5)
- **CLI** (`localmail inbox create`, `localmail send`, `localmail tail`)
- **MCP server** exposing tools: `create_inbox`, `list_threads`, `get_thread`, `send_message`, `reply`, `add_label`, `wait_for_email`
- `wait_for_email` helper — blocks until a matching mail arrives (great for signup/OTP flows in browser agents)

### 2.12 Admin dashboard
- Pods, inboxes, threads viewer, raw headers, webhook delivery log, Jev label decisions + confidence

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** (Node 20+) | One language across API, SDK, CLI, MCP, dashboard |
| Monorepo | **pnpm workspaces + Turborepo** | Parallel builds; agents can own separate packages |
| API server | **Fastify** + `@fastify/websocket` | Fast, schema-first, built-in WS |
| Validation / OpenAPI | **Zod** + `fastify-type-provider-zod` + `@fastify/swagger` | Types + generated OpenAPI spec → SDK generation |
| Database | **PostgreSQL 16** (+ `pgvector` later) | Relational threads, full-text search |
| ORM / migrations | **Drizzle ORM** + drizzle-kit | Typed SQL, simple migrations |
| Queue / jobs | **Redis 7 + BullMQ** | Webhook retries, scheduled sends, Jev classification jobs |
| Inbound SMTP | **`smtp-server`** (Nodemailer project) | Local MX on port 2525 |
| MIME parsing | **`mailparser`** | Headers, bodies, attachments |
| Outbound | **Nodemailer** → **Mailpit** (local SMTP catcher, UI on :8025) | See every outbound email without the real internet |
| Reply stripping | **`email-reply-parser`** | `extracted_text` |
| Object storage | **MinIO** (S3 API) | Attachments, raw `.eml` |
| AI triage | **TypeSafe Jev** via `@typesafe-ai/sdk` | Fast, cheap classification (labels, spam, priority) |
| Auth | API keys (argon2 hashed), HMAC webhook signing | Simple, agent-friendly |
| Dashboard | **Next.js 15** + Tailwind + shadcn/ui + TanStack Query | Admin/debug UI |
| CLI | **commander** + `@localmail/sdk` | Scriptable |
| MCP | **`@modelcontextprotocol/sdk`** | Plug into Claude Code / Codex / Hermes |
| Testing | **Vitest**, **Supertest**, **Testcontainers** (Postgres/Redis) | Unit + integration |
| E2E | **Playwright** (dashboard) | UI checks |
| Lint/format | ESLint + Prettier (or Biome) | Consistency across agents |
| Infra | **Docker Compose** | One command to start everything |
| Observability | **pino** logs, `/healthz`, `/metrics` (prom-client) | Debugging |

---

## 4. Architecture

```
                    ┌──────────────────────────┐
  Test sender ──SMTP:2525──▶  Inbound SMTP worker │── parse (mailparser) ──┐
  (swaks / script)  └──────────────────────────┘                          │
                                                                          ▼
┌────────────┐  REST/WS   ┌──────────────────┐   SQL   ┌──────────────┐  ┌────────┐
│ Agents     │◀──────────▶│  Fastify API     │◀──────▶│ PostgreSQL   │  │ MinIO  │
│ SDK / CLI  │            │  :8080           │         └──────────────┘  └────────┘
│ MCP server │            └──────┬───────────┘                ▲
└────────────┘                   │ enqueue                     │
                                 ▼                             │
                         ┌──────────────┐   ┌───────────────────────────┐
                         │ Redis/BullMQ │──▶│ Workers                   │
                         └──────────────┘   │  • jev-classify           │──▶ TypeSafe Jev API
                                            │  • webhook-deliver (retry)│──▶ Agent webhook URLs
                                            │  • scheduled-send         │──▶ Mailpit :1025 (outbound)
                                            │  • ws-broadcast (pub/sub) │
                                            └───────────────────────────┘
  Dashboard (Next.js :3000) ──▶ API
```

### Inbound flow
1. SMTP server accepts mail for `*@localmail.test` (or verified custom domains)
2. Resolve recipient → inbox (reject 550 if unknown)
3. Check allow/block lists
4. Parse MIME, store raw `.eml` + attachments in MinIO
5. Find/create thread, insert message with labels `inbox, unread`
6. Emit `message.received` → WS + webhook queue
7. Enqueue `jev-classify` → add smart labels → emit `message.labeled`

### Outbound flow
1. `POST /v1/inboxes/:id/messages/send`
2. Validate, build MIME, sign DKIM (if domain configured)
3. Send via Nodemailer → Mailpit (dev) or a real SMTP relay (prod toggle)
4. If recipient is another LocalMail inbox, **loop back** directly to inbound (agent-to-agent email!)
5. Store in `sent`, emit `message.sent` / `message.delivered`

---

## 5. Jev integration (the "smart" part)

Use Jev's System One model for the fast yes/no and pick-one decisions it's good at. Don't use it for writing replies.

| Decision | Jev question type | Output → action |
|---|---|---|
| Is this spam/phishing? | `Noul` | `spam` label, suppress webhook if configured |
| What is it about? | `Choice` (`billing`, `support`, `sales`, `otp/verification`, `newsletter`, `personal`, `other`) | Category label |
| Is it urgent? | `Noul` | `urgent` label |
| Does it need a human? | `Noul` | `needs-human` label + dashboard highlight |
| Is it an auto-reply / bounce? | `Noul` | `auto` label; skip agent triggers (prevents reply loops) |
| Contains OTP / verification link? | `Noul` | `otp` label; `wait_for_email` resolves faster |

```ts
// packages/workers/src/jev-classify.ts (sketch)
import { Choice, Noul, TypeSafeClient } from "@typesafe-ai/sdk";
const jev = new TypeSafeClient(); // reads TYPESAFE_API_KEY

export async function classify(msg: { from: string; subject: string; text: string }) {
  const r = await jev.systemOne({
    state: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${msg.text.slice(0, 4000)}`,
    questions: {
      category: Choice("What is this email about?", {
        billing: "Payments, invoices, refunds",
        support: "Help request or bug report",
        sales: "Buying interest or pricing",
        otp: "Verification code or confirm link",
        newsletter: "Bulk marketing or updates",
        other: "Anything else",
      }),
      spam: Noul("Email is spam or phishing"),
      urgent: Noul("Sender conveys urgency"),
      needsHuman: Noul("Needs a human decision, not an automated reply"),
      auto: Noul("Automated message such as out-of-office or bounce"),
    },
  });
  return r.answers;
}
```

- Store every decision (`jev_decisions` table) with confidence + latency for the dashboard
- Feature flag: `JEV_ENABLED=false` → fall back to simple rules (keyword + header heuristics) so the project works without a key
- Never send the API key to clients; workers only

---

## 6. Data model (PostgreSQL)

```
pods            (id, name, created_at)
api_keys        (id, pod_id, prefix, hash, scopes[], last_used_at, revoked_at)
domains         (id, pod_id, domain, status, dkim_private_key, dns_records jsonb)
inboxes         (id, pod_id, username, domain, address UNIQUE, display_name,
                 metadata jsonb, client_id UNIQUE NULL, created_at)
threads         (id, inbox_id, subject_normalized, last_message_at, message_count,
                 labels text[], preview)
messages        (id, inbox_id, thread_id, message_id_header UNIQUE, in_reply_to,
                 references text[], direction ENUM(inbound,outbound),
                 from, to[], cc[], bcc[], subject, text, html, extracted_text,
                 labels text[], raw_object_key, size_bytes, sent_at, received_at,
                 search tsvector)
attachments     (id, message_id, filename, content_type, size, object_key, content_id)
drafts          (id, inbox_id, thread_id NULL, to[], cc[], subject, text, html,
                 send_at NULL, status)
webhooks        (id, pod_id, url, secret, event_types[], inbox_ids[] NULL, enabled)
webhook_deliveries (id, webhook_id, event_id, status, attempts, last_error, next_retry_at)
events          (id, pod_id, type, payload jsonb, created_at)
sender_rules    (id, pod_id, inbox_id NULL, pattern, action ENUM(allow,block))
jev_decisions   (id, message_id, answers jsonb, latency_ms, created_at)
```

Indexes: `messages(inbox_id, received_at DESC)`, `threads(inbox_id, last_message_at DESC)`, GIN on `labels` and `search`.

---

## 7. REST API (v1)

Base: `http://localhost:8080/v1` · Auth: `Authorization: Bearer lm_live_…` · OpenAPI at `/docs`

| Method | Path | Purpose |
|---|---|---|
| POST | `/pods` | Create pod (admin key) |
| POST | `/api-keys` | Create API key |
| POST | `/inboxes` | Create inbox |
| GET | `/inboxes` | List inboxes |
| GET/PATCH/DELETE | `/inboxes/:inbox_id` | Manage inbox |
| GET | `/inboxes/:inbox_id/threads` | List threads (`labels`, `before`, `after`, `limit`, `page_token`) |
| GET | `/inboxes/:inbox_id/threads/:thread_id` | Thread with messages |
| GET | `/inboxes/:inbox_id/messages` | List messages |
| GET | `/inboxes/:inbox_id/messages/:message_id` | Get message |
| GET | `/inboxes/:inbox_id/messages/:message_id/raw` | Raw `.eml` |
| POST | `/inboxes/:inbox_id/messages/send` | Send new |
| POST | `/inboxes/:inbox_id/messages/:message_id/reply` | Reply (`reply_all` flag) |
| POST | `/inboxes/:inbox_id/messages/:message_id/forward` | Forward |
| PATCH | `/inboxes/:inbox_id/messages/:message_id` | Add/remove labels |
| GET | `/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id` | Download |
| CRUD | `/inboxes/:inbox_id/drafts[/:draft_id]` | Drafts |
| POST | `/inboxes/:inbox_id/drafts/:draft_id/send` | Send draft |
| GET | `/search?q=…&inbox_id=…` | Full-text search |
| CRUD | `/webhooks[/:id]` | Webhooks |
| GET | `/webhooks/:id/deliveries` | Delivery log |
| POST | `/webhooks/:id/test` | Fire test event |
| CRUD | `/domains[/:id]` | Custom domains |
| POST | `/domains/:id/verify` | Verify (mock DNS) |
| CRUD | `/lists[/:id]` | Allow/block rules |
| GET | `/ws` | WebSocket upgrade |

**Conventions:** cursor pagination (`page_token`), `Idempotency-Key` header on POST, error body `{ "error": { "code", "message" } }`, ISO-8601 timestamps, IDs prefixed (`inb_`, `thr_`, `msg_`).

### Webhook payload
```json
{
  "id": "evt_01J…",
  "type": "message.received",
  "created_at": "2026-09-22T14:03:11Z",
  "pod_id": "pod_…",
  "data": { "inbox_id": "inb_…", "thread_id": "thr_…", "message": { "...": "..." } }
}
```
Headers: `X-LocalMail-Signature: t=…,v1=<hmac_sha256(secret, t + "." + body)>`, `X-LocalMail-Event-Id`. Retries: 1m, 5m, 30m, 2h, 12h, then mark failed.

### WebSocket protocol
```json
→ { "type": "subscribe", "inbox_ids": ["inb_…"], "event_types": ["message.received"] }
← { "type": "subscribed" }
← { "type": "event", "event": { …same as webhook… } }
```

---

## 8. Repository layout

```
localmail/
├── apps/
│   ├── api/                 # Fastify REST + WS
│   ├── smtp/                # Inbound SMTP server
│   ├── workers/             # BullMQ: jev-classify, webhooks, scheduled-send
│   ├── dashboard/           # Next.js admin UI
│   └── mcp/                 # MCP server
├── packages/
│   ├── db/                  # Drizzle schema, migrations, seed
│   ├── core/                # Domain logic: threading, MIME build, labels, rules
│   ├── sdk/                 # @localmail/sdk (generated from OpenAPI + helpers)
│   ├── cli/                 # localmail CLI
│   └── config/              # tsconfig, eslint, shared env loader (zod)
├── examples/
│   ├── auto-reply-agent/    # replies to support mail
│   ├── otp-signup-agent/    # wait_for_email for verification codes
│   └── agent-to-agent/      # two inboxes negotiating a meeting
├── docker-compose.yml       # postgres, redis, minio, mailpit
├── .env.example
├── TASKS.md                 # task list for Herdr agents (see §10)
└── agentmail.md             # this file
```

---

## 9. Local setup

### Prerequisites
Node 20+, pnpm 9+, Docker Desktop, a TypeSafe API key (optional), `swaks` (optional, for sending test mail).

### `.env.example`
```bash
DATABASE_URL=postgres://localmail:localmail@localhost:5432/localmail
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minio
S3_SECRET_KEY=minio12345
S3_BUCKET=localmail
SMTP_INBOUND_PORT=2525
SMTP_OUTBOUND_HOST=localhost
SMTP_OUTBOUND_PORT=1025          # Mailpit
MAIL_DOMAIN=localmail.test
API_PORT=8080
ADMIN_API_KEY=lm_admin_change_me
JEV_ENABLED=true
TYPESAFE_API_KEY=                # keep out of git
```

### `docker-compose.yml` services
- `postgres:16` (with pgvector image later) → 5432
- `redis:7` → 6379
- `minio/minio` → 9000 / console 9001
- `axllent/mailpit` → SMTP 1025 / UI 8025

### Run
```bash
pnpm install
docker compose up -d
pnpm db:migrate && pnpm db:seed      # creates pod + admin key + demo inbox
pnpm dev                              # api, smtp, workers, dashboard in parallel (turbo)
```

### Smoke test
```bash
# create inbox
curl -s -X POST localhost:8080/v1/inboxes \
  -H "Authorization: Bearer $LM_KEY" -H "Content-Type: application/json" \
  -d '{"username":"support-bot","display_name":"Support Bot"}'

# send it an email
swaks --server localhost:2525 --to support-bot@localmail.test \
  --from alice@example.com --header "Subject: I was charged twice!" \
  --body "Please refund ASAP."

# watch it arrive + get labeled
pnpm --filter cli start tail support-bot@localmail.test
```
Expected: message appears with labels `inbox, unread, billing, urgent` and a `message.labeled` event.

---

## 10. Milestones & Herdr agent tasks

Each task is sized so a single agent in a Herdr pane can own it. Use `herdr-jev` (`prefix + j`) to route each one; run `jev-gate` in dry-run to watch command approvals.

### Phase 0 — Foundation
1. Scaffold pnpm + Turborepo monorepo, shared tsconfig/eslint, `packages/config` env loader (zod)
2. `docker-compose.yml` for postgres, redis, minio, mailpit + healthchecks
3. `packages/db`: Drizzle schema for all tables in §6, migrations, seed script

### Phase 1 — Core email (MVP)
4. API skeleton: Fastify, auth middleware (API key hash lookup), error format, OpenAPI `/docs`, `/healthz`
5. Inboxes CRUD + idempotent `client_id`
6. Inbound SMTP server: recipient resolution, mailparser, MinIO storage, insert message
7. Threading engine in `packages/core` (headers first, subject fallback) + unit tests
8. Send / reply / forward via Nodemailer → Mailpit, with correct headers; local loopback delivery
9. List/get threads & messages with cursor pagination and label filters
10. Attachments: upload on send, download endpoint, signed URLs

### Phase 2 — Real-time
11. Events table + BullMQ webhook worker with HMAC signing and retry schedule
12. Webhook CRUD, test-fire, delivery log
13. WebSocket endpoint with subscribe filters (Redis pub/sub fan-out)

### Phase 3 — Smart inbox (Jev)
14. `jev-classify` worker + `jev_decisions` table + `message.labeled` event
15. Rules fallback when `JEV_ENABLED=false`
16. Allow/block lists applied before classification
17. Reply-loop protection (skip `auto` mail, `Auto-Submitted` header)

### Phase 4 — Agent tooling
18. OpenAPI → `@localmail/sdk` + hand-written helpers (`waitForEmail`, `replyToThread`)
19. CLI: `inbox create|list`, `send`, `reply`, `tail`, `threads`
20. MCP server with tools listed in §2.11; test from Claude Code
21. Examples: auto-reply agent, OTP signup agent, agent-to-agent

### Phase 5 — Polish / stretch
22. Drafts + scheduled send
23. Pods + scoped API keys + rate limiting
24. Custom domains (mock DNS verify, DKIM signing)
25. Full-text search; then pgvector semantic search
26. Next.js dashboard (inboxes, thread viewer, webhook log, Jev decisions)
27. Python SDK
28. Metrics + structured logging + load test (k6: 1,000 inboxes, 10k messages)

---

## 11. Testing strategy

| Level | Tooling | What |
|---|---|---|
| Unit | Vitest | Threading, subject normalization, MIME building, HMAC signing, rule matching |
| Integration | Vitest + Testcontainers | API routes against real Postgres/Redis |
| Email E2E | Script + swaks + Mailpit API | Send → receive → thread → reply round trip |
| Webhook | Local receiver (`examples/webhook-receiver`) | Signature verify, retries on 500 |
| Jev | Recorded fixtures + `JEV_ENABLED=false` path | 20 sample emails with expected labels |
| UI | Playwright | Dashboard smoke |

**Fixture set:** `fixtures/emails/*.eml` — billing complaint, OTP code, newsletter, phishing, out-of-office, bounce, multi-part with attachment, long reply chain, non-UTF-8 charset.

---

## 12. Acceptance criteria (MVP = Phases 0–3)

- [ ] `docker compose up -d && pnpm dev` starts everything with no manual steps beyond `.env`
- [ ] Create inbox → address works in < 100 ms
- [ ] External (swaks) email lands in the correct inbox and thread
- [ ] Reply from API appears in Mailpit with correct `In-Reply-To`/`References`, and a reply to that reply threads correctly
- [ ] Inbox-to-inbox email works without Mailpit
- [ ] `message.received` reaches a webhook (signed) and a WS subscriber within 1 s
- [ ] Failed webhook retries per schedule and shows in delivery log
- [ ] Jev labels each inbound message; decision + latency stored; works with Jev disabled
- [ ] All tests green in CI (`pnpm test`), lint clean
- [ ] No secrets in repo; API keys hashed at rest

---

## 13. Security notes
- Hash API keys (argon2), show once on creation
- Verify webhook signatures in examples; include timestamp tolerance (5 min)
- Sanitize HTML (`sanitize-html`) before dashboard render
- Attachment size limit (25 MB) and content-type allowlist for previews
- SMTP: accept only for known domains; limit message size; no open relay
- `TYPESAFE_API_KEY` only in workers' env; never logged
- Prompt-injection awareness: email bodies are untrusted input — agents built on top must treat them as data, not instructions

---

## 14. References
- AgentMail — https://www.agentmail.to/ · docs: https://docs.agentmail.to/
- TypeSafe Jev — https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Herdr — https://github.com/herdrdev/herdr · herdr-jev — https://github.com/flaviomartil/herdr-jev · jev-gate — https://github.com/timjonez/jev-gate
- Nodemailer `smtp-server` / `mailparser` — https://nodemailer.com/extras/
- Mailpit — https://mailpit.axllent.org/
- MCP TypeScript SDK — https://github.com/modelcontextprotocol/typescript-sdk
