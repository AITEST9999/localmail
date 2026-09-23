import type { SMTPServer } from 'smtp-server';

import type { Env } from '@localmail/config';
import { createDatabase, createSenderRuleLoader } from '@localmail/db';
import { createDurableEventPublisher, createRedisConnection } from '@localmail/events';
import { createSenderRulesRecipientPolicy } from '@localmail/core';

import { createInboundIngestor } from './ingest.js';
import { createS3ObjectStore } from './object-store.js';
import { createDrizzleInboundRepository } from './repository.js';
import { createLocalMailSmtpServer } from './smtp-server.js';

export interface SmtpRuntime {
  server: SMTPServer;
  close(): Promise<void>;
}

export function createSmtpRuntime(env: Env): SmtpRuntime {
  const database = createDatabase(env.DATABASE_URL);
  const repository = createDrizzleInboundRepository(database.db);
  const objectStorage = createS3ObjectStore(env);
  const redis = createRedisConnection(env.REDIS_URL);
  const eventPublisher = createDurableEventPublisher(database.db, redis);
  const ingestor = createInboundIngestor({
    mailDomain: env.MAIL_DOMAIN,
    repository,
    objectStore: objectStorage.store,
    eventPublisher,
  });
  const policy = createSenderRulesRecipientPolicy({
    loader: createSenderRuleLoader(database.db),
    blockMode: env.SENDER_BLOCK_MODE,
  });
  const server = createLocalMailSmtpServer({
    directory: repository,
    policy,
    ingestor,
  });

  return {
    server,
    async close() {
      await closeServer(server);
      await eventPublisher.close();
      redis.disconnect();
      objectStorage.client.destroy();
      await database.close();
    },
  };
}

function closeServer(server: SMTPServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}
