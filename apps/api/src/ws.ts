import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

import { requireScope } from './auth.js';
import type { ApiStore } from './store.js';
import { createWsHub, type WsHub } from './ws-hub.js';

export interface RegisterWsRoutesOptions {
  store: ApiStore;
  subscriber: Redis;
}

export async function registerWsRoutes(
  app: FastifyInstance,
  { store, subscriber }: RegisterWsRoutesOptions,
): Promise<WsHub> {
  await app.register(websocket);

  const hub = createWsHub({
    subscriber,
    findInboxById: (podId, inboxId) => store.findInboxById(podId, inboxId),
  });

  app.get(
    '/v1/ws',
    {
      websocket: true,
      preHandler: requireScope('ws:connect'),
      schema: {
        tags: ['WebSockets'],
        operationId: 'connectWebSocket',
        security: [{ bearerAuth: [] }],
      },
    },
    (socket, request) => {
      const state = hub.addConnection(request.podId, socket);

      socket.on('message', (data) => {
        const raw =
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Array.isArray(data)
                ? Buffer.concat(data).toString('utf8')
                : Buffer.from(data).toString('utf8');
        void hub.handleClientMessage(state, raw);
      });

      socket.on('close', () => {
        void hub.removeConnection(state);
      });

      socket.on('error', () => {
        void hub.removeConnection(state);
      });
    },
  );

  app.addHook('onClose', async () => {
    await hub.close();
  });

  return hub;
}
