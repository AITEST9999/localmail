import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { encryptSecret } from '@localmail/core';

import {
  processWebhookDelivery,
  WebhookDeliveryError,
  type DeliveryRecord,
  type EventRecord,
  type WebhookDeliveryStore,
  type WebhookHttpClient,
  type WebhookHttpResponse,
  type WebhookRecord,
} from './deliver.js';
import {
  signWebhookBody,
  verifyWebhookSignature,
  buildWebhookBody,
} from './signature.js';

describe('processWebhookDelivery', () => {
  it('marks failed after five HTTP 500 responses and stops retrying', async () => {
    const harness = makeHarness({ status: 500, statusText: 'Internal Server Error' });
    const errors: string[] = [];

    for (let attemptsMade = 1; attemptsMade <= 5; attemptsMade += 1) {
      await expect(
        processWebhookDelivery({
          deliveryId: harness.delivery.id,
          attemptsMade,
          maxAttempts: 5,
          store: harness.store,
          httpClient: harness.httpClient,
          encryptionKey: harness.encryptionKey,
          now: () => new Date('2026-09-23T12:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(WebhookDeliveryError);
      errors.push(harness.delivery.lastError ?? '');
    }

    expect(harness.httpCalls).toBe(5);
    expect(harness.delivery.attempts).toBe(5);
    expect(harness.delivery.status).toBe('failed');
    expect(harness.delivery.nextRetryAt).toBeNull();
    expect(harness.delivery.lastError).toBe('HTTP 500 Internal Server Error');
    expect(errors.every((error) => error === 'HTTP 500 Internal Server Error')).toBe(
      true,
    );

    // A sixth call is not part of the contract; status stays failed.
    expect(harness.delivery.status).toBe('failed');
  });

  it('transitions pending → delivering → pending with next_retry_at between retries', async () => {
    const harness = makeHarness({ status: 503, statusText: 'Unavailable' });
    const clock = new Date('2026-09-23T12:00:00.000Z');

    await expect(
      processWebhookDelivery({
        deliveryId: harness.delivery.id,
        attemptsMade: 1,
        maxAttempts: 5,
        store: harness.store,
        httpClient: harness.httpClient,
        encryptionKey: harness.encryptionKey,
        now: () => clock,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryError);

    expect(harness.delivery.status).toBe('pending');
    expect(harness.delivery.attempts).toBe(1);
    expect(harness.delivery.nextRetryAt?.toISOString()).toBe(
      '2026-09-23T12:01:00.000Z',
    );
  });

  it('marks delivered on 2xx and clears last_error', async () => {
    const harness = makeHarness({ status: 204, statusText: 'No Content' });
    harness.delivery.lastError = 'prior failure';

    await processWebhookDelivery({
      deliveryId: harness.delivery.id,
      attemptsMade: 2,
      maxAttempts: 5,
      store: harness.store,
      httpClient: harness.httpClient,
      encryptionKey: harness.encryptionKey,
      now: () => new Date('2026-09-23T12:00:00.000Z'),
    });

    expect(harness.delivery.status).toBe('delivered');
    expect(harness.delivery.lastError).toBeNull();
    expect(harness.delivery.nextRetryAt).toBeNull();
    expect(harness.delivery.attempts).toBe(2);
  });
});

describe('webhook HMAC (agentmail.md §11)', () => {
  it('accepts a genuine signed payload and rejects a tampered body', () => {
    const secret = randomBytes(32).toString('hex');
    const envelope = {
      id: 'evt_test',
      type: 'message.received',
      created_at: '2026-09-23T12:00:00.000Z',
      pod_id: 'pod_local_dev',
      data: {
        inbox_id: 'inb_demo',
        thread_id: 'thr_demo',
        message_id: 'msg_demo',
      },
    };
    const body = buildWebhookBody(envelope);
    const t = 1_779_000_000;
    const signature = signWebhookBody(secret, body, t);

    expect(
      verifyWebhookSignature({
        secret,
        signatureHeader: signature,
        rawBody: body,
        nowUnixSeconds: t,
      }),
    ).toBe(true);

    const tampered = body.replace('msg_demo', 'msg_evil');
    expect(
      verifyWebhookSignature({
        secret,
        signatureHeader: signature,
        rawBody: tampered,
        nowUnixSeconds: t,
      }),
    ).toBe(false);
  });

  it('rejects signatures outside the 5-minute tolerance before checking HMAC', () => {
    const secret = 'test-secret';
    const body = '{"id":"evt_1"}';
    const t = 1_000_000;
    const signature = signWebhookBody(secret, body, t);

    expect(
      verifyWebhookSignature({
        secret,
        signatureHeader: signature,
        rawBody: body,
        nowUnixSeconds: t + 301,
      }),
    ).toBe(false);
  });
});

function makeHarness(response: WebhookHttpResponse) {
  const encryptionKey = randomBytes(32);
  const rawSecret = randomBytes(32).toString('hex');
  const delivery: DeliveryRecord = {
    id: 'dlv_test',
    webhookId: 'whk_test',
    eventId: 'evt_test',
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
  };
  const event: EventRecord = {
    id: 'evt_test',
    podId: 'pod_local_dev',
    type: 'message.received',
    payload: {
      inbox_id: 'inb_demo',
      thread_id: 'thr_demo',
      message_id: 'msg_demo',
    },
    createdAt: new Date('2026-09-23T11:00:00.000Z'),
  };
  const webhook: WebhookRecord = {
    id: 'whk_test',
    url: 'http://127.0.0.1:9/webhook',
    secretCiphertext: encryptSecret(rawSecret, encryptionKey),
  };

  let httpCalls = 0;
  const httpClient: WebhookHttpClient = {
    post() {
      httpCalls += 1;
      return Promise.resolve(response);
    },
  };

  const store: WebhookDeliveryStore = {
    getDelivery(deliveryId) {
      if (deliveryId !== delivery.id) return Promise.resolve(null);
      return Promise.resolve({ delivery, event, webhook });
    },
    markDelivering(deliveryId, attempts) {
      expect(deliveryId).toBe(delivery.id);
      delivery.status = 'delivering';
      delivery.attempts = attempts;
      return Promise.resolve();
    },
    markDelivered(deliveryId) {
      expect(deliveryId).toBe(delivery.id);
      delivery.status = 'delivered';
      delivery.lastError = null;
      delivery.nextRetryAt = null;
      return Promise.resolve();
    },
    markAttemptFailed({ deliveryId, status, lastError, nextRetryAt }) {
      expect(deliveryId).toBe(delivery.id);
      delivery.status = status;
      delivery.lastError = lastError;
      delivery.nextRetryAt = nextRetryAt;
      return Promise.resolve();
    },
  };

  return {
    delivery,
    store,
    httpClient,
    encryptionKey,
    get httpCalls() {
      return httpCalls;
    },
  };
}
