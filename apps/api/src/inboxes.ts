import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Env } from '@localmail/config';
import { createId } from '@localmail/db';

import { requireScope } from './auth.js';
import { ApiError, errorResponses } from './errors.js';
import { decodePageCursor, encodePageCursor } from './pagination.js';
import type { ApiStore, InboxRow, UpdateInboxRecord } from './store.js';

const GENERATED_USERNAME_ATTEMPTS = 8;
const GENERATED_USERNAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const usernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'Username must use lowercase letters, numbers, dots, underscores, or hyphens.',
  );
const metadataSchema = z.record(z.unknown());

const createInboxBodySchema = z
  .object({
    username: usernameSchema.optional(),
    display_name: z.string().max(255).nullable().optional(),
    metadata: metadataSchema.optional(),
    client_id: z.string().min(1).max(255).optional(),
  })
  .strict();

const updateInboxBodySchema = z
  .object({
    display_name: z.string().max(255).nullable().optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.',
  });

const inboxParamsSchema = z.object({ inbox_id: z.string().min(1) });

const listInboxesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  page_token: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
});

export const inboxResponseSchema = z.object({
  id: z.string(),
  address: z.string(),
  username: z.string(),
  domain: z.string(),
  display_name: z.string().nullable(),
  metadata: metadataSchema,
  client_id: z.string().nullable(),
  created_at: z.string().datetime(),
});

const listInboxesResponseSchema = z.object({
  data: z.array(inboxResponseSchema),
  next_page_token: z.string().nullable(),
});

export interface InboxRoutesOptions {
  env: Env;
  store: ApiStore;
}

export function registerInboxRoutes(
  app: FastifyInstance,
  { env, store }: InboxRoutesOptions,
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/v1/inboxes',
    {
      preHandler: requireScope('inboxes:write'),
      schema: {
        tags: ['Inboxes'],
        operationId: 'createInbox',
        security: [{ bearerAuth: [] }],
        body: createInboxBodySchema,
        response: { 201: inboxResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.client_id) {
        const existing = await store.findInboxByClientId(
          request.podId,
          body.client_id,
        );
        if (existing) return reply.code(201).send(toInboxResponse(existing));
      }

      const attempts = body.username ? 1 : GENERATED_USERNAME_ATTEMPTS;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const username = body.username ?? generateUsername();
        const created = await store.createInbox({
          id: createId('inb'),
          podId: request.podId,
          username,
          domain: env.MAIL_DOMAIN,
          address: `${username}@${env.MAIL_DOMAIN}`,
          displayName: body.display_name ?? null,
          metadata: body.metadata ?? {},
          clientId: body.client_id ?? null,
        });
        if (created) return reply.code(201).send(toInboxResponse(created));

        // An insert racing another request with the same client_id loses its
        // DB conflict but still resolves to the winning inbox.
        if (body.client_id) {
          const existing = await store.findInboxByClientId(
            request.podId,
            body.client_id,
          );
          if (existing)
            return reply.code(201).send(toInboxResponse(existing));
        }

        if (body.username) throw addressTakenError();
      }

      throw addressTakenError();
    },
  );

  typedApp.get(
    '/v1/inboxes',
    {
      preHandler: requireScope('inboxes:read'),
      schema: {
        tags: ['Inboxes'],
        operationId: 'listInboxes',
        security: [{ bearerAuth: [] }],
        querystring: listInboxesQuerySchema,
        response: { 200: listInboxesResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const cursor = request.query.page_token
        ? decodePageCursor(request.query.page_token)
        : undefined;
      const rows = await store.listInboxes(
        request.podId,
        request.query.limit + 1,
        cursor ? { createdAt: cursor.sortAt, id: cursor.id } : undefined,
        request.query.address,
      );
      const hasNextPage = rows.length > request.query.limit;
      const page = rows.slice(0, request.query.limit);
      const last = page.at(-1);

      return {
        data: page.map(toInboxResponse),
        next_page_token:
          hasNextPage && last
            ? encodePageCursor(last.createdAt, last.id)
            : null,
      };
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id',
    {
      preHandler: requireScope('inboxes:read'),
      schema: {
        tags: ['Inboxes'],
        operationId: 'getInbox',
        security: [{ bearerAuth: [] }],
        params: inboxParamsSchema,
        response: { 200: inboxResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const inbox = await store.findInboxById(
        request.podId,
        request.params.inbox_id,
      );
      if (!inbox) throw inboxNotFoundError();
      return toInboxResponse(inbox);
    },
  );

  typedApp.patch(
    '/v1/inboxes/:inbox_id',
    {
      preHandler: requireScope('inboxes:write'),
      schema: {
        tags: ['Inboxes'],
        operationId: 'updateInbox',
        security: [{ bearerAuth: [] }],
        params: inboxParamsSchema,
        body: updateInboxBodySchema,
        response: { 200: inboxResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const updates: UpdateInboxRecord = {};
      if ('display_name' in request.body)
        updates.displayName = request.body.display_name;
      if ('metadata' in request.body) updates.metadata = request.body.metadata;

      const inbox = await store.updateInbox(
        request.podId,
        request.params.inbox_id,
        updates,
      );
      if (!inbox) throw inboxNotFoundError();
      return toInboxResponse(inbox);
    },
  );

  typedApp.delete(
    '/v1/inboxes/:inbox_id',
    {
      preHandler: requireScope('inboxes:write'),
      schema: {
        tags: ['Inboxes'],
        operationId: 'deleteInbox',
        security: [{ bearerAuth: [] }],
        params: inboxParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const deleted = await store.deleteInbox(
        request.podId,
        request.params.inbox_id,
      );
      if (!deleted) throw inboxNotFoundError();
      return reply.code(204).send(null);
    },
  );
}

function toInboxResponse(row: InboxRow) {
  return {
    id: row.id,
    address: row.address,
    username: row.username,
    domain: row.domain,
    display_name: row.displayName,
    metadata: row.metadata,
    client_id: row.clientId,
    created_at: row.createdAt.toISOString(),
  };
}

function generateUsername(): string {
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes)
    suffix += GENERATED_USERNAME_ALPHABET[byte % GENERATED_USERNAME_ALPHABET.length];
  return `agent-${suffix}`;
}

function addressTakenError(): ApiError {
  return new ApiError(
    'address_taken',
    409,
    'Inbox address is already in use.',
  );
}

function inboxNotFoundError(): ApiError {
  return new ApiError(
    'not_found',
    404,
    'The requested inbox was not found.',
  );
}
