import { Queue, type ConnectionOptions } from 'bullmq';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { MessageEvent, MessageEventPublisher } from '@localmail/core';
import {
  createId,
  events,
  webhookDeliveries,
  webhooks,
  type Database,
} from '@localmail/db';

import { planEventFanout } from './fanout.js';
import {
  JEV_CLASSIFY_JOB,
  JEV_CLASSIFY_JOB_OPTIONS,
  JEV_CLASSIFY_QUEUE,
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_DELIVER_JOB_OPTIONS,
  WEBHOOK_DELIVER_QUEUE,
  type JevClassifyJobData,
  type WebhookDeliverJobData,
  EMBED_MESSAGE_JOB,
  EMBED_MESSAGE_JOB_OPTIONS,
  EMBED_MESSAGE_QUEUE,
  type EmbedMessageJobData,
} from './queue.js';
import { wsChannelForPod } from './ws-channel.js';

export interface WebhookEventEnvelope {
  id: string;
  type: string;
  created_at: string;
  pod_id: string;
  data: Record<string, unknown>;
}

export interface TestFireResult {
  eventId: string;
  deliveryId: string;
}

export interface DurableEventPublisher extends MessageEventPublisher {
  /**
   * Synthetic `webhook.test` for P2-12: one delivery forced to `webhookId`,
   * ignoring that webhook's enabled/event_types/inbox_ids filters.
   * Never publishes to the WS Redis channel.
   */
  enqueueTestFire(input: {
    podId: string;
    webhookId: string;
  }): Promise<TestFireResult>;
  close(): Promise<void>;
}

export function createDurableEventPublisher(
  db: Database,
  queueConnection: ConnectionOptions,
): DurableEventPublisher {
  const webhookQueue = new Queue<WebhookDeliverJobData>(WEBHOOK_DELIVER_QUEUE, {
    connection: queueConnection,
  });
  const jevQueue = new Queue<JevClassifyJobData>(JEV_CLASSIFY_QUEUE, {
    connection: queueConnection,
  });
  const embedQueue = new Queue<EmbedMessageJobData>(EMBED_MESSAGE_QUEUE, { connection: queueConnection });

  async function enqueueDeliveries(deliveryIds: string[]): Promise<void> {
    // Known limitation (design §1): if enqueue fails after commit, deliveries
    // stay pending with no BullMQ job. No reconciliation sweep in Phase 2.
    for (const deliveryId of deliveryIds) {
      await webhookQueue.add(
        WEBHOOK_DELIVER_JOB,
        { deliveryId },
        {
          ...WEBHOOK_DELIVER_JOB_OPTIONS,
          jobId: deliveryId,
        },
      );
    }
  }

  async function enqueueJevClassify(messageId: string): Promise<void> {
    await jevQueue.add(
      JEV_CLASSIFY_JOB,
      { messageId },
      {
        ...JEV_CLASSIFY_JOB_OPTIONS,
        jobId: `jev-${messageId}`,
      },
    );
  }
  async function enqueueEmbedding(messageId: string): Promise<void> {
    await embedQueue.add(EMBED_MESSAGE_JOB, { messageId }, { ...EMBED_MESSAGE_JOB_OPTIONS, jobId: `embed-${messageId}` });
  }

  async function publishWs(
    podId: string,
    envelope: WebhookEventEnvelope,
  ): Promise<void> {
    const redis = asPublishableRedis(queueConnection);
    if (!redis) return;
    await redis.publish(wsChannelForPod(podId), JSON.stringify(envelope));
  }

  return {
    async emit(event: MessageEvent) {
      const eventId = createId('evt');
      const createdAt = new Date();
      const fanout = planEventFanout(event);
      const payload: Record<string, unknown> = {
        inbox_id: event.inboxId,
        thread_id: event.threadId,
        message_id: event.messageId,
      };
      if (event.type === 'message.labeled') {
        payload.labels = event.labels;
      }
      if (
        event.type === 'message.received' &&
        event.suppressAgentTriggers === true
      ) {
        payload.suppress_agent_triggers = true;
      }
      const envelope: WebhookEventEnvelope = {
        id: eventId,
        type: event.type,
        created_at: createdAt.toISOString(),
        pod_id: event.podId,
        data: payload,
      };

      const deliveryIds = await db.transaction(async (tx) => {
        await tx.insert(events).values({
          id: eventId,
          podId: event.podId,
          type: event.type,
          payload,
          createdAt,
        });

        if (!fanout.webhooks) return [];

        const matches = await tx
          .select({ id: webhooks.id })
          .from(webhooks)
          .where(
            and(
              eq(webhooks.podId, event.podId),
              eq(webhooks.enabled, true),
              sql`${event.type} = ANY(${webhooks.eventTypes})`,
              or(
                isNull(webhooks.inboxIds),
                sql`${event.inboxId} = ANY(${webhooks.inboxIds})`,
              ),
            ),
          );

        const ids: string[] = [];
        for (const match of matches) {
          const deliveryId = createId('whd');
          ids.push(deliveryId);
          await tx.insert(webhookDeliveries).values({
            id: deliveryId,
            webhookId: match.id,
            eventId,
            status: 'pending',
            attempts: 0,
            lastError: null,
            nextRetryAt: null,
            createdAt,
          });
        }
        return ids;
      });

      const fanouts: Array<Promise<unknown>> = [];
      if (fanout.webhooks) fanouts.push(enqueueDeliveries(deliveryIds));
      if (fanout.ws) fanouts.push(publishWs(event.podId, envelope));
      if (fanout.jevClassify) fanouts.push(enqueueJevClassify(event.messageId));
      if (event.type === 'message.received') fanouts.push(enqueueEmbedding(event.messageId));
      if (fanouts.length > 0) await Promise.all(fanouts);
    },

    async enqueueTestFire({ podId, webhookId }) {
      const eventId = createId('evt');
      const deliveryId = createId('whd');
      const createdAt = new Date();

      await db.transaction(async (tx) => {
        const [webhook] = await tx
          .select({ id: webhooks.id })
          .from(webhooks)
          .where(and(eq(webhooks.id, webhookId), eq(webhooks.podId, podId)))
          .limit(1);
        if (!webhook) {
          throw new Error(`Webhook ${webhookId} not found in pod ${podId}`);
        }

        await tx.insert(events).values({
          id: eventId,
          podId,
          type: 'webhook.test',
          payload: { webhook_id: webhookId },
          createdAt,
        });

        await tx.insert(webhookDeliveries).values({
          id: deliveryId,
          webhookId,
          eventId,
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextRetryAt: null,
          createdAt,
        });
      });

      // No WS publish — webhook.test is diagnostic-only (design §4).
      await enqueueDeliveries([deliveryId]);
      return { eventId, deliveryId };
    },

    async close() {
      await Promise.all([webhookQueue.close(), jevQueue.close()]);
      await embedQueue.close();
    },
  };
}

function asPublishableRedis(connection: ConnectionOptions): Redis | null {
  if (
    connection &&
    typeof connection === 'object' &&
    'publish' in connection &&
    typeof (connection as Redis).publish === 'function'
  ) {
    return connection as Redis;
  }
  return null;
}
