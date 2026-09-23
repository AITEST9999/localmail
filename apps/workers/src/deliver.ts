import { decryptSecret } from '@localmail/core';
import { webhookBackoffDelayMs } from '@localmail/events';

import {
  WEBHOOK_REQUEST_TIMEOUT_MS,
  buildWebhookBody,
  signWebhookBody,
  type WebhookEnvelope,
} from './signature.js';

export interface DeliveryRecord {
  id: string;
  webhookId: string;
  eventId: string;
  status: 'pending' | 'delivering' | 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
}

export interface EventRecord {
  id: string;
  podId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface WebhookRecord {
  id: string;
  url: string;
  secretCiphertext: string;
}

export interface WebhookDeliveryStore {
  getDelivery(deliveryId: string): Promise<{
    delivery: DeliveryRecord;
    event: EventRecord;
    webhook: WebhookRecord;
  } | null>;
  markDelivering(deliveryId: string, attempts: number): Promise<void>;
  markDelivered(deliveryId: string): Promise<void>;
  markAttemptFailed(input: {
    deliveryId: string;
    status: 'pending' | 'failed';
    lastError: string;
    nextRetryAt: Date | null;
  }): Promise<void>;
}

export interface WebhookHttpResponse {
  status: number;
  statusText: string;
}

export interface WebhookHttpClient {
  post(input: {
    url: string;
    body: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }): Promise<WebhookHttpResponse>;
}

export class WebhookDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryError';
  }
}

export interface ProcessWebhookDeliveryInput {
  deliveryId: string;
  /** 1-indexed current attempt (matches BullMQ attemptsMade during processing). */
  attemptsMade: number;
  maxAttempts: number;
  store: WebhookDeliveryStore;
  httpClient: WebhookHttpClient;
  encryptionKey: Buffer;
  now?: () => Date;
}

export async function processWebhookDelivery(
  input: ProcessWebhookDeliveryInput,
): Promise<void> {
  const now = input.now ?? (() => new Date());
  const loaded = await input.store.getDelivery(input.deliveryId);
  if (!loaded) {
    throw new WebhookDeliveryError(
      `Webhook delivery ${input.deliveryId} not found`,
    );
  }

  const { delivery, event, webhook } = loaded;
  if (delivery.status === 'delivered') return;

  await input.store.markDelivering(delivery.id, input.attemptsMade);

  const envelope: WebhookEnvelope = {
    id: event.id,
    type: event.type,
    created_at: event.createdAt.toISOString(),
    pod_id: event.podId,
    data: event.payload,
  };
  const body = buildWebhookBody(envelope);
  const timestampSeconds = Math.floor(now().getTime() / 1000);
  const secret = decryptSecret(webhook.secretCiphertext, input.encryptionKey);
  const signature = signWebhookBody(secret, body, timestampSeconds);

  let lastError: string;
  try {
    const response = await input.httpClient.post({
      url: webhook.url,
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-LocalMail-Signature': signature,
        'X-LocalMail-Event-Id': event.id,
      },
      timeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS,
    });

    if (response.status >= 200 && response.status <= 299) {
      await input.store.markDelivered(delivery.id);
      return;
    }
    lastError = truncateError(
      `HTTP ${response.status} ${response.statusText || ''}`.trim(),
    );
  } catch (error) {
    lastError = truncateError(formatFetchError(error));
  }

  const isLastAttempt = input.attemptsMade >= input.maxAttempts;
  await input.store.markAttemptFailed({
    deliveryId: delivery.id,
    status: isLastAttempt ? 'failed' : 'pending',
    lastError,
    nextRetryAt: isLastAttempt
      ? null
      : new Date(now().getTime() + webhookBackoffDelayMs(input.attemptsMade)),
  });
  throw new WebhookDeliveryError(lastError);
}

export function createFetchWebhookHttpClient(
  fetchImpl: typeof fetch = fetch,
): WebhookHttpClient {
  return {
    async post({ url, body, headers, timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
        return {
          status: response.status,
          statusText: response.statusText,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
          throw new WebhookDeliveryError(
            `request timed out after ${timeoutMs}ms`,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function formatFetchError(error: unknown): string {
  if (error instanceof WebhookDeliveryError) return error.message;
  if (error instanceof Error) return `fetch failed: ${error.message}`;
  return 'fetch failed: unknown error';
}

function truncateError(message: string): string {
  return message.length > 500 ? message.slice(0, 500) : message;
}
