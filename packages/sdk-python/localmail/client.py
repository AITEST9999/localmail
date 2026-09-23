from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any, Iterator

import httpx


class LocalMailError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def verify_webhook_signature(secret: str, header: str, body: str, tolerance_sec: int = 300, now: float | None = None) -> bool:
    try:
        parts = dict(item.split("=", 1) for item in header.split(","))
        timestamp, supplied = int(parts["t"]), parts["v1"]
        if abs(int(now if now is not None else time.time()) - timestamp) > tolerance_sec or len(supplied) != 64:
            return False
        expected = hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, supplied)
    except (ValueError, KeyError):
        return False


@dataclass
class Page:
    data: list[dict[str, Any]]
    next_page_token: str | None = None


class LocalMail:
    def __init__(self, api_key: str, base_url: str = "http://127.0.0.1:8080", *, client: httpx.Client | None = None, timeout: float = 10):
        self.base_url, self.api_key = base_url.rstrip("/"), api_key
        self._client = client or httpx.Client(timeout=timeout)
        self.inboxes = _Resource(self, "inboxes")
        self.threads = _Resource(self, "threads")
        self.messages = _Resource(self, "messages")
        self.drafts = _Resource(self, "drafts")
        self.webhooks = _Resource(self, "webhooks")
        self.domains = _Resource(self, "domains")
        self.api_keys = _Resource(self, "api-keys")

    def close(self): self._client.close()
    def me(self): return self._request("GET", "/v1/me")
    def search(self, q: str, **params): return self._request("GET", "/v1/search", params={"q": q, **params})
    def wait_for_email(self, inbox_id: str, *, timeout: float = 30, poll_interval: float = 1, after: str | None = None, **filters):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            params = {"limit": 50, **filters}
            if after: params["after"] = after
            page = self.messages.list(inbox_id, **params)
            if page.data:
                return page.data[0]
            time.sleep(poll_interval)
        raise TimeoutError(f"Timed out waiting for an email in {inbox_id}")

    def _request(self, method: str, path: str, *, json_body: Any = None, params: dict[str, Any] | None = None, idempotency_key: str | None = None, retries: int = 2):
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if idempotency_key: headers["Idempotency-Key"] = idempotency_key
        retryable = method == "GET" or idempotency_key is not None
        for attempt in range(retries + 1):
            response = self._client.request(method, self.base_url + path, headers=headers, json=json_body, params=params)
            if response.status_code < 500 or not retryable or attempt == retries: break
            time.sleep(0.1 * 2**attempt)
        if response.status_code >= 400:
            try: body = response.json().get("error", {})
            except ValueError: body = {}
            raise LocalMailError(response.status_code, body.get("code", "http_error"), body.get("message", f"HTTP {response.status_code}"), body.get("details"))
        return response.json() if response.content else None


class _Resource:
    def __init__(self, sdk: LocalMail, name: str): self.sdk, self.name = sdk, name
    def list(self, parent_id: str | None = None, **params) -> Page:
        path = f"/v1/inboxes/{parent_id}/{self.name}" if parent_id and self.name in {"threads", "messages", "drafts"} else f"/v1/{self.name}"
        body = self.sdk._request("GET", path, params={k: v for k, v in params.items() if v is not None})
        return Page(body.get("data", []), body.get("next_page_token"))
    def get(self, item_id: str, parent_id: str | None = None):
        path = f"/v1/inboxes/{parent_id}/{self.name}/{item_id}" if parent_id and self.name in {"threads", "messages", "drafts"} else f"/v1/{self.name}/{item_id}"
        return self.sdk._request("GET", path)
    def create(self, body: dict[str, Any], parent_id: str | None = None, *, idempotency_key: str | None = None): return self.sdk._request("POST", f"/v1/inboxes/{parent_id}/{self.name}" if parent_id and self.name in {"drafts"} else f"/v1/{self.name}", json_body=body, idempotency_key=idempotency_key)
    def update(self, item_id: str, body: dict[str, Any], parent_id: str | None = None): return self.sdk._request("PATCH", f"/v1/inboxes/{parent_id}/{self.name}/{item_id}" if parent_id else f"/v1/{self.name}/{item_id}", json_body=body)
    def delete(self, item_id: str, parent_id: str | None = None): return self.sdk._request("DELETE", f"/v1/inboxes/{parent_id}/{self.name}/{item_id}" if parent_id else f"/v1/{self.name}/{item_id}")
    def send(self, parent_id: str, body: dict[str, Any], *, idempotency_key: str | None = None): return self.sdk._request("POST", f"/v1/inboxes/{parent_id}/messages/send", json_body=body, idempotency_key=idempotency_key)
    def reply(self, parent_id: str, item_id: str, body: dict[str, Any], *, idempotency_key: str | None = None): return self.sdk._request("POST", f"/v1/inboxes/{parent_id}/messages/{item_id}/reply", json_body=body, idempotency_key=idempotency_key)
    def forward(self, parent_id: str, item_id: str, body: dict[str, Any], *, idempotency_key: str | None = None): return self.sdk._request("POST", f"/v1/inboxes/{parent_id}/messages/{item_id}/forward", json_body=body, idempotency_key=idempotency_key)
    def verify(self, item_id: str, dns_records: dict[str, Any]): return self.sdk._request("POST", f"/v1/domains/{item_id}/verify", json_body={"dns_records": dns_records})
    def send_draft(self, parent_id: str, item_id: str, *, idempotency_key: str | None = None): return self.sdk._request("POST", f"/v1/inboxes/{parent_id}/drafts/{item_id}/send", json_body={}, idempotency_key=idempotency_key)
