import { randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseEnv } from '@localmail/config';
import type {
  InboxRecipient,
  PersistedInboundMessage,
  RawObjectReader,
  ThreadRecord,
} from '@localmail/core';

import { createApp } from './app.js';
import { createAttachmentUrlSigner, type AttachmentUrlSigner } from './attachments.js';
import { requireScope } from './auth.js';
import { ApiError } from './errors.js';
import type {
  OutboundMessageService,
  SendOutboundInput,
} from './outbound.js';
import type {
  ApiKeyRow,
  DomainRow,
  PodRow,
  ApiStore,
  AttachmentRow,
  CreateInboxRecord,
  CreateWebhookRecord,
  CreateDraftRecord,
  DraftCursor,
  DraftRow,
  DraftSendTarget,
  IdempotencyRecord,
  InboxCursor,
  InboxRow,
  ListMessagesQuery,
  ListThreadsQuery,
  MessageForSend,
  MessageListRow,
  MessageRow,
  SearchMessageRow,
  ThreadRow,
  UpdateInboxRecord,
  UpdateMessageLabelsRecord,
  UpdateWebhookRecord,
  WebhookDeliveryRow,
  WebhookRow,
} from './store.js';
import type { SearchCursor } from './pagination.js';

const apps: ReturnType<typeof createApp>[] = [];
const rawAdminKey = 'lm_admin_change_me';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API foundation', () => {
  it('serves unauthenticated Prometheus metrics with route templates', async () => {
    const { app } = buildTestApp();
    await app.inject({ method: 'GET', url: '/healthz' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('localmail_http_requests_total');
    expect(response.body).toContain('route="/healthz"');
    expect(response.body).not.toContain('lm_admin_change_me');
  });
  it('reports healthy without authentication', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'localmail-api',
    });
  });

  it('serves generated OpenAPI and Swagger UI', async () => {
    const { app } = buildTestApp();

    const [docs, spec] = await Promise.all([
      app.inject({ method: 'GET', url: '/docs' }),
      app.inject({ method: 'GET', url: '/docs/json' }),
    ]);

    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(spec.statusCode).toBe(200);
    const openApiDocument = z
      .object({
        openapi: z.string(),
        components: z.object({
          securitySchemes: z.record(z.unknown()),
          schemas: z.record(z.unknown()),
        }),
      })
      .parse(spec.json<unknown>());
    expect(openApiDocument).toMatchObject({
      openapi: '3.0.3',
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    });
    expect(Object.keys(openApiDocument.components.schemas)).toEqual(
      expect.arrayContaining([
        'Inbox',
        'Thread',
        'Message',
        'MessageSummary',
        'Pagination',
        'Webhook',
        'WebhookDelivery',
        'ErrorResponse',
      ]),
    );
  });

  it('returns the contract envelope for a bad API key', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer lm_admin_change_wrong' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'invalid_api_key', message: 'Invalid API key.' },
    });
  });

  it('distinguishes missing authorization from an invalid key', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'missing_authorization',
        message: 'Authorization header must use the Bearer scheme.',
      },
    });
  });

  it('decorates authenticated requests with pod and API-key context', async () => {
    const { app, store } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authorizationHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      pod_id: 'pod_test',
      api_key_id: 'key_test',
      scopes: ['*'],
    });
    expect(store.touchedApiKeyIds).toContain('key_test');
  });

  it('enforces route scopes after authentication', async () => {
    const { app } = buildTestApp({ scopes: ['messages:read'] });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/scoped',
      headers: authorizationHeader(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'insufficient_scope',
        message: 'API key requires the inboxes:read scope.',
      },
    });
  });

  it('replays a successful POST without running its handler again', async () => {
    const { app, getMutationCount } = buildTestApp();
    const headers = {
      ...authorizationHeader(),
      'idempotency-key': 'create-123',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/test-mutation',
      headers,
      payload: { second: 2, first: 1 },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/test-mutation',
      headers,
      payload: { first: 1, second: 2 },
    });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ execution: 1 });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replay']).toBe('true');
    expect(replay.json()).toEqual({ execution: 1 });
    expect(getMutationCount()).toBe(1);
  });

  it('rejects reuse of an idempotency key for a different body', async () => {
    const { app, getMutationCount } = buildTestApp();
    const headers = {
      ...authorizationHeader(),
      'idempotency-key': 'create-456',
    };

    await app.inject({
      method: 'POST',
      url: '/v1/test-mutation',
      headers,
      payload: { first: 1 },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/test-mutation',
      headers,
      payload: { first: 2 },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: 'idempotency_key_reused',
        message:
          'The Idempotency-Key was already used with a different request body.',
      },
    });
    expect(getMutationCount()).toBe(1);
  });

  it('does not memoize unsuccessful POST responses', async () => {
    const { app, getFailureCount } = buildTestApp();
    const headers = {
      ...authorizationHeader(),
      'idempotency-key': 'failure-123',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/test-failure',
      headers,
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/test-failure',
      headers,
    });

    expect(first.statusCode).toBe(409);
    expect(retry.statusCode).toBe(409);
    expect(getFailureCount()).toBe(2);
  });

  it('maps Zod failures to validation_error details', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/test-mutation',
      headers: authorizationHeader(),
      payload: { first: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'validation_error',
        message: 'Request validation failed.',
        details: [
          { path: 'first', message: 'Expected number, received string' },
        ],
      },
    });
  });

  it('uses the documented not-found envelope', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'The requested resource was not found.',
      },
    });
  });
});

describe('inbox CRUD', () => {
  it('creates, reads, updates, lists, and deletes an inbox', async () => {
    const { app } = buildTestApp();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/inboxes',
      headers: authorizationHeader(),
      payload: {
        display_name: 'Support agent',
        metadata: { team: 'support' },
      },
    });
    expect(created.statusCode).toBe(201);
    const inbox = z
      .object({
        id: z.string(),
        username: z.string(),
        address: z.string(),
        domain: z.string(),
      })
      .passthrough()
      .parse(created.json<unknown>());
    expect(inbox.username).toMatch(/^agent-[a-z0-9]{6}$/);
    expect(inbox.address).toBe(`${inbox.username}@localmail.test`);
    expect(inbox.domain).toBe('localmail.test');

    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}`,
      headers: authorizationHeader(),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: inbox.id, metadata: { team: 'support' } });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/inboxes/${inbox.id}`,
      headers: authorizationHeader(),
      payload: { display_name: 'Escalations', metadata: { priority: 1 } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id: inbox.id,
      address: inbox.address,
      display_name: 'Escalations',
      metadata: { priority: 1 },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/inboxes',
      headers: authorizationHeader(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      data: [{ id: inbox.id }],
      next_page_token: null,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/inboxes/${inbox.id}`,
      headers: authorizationHeader(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}`,
      headers: authorizationHeader(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'The requested inbox was not found.',
      },
    });
  });

  it('returns the same inbox when client_id is created twice', async () => {
    const { app, store } = buildTestApp();
    const request = {
      method: 'POST' as const,
      url: '/v1/inboxes',
      headers: authorizationHeader(),
      payload: { username: 'stable-agent', client_id: 'client-42' },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(store.inboxCount).toBe(1);
  });

  it('returns address_taken for a DB uniqueness collision', async () => {
    const { app } = buildTestApp();
    const request = {
      method: 'POST' as const,
      url: '/v1/inboxes',
      headers: authorizationHeader(),
      payload: { username: 'claimed' },
    };

    expect((await app.inject(request)).statusCode).toBe(201);
    const conflict = await app.inject(request);

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: 'address_taken',
        message: 'Inbox address is already in use.',
      },
    });
  });

  it('paginates newest-first with an opaque cursor', async () => {
    const { app } = buildTestApp();
    for (const username of ['first', 'second', 'third']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/inboxes',
        headers: authorizationHeader(),
        payload: { username },
      });
      expect(response.statusCode).toBe(201);
    }

    const firstPage = await app.inject({
      method: 'GET',
      url: '/v1/inboxes?limit=2',
      headers: authorizationHeader(),
    });
    const firstBody = z
      .object({
        data: z.array(z.object({ username: z.string() })),
        next_page_token: z.string(),
      })
      .parse(firstPage.json<unknown>());
    expect(firstBody.data.map(({ username }) => username)).toEqual([
      'third',
      'second',
    ]);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/inboxes?limit=2&page_token=${firstBody.next_page_token}`,
      headers: authorizationHeader(),
    });
    expect(secondPage.json()).toMatchObject({
      data: [{ username: 'first' }],
      next_page_token: null,
    });
  });

  it('rejects malformed cursors and immutable patch fields', async () => {
    const { app } = buildTestApp();
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/inboxes?page_token=not-a-cursor',
      headers: authorizationHeader(),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: {
        code: 'validation_error',
        details: [
          { path: 'page_token', message: 'invalid or expired page token' },
        ],
      },
    });

    const immutable = await app.inject({
      method: 'PATCH',
      url: '/v1/inboxes/inb_missing',
      headers: authorizationHeader(),
      payload: { username: 'replacement' },
    });
    expect(immutable.statusCode).toBe(400);
    expect(immutable.json()).toMatchObject({
      error: { code: 'validation_error' },
    });
  });

  it('enforces inbox read and write scopes', async () => {
    const { app } = buildTestApp({ scopes: ['inboxes:read'] });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/inboxes',
      headers: authorizationHeader(),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/inboxes',
      headers: authorizationHeader(),
      payload: { username: 'forbidden' },
    });

    expect(listed.statusCode).toBe(200);
    expect(created.statusCode).toBe(403);
    expect(created.json()).toEqual({
      error: {
        code: 'insufficient_scope',
        message: 'API key requires the inboxes:write scope.',
      },
    });
  });
});

describe('message send routes', () => {
  it('replies to a reply with the full reference chain and same thread', async () => {
    const sent: SendOutboundInput[] = [];
    const outbound: OutboundMessageService = {
      send(input) {
        sent.push(structuredClone(input));
        return Promise.resolve(
          makeMessageRow({
            id: 'msg_reply_3',
            inboxId: input.sender.id,
            threadId: input.existingThreadId ?? 'thr_new',
            messageIdHeader: '<reply-3@example.com>',
            inReplyTo: input.inReplyTo ?? null,
            references: input.references ?? [],
            subject: input.subject,
            text: input.text ?? null,
            html: input.html ?? null,
            hopCount: (input.incomingHopCount ?? 0) + 1,
            direction: 'outbound',
          }),
        );
      },
    };
    const { app, store } = buildTestApp({ outbound });
    const sender = store.seedInbox('sender', 'sender@localmail.test');
    store.seedMessage(
      makeMessageRow({
        id: 'msg_reply_2',
        inboxId: sender.id,
        threadId: 'thr_chain',
        messageIdHeader: '<reply-2@example.com>',
        inReplyTo: '<reply-1@example.com>',
        references: ['<root@example.com>', '<reply-1@example.com>'],
        from: 'Recipient <recipient@example.com>',
        to: [sender.address],
        subject: 'Re: Décoded topic',
        text: 'Second reply',
        hopCount: 2,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/inboxes/${sender.id}/messages/msg_reply_2/reply`,
      headers: authorizationHeader(),
      payload: { text: 'Third reply' },
    });

    expect(response.statusCode).toBe(201);
    expect(sent).toEqual([
      expect.objectContaining({
        sender,
        to: ['recipient@example.com'],
        subject: 'Re: Décoded topic',
        existingThreadId: 'thr_chain',
        inReplyTo: '<reply-2@example.com>',
        references: [
          '<root@example.com>',
          '<reply-1@example.com>',
          '<reply-2@example.com>',
        ],
        incomingHopCount: 2,
      }),
    ]);
    expect(response.json()).toMatchObject({
      thread_id: 'thr_chain',
      in_reply_to: '<reply-2@example.com>',
      direction: 'outbound',
    });
  });

  it('builds reply-all recipients and quoted forward headers', async () => {
    const sent: SendOutboundInput[] = [];
    const outbound: OutboundMessageService = {
      send(input) {
        sent.push(structuredClone(input));
        return Promise.resolve(
          makeMessageRow({
            id: `msg_out_${sent.length}`,
            inboxId: input.sender.id,
            threadId: input.existingThreadId ?? `thr_out_${sent.length}`,
            direction: 'outbound',
            messageIdHeader: `<out-${sent.length}@example.com>`,
            inReplyTo: input.inReplyTo ?? null,
            references: input.references ?? [],
            subject: input.subject,
            text: input.text ?? null,
            html: input.html ?? null,
          }),
        );
      },
    };
    const { app, store } = buildTestApp({ outbound });
    const sender = store.seedInbox('sender-all', 'sender-all@localmail.test');
    store.seedMessage(
      makeMessageRow({
        id: 'msg_original',
        inboxId: sender.id,
        messageIdHeader: '<original@example.com>',
        from: 'Author <author@example.com>',
        to: [sender.address, 'other@example.com'],
        cc: ['copied@example.com'],
        subject: 'Original subject',
        text: 'Original body',
      }),
    );

    const replyAll = await app.inject({
      method: 'POST',
      url: `/v1/inboxes/${sender.id}/messages/msg_original/reply`,
      headers: authorizationHeader(),
      payload: { text: 'Everyone sees this', reply_all: true },
    });
    const forward = await app.inject({
      method: 'POST',
      url: `/v1/inboxes/${sender.id}/messages/msg_original/forward`,
      headers: authorizationHeader(),
      payload: { to: ['forward@example.com'], text: 'FYI' },
    });

    expect(replyAll.statusCode).toBe(201);
    expect(forward.statusCode).toBe(201);
    expect(sent[0]).toMatchObject({
      to: ['author@example.com'],
      cc: ['other@example.com', 'copied@example.com'],
      subject: 'Re: Original subject',
      inReplyTo: '<original@example.com>',
    });
    expect(sent[1]).toMatchObject({
      to: ['forward@example.com'],
      subject: 'Fwd: Original subject',
      inReplyTo: '<original@example.com>',
      references: ['<original@example.com>'],
    });
    expect(sent[1]?.text).toContain('Forwarded message');
    expect(sent[1]?.text).toContain('Original body');
  });
});

describe('attachments', () => {
  it('accepts multipart upload and serves a signed URL until it expires', async () => {
    const sent: SendOutboundInput[] = [];
    const outbound: OutboundMessageService = {
      send(input) {
        sent.push(input);
        return Promise.resolve(
          makeMessageRow({
            id: 'msg_attachment',
            inboxId: input.sender.id,
            threadId: 'thr_attachment',
            direction: 'outbound',
            messageIdHeader: '<attachment@example.com>',
            subject: input.subject,
            text: input.text ?? null,
          }),
        );
      },
    };
    let now = new Date('2026-09-23T12:00:00.000Z');
    const signer = createAttachmentUrlSigner(
      'test-attachment-signing-secret-at-least-32-bytes',
      () => now,
    );
    const bytes = Buffer.from('attachment bytes');
    const reader: RawObjectReader = {
      getStream: () => Promise.resolve(Readable.from(bytes)),
    };
    const { app, store } = buildTestApp({
      outbound,
      rawObjectReader: reader,
      attachmentUrlSigner: signer,
    });
    const inbox = store.seedInbox('attachment', 'attachment@localmail.test');
    const multipart = makeMultipartBody(
      {
        to: ['outside@example.com'],
        subject: 'Attachment test',
        text: 'See attached.',
      },
      [{ filename: 'notes.txt', contentType: 'text/plain', content: bytes }],
    );

    const sentResponse = await app.inject({
      method: 'POST',
      url: `/v1/inboxes/${inbox.id}/messages/send`,
      headers: {
        ...authorizationHeader(),
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    });
    expect(sentResponse.statusCode, sentResponse.body).toBe(201);
    expect(sent[0]?.attachments).toEqual([
      expect.objectContaining({
        filename: 'notes.txt',
        contentType: 'text/plain',
        content: bytes,
      }),
    ]);

    const message = makeMessageRow({
      id: 'msg_attachment',
      inboxId: inbox.id,
      threadId: 'thr_attachment',
    });
    store.seedMessage(message);
    store.seedAttachment({
      id: 'att_test',
      messageId: message.id,
      filename: 'notes.txt',
      contentType: 'text/plain',
      size: bytes.byteLength,
      objectKey: 'attachments/test/notes.txt',
      contentId: null,
      createdAt: now,
    });

    const linkResponse = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/messages/${message.id}/attachments/att_test?expires_in=60`,
      headers: authorizationHeader(),
    });
    expect(linkResponse.statusCode).toBe(200);
    const link = z
      .object({
        url: z.string().url(),
        expires_at: z.string().datetime(),
        preview_allowed: z.boolean(),
      })
      .parse(linkResponse.json<unknown>());
    expect(link.preview_allowed).toBe(true);

    const downloadUrl = new URL(link.url);
    const downloaded = await app.inject({
      method: 'GET',
      url: `${downloadUrl.pathname}${downloadUrl.search}`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(bytes);
    expect(downloaded.headers['content-type']).toContain('text/plain');
    expect(downloaded.headers['content-disposition']).toContain('inline');

    now = new Date('2026-09-23T12:01:01.000Z');
    const expired = await app.inject({
      method: 'GET',
      url: `${downloadUrl.pathname}${downloadUrl.search}`,
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({
      error: {
        code: 'validation_error',
        details: [{ path: 'expires', message: 'signed URL has expired' }],
      },
    });
  });

  it('accepts multipart attachments on reply and forward routes', async () => {
    const sent: SendOutboundInput[] = [];
    const outbound: OutboundMessageService = {
      send(input) {
        sent.push(input);
        return Promise.resolve(
          makeMessageRow({
            id: `msg_attachment_${sent.length}`,
            inboxId: input.sender.id,
            threadId: input.existingThreadId ?? `thr_attachment_${sent.length}`,
            direction: 'outbound',
            messageIdHeader: `<attachment-${sent.length}@example.com>`,
            subject: input.subject,
            text: input.text ?? null,
          }),
        );
      },
    };
    const { app, store } = buildTestApp({ outbound });
    const inbox = store.seedInbox(
      'attachment-actions',
      'attachment-actions@localmail.test',
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_attachment_source',
        inboxId: inbox.id,
        threadId: 'thr_attachment_source',
        messageIdHeader: '<attachment-source@example.com>',
        from: 'author@example.com',
        subject: 'Source',
        text: 'Original',
      }),
    );
    const file = {
      filename: 'reply.txt',
      contentType: 'text/plain',
      content: Buffer.from('reply attachment'),
    };
    const reply = makeMultipartBody({ text: 'Reply' }, [file]);
    const forward = makeMultipartBody(
      { to: ['forward@example.com'], text: 'Forward' },
      [{ ...file, filename: 'forward.txt' }],
    );

    const [replyResponse, forwardResponse] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/inboxes/${inbox.id}/messages/msg_attachment_source/reply`,
        headers: {
          ...authorizationHeader(),
          'content-type': reply.contentType,
        },
        payload: reply.body,
      }),
      app.inject({
        method: 'POST',
        url: `/v1/inboxes/${inbox.id}/messages/msg_attachment_source/forward`,
        headers: {
          ...authorizationHeader(),
          'content-type': forward.contentType,
        },
        payload: forward.body,
      }),
    ]);

    expect(replyResponse.statusCode).toBe(201);
    expect(forwardResponse.statusCode).toBe(201);
    expect(sent.map((input) => input.attachments?.[0]?.filename).sort()).toEqual(
      ['forward.txt', 'reply.txt'],
    );
  });
});

describe('draft routes', () => {
  it('creates, lists, gets, updates, schedules, and deletes drafts', async () => {
    const { app, store } = buildTestApp();
    const inbox = store.seedInbox('drafts', 'drafts@localmail.test');
    store.seedThread(makeThreadRow(inbox.id, 'thr_draft'));

    const created = await app.inject({
      method: 'POST',
      url: `/v1/inboxes/${inbox.id}/drafts`,
      headers: authorizationHeader(),
      payload: {
        thread_id: 'thr_draft',
        to: ['Recipient@Example.com'],
        subject: 'Working draft',
        text: 'Not sent yet',
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = z
      .object({ id: z.string(), status: z.literal('draft'), threadId: z.string() })
      .parse(created.json<unknown>());
    expect(created.json()).toMatchObject({
      to: ['recipient@example.com'],
      sendAt: null,
    });

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/drafts`,
      headers: authorizationHeader(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ data: [{ id: draft.id }] });

    const scheduled = await app.inject({
      method: 'PATCH',
      url: `/v1/inboxes/${inbox.id}/drafts/${draft.id}`,
      headers: authorizationHeader(),
      payload: { send_at: '2099-01-01T00:00:00.000Z' },
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json()).toMatchObject({ status: 'scheduled' });

    const unscheduled = await app.inject({
      method: 'PATCH',
      url: `/v1/inboxes/${inbox.id}/drafts/${draft.id}`,
      headers: authorizationHeader(),
      payload: { send_at: null },
    });
    expect(unscheduled.statusCode).toBe(200);
    expect(unscheduled.json()).toMatchObject({ status: 'draft', sendAt: null });

    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/drafts/${draft.id}`,
      headers: authorizationHeader(),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: draft.id, status: 'draft' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/inboxes/${inbox.id}/drafts/${draft.id}`,
      headers: authorizationHeader(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/inboxes/${inbox.id}/drafts/${draft.id}`,
          headers: authorizationHeader(),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects past schedules and protects claimed drafts from edits/deletes', async () => {
    const { app, store } = buildTestApp();
    const inbox = store.seedInbox('draft-edge', 'draft-edge@localmail.test');
    const past = await app.inject({
      method: 'POST',
      url: `/v1/inboxes/${inbox.id}/drafts`,
      headers: authorizationHeader(),
      payload: {
        to: ['recipient@example.com'],
        send_at: new Date(Date.now() - 1000).toISOString(),
      },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({
      error: { code: 'validation_error', message: 'send_at must be in the future.' },
    });

    const row = makeDraftRow(inbox.id, 'draft_claimed', { status: 'sending' });
    store.seedDraft(row);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/inboxes/${inbox.id}/drafts/${row.id}`,
      headers: authorizationHeader(),
      payload: { subject: 'race' },
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/inboxes/${inbox.id}/drafts/${row.id}`,
      headers: authorizationHeader(),
    });
    expect(patch.statusCode).toBe(400);
    expect(deleted.statusCode).toBe(400);
    expect(deleted.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('sends an immediate draft through the existing outbound service and marks it sent', async () => {
    const sent: SendOutboundInput[] = [];
    const outbound: OutboundMessageService = {
      send(input) {
        sent.push(input);
        return Promise.resolve(
          makeMessageRow({
            id: 'msg_from_draft',
            inboxId: input.sender.id,
            threadId: input.existingThreadId ?? 'thr_from_draft',
            direction: 'outbound',
            messageIdHeader: '<draft-send@example.com>',
            subject: input.subject,
            text: input.text ?? null,
          }),
        );
      },
    };
    const { app, store } = buildTestApp({ outbound });
    const inbox = store.seedInbox('draft-send', 'draft-send@localmail.test');
    const row = makeDraftRow(inbox.id, 'draft_to_send', {
      to: ['recipient@example.com'],
      subject: 'Send me',
      text: 'Draft body',
    });
    store.seedDraft(row);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/inboxes/${inbox.id}/drafts/${row.id}/send`,
      headers: authorizationHeader(),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: 'msg_from_draft' });
    expect(sent[0]).toMatchObject({
      sender: inbox,
      to: ['recipient@example.com'],
      subject: 'Send me',
      text: 'Draft body',
    });
    expect((await store.findDraftById('pod_test', inbox.id, row.id))?.status).toBe('sent');
  });
});

describe('pods and scoped API keys', () => {
  it('creates a pod with a one-time admin key and refuses admin scope minting', async () => {
    const { app } = buildTestApp();
    const created = await app.inject({ method: 'POST', url: '/v1/pods', headers: authorizationHeader(), payload: { name: 'Agent Pod' } });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{ pod: { name: string }; admin_api_key: string }>();
    expect(createdBody.pod.name).toBe('Agent Pod');
    expect(createdBody.admin_api_key.startsWith('lm_admin_')).toBe(true);
    const star = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: authorizationHeader(), payload: { scopes: ['*'] } });
    expect(star.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: authorizationHeader(), payload: { scopes: ['typo:scope'] } });
    expect(unknown.statusCode).toBe(400);
  });
});

describe('search routes', () => {
  it('searches plain text, scopes by pod/inbox, and paginates by rank/id', async () => {
    const { app, store } = buildTestApp();
    const inbox = store.seedInbox('search', 'search@localmail.test');
    store.seedMessage(makeMessageRow({ id: 'msg_search_b', inboxId: inbox.id, subject: 'Refund request', text: 'please refund this' }));
    store.seedMessage({ ...makeMessageRow({ id: 'msg_search_a', inboxId: inbox.id, subject: 'Refund request', text: 'please refund this' }), embedding: [1, 0, 0] });
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=refund&limit=1', headers: authorizationHeader() });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: Array<{ id: string; rank: number }>; next_page_token: string | null }>();
    expect(body.data).toHaveLength(1); expect(body.data[0]?.rank).toBeGreaterThan(0); expect(body.next_page_token).toBeTruthy();
    const next = await app.inject({ method: 'GET', url: `/v1/search?q=refund&limit=1&page_token=${body.next_page_token}`, headers: authorizationHeader() });
    expect(next.statusCode).toBe(200); expect(next.json<{ data: Array<{ id: string }> }>().data).toHaveLength(1);
    const mismatch = await app.inject({ method: 'GET', url: `/v1/search?q=refund&mode=semantic&page_token=${body.next_page_token}`, headers: authorizationHeader() });
    expect(mismatch.statusCode).toBe(400);
    const adversarial = await app.inject({ method: 'GET', url: '/v1/search?q=refund%20%26%20%28invoice', headers: authorizationHeader() });
    expect(adversarial.statusCode).toBe(200);
    const bad = await app.inject({ method: 'GET', url: '/v1/search?q=%20%20', headers: authorizationHeader() });
    expect(bad.statusCode).toBe(400);
    const semantic = await app.inject({ method: 'GET', url: '/v1/search?q=refund&mode=semantic', headers: authorizationHeader() });
    expect(semantic.statusCode).toBe(200);
    expect(semantic.json<{ data: Array<{ rank: number; mode: string }> }>().data[0]?.mode).toBe('semantic');
  });
});

describe('custom domains', () => {
  it('creates encrypted RSA DNS records, verifies echo-back, and never exposes the private key', async () => {
    const { app } = buildTestApp();
    const created = await app.inject({ method: 'POST', url: '/v1/domains', headers: authorizationHeader(), payload: { domain: 'mail.example.test' } });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ id: string; status: string; dns_records: { dkim: { host: string; value: string } } }>();
    expect(body.status).toBe('pending'); expect(body.dns_records.dkim.value).toContain('p=');
    expect(created.body).not.toContain('dkim_private_key');
    const failed = await app.inject({ method: 'POST', url: `/v1/domains/${body.id}/verify`, headers: authorizationHeader(), payload: { dns_records: { dkim: { host: 'wrong', value: 'wrong' } } } });
    expect(failed.statusCode).toBe(200); expect(failed.json<{ status: string }>().status).toBe('failed');
    const verified = await app.inject({ method: 'POST', url: `/v1/domains/${body.id}/verify`, headers: authorizationHeader(), payload: { dns_records: body.dns_records } });
    expect(verified.statusCode).toBe(200); expect(verified.json<{ status: string }>().status).toBe('verified'); expect(verified.body).not.toContain('dkim_private_key');
  });
});

describe('thread and message reads', () => {
  it('keeps cursor pagination stable when a newer message arrives between pages', async () => {
    const { app, store } = buildTestApp();
    const inbox = store.seedInbox('paged', 'paged@localmail.test');
    store.seedThread(makeThreadRow(inbox.id, 'thr_paged'));
    for (const [id, timestamp] of [
      ['msg_1', '2026-09-23T12:01:00.000Z'],
      ['msg_2', '2026-09-23T12:02:00.000Z'],
      ['msg_3', '2026-09-23T12:03:00.000Z'],
    ] as const) {
      store.seedMessage(
        makeMessageRow({
          id,
          inboxId: inbox.id,
          threadId: 'thr_paged',
          receivedAt: new Date(timestamp),
          createdAt: new Date(timestamp),
        }),
      );
    }

    const first = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/messages?limit=2`,
      headers: authorizationHeader(),
    });
    const firstBody = z
      .object({
        data: z.array(z.object({ id: z.string() })),
        next_page_token: z.string(),
      })
      .parse(first.json<unknown>());

    store.seedMessage(
      makeMessageRow({
        id: 'msg_newer',
        inboxId: inbox.id,
        threadId: 'thr_paged',
        receivedAt: new Date('2026-09-23T12:04:00.000Z'),
        createdAt: new Date('2026-09-23T12:04:00.000Z'),
      }),
    );
    const second = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/messages?limit=2&page_token=${firstBody.next_page_token}`,
      headers: authorizationHeader(),
    });
    const secondBody = z
      .object({
        data: z.array(z.object({ id: z.string() })),
        next_page_token: z.string().nullable(),
      })
      .parse(second.json<unknown>());

    expect(firstBody.data.map(({ id }) => id)).toEqual(['msg_3', 'msg_2']);
    expect(secondBody.data.map(({ id }) => id)).toEqual(['msg_1']);
    expect(secondBody.next_page_token).toBeNull();
  });

  it('applies label, time, sender, and unread filters', async () => {
    const { app, store } = buildTestApp();
    const inbox = store.seedInbox('filtered', 'filtered@localmail.test');
    store.seedThread(
      makeThreadRow(inbox.id, 'thr_filtered', {
        labels: ['inbox', 'unread'],
        lastMessageAt: new Date('2026-09-23T12:03:00.000Z'),
      }),
    );
    store.seedThread(
      makeThreadRow(inbox.id, 'thr_sent', {
        labels: ['sent'],
        lastMessageAt: new Date('2026-09-23T12:02:00.000Z'),
      }),
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_alice_unread',
        inboxId: inbox.id,
        threadId: 'thr_filtered',
        from: 'Alice <alice@example.com>',
        labels: ['inbox', 'unread'],
        receivedAt: new Date('2026-09-23T12:01:00.000Z'),
      }),
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_bob',
        inboxId: inbox.id,
        threadId: 'thr_filtered',
        from: 'bob@example.com',
        labels: ['sent'],
        receivedAt: new Date('2026-09-23T12:02:00.000Z'),
      }),
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_alice_read',
        inboxId: inbox.id,
        threadId: 'thr_filtered',
        from: 'alice@example.com',
        labels: ['inbox'],
        receivedAt: new Date('2026-09-23T12:03:00.000Z'),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/messages?labels=inbox&after=2026-09-23T12%3A00%3A00.000Z&before=2026-09-23T12%3A04%3A00.000Z&sender=alice%40example.com&unread=false`,
      headers: authorizationHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ id: 'msg_alice_read' }],
      next_page_token: null,
    });

    const threadResponse = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/threads?labels=inbox&after=2026-09-23T12%3A01%3A00.000Z&before=2026-09-23T12%3A04%3A00.000Z`,
      headers: authorizationHeader(),
    });
    expect(threadResponse.statusCode).toBe(200);
    expect(threadResponse.json()).toMatchObject({
      data: [{ id: 'thr_filtered' }],
      next_page_token: null,
    });
  });

  it('returns thread detail, full message content, raw bytes, and cursor errors', async () => {
    const raw = Buffer.from('From: sender@example.com\r\n\r\nRaw body');
    const reader: RawObjectReader = {
      getStream: () => Promise.resolve(Readable.from(raw)),
    };
    const { app, store } = buildTestApp({ rawObjectReader: reader });
    const inbox = store.seedInbox('reader', 'reader@localmail.test');
    store.seedThread(
      makeThreadRow(inbox.id, 'thr_reader', {
        subjectNormalized: 'read me',
        labels: ['inbox'],
      }),
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_reader',
        inboxId: inbox.id,
        threadId: 'thr_reader',
        subject: 'Read me',
        text: 'Full text',
        html: '<p>Full text</p>',
        labels: ['inbox'],
        rawObjectKey: 'raw/test.eml',
      }),
    );

    const [thread, message, rawResponse, malformed] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${inbox.id}/threads/thr_reader`,
        headers: authorizationHeader(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${inbox.id}/messages/msg_reader`,
        headers: authorizationHeader(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${inbox.id}/messages/msg_reader/raw`,
        headers: authorizationHeader(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${inbox.id}/messages?page_token=broken`,
        headers: authorizationHeader(),
      }),
    ]);

    expect(thread.statusCode).toBe(200);
    expect(thread.json()).toMatchObject({
      thread: { id: 'thr_reader' },
      messages: [{ id: 'msg_reader', preview: 'Full text' }],
    });
    expect(message.statusCode).toBe(200);
    expect(message.json()).toMatchObject({
      id: 'msg_reader',
      text: 'Full text',
      html: '<p>Full text</p>',
    });
    expect(rawResponse.statusCode).toBe(200);
    expect(rawResponse.headers['content-type']).toContain('message/rfc822');
    expect(rawResponse.rawPayload).toEqual(raw);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: {
        code: 'validation_error',
        details: [
          { path: 'page_token', message: 'invalid or expired page token' },
        ],
      },
    });
  });

  it('hides inboxes, threads, messages, and raw content owned by another pod', async () => {
    const { app, store } = buildTestApp();
    const foreignInbox = store.seedInbox(
      'foreign',
      'foreign@localmail.test',
      'pod_other',
    );
    store.seedThread(makeThreadRow(foreignInbox.id, 'thr_foreign'));
    store.seedMessage(
      makeMessageRow({
        id: 'msg_foreign',
        inboxId: foreignInbox.id,
        threadId: 'thr_foreign',
        rawObjectKey: 'raw/foreign.eml',
      }),
    );

    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${foreignInbox.id}/threads`,
        headers: authorizationHeader(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${foreignInbox.id}/threads/thr_foreign`,
        headers: authorizationHeader(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${foreignInbox.id}/messages`,
        headers: authorizationHeader(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${foreignInbox.id}/messages/msg_foreign`,
        headers: authorizationHeader(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/inboxes/${foreignInbox.id}/messages/msg_foreign/raw`,
        headers: authorizationHeader(),
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });
});

describe('message label updates (P4-18-api G2)', () => {
  function seedLabeledMessage(store: MemoryApiStore) {
    const inbox = store.seedInbox('labels', 'labels@localmail.test');
    store.seedThread(
      makeThreadRow(inbox.id, 'thr_labels', { labels: ['inbox'] }),
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_a',
        inboxId: inbox.id,
        threadId: 'thr_labels',
        labels: ['inbox'],
      }),
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_b',
        inboxId: inbox.id,
        threadId: 'thr_labels',
        labels: ['sent'],
      }),
    );
    return inbox;
  }

  it('adds and removes labels, and recomputes the thread union', async () => {
    const { app, store } = buildTestApp();
    const inbox = seedLabeledMessage(store);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/inboxes/${inbox.id}/messages/msg_a`,
      headers: authorizationHeader(),
      payload: { add_labels: ['triaged'], remove_labels: ['inbox'] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ id: string; labels: string[] }>();
    expect(body.id).toBe('msg_a');
    expect(body.labels).toContain('triaged');
    expect(body.labels).not.toContain('inbox');

    const thread = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/threads/thr_labels`,
      headers: authorizationHeader(),
    });
    // Union of msg_a's ['triaged'] and msg_b's ['sent'].
    const threadBody = thread.json<{ thread: { labels: string[] } }>();
    expect(threadBody.thread.labels.sort()).toEqual(['sent', 'triaged']);
  });

  it('requires the messages:write scope', async () => {
    const { app, store } = buildTestApp({ scopes: ['messages:read'] });
    const inbox = seedLabeledMessage(store);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/inboxes/${inbox.id}/messages/msg_a`,
      headers: authorizationHeader(),
      payload: { add_labels: ['triaged'] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'insufficient_scope' },
    });
  });

  it('404s across pods and 400s on an empty body', async () => {
    const { app, store } = buildTestApp();
    const foreignInbox = store.seedInbox(
      'foreign-labels',
      'foreign-labels@localmail.test',
      'pod_other',
    );
    store.seedMessage(
      makeMessageRow({ id: 'msg_foreign', inboxId: foreignInbox.id }),
    );
    const inbox = seedLabeledMessage(store);

    const [crossPod, emptyBody] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/v1/inboxes/${foreignInbox.id}/messages/msg_foreign`,
        headers: authorizationHeader(),
        payload: { add_labels: ['triaged'] },
      }),
      app.inject({
        method: 'PATCH',
        url: `/v1/inboxes/${inbox.id}/messages/msg_a`,
        headers: authorizationHeader(),
        payload: {},
      }),
    ]);

    expect(crossPod.statusCode).toBe(404);
    expect(emptyBody.statusCode).toBe(400);
    expect(emptyBody.json()).toMatchObject({
      error: { code: 'validation_error' },
    });
  });
});

describe('listMessages direction filter and listInboxes address filter (G3-G5)', () => {
  it('excludes outbound rows when direction=inbound is set', async () => {
    const { app, store } = buildTestApp();
    const inbox = store.seedInbox('dir', 'dir@localmail.test');
    store.seedThread(makeThreadRow(inbox.id, 'thr_dir'));
    store.seedMessage(
      makeMessageRow({
        id: 'msg_in',
        inboxId: inbox.id,
        threadId: 'thr_dir',
        direction: 'inbound',
      }),
    );
    store.seedMessage(
      makeMessageRow({
        id: 'msg_out',
        inboxId: inbox.id,
        threadId: 'thr_dir',
        direction: 'outbound',
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/messages?direction=inbound`,
      headers: authorizationHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: Array<{ id: string }> }>();
    expect(body.data.map((m) => m.id)).toEqual(['msg_in']);
  });

  it('includes G3 summary fields on list and thread-detail responses', async () => {
    const { app, store } = buildTestApp();
    const inbox = store.seedInbox('g3', 'g3@localmail.test');
    store.seedThread(makeThreadRow(inbox.id, 'thr_g3'));
    store.seedMessage(
      makeMessageRow({
        id: 'msg_g3',
        inboxId: inbox.id,
        threadId: 'thr_g3',
        direction: 'inbound',
        from: 'sender@example.com',
        to: ['g3@localmail.test'],
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/inboxes/${inbox.id}/messages`,
      headers: authorizationHeader(),
    });

    expect(response.json()).toMatchObject({
      data: [
        {
          id: 'msg_g3',
          direction: 'inbound',
          from: 'sender@example.com',
          to: ['g3@localmail.test'],
        },
      ],
    });
    const g3Body = response.json<{
      data: Array<{ received_at: unknown; created_at: unknown }>;
    }>();
    expect(g3Body.data[0]?.received_at).toBeTypeOf('string');
    expect(g3Body.data[0]?.created_at).toBeTypeOf('string');
  });

  it('finds an inbox by an exact, case-insensitive address match', async () => {
    const { app, store } = buildTestApp();
    store.seedInbox('addr', 'Addr@LocalMail.test');
    store.seedInbox('other', 'other@localmail.test');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/inboxes?address=${encodeURIComponent('addr@localmail.test')}`,
      headers: authorizationHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: Array<{ address: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.address).toBe('Addr@LocalMail.test');
  });
});

describe('OpenAPI spec (G1, G7, §2.4 drift gate)', () => {
  it('captures every route, including updateMessageLabels, in the generated spec', async () => {
    const { app } = buildTestApp();
    await app.ready();
    const document = app.swagger();
    const operationIds = new Set<string>();
    for (const methods of Object.values(document.paths ?? {})) {
      for (const details of Object.values(
        methods as Record<string, { operationId?: string }>,
      )) {
        if (details.operationId) operationIds.add(details.operationId);
      }
    }

    for (const expected of [
      'getHealth',
      'getCurrentApiKey',
      'createInbox',
      'listInboxes',
      'getInbox',
      'updateInbox',
      'deleteInbox',
      'listThreads',
      'getThread',
      'listMessages',
      'getMessage',
      'getMessageRaw',
      'updateMessageLabels',
      'sendMessage',
      'replyToMessage',
      'forwardMessage',
      'getAttachmentDownloadUrl',
      'downloadAttachment',
      'createWebhook',
      'listWebhooks',
      'getWebhook',
      'updateWebhook',
      'deleteWebhook',
      'listWebhookDeliveries',
      'testFireWebhook',
      'createPod',
      'getPod',
      'createApiKey',
      'listApiKeys',
      'revokeApiKey',
    ]) {
      expect(operationIds.has(expected), expected).toBe(true);
    }

    const components = (
      document as { components?: { schemas?: Record<string, unknown> } }
    ).components;
    expect(Object.keys(components?.schemas ?? {}).sort()).toEqual([
      'Draft',
      'ErrorResponse',
      'Inbox',
      'Message',
      'MessageSummary',
      'Pagination',
      'Thread',
      'Webhook',
      'WebhookDelivery',
    ]);
  });

  it('matches the committed packages/sdk/openapi.json (no drift)', async () => {
    const { buildOpenApiDocument, sortKeysDeep } = await import(
      './export-openapi.js'
    );
    const generated = await buildOpenApiDocument();
    const committed = JSON.parse(
      await readFile(
        new URL('../../../packages/sdk/openapi.json', import.meta.url),
        'utf8',
      ),
    ) as unknown;

    expect(sortKeysDeep(generated)).toEqual(sortKeysDeep(committed));
  });
});

describe('webhooks', () => {
  it('creates a webhook with a one-time secret and omits secret on GET', async () => {
    const { app } = buildTestApp();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authorizationHeader(),
      payload: {
        url: 'http://127.0.0.1:9999/hook',
        event_types: ['message.received'],
        enabled: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{
      id: string;
      secret: string;
      enabled: boolean;
    }>();
    expect(createdBody.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(createdBody.enabled).toBe(false);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: authorizationHeader(),
    });
    expect(listed.statusCode).toBe(200);
    const listBody = listed.json<{ data: Array<Record<string, unknown>> }>();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).not.toHaveProperty('secret');
    expect(listBody.data[0]).toMatchObject({
      id: createdBody.id,
      url: 'http://127.0.0.1:9999/hook',
      event_types: ['message.received'],
      enabled: false,
    });

    const got = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${createdBody.id}`,
      headers: authorizationHeader(),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).not.toHaveProperty('secret');
  });

  it('enforces webhook read and write scopes', async () => {
    const { app } = buildTestApp({ scopes: ['webhooks:read'] });

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authorizationHeader(),
      payload: {
        url: 'http://127.0.0.1:9999/hook',
        event_types: ['message.sent'],
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: 'insufficient_scope' },
    });

    const allowedList = await app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: authorizationHeader(),
    });
    expect(allowedList.statusCode).toBe(200);
  });

  it('updates, deletes, and isolates foreign-pod webhooks as 404', async () => {
    const { app, store } = buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authorizationHeader(),
      payload: {
        url: 'http://127.0.0.1:9999/hook',
        event_types: ['message.received', 'message.sent'],
      },
    });
    const webhookId = created.json<{ id: string }>().id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${webhookId}`,
      headers: authorizationHeader(),
      payload: { enabled: false, inbox_ids: ['inb_demo'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      enabled: false,
      inbox_ids: ['inb_demo'],
    });
    expect(patched.json()).not.toHaveProperty('secret');

    await store.createWebhook({
      id: 'wh_foreign',
      podId: 'pod_other',
      url: 'http://127.0.0.1:9999/other',
      secretCiphertext: 'v1:x:y:z',
      eventTypes: ['message.received'],
      inboxIds: null,
      enabled: true,
    });
    const foreign = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/wh_foreign',
      headers: authorizationHeader(),
    });
    expect(foreign.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${webhookId}`,
      headers: authorizationHeader(),
    });
    expect(deleted.statusCode).toBe(204);
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${webhookId}`,
      headers: authorizationHeader(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('test-fires through the shared enqueue path and lists a real delivery row', async () => {
    const { app } = buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authorizationHeader(),
      payload: {
        url: 'http://127.0.0.1:9999/hook',
        event_types: ['message.received'],
        enabled: false,
      },
    });
    const webhookId = created.json<{ id: string }>().id;

    const fired = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/${webhookId}/test`,
      headers: authorizationHeader(),
    });
    expect(fired.statusCode).toBe(202);
    const fireBody = fired.json<{ event_id: string; delivery_id: string }>();
    expect(fireBody.event_id).toMatch(/^evt_/);
    expect(fireBody.delivery_id).toMatch(/^whd_/);

    const deliveries = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${webhookId}/deliveries`,
      headers: authorizationHeader(),
    });
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json()).toMatchObject({
      data: [
        {
          id: fireBody.delivery_id,
          webhook_id: webhookId,
          event_id: fireBody.event_id,
          status: 'pending',
          attempts: 0,
          last_error: null,
        },
      ],
    });
  });
});

function buildTestApp(
  options: {
    scopes?: string[];
    outbound?: OutboundMessageService;
    rawObjectReader?: RawObjectReader;
    attachmentUrlSigner?: AttachmentUrlSigner;
  } = {},
) {
  const apiKey = makeApiKeyRow(rawAdminKey, options.scopes ?? ['*']);
  const store = new MemoryApiStore(apiKey);
  const encryptionKey = randomBytes(32);
  let mutationCount = 0;
  let failureCount = 0;
  const app = createApp(
    parseEnv({
      NODE_ENV: 'test',
      APP_ENCRYPTION_KEY: encryptionKey.toString('base64'),
    }),
    {
      logger: false,
      store,
      outbound: options.outbound,
      rawObjectReader: options.rawObjectReader,
      attachmentUrlSigner: options.attachmentUrlSigner,
      encryptionKey,
      wsSubscriber: null,
      webhookTestFire: {
        enqueueTestFire({ podId, webhookId }) {
          return store.enqueueTestFire(podId, webhookId);
        },
      },
      registerRoutes: (instance, _options, done) => {
        instance.get(
          '/v1/scoped',
          { preHandler: requireScope('inboxes:read') },
          () => ({ ok: true }),
        );
        instance.post(
          '/v1/test-mutation',
          {
            schema: {
              body: z.object({
                first: z.number(),
                second: z.number().optional(),
              }),
            },
          },
          (_request, reply) => {
            mutationCount += 1;
            return reply.code(201).send({ execution: mutationCount });
          },
        );
        instance.post('/v1/test-failure', () => {
          failureCount += 1;
          throw new ApiError(
            'address_taken',
            409,
            'Inbox address is already in use.',
          );
        });
        done();
      },
    },
  );
  apps.push(app);
  return {
    app,
    store,
    encryptionKey,
    getMutationCount: () => mutationCount,
    getFailureCount: () => failureCount,
  };
}

function authorizationHeader(): { authorization: string } {
  return { authorization: `Bearer ${rawAdminKey}` };
}

function makeApiKeyRow(rawKey: string, scopes: string[]): ApiKeyRow {
  const salt = randomBytes(16);
  const hash = scryptSync(rawKey, salt, 64);
  return {
    id: 'key_test',
    podId: 'pod_test',
    prefix: rawKey.slice(0, 12),
    hash: `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`,
    scopes,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-09-22T00:00:00Z'),
  };
}

class MemoryApiStore implements ApiStore {
  readonly touchedApiKeyIds: string[] = [];
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly inboxes: InboxRow[] = [];
  private readonly messages: MessageRow[] = [];
  private readonly threads: ThreadRow[] = [];
  private readonly attachments: AttachmentRow[] = [];
  private readonly drafts: DraftRow[] = [];
  private readonly pods: PodRow[] = [{ id: 'pod_test', name: 'Test Pod', createdAt: new Date('2026-09-22T00:00:00.000Z') }];
  private readonly keys: ApiKeyRow[] = [];
  private readonly domains: DomainRow[] = [];
  private readonly webhooks: WebhookRow[] = [];
  private readonly deliveries: WebhookDeliveryRow[] = [];
  private createdInboxCount = 0;

  constructor(private readonly apiKey: ApiKeyRow) { this.keys.push(apiKey); }

  get inboxCount(): number {
    return this.inboxes.length;
  }

  seedInbox(
    username: string,
    address: string,
    podId = 'pod_test',
  ): InboxRow {
    const row: InboxRow = {
      id: `inb_${username}`,
      podId,
      username,
      domain: address.split('@')[1] ?? 'localmail.test',
      address,
      displayName: null,
      metadata: {},
      clientId: null,
      createdAt: new Date('2026-09-22T00:00:00.000Z'),
    };
    this.inboxes.push(row);
    return structuredClone(row);
  }

  seedMessage(message: MessageRow): void {
    this.messages.push(structuredClone(message));
  }

  seedThread(thread: ThreadRow): void {
    this.threads.push(structuredClone(thread));
  }

  seedAttachment(attachment: AttachmentRow): void {
    this.attachments.push(structuredClone(attachment));
  }

  seedDraft(draft: DraftRow): void {
    this.drafts.push(structuredClone(draft));
  }

  createPod(record: { id: string; name: string }): Promise<PodRow> {
    const row = { ...record, createdAt: new Date() }; this.pods.push(row); return Promise.resolve(row);
  }
  findPodById(id: string): Promise<PodRow | null> { return Promise.resolve(this.pods.find((pod) => pod.id === id) ?? null); }
  createApiKey(record: { id: string; podId: string; prefix: string; hash: string; scopes: string[] }): Promise<ApiKeyRow> {
    const row: ApiKeyRow = { ...record, lastUsedAt: null, revokedAt: null, createdAt: new Date() }; this.keys.push(row); return Promise.resolve(row);
  }
  listApiKeys(podId: string, limit: number, cursor?: InboxCursor): Promise<ApiKeyRow[]> {
    return Promise.resolve(this.keys.filter((key) => key.podId === podId && (!cursor || key.createdAt < cursor.createdAt)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit));
  }
  countActiveApiKeys(podId: string): Promise<number> { return Promise.resolve(this.keys.filter((key) => key.podId === podId && !key.revokedAt).length); }
  revokeApiKey(podId: string, id: string): Promise<boolean> { const row = this.keys.find((key) => key.podId === podId && key.id === id && !key.revokedAt); if (!row) return Promise.resolve(false); row.revokedAt = new Date(); return Promise.resolve(true); }
  createDomain(record: { id: string; podId: string; domain: string; status: 'pending'; dkimPrivateKey: string; dnsRecords: Record<string, unknown> }): Promise<DomainRow> { const row: DomainRow = { ...record, createdAt: new Date() }; this.domains.push(row); return Promise.resolve(row); }
  listDomains(podId: string, limit: number, cursor?: InboxCursor): Promise<DomainRow[]> { return Promise.resolve(this.domains.filter((domain) => domain.podId === podId && (!cursor || domain.createdAt < cursor.createdAt)).slice(0, limit)); }
  findDomainById(podId: string, id: string): Promise<DomainRow | null> { return Promise.resolve(this.domains.find((domain) => domain.podId === podId && domain.id === id) ?? null); }
  updateDomainStatus(podId: string, id: string, status: 'verified' | 'failed'): Promise<DomainRow | null> { const row = this.domains.find((domain) => domain.podId === podId && domain.id === id); if (row) row.status = status; return Promise.resolve(row ?? null); }
  deleteDomain(podId: string, id: string): Promise<boolean> { const index = this.domains.findIndex((domain) => domain.podId === podId && domain.id === id); if (index < 0) return Promise.resolve(false); this.domains.splice(index, 1); return Promise.resolve(true); }
  findVerifiedDomain(podId: string, domain: string): Promise<DomainRow | null> { return Promise.resolve(this.domains.find((row) => row.podId === podId && row.domain === domain && row.status === 'verified') ?? null); }

  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    return Promise.resolve(prefix === this.apiKey.prefix ? this.apiKey : null);
  }

  touchApiKey(id: string): Promise<void> {
    this.touchedApiKeyIds.push(id);
    return Promise.resolve();
  }

  findIdempotencyRecord(
    podId: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    return Promise.resolve(this.idempotency.get(`${podId}:${key}`) ?? null);
  }

  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(
      `${record.podId}:${record.key}`,
      structuredClone(record),
    );
    return Promise.resolve();
  }

  findInboxByClientId(
    podId: string,
    clientId: string,
  ): Promise<InboxRow | null> {
    return Promise.resolve(
      this.inboxes.find(
        (inbox) => inbox.podId === podId && inbox.clientId === clientId,
      ) ?? null,
    );
  }

  createInbox(record: CreateInboxRecord): Promise<InboxRow | null> {
    const collides = this.inboxes.some(
      (inbox) =>
        inbox.address === record.address ||
        (record.clientId !== null && inbox.clientId === record.clientId) ||
        (inbox.podId === record.podId &&
          inbox.username === record.username &&
          inbox.domain === record.domain),
    );
    if (collides) return Promise.resolve(null);

    this.createdInboxCount += 1;
    const row: InboxRow = {
      ...structuredClone(record),
      createdAt: new Date(
        Date.parse('2026-09-22T00:00:00Z') + this.createdInboxCount,
      ),
    };
    this.inboxes.push(row);
    return Promise.resolve(structuredClone(row));
  }

  listInboxes(
    podId: string,
    limit: number,
    cursor?: InboxCursor,
    address?: string,
  ): Promise<InboxRow[]> {
    const rows = this.inboxes
      .filter((inbox) => inbox.podId === podId)
      .filter(
        (inbox) =>
          !address || inbox.address.toLowerCase() === address.toLowerCase(),
      )
      .filter(
        (inbox) =>
          !cursor ||
          inbox.createdAt < cursor.createdAt ||
          (inbox.createdAt.getTime() === cursor.createdAt.getTime() &&
            inbox.id < cursor.id),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit);
    return Promise.resolve(structuredClone(rows));
  }

  findInboxById(podId: string, id: string): Promise<InboxRow | null> {
    return Promise.resolve(
      structuredClone(
        this.inboxes.find(
          (inbox) => inbox.podId === podId && inbox.id === id,
        ) ?? null,
      ),
    );
  }

  updateInbox(
    podId: string,
    id: string,
    updates: UpdateInboxRecord,
  ): Promise<InboxRow | null> {
    const inbox = this.inboxes.find(
      (candidate) => candidate.podId === podId && candidate.id === id,
    );
    if (!inbox) return Promise.resolve(null);
    Object.assign(inbox, structuredClone(updates));
    return Promise.resolve(structuredClone(inbox));
  }

  deleteInbox(podId: string, id: string): Promise<boolean> {
    const index = this.inboxes.findIndex(
      (inbox) => inbox.podId === podId && inbox.id === id,
    );
    if (index < 0) return Promise.resolve(false);
    this.inboxes.splice(index, 1);
    return Promise.resolve(true);
  }

  findByAddress(address: string): Promise<InboxRecipient | null> {
    const match = this.inboxes.find((inbox) => inbox.address === address);
    return Promise.resolve(
      match
        ? { id: match.id, podId: match.podId, address: match.address }
        : null,
    );
  }

  lookupThread(): Promise<ThreadRecord | null> {
    return Promise.resolve(null);
  }

  persistMessage(): Promise<PersistedInboundMessage> {
    return Promise.reject(new Error('Inbound persistence not configured.'));
  }

  findMessageForSend(
    podId: string,
    inboxId: string,
    messageId: string,
  ): Promise<MessageForSend | null> {
    const inbox = this.inboxes.find(
      (candidate) => candidate.podId === podId && candidate.id === inboxId,
    );
    const message = this.messages.find(
      (candidate) =>
        candidate.inboxId === inboxId && candidate.id === messageId,
    );
    return Promise.resolve(
      inbox && message
        ? { inbox: structuredClone(inbox), message: structuredClone(message) }
        : null,
    );
  }

  findLocalInboxesByAddresses(
    addresses: string[],
  ): Promise<InboxRecipient[]> {
    return Promise.resolve(
      this.inboxes
        .filter((inbox) => addresses.includes(inbox.address))
        .map(({ id, podId, address }) => ({ id, podId, address })),
    );
  }

  persistOutboundMessage(): Promise<MessageRow> {
    return Promise.reject(new Error('Outbound persistence not configured.'));
  }

  listThreads(
    podId: string,
    inboxId: string,
    query: ListThreadsQuery,
  ): Promise<ThreadRow[]> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    if (!ownsInbox) return Promise.resolve([]);
    const rows = this.threads
      .filter((thread) => thread.inboxId === inboxId)
      .filter((thread) =>
        query.labels.every((label) => thread.labels.includes(label)),
      )
      .filter((thread) => !query.before || thread.lastMessageAt < query.before)
      .filter((thread) => !query.after || thread.lastMessageAt > query.after)
      .filter(
        (thread) =>
          !query.cursor ||
          thread.lastMessageAt < query.cursor.sortAt ||
          (thread.lastMessageAt.getTime() === query.cursor.sortAt.getTime() &&
            thread.id < query.cursor.id),
      )
      .sort(
        (left, right) =>
          right.lastMessageAt.getTime() - left.lastMessageAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, query.limit);
    return Promise.resolve(structuredClone(rows));
  }

  findThreadById(
    podId: string,
    inboxId: string,
    threadId: string,
  ): Promise<ThreadRow | null> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    const thread = ownsInbox
      ? this.threads.find(
          (candidate) =>
            candidate.inboxId === inboxId && candidate.id === threadId,
        )
      : undefined;
    return Promise.resolve(structuredClone(thread ?? null));
  }

  listThreadMessages(
    podId: string,
    inboxId: string,
    threadId: string,
  ): Promise<MessageRow[]> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    if (!ownsInbox) return Promise.resolve([]);
    const rows = this.messages
      .filter(
        (message) =>
          message.inboxId === inboxId && message.threadId === threadId,
      )
      .sort(
        (left, right) =>
          messageSortAt(left).getTime() - messageSortAt(right).getTime() ||
          left.id.localeCompare(right.id),
      );
    return Promise.resolve(structuredClone(rows));
  }

  listMessages(
    podId: string,
    inboxId: string,
    query: ListMessagesQuery,
  ): Promise<MessageListRow[]> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    if (!ownsInbox) return Promise.resolve([]);
    const sender = query.sender?.toLowerCase();
    const rows = this.messages
      .filter((message) => message.inboxId === inboxId)
      .map((message) => ({ message, sortAt: messageSortAt(message) }))
      .filter(({ message }) =>
        query.labels.every((label) => message.labels.includes(label)),
      )
      .filter(({ sortAt }) => !query.before || sortAt < query.before)
      .filter(({ sortAt }) => !query.after || sortAt > query.after)
      .filter(
        ({ message }) =>
          !sender || message.from.toLowerCase().includes(sender),
      )
      .filter(
        ({ message }) =>
          query.unread === undefined ||
          message.labels.includes('unread') === query.unread,
      )
      .filter(
        ({ message }) =>
          !query.direction || message.direction === query.direction,
      )
      .filter(
        ({ message, sortAt }) =>
          !query.cursor ||
          sortAt < query.cursor.sortAt ||
          (sortAt.getTime() === query.cursor.sortAt.getTime() &&
            message.id < query.cursor.id),
      )
      .sort(
        (left, right) =>
          right.sortAt.getTime() - left.sortAt.getTime() ||
          right.message.id.localeCompare(left.message.id),
      )
      .slice(0, query.limit);
    return Promise.resolve(structuredClone(rows));
  }

  searchMessages(
    podId: string,
    query: string,
    inboxId: string | undefined,
    limit: number,
    cursor?: SearchCursor,
  ): Promise<SearchMessageRow[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.messages
      .filter((message) => this.inboxes.some((inbox) => inbox.id === message.inboxId && inbox.podId === podId && (!inboxId || inbox.id === inboxId)))
      .filter((message) => terms.every((term) => `${message.subject ?? ''} ${message.text ?? ''} ${message.extractedText ?? ''}`.toLowerCase().includes(term)))
      .map((message) => ({ message, rank: terms.filter((term) => `${message.subject ?? ''} ${message.text ?? ''}`.toLowerCase().includes(term)).length }));
    return Promise.resolve(rows.filter((row) => !cursor || row.rank < cursor.rank || (row.rank === cursor.rank && row.message.id < cursor.id)).sort((a, b) => b.rank - a.rank || b.message.id.localeCompare(a.message.id)).slice(0, limit));
  }

  searchMessagesSemantic(
    podId: string,
    _queryVector: number[],
    inboxId: string | undefined,
    limit: number,
    cursor?: SearchCursor,
  ): Promise<SearchMessageRow[]> {
    const rows = this.messages
      .filter((message) => this.inboxes.some((inbox) => inbox.id === message.inboxId && inbox.podId === podId && (!inboxId || inbox.id === inboxId)))
      .filter((message) => message.embedding !== undefined && message.embedding !== null)
      .map((message) => ({ message, rank: 1 }));
    return Promise.resolve(rows.filter((row) => !cursor || row.rank < cursor.rank || (row.rank === cursor.rank && row.message.id < cursor.id)).slice(0, limit));
  }

  findMessageById(
    podId: string,
    inboxId: string,
    messageId: string,
  ): Promise<MessageRow | null> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    const message = ownsInbox
      ? this.messages.find(
          (candidate) =>
            candidate.inboxId === inboxId && candidate.id === messageId,
        )
      : undefined;
    return Promise.resolve(structuredClone(message ?? null));
  }

  findAttachmentById(
    podId: string,
    inboxId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentRow | null> {
    const ownsMessage = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    ) && this.messages.some(
      (message) => message.id === messageId && message.inboxId === inboxId,
    );
    const attachment = ownsMessage
      ? this.attachments.find(
          (candidate) =>
            candidate.id === attachmentId &&
            candidate.messageId === messageId,
        )
      : undefined;
    return Promise.resolve(structuredClone(attachment ?? null));
  }

  createDraft(record: CreateDraftRecord): Promise<DraftRow> {
    const row: DraftRow = {
      ...structuredClone(record),
      createdAt: new Date(
        Date.parse('2026-09-23T12:00:00.000Z') + this.drafts.length,
      ),
    };
    this.drafts.push(row);
    return Promise.resolve(structuredClone(row));
  }

  listDrafts(
    podId: string,
    inboxId: string,
    limit: number,
    cursor?: DraftCursor,
    status?: DraftRow['status'],
  ): Promise<DraftRow[]> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    if (!ownsInbox) return Promise.resolve([]);
    const rows = this.drafts
      .filter((draft) => draft.inboxId === inboxId)
      .filter((draft) => !status || draft.status === status)
      .filter(
        (draft) =>
          !cursor ||
          draft.createdAt < cursor.createdAt ||
          (draft.createdAt.getTime() === cursor.createdAt.getTime() &&
            draft.id < cursor.id),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit);
    return Promise.resolve(structuredClone(rows));
  }

  findDraftById(
    podId: string,
    inboxId: string,
    draftId: string,
  ): Promise<DraftRow | null> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    const draft = ownsInbox
      ? this.drafts.find(
          (candidate) => candidate.id === draftId && candidate.inboxId === inboxId,
        )
      : undefined;
    return Promise.resolve(structuredClone(draft ?? null));
  }

  updateDraft(
    podId: string,
    inboxId: string,
    draftId: string,
    updates: Parameters<ApiStore['updateDraft']>[3],
  ): Promise<DraftRow | null> {
    const draft = this.drafts.find(
      (candidate) =>
        candidate.id === draftId &&
        candidate.inboxId === inboxId &&
        ['draft', 'scheduled'].includes(candidate.status),
    );
    if (
      !draft ||
      !this.inboxes.some(
        (inbox) => inbox.podId === podId && inbox.id === inboxId,
      )
    )
      return Promise.resolve(null);
    Object.assign(draft, structuredClone(updates));
    return Promise.resolve(structuredClone(draft));
  }

  deleteDraft(podId: string, inboxId: string, draftId: string): Promise<boolean> {
    const index = this.drafts.findIndex(
      (draft) =>
        draft.id === draftId &&
        draft.inboxId === inboxId &&
        ['draft', 'scheduled'].includes(draft.status),
    );
    if (
      index < 0 ||
      !this.inboxes.some(
        (inbox) => inbox.podId === podId && inbox.id === inboxId,
      )
    )
      return Promise.resolve(false);
    this.drafts.splice(index, 1);
    return Promise.resolve(true);
  }

  claimDraftForSend(
    podId: string,
    inboxId: string,
    draftId: string,
  ): Promise<DraftSendTarget | null> {
    const draft = this.drafts.find(
      (candidate) =>
        candidate.id === draftId &&
        candidate.inboxId === inboxId &&
        ['draft', 'scheduled'].includes(candidate.status),
    );
    const inbox = this.inboxes.find(
      (candidate) => candidate.podId === podId && candidate.id === inboxId,
    );
    if (!draft || !inbox) return Promise.resolve(null);
    draft.status = 'sending';
    return Promise.resolve({ draft: structuredClone(draft), inbox: structuredClone(inbox) });
  }

  listDueDraftIds(limit: number): Promise<string[]> {
    const now = Date.now();
    return Promise.resolve(
      this.drafts
        .filter(
          (draft) =>
            draft.status === 'scheduled' &&
            draft.sendAt !== null &&
            draft.sendAt.getTime() <= now,
        )
        .sort(
          (left, right) =>
            (left.sendAt?.getTime() ?? 0) - (right.sendAt?.getTime() ?? 0),
        )
        .slice(0, limit)
        .map((draft) => draft.id),
    );
  }

  claimScheduledDraft(draftId: string): Promise<DraftSendTarget | null> {
    const draft = this.drafts.find(
      (candidate) =>
        candidate.id === draftId &&
        candidate.status === 'scheduled' &&
        candidate.sendAt !== null &&
        candidate.sendAt.getTime() <= Date.now(),
    );
    const inbox = draft
      ? this.inboxes.find((candidate) => candidate.id === draft.inboxId)
      : undefined;
    if (!draft || !inbox) return Promise.resolve(null);
    draft.status = 'sending';
    return Promise.resolve({ draft: structuredClone(draft), inbox: structuredClone(inbox) });
  }

  markDraftStatus(draftId: string, status: DraftRow['status']): Promise<void> {
    const draft = this.drafts.find(
      (candidate) => candidate.id === draftId && candidate.status === 'sending',
    );
    if (draft) draft.status = status;
    return Promise.resolve();
  }

  updateMessageLabels(
    podId: string,
    inboxId: string,
    messageId: string,
    updates: UpdateMessageLabelsRecord,
  ): Promise<MessageRow | null> {
    const ownsInbox = this.inboxes.some(
      (inbox) => inbox.podId === podId && inbox.id === inboxId,
    );
    const message = ownsInbox
      ? this.messages.find(
          (candidate) =>
            candidate.inboxId === inboxId && candidate.id === messageId,
        )
      : undefined;
    if (!message) return Promise.resolve(null);

    const removeSet = new Set(updates.removeLabels);
    const nextLabels = new Set(
      message.labels.filter((label) => !removeSet.has(label)),
    );
    for (const label of updates.addLabels) nextLabels.add(label);
    message.labels = [...nextLabels];

    const thread = this.threads.find(
      (candidate) => candidate.id === message.threadId,
    );
    if (thread) {
      thread.labels = [
        ...new Set(
          this.messages
            .filter((candidate) => candidate.threadId === message.threadId)
            .flatMap((candidate) => candidate.labels),
        ),
      ];
    }

    return Promise.resolve(structuredClone(message));
  }

  createWebhook(record: CreateWebhookRecord): Promise<WebhookRow> {
    const row: WebhookRow = {
      id: record.id,
      podId: record.podId,
      url: record.url,
      secret: record.secretCiphertext,
      eventTypes: record.eventTypes,
      inboxIds: record.inboxIds,
      enabled: record.enabled,
      createdAt: new Date('2026-09-23T12:00:00.000Z'),
    };
    this.webhooks.push(row);
    return Promise.resolve(structuredClone(row));
  }

  listWebhooks(podId: string): Promise<WebhookRow[]> {
    return Promise.resolve(
      structuredClone(
        this.webhooks
          .filter((webhook) => webhook.podId === podId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      ),
    );
  }

  findWebhookById(podId: string, id: string): Promise<WebhookRow | null> {
    const row = this.webhooks.find(
      (webhook) => webhook.podId === podId && webhook.id === id,
    );
    return Promise.resolve(structuredClone(row ?? null));
  }

  updateWebhook(
    podId: string,
    id: string,
    updates: UpdateWebhookRecord,
  ): Promise<WebhookRow | null> {
    const row = this.webhooks.find(
      (webhook) => webhook.podId === podId && webhook.id === id,
    );
    if (!row) return Promise.resolve(null);
    if (updates.url !== undefined) row.url = updates.url;
    if (updates.eventTypes !== undefined) row.eventTypes = updates.eventTypes;
    if (updates.inboxIds !== undefined) row.inboxIds = updates.inboxIds;
    if (updates.enabled !== undefined) row.enabled = updates.enabled;
    return Promise.resolve(structuredClone(row));
  }

  deleteWebhook(podId: string, id: string): Promise<boolean> {
    const index = this.webhooks.findIndex(
      (webhook) => webhook.podId === podId && webhook.id === id,
    );
    if (index < 0) return Promise.resolve(false);
    this.webhooks.splice(index, 1);
    for (let i = this.deliveries.length - 1; i >= 0; i -= 1) {
      if (this.deliveries[i]?.webhookId === id) this.deliveries.splice(i, 1);
    }
    return Promise.resolve(true);
  }

  listWebhookDeliveries(
    podId: string,
    webhookId: string,
    limit: number,
  ): Promise<WebhookDeliveryRow[]> {
    const owns = this.webhooks.some(
      (webhook) => webhook.podId === podId && webhook.id === webhookId,
    );
    if (!owns) return Promise.resolve([]);
    return Promise.resolve(
      structuredClone(
        this.deliveries
          .filter((delivery) => delivery.webhookId === webhookId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, limit),
      ),
    );
  }

  enqueueTestFire(
    podId: string,
    webhookId: string,
  ): Promise<{ eventId: string; deliveryId: string }> {
    const webhook = this.webhooks.find(
      (candidate) => candidate.podId === podId && candidate.id === webhookId,
    );
    if (!webhook) {
      return Promise.reject(new Error(`Webhook ${webhookId} not found`));
    }
    const eventId = `evt_test_${this.deliveries.length + 1}`;
    const deliveryId = `whd_test_${this.deliveries.length + 1}`;
    this.deliveries.push({
      id: deliveryId,
      webhookId,
      eventId,
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextRetryAt: null,
      createdAt: new Date('2026-09-23T12:05:00.000Z'),
    });
    return Promise.resolve({ eventId, deliveryId });
  }
}

function makeMessageRow(
  overrides: Partial<MessageRow> & Pick<MessageRow, 'id' | 'inboxId'>,
): MessageRow {
  const timestamp = new Date('2026-09-23T12:00:00.000Z');
  const { id, inboxId, ...rest } = overrides;
  return {
    id,
    inboxId,
    threadId: 'thr_test',
    messageIdHeader: `<${overrides.id}@example.com>`,
    inReplyTo: null,
    references: [],
    direction: 'inbound',
    from: 'sender@example.com',
    to: [],
    cc: [],
    bcc: [],
    subject: null,
    text: null,
    html: null,
    extractedText: null,
    labels: [],
    rawObjectKey: null,
    sizeBytes: 0,
    hopCount: 0,
    sentAt: null,
    receivedAt: timestamp,
    search: null,
    createdAt: timestamp,
    ...rest,
  };
}

function makeThreadRow(
  inboxId: string,
  id: string,
  overrides: Partial<ThreadRow> = {},
): ThreadRow {
  const timestamp = new Date('2026-09-23T12:00:00.000Z');
  return {
    id,
    inboxId,
    subjectNormalized: 'subject',
    lastMessageAt: timestamp,
    messageCount: 1,
    labels: [],
    preview: null,
    createdAt: timestamp,
    ...overrides,
  };
}

function makeDraftRow(
  inboxId: string,
  id: string,
  overrides: Partial<DraftRow> = {},
): DraftRow {
  return {
    id,
    inboxId,
    threadId: null,
    to: ['recipient@example.com'],
    cc: [],
    subject: 'Draft subject',
    text: 'Draft text',
    html: null,
    sendAt: null,
    status: 'draft',
    createdAt: new Date('2026-09-23T12:00:00.000Z'),
    ...overrides,
  };
}

function messageSortAt(message: MessageRow): Date {
  return message.receivedAt ?? message.sentAt ?? message.createdAt;
}

function makeMultipartBody(
  payload: Record<string, unknown>,
  files: Array<{
    filename: string;
    contentType: string;
    content: Buffer;
  }>,
): { body: Buffer; contentType: string } {
  const boundary = 'localmail-test-boundary';
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`,
    ),
  ];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachments"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
