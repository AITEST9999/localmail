import hashlib, hmac, json
import httpx
import pytest
from localmail import LocalMail, LocalMailError, verify_webhook_signature

def transport(handler): return httpx.Client(transport=httpx.MockTransport(handler))

def test_retry_get_and_me():
    calls = []
    def handler(request):
        calls.append(request); return httpx.Response(503 if len(calls) == 1 else 200, json={"pod_id":"p","api_key_id":"k","scopes":["*"]})
    sdk = LocalMail("key", client=transport(handler)); assert sdk.me()["pod_id"] == "p"; assert len(calls) == 2

def test_post_not_retried_without_idempotency():
    calls = []
    def handler(request): calls.append(request); return httpx.Response(503, json={"error":{"code":"internal_error","message":"down"}})
    sdk = LocalMail("key", client=transport(handler))
    with pytest.raises(LocalMailError): sdk.inboxes.create({"username":"x"})
    assert len(calls) == 1

def test_webhook_signature_vectors():
    ts, body, secret = 1700000000, '{"ok":true}', "secret"
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    assert verify_webhook_signature(secret, f"t={ts},v1={sig}", body, now=ts)
    assert not verify_webhook_signature(secret, f"t={ts},v1={'0'*64}", body, now=ts)

def test_wait_for_email_polls_then_returns():
    count = 0
    def handler(request):
        nonlocal count; count += 1
        return httpx.Response(200, json={"data": ([{"id":"m1"}] if count > 1 else []), "next_page_token": None})
    sdk = LocalMail("key", client=transport(handler)); assert sdk.wait_for_email("i", timeout=1, poll_interval=0)["id"] == "m1"
