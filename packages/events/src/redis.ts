import { Redis } from 'ioredis';

/** BullMQ requires maxRetriesPerRequest: null on shared/worker connections. */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * Dedicated Redis client for pub/sub subscribe mode (design §4).
 * Ready-check INFO is disabled — it is illegal after SUBSCRIBE.
 */
export function createRedisSubscriber(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
