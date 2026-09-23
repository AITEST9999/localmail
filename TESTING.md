# Hand-testing LocalMail

A 15–30 minute operator checklist for verifying the live LocalMail deployment end-to-end. Numbered, copy-pasteable, no code reading required.

---

## 1. Prerequisites

- **Tools:** `curl`, a browser. (`jq` is optional — used for one convenience one-liner, skip it if you don't have it.)
- **Access:** Railway project access, to read `ADMIN_API_KEY` from the **API service's environment variables** in the Railway dashboard. Do not ask anyone to paste it into chat or a file — copy it directly from Railway into your shell.
- **What's already live:** the API, the dashboard, Mailpit, and an inbound SMTP TCP proxy are all deployed on Railway already — this checklist verifies them, it doesn't stand anything up.

---

## 2. Live URLs

Use exactly these:

| | |
|---|---|
| API | https://api-production-717c.up.railway.app |
| Dashboard | https://dashboard-production-9fad.up.railway.app |
| Mailpit | https://mailpit-production-4625.up.railway.app |
| Inbound SMTP (TCP) | `roundhouse.proxy.rlwy.net:38181` |

Set up your shell:

```bash
export API_BASE=https://api-production-717c.up.railway.app

# Get this from Railway → API service → Variables. Never commit it, never paste it into a file.
export ADMIN_API_KEY=...   # paste from Railway UI only
```

---

## 3. Domain note

No real DNS is needed to run this checklist. The API, dashboard, and Mailpit each have their own HTTPS URL, and inboxes use `MAIL_DOMAIN=localmail.test` — a fake domain that's perfectly valid for inbox-to-inbox mail and everything below. A real domain is only needed if you want LocalMail sending/receiving on the public internet (real MX/SPF/DKIM records) — not part of this checklist.

---

## 4. End-to-end checklist

Work through these in order — later steps assume the inboxes from step 3 exist.

### Step 1 — API health

```bash
curl -s "$API_BASE/healthz"
```

**Pass:** `200`, JSON like:
```json
{ "status": "ok", "service": "localmail-api", "timestamp": "2026-09-23T12:00:00.000Z" }
```

### Step 2 — Authenticated request

```bash
curl -s "$API_BASE/v1/me" -H "Authorization: Bearer $ADMIN_API_KEY"
```

**Pass:** `200`, JSON with `pod_id`, `api_key_id`, and a `scopes` array. If you get `401`, double-check you copied the current value of `ADMIN_API_KEY` from Railway (not a stale/local one).

### Step 3 — Create two inboxes

```bash
curl -s -X POST "$API_BASE/v1/inboxes" \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"username":"alice","display_name":"Alice"}'

curl -s -X POST "$API_BASE/v1/inboxes" \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"username":"bob","display_name":"Bob"}'
```

**Pass:** `201` for each, response body has `id`, `address` (e.g. `alice@localmail.test`), `username`, `domain`, `created_at`. Copy each `id` value:

```bash
export ALICE_ID=inb_...   # paste from alice's response
export BOB_ID=inb_...     # paste from bob's response
```

(Convenience, if you have `jq` and re-run the two `curl` calls: append `| jq -r .id` to each and assign directly, e.g. `export ALICE_ID=$(curl -s -X POST ... | jq -r .id)`.)

**If `alice`/`bob` are already taken** (someone ran this checklist before you against the same deployment), you have two options — either is fine:
- **Reuse:** `GET "$API_BASE/v1/inboxes"` (with the same Bearer header), find the existing `alice`/`bob` rows, and copy their `id`s instead of creating new ones.
- **Pick unique names:** rerun step 3 with e.g. `"username":"alice-'"$(date +%s)"'"` (and same for bob) so you get fresh inboxes.

### Step 4 — Send a local message, alice → bob

```bash
curl -s -X POST "$API_BASE/v1/inboxes/$ALICE_ID/messages/send" \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":["bob@localmail.test"],"subject":"hello bob","text":"ping from alice"}'
```

**Pass:** `201`.

Then check it landed in bob's inbox:

```bash
curl -s "$API_BASE/v1/inboxes/$BOB_ID/messages" -H "Authorization: Bearer $ADMIN_API_KEY"
```

**Pass:** `200`, `data` array with at least one message (exactly one if you used fresh inboxes) whose `subject` is `"hello bob"` and whose `preview` contains `"ping from alice"` (the list view returns a truncated `preview`, not the full `text` — that's expected, not a bug).

This is a **local loopback send** — no external SMTP relay involved, both inboxes live on `localmail.test`.

### Step 5 — Full-text search

```bash
curl -s "$API_BASE/v1/search?q=hello&mode=fts" -H "Authorization: Bearer $ADMIN_API_KEY"
```

**Pass:** `200`, `data` array with at least one hit — the message from step 4 should be in it (matched on the `hello` in its subject).

### Step 6 — Dashboard login

1. Open https://dashboard-production-9fad.up.railway.app/login in a browser.
2. Paste the same `ADMIN_API_KEY` value into the API key field, click **Sign in**.
3. **Pass:** you land on `/inboxes` and see `alice` and `bob` (or whichever usernames you actually created) listed.

---

## 5. Known partial / not-yet-working

**External send (an inbox → a real external address) may fail at the Mailpit relay** with a `500` or an SMTP-AUTH-related error (Mailpit's `MP_SMTP_AUTH` setting). This is a **known limitation of the current Railway deployment, not a regression** — local loopback (step 4) is the fully-working path and is what this checklist verifies. If you want to poke at it anyway: send to any external-looking address from one of your inboxes and check https://mailpit-production-4625.up.railway.app for the message; a `500`/auth error there is expected right now, not something to chase down or file as new. Don't invent or try SMTP credentials to work around it.

---

## 6. Optional — local Docker Compose path (offline, no Railway)

If you'd rather test entirely on your own machine instead of the live Railway deployment:

```bash
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Then repeat this checklist against `http://localhost:8080` (API), `http://localhost:3000` (dashboard), and `http://localhost:8025` (Mailpit) instead of the Railway URLs — same requests, same pass criteria. See the README's **Quickstart (local)** section for details.

---

## 7. Optional — SMTP TCP connectivity smoke

Just confirms the inbound SMTP proxy is reachable — not a full SMTP conversation:

```bash
nc -vz roundhouse.proxy.rlwy.net 38181
# or, without nc:
timeout 3 bash -c 'echo >/dev/tcp/roundhouse.proxy.rlwy.net/38181' && echo open
```

**Pass:** connection succeeds (`nc` reports "succeeded" / the second form prints `open`).
