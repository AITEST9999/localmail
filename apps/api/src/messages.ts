import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { RawObjectReader } from '@localmail/core';

import { requireScope } from './auth.js';
import {
  DEFAULT_ATTACHMENT_URL_TTL_SECONDS,
  isPreviewableContentType,
  parseMultipartMessage,
  safeDownloadFilename,
  type AttachmentSignaturePayload,
  type AttachmentUrlSigner,
} from './attachments.js';
import { ApiError, errorResponses } from './errors.js';
import {
  HopLimitExceededError,
  type OutboundMessageService,
  type SendOutboundInput,
} from './outbound.js';
import { decodePageCursor, encodePageCursor } from './pagination.js';
import type {
  ApiStore,
  MessageRow,
  ThreadRow,
} from './store.js';

const addressSchema = z.string().email();
const contentFields = {
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
};
const hasContent = (body: { text?: string | null; html?: string | null }) =>
  Boolean(body.text || body.html);

const sendBodySchema = z
  .object({
    to: z.array(addressSchema).min(1),
    cc: z.array(addressSchema).optional(),
    bcc: z.array(addressSchema).optional(),
    subject: z.string(),
    ...contentFields,
    labels: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(hasContent, { message: 'At least one of text or html is required.' });

const replyBodySchema = z
  .object({
    ...contentFields,
    reply_all: z.boolean().default(false),
  })
  .strict()
  .refine(hasContent, { message: 'At least one of text or html is required.' });

const forwardBodySchema = z
  .object({
    to: z.array(addressSchema).min(1),
    cc: z.array(addressSchema).optional(),
    bcc: z.array(addressSchema).optional(),
    ...contentFields,
  })
  .strict();

const inboxParamsSchema = z.object({ inbox_id: z.string().min(1) });
const messageParamsSchema = inboxParamsSchema.extend({
  message_id: z.string().min(1),
});
const attachmentParamsSchema = messageParamsSchema.extend({
  attachment_id: z.string().min(1),
});

export const messageResponseSchema = z.object({
  id: z.string(),
  inbox_id: z.string(),
  thread_id: z.string(),
  message_id: z.string(),
  in_reply_to: z.string().nullable(),
  references: z.array(z.string()),
  direction: z.enum(['inbound', 'outbound']),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  extracted_text: z.string().nullable(),
  preview: z.string().nullable(),
  labels: z.array(z.string()),
  size_bytes: z.number(),
  sent_at: z.string().datetime().nullable(),
  received_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  jev_decision: z.object({ answers: z.record(z.unknown()), latency_ms: z.number().int(), created_at: z.string().datetime() }).nullable().optional(),
});

export const threadSummarySchema = z.object({
  id: z.string(),
  subject_normalized: z.string(),
  last_message_at: z.string().datetime(),
  message_count: z.number().int(),
  labels: z.array(z.string()),
  preview: z.string().nullable(),
});

export const messageSummarySchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  subject: z.string().nullable(),
  preview: z.string().nullable(),
  labels: z.array(z.string()),
  direction: z.enum(['inbound', 'outbound']),
  from: z.string(),
  to: z.array(z.string()),
  received_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  jev_decision: z.object({ answers: z.record(z.unknown()), latency_ms: z.number().int(), created_at: z.string().datetime() }).nullable().optional(),
});

const updateLabelsBodySchema = z
  .object({
    add_labels: z.array(z.string().min(1).max(64)).max(20).optional(),
    remove_labels: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.add_labels?.length ?? 0) > 0 ||
      (value.remove_labels?.length ?? 0) > 0,
    { message: 'At least one of add_labels or remove_labels is required.' },
  );

const pageQueryFields = {
  labels: z.string().optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  page_token: z.string().min(1).optional(),
};

const listThreadsQuerySchema = z.object(pageQueryFields);
const listMessagesQuerySchema = z.object({
  ...pageQueryFields,
  sender: z.string().min(1).optional(),
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
});

export interface MessageRoutesOptions {
  store: ApiStore;
  outbound: OutboundMessageService;
  rawObjectReader: RawObjectReader;
  attachmentUrlSigner: AttachmentUrlSigner;
}

export function registerMessageRoutes(
  app: FastifyInstance,
  {
    store,
    outbound,
    rawObjectReader,
    attachmentUrlSigner,
  }: MessageRoutesOptions,
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/v1/inboxes/:inbox_id/threads',
    {
      preHandler: requireScope('threads:read'),
      schema: {
        tags: ['Threads'],
        operationId: 'listThreads',
        security: [{ bearerAuth: [] }],
        params: inboxParamsSchema,
        querystring: listThreadsQuerySchema,
        response: {
          200: z.object({
            data: z.array(threadSummarySchema),
            next_page_token: z.string().nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      await requireInbox(store, request.podId, request.params.inbox_id);
      const cursor = request.query.page_token
        ? decodePageCursor(request.query.page_token)
        : undefined;
      const rows = await store.listThreads(
        request.podId,
        request.params.inbox_id,
        {
          labels: parseLabels(request.query.labels),
          before: toDate(request.query.before),
          after: toDate(request.query.after),
          limit: request.query.limit + 1,
          cursor,
        },
      );
      const hasNextPage = rows.length > request.query.limit;
      const page = rows.slice(0, request.query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toThreadSummary),
        next_page_token:
          hasNextPage && last
            ? encodePageCursor(last.lastMessageAt, last.id)
            : null,
      };
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id',
    {
      preHandler: requireScope('messages:read'),
      schema: {
        tags: ['Messages'],
        operationId: 'getAttachmentDownloadUrl',
        security: [{ bearerAuth: [] }],
        params: attachmentParamsSchema,
        querystring: z.object({
          expires_in: z.coerce
            .number()
            .int()
            .min(1)
            .max(3600)
            .default(DEFAULT_ATTACHMENT_URL_TTL_SECONDS),
        }),
        response: {
          200: z.object({
            url: z.string().url(),
            expires_at: z.string().datetime(),
            preview_allowed: z.boolean(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const attachment = await store.findAttachmentById(
        request.podId,
        request.params.inbox_id,
        request.params.message_id,
        request.params.attachment_id,
      );
      if (!attachment) throw attachmentNotFoundError();

      const expires = attachmentUrlSigner.expiresAfter(
        request.query.expires_in,
      );
      const payload: AttachmentSignaturePayload = {
        podId: request.podId,
        inboxId: request.params.inbox_id,
        messageId: request.params.message_id,
        attachmentId: attachment.id,
        expires,
      };
      const query = new URLSearchParams({
        pod_id: payload.podId,
        inbox_id: payload.inboxId,
        message_id: payload.messageId,
        expires: String(payload.expires),
        signature: attachmentUrlSigner.sign(payload),
      });
      return {
        url: `${request.protocol}://${request.host}/downloads/attachments/${attachment.id}?${query.toString()}`,
        expires_at: new Date(expires * 1000).toISOString(),
        preview_allowed: isPreviewableContentType(attachment.contentType),
      };
    },
  );

  typedApp.get(
    '/downloads/attachments/:attachment_id',
    {
      schema: {
        tags: ['Messages'],
        operationId: 'downloadAttachment',
        params: z.object({ attachment_id: z.string().min(1) }),
        querystring: z.object({
          pod_id: z.string().min(1),
          inbox_id: z.string().min(1),
          message_id: z.string().min(1),
          expires: z.coerce.number().int().positive(),
          signature: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const payload: AttachmentSignaturePayload = {
        podId: request.query.pod_id,
        inboxId: request.query.inbox_id,
        messageId: request.query.message_id,
        attachmentId: request.params.attachment_id,
        expires: request.query.expires,
      };
      const verification = attachmentUrlSigner.verify(
        payload,
        request.query.signature,
      );
      if (verification === 'expired') throw attachmentUrlExpiredError();
      if (verification === 'invalid') throw invalidAttachmentUrlError();

      const attachment = await store.findAttachmentById(
        payload.podId,
        payload.inboxId,
        payload.messageId,
        payload.attachmentId,
      );
      if (!attachment) throw attachmentNotFoundError();
      try {
        const stream = await rawObjectReader.getStream(attachment.objectKey);
        const disposition = isPreviewableContentType(attachment.contentType)
          ? 'inline'
          : 'attachment';
        return reply
          .type(attachment.contentType)
          .header(
            'Content-Disposition',
            `${disposition}; filename="${safeDownloadFilename(attachment.filename)}"`,
          )
          .header('Content-Length', String(attachment.size))
          .send(stream);
      } catch (error) {
        if (isMissingObjectError(error)) throw attachmentNotFoundError();
        throw error;
      }
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id/threads/:thread_id',
    {
      preHandler: requireScope('threads:read'),
      schema: {
        tags: ['Threads'],
        operationId: 'getThread',
        security: [{ bearerAuth: [] }],
        params: inboxParamsSchema.extend({ thread_id: z.string().min(1) }),
        response: {
          200: z.object({
            thread: threadSummarySchema,
            messages: z.array(messageSummarySchema),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const thread = await store.findThreadById(
        request.podId,
        request.params.inbox_id,
        request.params.thread_id,
      );
      if (!thread) throw threadNotFoundError();
      const threadMessages = await store.listThreadMessages(
        request.podId,
        request.params.inbox_id,
        thread.id,
      );
      return {
        thread: toThreadSummary(thread),
        messages: threadMessages.map(toMessageSummary),
      };
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id/messages',
    {
      preHandler: requireScope('messages:read'),
      schema: {
        tags: ['Messages'],
        operationId: 'listMessages',
        security: [{ bearerAuth: [] }],
        params: inboxParamsSchema,
        querystring: listMessagesQuerySchema,
        response: {
          200: z.object({
            data: z.array(messageSummarySchema),
            next_page_token: z.string().nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      await requireInbox(store, request.podId, request.params.inbox_id);
      const cursor = request.query.page_token
        ? decodePageCursor(request.query.page_token)
        : undefined;
      const rows = await store.listMessages(
        request.podId,
        request.params.inbox_id,
        {
          labels: parseLabels(request.query.labels),
          before: toDate(request.query.before),
          after: toDate(request.query.after),
          sender: request.query.sender,
          unread: request.query.unread,
          direction: request.query.direction,
          limit: request.query.limit + 1,
          cursor,
        },
      );
      const hasNextPage = rows.length > request.query.limit;
      const page = rows.slice(0, request.query.limit);
      const last = page.at(-1);
      return {
        data: page.map(({ message }) => toMessageSummary(message)),
        next_page_token:
          hasNextPage && last
            ? encodePageCursor(last.sortAt, last.message.id)
            : null,
      };
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id/messages/:message_id',
    {
      preHandler: requireScope('messages:read'),
      schema: {
        tags: ['Messages'],
        operationId: 'getMessage',
        security: [{ bearerAuth: [] }],
        params: messageParamsSchema,
        response: { 200: messageResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const message = await store.findMessageById(
        request.podId,
        request.params.inbox_id,
        request.params.message_id,
      );
      if (!message) throw messageNotFoundError();
      return toMessageResponse(message);
    },
  );

  typedApp.patch(
    '/v1/inboxes/:inbox_id/messages/:message_id',
    {
      preHandler: requireScope('messages:write'),
      schema: {
        tags: ['Messages'],
        operationId: 'updateMessageLabels',
        security: [{ bearerAuth: [] }],
        params: messageParamsSchema,
        body: updateLabelsBodySchema,
        response: { 200: messageResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const message = await store.updateMessageLabels(
        request.podId,
        request.params.inbox_id,
        request.params.message_id,
        {
          addLabels: request.body.add_labels ?? [],
          removeLabels: request.body.remove_labels ?? [],
        },
      );
      if (!message) throw messageNotFoundError();
      return toMessageResponse(message);
    },
  );

  typedApp.get(
    '/v1/inboxes/:inbox_id/messages/:message_id/raw',
    {
      preHandler: requireScope('messages:read'),
      schema: {
        tags: ['Messages'],
        operationId: 'getMessageRaw',
        security: [{ bearerAuth: [] }],
        params: messageParamsSchema,
      },
    },
    async (request, reply) => {
      const message = await store.findMessageById(
        request.podId,
        request.params.inbox_id,
        request.params.message_id,
      );
      if (!message?.rawObjectKey) throw rawMessageNotFoundError();
      try {
        const stream = await rawObjectReader.getStream(message.rawObjectKey);
        return reply.type('message/rfc822').send(stream);
      } catch (error) {
        if (isMissingObjectError(error)) throw rawMessageNotFoundError();
        throw error;
      }
    },
  );

  typedApp.post(
    '/v1/inboxes/:inbox_id/messages/send',
    {
      preValidation: parseMultipartMessage,
      preHandler: requireScope('messages:send'),
      schema: {
        tags: ['Messages'],
        operationId: 'sendMessage',
        security: [{ bearerAuth: [] }],
        params: inboxParamsSchema,
        body: sendBodySchema,
        response: { 201: messageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const sender = await store.findInboxById(
        request.podId,
        request.params.inbox_id,
      );
      if (!sender) throw inboxNotFoundError();
      const message = await deliver(outbound, {
        sender,
        ...request.body,
        attachments: request.outboundAttachments,
      });
      return reply.code(201).send(toMessageResponse(message));
    },
  );

  typedApp.post(
    '/v1/inboxes/:inbox_id/messages/:message_id/reply',
    {
      preValidation: parseMultipartMessage,
      preHandler: requireScope('messages:send'),
      schema: {
        tags: ['Messages'],
        operationId: 'replyToMessage',
        security: [{ bearerAuth: [] }],
        params: messageParamsSchema,
        body: replyBodySchema,
        response: { 201: messageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const target = await store.findMessageForSend(
        request.podId,
        request.params.inbox_id,
        request.params.message_id,
      );
      if (!target) throw messageNotFoundError();

      const recipients = replyRecipients(target.message, target.inbox.address, request.body.reply_all);
      const message = await deliver(outbound, {
        sender: target.inbox,
        to: recipients.to,
        cc: recipients.cc,
        subject: replySubject(target.message.subject),
        text: request.body.text,
        html: request.body.html,
        existingThreadId: target.message.threadId,
        inReplyTo: target.message.messageIdHeader,
        references: appendReference(
          target.message.references,
          target.message.messageIdHeader,
        ),
        incomingHopCount: target.message.hopCount,
        attachments: request.outboundAttachments,
      });
      return reply.code(201).send(toMessageResponse(message));
    },
  );

  typedApp.post(
    '/v1/inboxes/:inbox_id/messages/:message_id/forward',
    {
      preValidation: parseMultipartMessage,
      preHandler: requireScope('messages:send'),
      schema: {
        tags: ['Messages'],
        operationId: 'forwardMessage',
        security: [{ bearerAuth: [] }],
        params: messageParamsSchema,
        body: forwardBodySchema,
        response: { 201: messageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const target = await store.findMessageForSend(
        request.podId,
        request.params.inbox_id,
        request.params.message_id,
      );
      if (!target) throw messageNotFoundError();
      const quoted = forwardContent(target.message, request.body);
      const message = await deliver(outbound, {
        sender: target.inbox,
        to: request.body.to,
        cc: request.body.cc,
        bcc: request.body.bcc,
        subject: forwardSubject(target.message.subject),
        text: quoted.text,
        html: quoted.html,
        inReplyTo: target.message.messageIdHeader,
        references: appendReference(
          target.message.references,
          target.message.messageIdHeader,
        ),
        incomingHopCount: target.message.hopCount,
        attachments: request.outboundAttachments,
      });
      return reply.code(201).send(toMessageResponse(message));
    },
  );
}

async function deliver(
  outbound: OutboundMessageService,
  input: SendOutboundInput,
): Promise<MessageRow> {
  try {
    return await outbound.send(input);
  } catch (error) {
    if (error instanceof HopLimitExceededError) {
      throw new ApiError(
        'validation_error',
        400,
        'Message hop limit reached.',
        [
          {
            path: 'X-LocalMail-Hop-Count',
            message: `maximum hop count ${error.maximumHopCount} reached`,
          },
        ],
      );
    }
    throw error;
  }
}

function replyRecipients(
  target: MessageRow,
  senderAddress: string,
  replyAll: boolean,
): { to: string[]; cc: string[] } {
  const primary = extractAddress(target.from);
  if (!replyAll) return { to: [primary], cc: [] };
  const excluded = new Set([senderAddress.toLowerCase(), primary]);
  const cc = [...target.to, ...target.cc]
    .map(extractAddress)
    .filter((address) => !excluded.has(address));
  return { to: [primary], cc: [...new Set(cc)] };
}

function extractAddress(value: string): string {
  const bracketed = /<([^<>]+)>/.exec(value)?.[1];
  return (bracketed ?? value).trim().toLowerCase();
}

function replySubject(subject: string | null): string {
  const decoded = subject ?? '';
  return /^re(?:\[\d+])?\s*:/i.test(decoded) ? decoded : `Re: ${decoded}`;
}

function forwardSubject(subject: string | null): string {
  const decoded = subject ?? '';
  return /^(?:fw|fwd)\s*:/i.test(decoded) ? decoded : `Fwd: ${decoded}`;
}

function appendReference(references: string[], messageId: string): string[] {
  return [...new Set([...references, messageId])];
}

function forwardContent(
  target: MessageRow,
  body: { text?: string | null; html?: string | null },
): { text: string | null; html: string | null } {
  const heading = `---------- Forwarded message ----------\nFrom: ${target.from}\nSubject: ${target.subject ?? ''}\n\n`;
  const originalText = target.text ?? target.extractedText ?? '';
  const text = `${body.text ? `${body.text}\n\n` : ''}${heading}${originalText}`;
  const htmlHeading = `<hr><p><strong>Forwarded message</strong><br>From: ${escapeHtml(target.from)}<br>Subject: ${escapeHtml(target.subject ?? '')}</p>`;
  const originalHtml = target.html ?? escapeHtml(originalText).replaceAll('\n', '<br>');
  const html = body.html ? `${body.html}${htmlHeading}${originalHtml}` : null;
  return { text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function toMessageResponse(message: MessageRow) {
  return {
    id: message.id,
    inbox_id: message.inboxId,
    thread_id: message.threadId,
    message_id: message.messageIdHeader,
    in_reply_to: message.inReplyTo,
    references: message.references,
    direction: message.direction,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    extracted_text: message.extractedText,
    preview: makePreview(message.text, message.html),
    labels: message.labels,
    size_bytes: message.sizeBytes,
    sent_at: message.sentAt?.toISOString() ?? null,
    received_at: message.receivedAt?.toISOString() ?? null,
    created_at: message.createdAt.toISOString(),
    jev_decision: null,
  };
}

function toThreadSummary(thread: ThreadRow) {
  return {
    id: thread.id,
    subject_normalized: thread.subjectNormalized,
    last_message_at: thread.lastMessageAt.toISOString(),
    message_count: thread.messageCount,
    labels: thread.labels,
    preview: thread.preview,
  };
}

export function toMessageSummary(message: MessageRow) {
  return {
    id: message.id,
    thread_id: message.threadId,
    subject: message.subject,
    preview: makePreview(message.text, message.html),
    labels: message.labels,
    direction: message.direction,
    from: message.from,
    to: message.to,
    received_at: message.receivedAt?.toISOString() ?? null,
    created_at: message.createdAt.toISOString(),
    jev_decision: null,
  };
}

function parseLabels(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((label) => label.trim()).filter(Boolean))];
}

function toDate(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

async function requireInbox(
  store: ApiStore,
  podId: string,
  inboxId: string,
): Promise<void> {
  if (!(await store.findInboxById(podId, inboxId))) throw inboxNotFoundError();
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? error.name : undefined;
  return name === 'NoSuchKey' || name === 'NotFound';
}

function makePreview(text: string | null, html: string | null): string | null {
  const content = text ?? html?.replaceAll(/<[^>]*>/g, ' ') ?? '';
  const normalized = content.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, 200) : null;
}

function inboxNotFoundError(): ApiError {
  return new ApiError('not_found', 404, 'The requested inbox was not found.');
}

function messageNotFoundError(): ApiError {
  return new ApiError('not_found', 404, 'The requested message was not found.');
}

function threadNotFoundError(): ApiError {
  return new ApiError('not_found', 404, 'The requested thread was not found.');
}

function rawMessageNotFoundError(): ApiError {
  return new ApiError(
    'not_found',
    404,
    'The raw message was not found.',
  );
}

function attachmentNotFoundError(): ApiError {
  return new ApiError('not_found', 404, 'The requested attachment was not found.');
}

function attachmentUrlExpiredError(): ApiError {
  return new ApiError(
    'validation_error',
    400,
    'Attachment download URL has expired.',
    [{ path: 'expires', message: 'signed URL has expired' }],
  );
}

function invalidAttachmentUrlError(): ApiError {
  return new ApiError(
    'validation_error',
    400,
    'Attachment download URL signature is invalid.',
    [{ path: 'signature', message: 'invalid attachment download signature' }],
  );
}
