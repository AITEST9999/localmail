# LocalMail k6 load test

Install k6, start the real LocalMail stack, then run:

```bash
LOCALMAIL_API_URL=http://127.0.0.1:8080 \
LOCALMAIL_API_KEY="$ADMIN_API_KEY" \
K6_INBOXES=1000 K6_MESSAGES=10000 k6 run k6/load.js
```

For a quick local run use `K6_INBOXES=10 K6_MESSAGES=100 K6_RPS=5 K6_DURATION=30s`. The setup phase is idempotent via `client_id`; messages are intentionally retained in the local test database. HTTP-only k6 exercises API send/read paths, not SMTP protocol load.
