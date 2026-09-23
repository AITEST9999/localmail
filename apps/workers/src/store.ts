import { eq } from 'drizzle-orm';

import {
  events,
  webhookDeliveries,
  webhooks,
  type Database,
} from '@localmail/db';

import type {
  DeliveryRecord,
  EventRecord,
  WebhookDeliveryStore,
  WebhookRecord,
} from './deliver.js';

export function createDrizzleWebhookDeliveryStore(
  db: Database,
): WebhookDeliveryStore {
  return {
    async getDelivery(deliveryId) {
      const rows = await db
        .select({
          delivery: webhookDeliveries,
          event: events,
          webhook: webhooks,
        })
        .from(webhookDeliveries)
        .innerJoin(events, eq(webhookDeliveries.eventId, events.id))
        .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
        .where(eq(webhookDeliveries.id, deliveryId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        delivery: toDelivery(row.delivery),
        event: toEvent(row.event),
        webhook: toWebhook(row.webhook),
      };
    },

    async markDelivering(deliveryId, attempts) {
      await db
        .update(webhookDeliveries)
        .set({ status: 'delivering', attempts })
        .where(eq(webhookDeliveries.id, deliveryId));
    },

    async markDelivered(deliveryId) {
      await db
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          lastError: null,
          nextRetryAt: null,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
    },

    async markAttemptFailed({ deliveryId, status, lastError, nextRetryAt }) {
      await db
        .update(webhookDeliveries)
        .set({ status, lastError, nextRetryAt })
        .where(eq(webhookDeliveries.id, deliveryId));
    },
  };
}

function toDelivery(
  row: typeof webhookDeliveries.$inferSelect,
): DeliveryRecord {
  return {
    id: row.id,
    webhookId: row.webhookId,
    eventId: row.eventId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    nextRetryAt: row.nextRetryAt,
  };
}

function toEvent(row: typeof events.$inferSelect): EventRecord {
  return {
    id: row.id,
    podId: row.podId,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

function toWebhook(row: typeof webhooks.$inferSelect): WebhookRecord {
  return {
    id: row.id,
    url: row.url,
    secretCiphertext: row.secret,
  };
}
