# LocalMail Python SDK

Repo-internal, editable-install client (not published to PyPI):

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e 'packages/sdk-python[test]'
```

```python
from localmail import LocalMail
client = LocalMail(api_key="lm_admin_…")
print(client.me())
print(client.inboxes.list().data)
client.close()
```

The client exposes inboxes, threads, messages, drafts, webhooks, domains, API keys, search, `me`, polling `wait_for_email`, and `verify_webhook_signature`.
