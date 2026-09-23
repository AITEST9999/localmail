import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { createId } from '@localmail/db';

import { requireScope } from './auth.js';
import { ApiError, errorResponses } from './errors.js';
import { sendClaimedDraft } from './draft-service.js';
import { decodePageCursor, encodePageCursor, paginationSchema } from './pagination.js';
import { toMessageResponse } from './messages.js';
import type { OutboundMessageService } from './outbound.js';
import type { ApiStore, DraftRow } from './store.js';

const address = z.string().email();
const params = z.object({ inbox_id: z.string().min(1) });
const draftParams = params.extend({ draft_id: z.string().min(1) });
const sendAt = z.string().datetime().nullable().optional();

const createDraftBody = z
  .object({
    thread_id: z.string().min(1).optional(),
    to: z.array(address).min(1),
    cc: z.array(address).optional(),
    subject: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    html: z.string().nullable().optional(),
    send_at: z.string().datetime().optional(),
  })
  .strict();

const updateDraftBody = z
  .object({
    to: z.array(address).min(1).optional(),
    cc: z.array(address).optional(),
    subject: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    html: z.string().nullable().optional(),
    send_at: sendAt,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.',
  });

const listDraftQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  page_token: z.string().min(1).optional(),
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']).optional(),
});

export const draftResponseSchema = z.object({
  id: z.string(),
  inboxId: z.string(),
  threadId: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  sendAt: z.string().datetime().nullable(),
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']),
  createdAt: z.string().datetime(),
});

export interface DraftRoutesOptions {
  store: ApiStore;
  outbound: OutboundMessageService;
}

export function registerDraftRoutes(
  app: FastifyInstance,
  { store, outbound }: DraftRoutesOptions,
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/v1/inboxes/:inbox_id/drafts',
    {
      preHandler: requireScope('drafts:write'),
      schema: {
        tags: ['Drafts'],
        operationId: 'createDraft',
        security: [{ bearerAuth: [] }],
        params,
        body: createDraftBody,
        response: { 201: draftResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      await requireInbox(store, request.podId, request.params.inbox_id);
      if (request.body.thread_id) {
        const thread = await store.findThreadById(
          request.podId,
          request.params.inbox_id,
          request.body.thread_id,
        );
        if (!thread) throw notFound('The requested thread was not found.');
      }
      const scheduledAt = request.body.send_at
        ? futureDate(request.body.send_at)
        : null;
      const row = await store.createDraft({
        id: createId('draft'),
        inboxId: request.params.inbox_id,
        threadId: request.body.thread_id ?? null,
        to: normalizeAddresses(request.body.to),
        cc: normalizeAddresses(request.body.cc ?? []),
        subject: request.body.subject ?? null,
        text: request.body.text ?? null,
        html: request.body.html ?? null,
        sendAt: scheduledAt,
        status: scheduledAt ? 'scheduled' : 'draft',
      });
      return reply.code(201).send(toDraftResponse(row));
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id/drafts',
    {
      preHandler: requireScope('drafts:read'),
      schema: {
        tags: ['Drafts'],
        operationId: 'listDrafts',
        security: [{ bearerAuth: [] }],
        params,
        querystring: listDraftQuery,
        response: {
          200: z.object({ data: z.array(draftResponseSchema), ...paginationSchema.shape }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      await requireInbox(store, request.podId, request.params.inbox_id);
      const cursor = request.query.page_token
        ? decodePageCursor(request.query.page_token)
        : undefined;
      const rows = await store.listDrafts(
        request.podId,
        request.params.inbox_id,
        request.query.limit + 1,
        cursor ? { createdAt: cursor.sortAt, id: cursor.id } : undefined,
        request.query.status,
      );
      const page = rows.slice(0, request.query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toDraftResponse),
        next_page_token:
          rows.length > request.query.limit && last
            ? encodePageCursor(last.createdAt, last.id)
            : null,
      };
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id/drafts/:draft_id',
    {
      preHandler: requireScope('drafts:read'),
      schema: {
        tags: ['Drafts'],
        operationId: 'getDraft',
        security: [{ bearerAuth: [] }],
        params: draftParams,
        response: { 200: draftResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await store.findDraftById(
        request.podId,
        request.params.inbox_id,
        request.params.draft_id,
      );
      if (!row) throw notFound('The requested draft was not found.');
      return toDraftResponse(row);
    },
  );

  typedApp.patch(
    '/v1/inboxes/:inbox_id/drafts/:draft_id',
    {
      preHandler: requireScope('drafts:write'),
      schema: {
        tags: ['Drafts'],
        operationId: 'updateDraft',
        security: [{ bearerAuth: [] }],
        params: draftParams,
        body: updateDraftBody,
        response: { 200: draftResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const existing = await store.findDraftById(
        request.podId,
        request.params.inbox_id,
        request.params.draft_id,
      );
      if (!existing) throw notFound('The requested draft was not found.');
      const updates = toDraftUpdates(request.body);
      const updated = await store.updateDraft(
        request.podId,
        request.params.inbox_id,
        request.params.draft_id,
        updates,
      );
      if (!updated) throw draftLockedError('edited');
      return toDraftResponse(updated);
    },
  );

  typedApp.delete(
    '/v1/inboxes/:inbox_id/drafts/:draft_id',
    {
      preHandler: requireScope('drafts:write'),
      schema: {
        tags: ['Drafts'],
        operationId: 'deleteDraft',
        security: [{ bearerAuth: [] }],
        params: draftParams,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const existing = await store.findDraftById(
        request.podId,
        request.params.inbox_id,
        request.params.draft_id,
      );
      if (!existing) throw notFound('The requested draft was not found.');
      const deleted = await store.deleteDraft(
        request.podId,
        request.params.inbox_id,
        request.params.draft_id,
      );
      if (!deleted) throw draftLockedError('deleted');
      return reply.code(204).send(null);
    },
  );

  typedApp.post(
    '/v1/inboxes/:inbox_id/drafts/:draft_id/send',
    {
      preHandler: requireScope('messages:send'),
      schema: {
        tags: ['Drafts'],
        operationId: 'sendDraft',
        security: [{ bearerAuth: [] }],
        params: draftParams,
        body: z.object({}).strict().optional(),
        response: { 201: z.unknown(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const target = await store.claimDraftForSend(
        request.podId,
        request.params.inbox_id,
        request.params.draft_id,
      );
      if (!target) {
        const existing = await store.findDraftById(
          request.podId,
          request.params.inbox_id,
          request.params.draft_id,
        );
        if (!existing) throw notFound('The requested draft was not found.');
        throw draftLockedError('sent');
      }
      try {
        const message = await sendClaimedDraft(target, outbound, store);
        return reply.code(201).send(toMessageResponse(message));
      } catch (error) {
        await store.markDraftStatus(target.draft.id, 'failed');
        throw error;
      }
    },
  );
}

export function toDraftResponse(row: DraftRow) {
  return {
    id: row.id,
    inboxId: row.inboxId,
    threadId: row.threadId,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    text: row.text,
    html: row.html,
    sendAt: row.sendAt?.toISOString() ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDraftUpdates(body: z.infer<typeof updateDraftBody>) {
  const updates: Parameters<ApiStore['updateDraft']>[3] = {};
  if (body.to !== undefined) updates.to = normalizeAddresses(body.to);
  if (body.cc !== undefined) updates.cc = normalizeAddresses(body.cc);
  if (body.subject !== undefined) updates.subject = body.subject;
  if (body.text !== undefined) updates.text = body.text;
  if (body.html !== undefined) updates.html = body.html;
  if ('send_at' in body) {
    updates.sendAt = body.send_at ? futureDate(body.send_at) : null;
    updates.status = updates.sendAt ? 'scheduled' : 'draft';
  }
  return updates;
}

function futureDate(value: string): Date {
  const date = new Date(value);
  if (date.getTime() <= Date.now())
    throw new ApiError('validation_error', 400, 'send_at must be in the future.');
  return date;
}

function normalizeAddresses(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))];
}

async function requireInbox(
  store: ApiStore,
  podId: string,
  inboxId: string,
): Promise<void> {
  if (!(await store.findInboxById(podId, inboxId)))
    throw notFound('The requested inbox was not found.');
}

function notFound(message: string): ApiError {
  return new ApiError('not_found', 404, message);
}

function draftLockedError(action: string): ApiError {
  const message =
    action === 'edited'
      ? 'Draft has already been sent or is currently sending and can no longer be edited.'
      : action === 'deleted'
        ? 'Draft has already been sent or is currently sending and can no longer be deleted.'
        : 'Draft is already sending, has been sent, or previously failed to send.';
  return new ApiError('validation_error', 400, message);
}
