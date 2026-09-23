import { randomBytes, scryptSync } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { parseEnv } from '@localmail/config';
import { createRedisSubscriber } from '@localmail/events';

import { createApp } from './app.js';
import type { ApiKeyRow, ApiStore, InboxRow } from './store.js';

const apps: ReturnType<typeof createApp>[] = [];
const redisClients: ReturnType<typeof createRedisSubscriber>[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop()!;
    await Promise.race([
      app.close(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  while (redisClients.length > 0) {
    const redis = redisClients.pop()!;
    redis.disconnect(false);
  }
});

describe('WebSocket /v1/ws auth', () => {
  it('rejects HTTP access without Authorization before upgrade', async () => {
    const { app } = await buildWsTestApp(['*']);
    const response = await app.inject({ method: 'GET', url: '/v1/ws' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'missing_authorization' },
    });
  });

  it('rejects a valid key missing ws:connect', async () => {
    const { app } = await buildWsTestApp(['inboxes:read']);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ws',
      headers: { authorization: 'Bearer lm_admin_change_me' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'insufficient_scope' },
    });
  });

  it('accepts admin * scope and returns invalid_inbox_id without closing', async () => {
    const { app, store } = await buildWsTestApp(['*']);
    store.seedInbox('demo', 'agent-demo@localmail.test');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('expected TCP address');

    const socket = await openWs(`ws://127.0.0.1:${address.port}/v1/ws`, {
      authorization: 'Bearer lm_admin_change_me',
    });

    const error = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2000);
      socket.once('message', (data) => {
        clearTimeout(timer);
        const text =
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Buffer.from(data as ArrayBuffer).toString('utf8');
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          inbox_ids: ['inb_missing'],
          event_types: ['message.received'],
        }),
      );
    });

    expect(error).toMatchObject({
      type: 'error',
      code: 'invalid_inbox_id',
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});

async function buildWsTestApp(scopes: string[]) {
  const rawKey = 'lm_admin_change_me';
  const encryptionKey = randomBytes(32);
  const apiKey = makeApiKey(rawKey, scopes);
  const store = new MinimalStore(apiKey);
  const subscriber = createRedisSubscriber(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
  );
  redisClients.push(subscriber);

  const app = createApp(
    parseEnv({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: encryptionKey.toString('base64'),
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    }),
    {
      logger: false,
      store: store as unknown as ApiStore,
      outbound: {
        send: () => Promise.reject(new Error('outbound unused in ws tests')),
      },
      encryptionKey,
      webhookTestFire: {
        enqueueTestFire: () =>
          Promise.resolve({ eventId: 'evt_x', deliveryId: 'whd_x' }),
      },
      wsSubscriber: subscriber,
      rawObjectReader: {
        getStream: () => Promise.reject(new Error('unused')),
      },
    },
  );
  apps.push(app);
  await app.ready();
  return { app, store };
}

function openWs(
  url: string,
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('open timeout'));
    }, 3000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected server response: ${res.statusCode}`));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function makeApiKey(rawKey: string, scopes: string[]): ApiKeyRow {
  const salt = randomBytes(16);
  const hash = scryptSync(rawKey, salt, 64);
  return {
    id: 'key_ws',
    podId: 'pod_test',
    prefix: rawKey.slice(0, 12),
    hash: `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`,
    scopes,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-09-22T00:00:00Z'),
  };
}

class MinimalStore {
  private readonly inboxes: InboxRow[] = [];
  constructor(private readonly apiKey: ApiKeyRow) {}

  seedInbox(username: string, address: string): InboxRow {
    const row: InboxRow = {
      id: `inb_${username}`,
      podId: 'pod_test',
      username,
      domain: 'localmail.test',
      address,
      displayName: null,
      metadata: {},
      clientId: null,
      createdAt: new Date('2026-09-22T00:00:00.000Z'),
    };
    this.inboxes.push(row);
    return row;
  }

  findApiKeyByPrefix(prefix: string) {
    return Promise.resolve(prefix === this.apiKey.prefix ? this.apiKey : null);
  }
  touchApiKey() {
    return Promise.resolve();
  }
  findInboxById(podId: string, id: string) {
    return Promise.resolve(
      this.inboxes.find((inbox) => inbox.podId === podId && inbox.id === id) ??
        null,
    );
  }
  findIdempotencyRecord() {
    return Promise.resolve(null);
  }
  saveIdempotencyRecord() {
    return Promise.resolve();
  }
  findInboxByClientId() {
    return Promise.resolve(null);
  }
  createInbox() {
    return Promise.resolve(null);
  }
  listInboxes() {
    return Promise.resolve([]);
  }
  updateInbox() {
    return Promise.resolve(null);
  }
  deleteInbox() {
    return Promise.resolve(false);
  }
  findMessageForSend() {
    return Promise.resolve(null);
  }
  findLocalInboxesByAddresses() {
    return Promise.resolve([]);
  }
  persistOutboundMessage() {
    return Promise.reject(new Error('unused'));
  }
  listThreads() {
    return Promise.resolve([]);
  }
  findThreadById() {
    return Promise.resolve(null);
  }
  listThreadMessages() {
    return Promise.resolve([]);
  }
  listMessages() {
    return Promise.resolve([]);
  }
  findMessageById() {
    return Promise.resolve(null);
  }
  findAttachmentById() {
    return Promise.resolve(null);
  }
  createWebhook() {
    return Promise.reject(new Error('unused'));
  }
  listWebhooks() {
    return Promise.resolve([]);
  }
  findWebhookById() {
    return Promise.resolve(null);
  }
  updateWebhook() {
    return Promise.resolve(null);
  }
  deleteWebhook() {
    return Promise.resolve(false);
  }
  listWebhookDeliveries() {
    return Promise.resolve([]);
  }
  lookupThread() {
    return Promise.resolve(null);
  }
  persistMessage() {
    return Promise.reject(new Error('unused'));
  }
  findByAddress() {
    return Promise.resolve(null);
  }
}
