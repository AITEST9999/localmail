import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { encryptSecret } from '@localmail/core';
import { createId } from '@localmail/db';
import type { TestFireResult } from '@localmail/events';

import { requireScope } from './auth.js';
import { ApiError, errorResponses } from './errors.js';
import type {
  ApiStore,
  UpdateWebhookRecord,
  WebhookDeliveryRow,
  WebhookRow,
} from './store.js';

const PHASE2_EVENT_TYPES = [
  'message.received',
  'message.sent',
] as const;

const eventTypeSchema = z.enum(PHASE2_EVENT_TYPES);

const createWebhookBodySchema = z
  .object({
    url: z.string().url(),
    event_types: z.array(eventTypeSchema).min(1),
    inbox_ids: z.array(z.string().min(1)).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const updateWebhookBodySchema = z
  .object({
    url: z.string().url().optional(),
    event_types: z.array(eventTypeSchema).min(1).optional(),
    inbox_ids: z.array(z.string().min(1)).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.',
  });

const webhookParamsSchema = z.object({ webhook_id: z.string().min(1) });

const listDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const webhookResponseSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  event_types: z.array(z.string()),
  inbox_ids: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  created_at: z.string().datetime(),
});

const webhookCreatedResponseSchema = webhookResponseSchema.extend({
  secret: z.string().min(1),
});

const listWebhooksResponseSchema = z.object({
  data: z.array(webhookResponseSchema),
});

export const deliveryResponseSchema = z.object({
  id: z.string(),
  webhook_id: z.string(),
  event_id: z.string(),
  status: z.enum(['pending', 'delivering', 'delivered', 'failed']),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  next_retry_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});

const listDeliveriesResponseSchema = z.object({
  data: z.array(deliveryResponseSchema),
});

const testFireResponseSchema = z.object({
  event_id: z.string(),
  delivery_id: z.string(),
});

export interface WebhookTestFire {
  enqueueTestFire(input: {
    podId: string;
    webhookId: string;
  }): Promise<TestFireResult>;
}

export interface WebhookRoutesOptions {
  store: ApiStore;
  encryptionKey: Buffer;
  testFire: WebhookTestFire;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  { store, encryptionKey, testFire }: WebhookRoutesOptions,
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/v1/webhooks',
    {
      preHandler: requireScope('webhooks:write'),
      schema: {
        tags: ['Webhooks'],
        operationId: 'createWebhook',
        security: [{ bearerAuth: [] }],
        body: createWebhookBodySchema,
        response: { 201: webhookCreatedResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const rawSecret = randomBytes(32).toString('hex');
      const created = await store.createWebhook({
        id: createId('wh'),
        podId: request.podId,
        url: request.body.url,
        secretCiphertext: encryptSecret(rawSecret, encryptionKey),
        eventTypes: request.body.event_types,
        inboxIds: request.body.inbox_ids ?? null,
        enabled: request.body.enabled ?? true,
      });
      return reply.code(201).send(toWebhookCreatedResponse(created, rawSecret));
    },
  );

  typedApp.get(
    '/v1/webhooks',
    {
      preHandler: requireScope('webhooks:read'),
      schema: {
        tags: ['Webhooks'],
        operationId: 'listWebhooks',
        security: [{ bearerAuth: [] }],
        response: { 200: listWebhooksResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const rows = await store.listWebhooks(request.podId);
      return { data: rows.map(toWebhookResponse) };
    },
  );

  typedApp.get(
    '/v1/webhooks/:webhook_id',
    {
      preHandler: requireScope('webhooks:read'),
      schema: {
        tags: ['Webhooks'],
        operationId: 'getWebhook',
        security: [{ bearerAuth: [] }],
        params: webhookParamsSchema,
        response: { 200: webhookResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await requireWebhook(store, request.podId, request.params.webhook_id);
      return toWebhookResponse(row);
    },
  );

  typedApp.patch(
    '/v1/webhooks/:webhook_id',
    {
      preHandler: requireScope('webhooks:write'),
      schema: {
        tags: ['Webhooks'],
        operationId: 'updateWebhook',
        security: [{ bearerAuth: [] }],
        params: webhookParamsSchema,
        body: updateWebhookBodySchema,
        response: { 200: webhookResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const updates: UpdateWebhookRecord = {};
      if (request.body.url !== undefined) updates.url = request.body.url;
      if (request.body.event_types !== undefined)
        updates.eventTypes = request.body.event_types;
      if (request.body.inbox_ids !== undefined)
        updates.inboxIds = request.body.inbox_ids;
      if (request.body.enabled !== undefined)
        updates.enabled = request.body.enabled;

      const updated = await store.updateWebhook(
        request.podId,
        request.params.webhook_id,
        updates,
      );
      if (!updated) throw notFound();
      return toWebhookResponse(updated);
    },
  );

  typedApp.delete(
    '/v1/webhooks/:webhook_id',
    {
      preHandler: requireScope('webhooks:write'),
      schema: {
        tags: ['Webhooks'],
        operationId: 'deleteWebhook',
        security: [{ bearerAuth: [] }],
        params: webhookParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const deleted = await store.deleteWebhook(
        request.podId,
        request.params.webhook_id,
      );
      if (!deleted) throw notFound();
      return reply.code(204).send(null);
    },
  );

  typedApp.get(
    '/v1/webhooks/:webhook_id/deliveries',
    {
      preHandler: requireScope('webhooks:read'),
      schema: {
        tags: ['Webhooks'],
        operationId: 'listWebhookDeliveries',
        security: [{ bearerAuth: [] }],
        params: webhookParamsSchema,
        querystring: listDeliveriesQuerySchema,
        response: { 200: listDeliveriesResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      await requireWebhook(store, request.podId, request.params.webhook_id);
      const rows = await store.listWebhookDeliveries(
        request.podId,
        request.params.webhook_id,
        request.query.limit,
      );
      return { data: rows.map(toDeliveryResponse) };
    },
  );

  typedApp.post(
    '/v1/webhooks/:webhook_id/test',
    {
      preHandler: requireScope('webhooks:write'),
      schema: {
        tags: ['Webhooks'],
        operationId: 'testFireWebhook',
        security: [{ bearerAuth: [] }],
        params: webhookParamsSchema,
        response: { 202: testFireResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      await requireWebhook(store, request.podId, request.params.webhook_id);
      const result = await testFire.enqueueTestFire({
        podId: request.podId,
        webhookId: request.params.webhook_id,
      });
      return reply.code(202).send({
        event_id: result.eventId,
        delivery_id: result.deliveryId,
      });
    },
  );
}

async function requireWebhook(
  store: ApiStore,
  podId: string,
  webhookId: string,
): Promise<WebhookRow> {
  const row = await store.findWebhookById(podId, webhookId);
  if (!row) throw notFound();
  return row;
}

function notFound(): ApiError {
  return new ApiError('not_found', 404, 'The requested resource was not found.');
}

function toWebhookResponse(row: WebhookRow) {
  return {
    id: row.id,
    url: row.url,
    event_types: row.eventTypes,
    inbox_ids: row.inboxIds,
    enabled: row.enabled,
    created_at: row.createdAt.toISOString(),
  };
}

function toWebhookCreatedResponse(row: WebhookRow, rawSecret: string) {
  return {
    ...toWebhookResponse(row),
    secret: rawSecret,
  };
}

function toDeliveryResponse(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    webhook_id: row.webhookId,
    event_id: row.eventId,
    status: row.status,
    attempts: row.attempts,
    last_error: row.lastError,
    next_retry_at: row.nextRetryAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
