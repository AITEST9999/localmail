import { Worker, type ConnectionOptions, type Job } from 'bullmq';

import type { Env } from '@localmail/config';
import {
  createInboundIngestor,
  createS3ObjectStore,
  decodeEncryptionKey,
  decryptSecret,
} from '@localmail/core';
import { createDatabase } from '@localmail/db';
import {
  JEV_CLASSIFY_QUEUE,
  EMBED_MESSAGE_QUEUE,
  WEBHOOK_DELIVER_QUEUE,
  createDurableEventPublisher,
  createRedisConnection,
  webhookBackoffDelayMs,
  type JevClassifyJobData,
  type EmbedMessageJobData,
  type WebhookDeliverJobData,
} from '@localmail/events';
import {
  createNodemailerOutboundTransport,
  createOutboundMessageService,
} from '@localmail/api/outbound';
import { createDrizzleApiStore } from '@localmail/api/store';

import { processJevClassify } from './classify.js';
import {
  createFetchWebhookHttpClient,
  processWebhookDelivery,
} from './deliver.js';
import { createDrizzleWebhookDeliveryStore } from './store.js';
import { createScheduledSendPoller } from './scheduled-send.js';
import { processEmbedMessage } from './embed.js';

export const workerService = {
  name: 'localmail-workers',
  queues: ['jev-classify', 'webhook-deliver', 'scheduled-send', 'ws-broadcast', 'embed-message'],
  status: 'running',
} as const;

export interface WorkerRuntime {
  close(): Promise<void>;
}

export function createWorkerRuntime(
  env: Env,
  connection?: ConnectionOptions,
): WorkerRuntime {
  if (!env.APP_ENCRYPTION_KEY) {
    throw new Error(
      'APP_ENCRYPTION_KEY is required for webhook delivery workers.',
    );
  }
  if (env.JEV_ENABLED && !env.TYPESAFE_API_KEY) {
    throw new Error('TYPESAFE_API_KEY is required when JEV_ENABLED=true');
  }
  const encryptionKey = decodeEncryptionKey(env.APP_ENCRYPTION_KEY);
  const database = createDatabase(env.DATABASE_URL);
  const apiStore = createDrizzleApiStore(database.db);
  const store = createDrizzleWebhookDeliveryStore(database.db);
  const httpClient = createFetchWebhookHttpClient();
  const ownedRedis = connection ? null : createRedisConnection(env.REDIS_URL);
  const redisConnection = connection ?? ownedRedis!;
  const eventPublisher = createDurableEventPublisher(
    database.db,
    redisConnection,
  );

  const objectStorage = createS3ObjectStore({
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
  });
  const transport = createNodemailerOutboundTransport({
    host: env.SMTP_OUTBOUND_HOST,
    port: env.SMTP_OUTBOUND_PORT,
  });
  const ingestor = createInboundIngestor({
    mailDomain: env.MAIL_DOMAIN,
    repository: apiStore,
    objectStore: objectStorage.store,
    eventPublisher,
  });
  const outbound = createOutboundMessageService({
    store: apiStore,
    objectStore: objectStorage.store,
    ingestor,
    transport,
    mailDomain: env.MAIL_DOMAIN,
    maximumHopCount: env.SMTP_MAX_HOPS,
    eventPublisher,
    dkimResolver: async (sender) => {
      const domain = await apiStore.findVerifiedDomain(sender.podId, sender.domain);
      if (!domain?.dkimPrivateKey) return undefined;
      return { domainName: domain.domain, keySelector: 'lm1', privateKey: decryptSecret(domain.dkimPrivateKey, encryptionKey) };
    },
  });
  const scheduledSendPoller = createScheduledSendPoller({
    store: apiStore,
    outbound,
    intervalMs: env.SCHEDULED_SEND_POLL_INTERVAL_MS,
    onError: (draftId, error) => {
      console.error(
        `scheduled-send draft ${draftId} failed:`,
        error instanceof Error ? error.message : error,
      );
    },
  });

  const webhookWorker = new Worker<WebhookDeliverJobData>(
    WEBHOOK_DELIVER_QUEUE,
    async (job: Job<WebhookDeliverJobData>) => {
      const maxAttempts = job.opts.attempts ?? 5;
      // BullMQ increments attemptsMade at the start of each attempt (1-indexed).
      const attemptsMade = Math.max(job.attemptsMade, 1);
      await processWebhookDelivery({
        deliveryId: job.data.deliveryId,
        attemptsMade,
        maxAttempts,
        store,
        httpClient,
        encryptionKey,
      });
    },
    {
      connection: redisConnection,
      settings: {
        backoffStrategy: (attemptsMade) => webhookBackoffDelayMs(attemptsMade),
      },
    },
  );

  webhookWorker.on('failed', (job, error) => {
    console.error(
      `webhook-deliver job ${job?.id ?? 'unknown'} failed:`,
      error.message,
    );
  });

  const jevWorker = new Worker<JevClassifyJobData>(
    JEV_CLASSIFY_QUEUE,
    async (job: Job<JevClassifyJobData>) => {
      const outcome = await processJevClassify({
        messageId: job.data.messageId,
        db: database.db,
        eventPublisher,
        classifyOptions: {
          jevEnabled: env.JEV_ENABLED,
          apiKey: env.TYPESAFE_API_KEY,
        },
      });
      if (outcome.status === 'skipped') {
        console.log(
          `jev-classify ${job.data.messageId} skipped (${outcome.reason})`,
        );
      } else {
        console.log(
          `jev-classify ${job.data.messageId} ${outcome.source} labels=${outcome.labels.join(',')}`,
        );
      }
    },
    { connection: redisConnection },
  );

  jevWorker.on('failed', (job, error) => {
    console.error(
      `jev-classify job ${job?.id ?? 'unknown'} failed:`,
      error.message,
    );
  });

  const embedWorker = new Worker<EmbedMessageJobData>(EMBED_MESSAGE_QUEUE, async (job) => {
    await processEmbedMessage(database.db, job.data.messageId);
  }, { connection: redisConnection });
  embedWorker.on('failed', (job, error) => {
    console.error(`embed-message job ${job?.id ?? 'unknown'} failed:`, error.message);
  });

  return {
    async close() {
      await Promise.all([
        scheduledSendPoller.close(),
        webhookWorker.close(),
        jevWorker.close(),
        embedWorker.close(),
      ]);
      transport.close?.();
      objectStorage.client.destroy();
      await eventPublisher.close();
      if (ownedRedis) ownedRedis.disconnect();
      await database.close();
    },
  };
}
