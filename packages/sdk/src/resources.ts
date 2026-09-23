import { LocalMailError } from './errors.js';
import { withRetry, type LocalMailTransport, type RequestOptions } from './client.js';
import type { components } from './generated/openapi.js';

export type Inbox = components['schemas']['Inbox'];
export type Thread = components['schemas']['Thread'];
export type Message = components['schemas']['Message'];
export type MessageSummary = components['schemas']['MessageSummary'];
export type Webhook = components['schemas']['Webhook'];
export type WebhookDelivery = components['schemas']['WebhookDelivery'];

export interface Page<T> {
  data: T[];
  next_page_token: string | null;
}

async function* iteratePages<T>(
  fetchPage: (pageToken?: string) => Promise<Page<T>>,
): AsyncIterableIterator<T> {
  let pageToken: string | undefined;
  do {
    const page = await fetchPage(pageToken);
    for (const item of page.data) yield item;
    pageToken = page.next_page_token ?? undefined;
  } while (pageToken);
}

function toIsoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

export class InboxesResource {
  constructor(private readonly transport: LocalMailTransport) {}

  async create(
    body: {
      username?: string;
      display_name?: string | null;
      metadata?: Record<string, unknown>;
      client_id?: string;
    } = {},
    options: RequestOptions = {},
  ): Promise<Inbox> {
    return withRetry(Boolean(options.idempotencyKey), () =>
      this.transport.client.POST('/v1/inboxes', {
        body,
        headers: this.transport.headersFor(options),
        signal: options.signal,
      }),
    );
  }

  async list(
    query: { limit?: number; pageToken?: string; address?: string } = {},
  ): Promise<Page<Inbox>> {
    return withRetry(true, () =>
      this.transport.client.GET('/v1/inboxes', {
        params: {
          query: {
            limit: query.limit,
            page_token: query.pageToken,
            address: query.address,
          },
        },
      }),
    );
  }

  iterate(query: { limit?: number; address?: string } = {}): AsyncIterableIterator<Inbox> {
    return iteratePages((pageToken) => this.list({ ...query, pageToken }));
  }

  async get(inboxId: string): Promise<Inbox> {
    return withRetry(true, () =>
      this.transport.client.GET('/v1/inboxes/{inbox_id}', {
        params: { path: { inbox_id: inboxId } },
      }),
    );
  }

  async update(
    inboxId: string,
    patch: { display_name?: string | null; metadata?: Record<string, unknown> },
  ): Promise<Inbox> {
    return withRetry(false, () =>
      this.transport.client.PATCH('/v1/inboxes/{inbox_id}', {
        params: { path: { inbox_id: inboxId } },
        body: patch,
      }),
    );
  }

  async delete(inboxId: string): Promise<void> {
    await withRetry(false, () =>
      this.transport.client.DELETE('/v1/inboxes/{inbox_id}', {
        params: { path: { inbox_id: inboxId } },
      }),
    );
  }

  /** "inb_…" → get by id; anything containing "@" → list({address}), 404 if none. */
  async resolve(idOrAddress: string): Promise<Inbox> {
    if (!idOrAddress.includes('@')) return this.get(idOrAddress);
    const page = await this.list({ address: idOrAddress, limit: 1 });
    const inbox = page.data[0];
    if (!inbox) {
      throw new LocalMailError({
        status: 404,
        code: 'not_found',
        message: `No inbox found for address ${idOrAddress}.`,
      });
    }
    return inbox;
  }
}

export class ThreadsResource {
  constructor(private readonly transport: LocalMailTransport) {}

  async list(
    inboxId: string,
    query: {
      labels?: string[];
      before?: Date | string;
      after?: Date | string;
      limit?: number;
      pageToken?: string;
    } = {},
  ): Promise<Page<Thread>> {
    return withRetry(true, () =>
      this.transport.client.GET('/v1/inboxes/{inbox_id}/threads', {
        params: {
          path: { inbox_id: inboxId },
          query: {
            labels: query.labels?.join(','),
            before: toIsoDate(query.before),
            after: toIsoDate(query.after),
            limit: query.limit,
            page_token: query.pageToken,
          },
        },
      }),
    );
  }

  iterate(
    inboxId: string,
    query: Omit<Parameters<ThreadsResource['list']>[1], 'pageToken'> = {},
  ): AsyncIterableIterator<Thread> {
    return iteratePages((pageToken) => this.list(inboxId, { ...query, pageToken }));
  }

  async get(inboxId: string, threadId: string): Promise<{ thread: Thread; messages: MessageSummary[] }> {
    return withRetry(true, () =>
      this.transport.client.GET('/v1/inboxes/{inbox_id}/threads/{thread_id}', {
        params: { path: { inbox_id: inboxId, thread_id: threadId } },
      }),
    );
  }
}

export interface SendMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  labels?: string[];
  attachments?: Array<{ filename: string; content: Blob | Uint8Array; contentType?: string }>;
}

function buildMultipart(payload: Record<string, unknown>, attachments: SendMessageInput['attachments']): FormData {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const attachment of attachments ?? []) {
    const blob =
      attachment.content instanceof Blob
        ? attachment.content
        : new Blob([attachment.content], { type: attachment.contentType });
    form.append('attachments', blob, attachment.filename);
  }
  return form;
}

export class MessagesResource {
  constructor(private readonly transport: LocalMailTransport) {}

  async list(
    inboxId: string,
    query: {
      labels?: string[];
      before?: Date | string;
      after?: Date | string;
      sender?: string;
      unread?: boolean;
      direction?: 'inbound' | 'outbound';
      limit?: number;
      pageToken?: string;
    } = {},
  ): Promise<Page<MessageSummary>> {
    return withRetry(true, () =>
      this.transport.client.GET('/v1/inboxes/{inbox_id}/messages', {
        params: {
          path: { inbox_id: inboxId },
          query: {
            labels: query.labels?.join(','),
            before: toIsoDate(query.before),
            after: toIsoDate(query.after),
            sender: query.sender,
            unread: query.unread === undefined ? undefined : query.unread ? 'true' : 'false',
            direction: query.direction,
            limit: query.limit,
            page_token: query.pageToken,
          },
        },
      }),
    );
  }

  iterate(
    inboxId: string,
    query: Omit<Parameters<MessagesResource['list']>[1], 'pageToken'> = {},
  ): AsyncIterableIterator<MessageSummary> {
    return iteratePages((pageToken) => this.list(inboxId, { ...query, pageToken }));
  }

  async get(inboxId: string, messageId: string): Promise<Message> {
    return withRetry(true, () =>
      this.transport.client.GET('/v1/inboxes/{inbox_id}/messages/{message_id}', {
        params: { path: { inbox_id: inboxId, message_id: messageId } },
      }),
    );
  }

  /** Raw RFC 822 bytes — not well described by JSON schema (§2.3 G8). */
  async getRaw(inboxId: string, messageId: string): Promise<Response> {
    const response = await this.transport.rawFetch(
      `/v1/inboxes/${inboxId}/messages/${messageId}/raw`,
    );
    if (!response.ok) {
      const { toLocalMailError } = await import('./errors.js');
      throw await toLocalMailError(response);
    }
    return response;
  }

  async send(
    inboxId: string,
    input: SendMessageInput,
    options: RequestOptions = {},
  ): Promise<Message> {
    if (input.attachments?.length) {
      return this.sendMultipart(inboxId, 'send', input, options);
    }
    return withRetry(Boolean(options.idempotencyKey), () =>
      this.transport.client.POST('/v1/inboxes/{inbox_id}/messages/send', {
        params: { path: { inbox_id: inboxId } },
        body: {
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html,
          labels: input.labels,
        },
        headers: this.transport.headersFor(options),
        signal: options.signal,
      }),
    );
  }

  async reply(
    inboxId: string,
    messageId: string,
    input: { text?: string | null; html?: string | null; replyAll?: boolean },
    options: RequestOptions = {},
  ): Promise<Message> {
    return withRetry(Boolean(options.idempotencyKey), () =>
      this.transport.client.POST('/v1/inboxes/{inbox_id}/messages/{message_id}/reply', {
        params: { path: { inbox_id: inboxId, message_id: messageId } },
        body: { text: input.text, html: input.html, reply_all: input.replyAll ?? false },
        headers: this.transport.headersFor(options),
        signal: options.signal,
      }),
    );
  }

  async forward(
    inboxId: string,
    messageId: string,
    input: { to: string[]; cc?: string[]; bcc?: string[]; text?: string | null; html?: string | null },
    options: RequestOptions = {},
  ): Promise<Message> {
    return withRetry(Boolean(options.idempotencyKey), () =>
      this.transport.client.POST('/v1/inboxes/{inbox_id}/messages/{message_id}/forward', {
        params: { path: { inbox_id: inboxId, message_id: messageId } },
        body: input,
        headers: this.transport.headersFor(options),
        signal: options.signal,
      }),
    );
  }

  async updateLabels(
    inboxId: string,
    messageId: string,
    updates: { add?: string[]; remove?: string[] },
  ): Promise<Message> {
    return withRetry(false, () =>
      this.transport.client.PATCH('/v1/inboxes/{inbox_id}/messages/{message_id}', {
        params: { path: { inbox_id: inboxId, message_id: messageId } },
        body: { add_labels: updates.add, remove_labels: updates.remove },
      }),
    );
  }

  private async sendMultipart(
    inboxId: string,
    action: 'send',
    input: SendMessageInput,
    options: RequestOptions,
  ): Promise<Message> {
    const { attachments, ...payload } = input;
    const form = buildMultipart(payload, attachments);
    const response = await this.transport.rawFetch(
      `/v1/inboxes/${inboxId}/messages/${action}`,
      {
        method: 'POST',
        body: form,
        headers: this.transport.headersFor(options),
        signal: options.signal,
      },
    );
    if (!response.ok) {
      const { toLocalMailError } = await import('./errors.js');
      throw await toLocalMailError(response);
    }
    return (await response.json()) as Message;
  }
}

export class AttachmentsResource {
  constructor(private readonly transport: LocalMailTransport) {}

  async getUrl(
    inboxId: string,
    messageId: string,
    attachmentId: string,
    query: { expiresIn?: number } = {},
  ): Promise<{ url: string; expires_at: string; preview_allowed: boolean }> {
    return withRetry(true, () =>
      this.transport.client.GET(
        '/v1/inboxes/{inbox_id}/messages/{message_id}/attachments/{attachment_id}',
        {
          params: {
            path: { inbox_id: inboxId, message_id: messageId, attachment_id: attachmentId },
            query: { expires_in: query.expiresIn },
          },
        },
      ),
    );
  }

  async download(
    inboxId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<Response> {
    const { url } = await this.getUrl(inboxId, messageId, attachmentId);
    const doFetch = this.transport.customFetch ?? fetch;
    const response = await doFetch(url);
    if (!response.ok) {
      const { toLocalMailError } = await import('./errors.js');
      throw await toLocalMailError(response);
    }
    return response;
  }
}

export class WebhooksResource {
  constructor(private readonly transport: LocalMailTransport) {}

  async create(body: {
    url: string;
    event_types: Array<'message.received' | 'message.sent'>;
    inbox_ids?: string[] | null;
    enabled?: boolean;
  }): Promise<Webhook & { secret: string }> {
    return withRetry(false, () =>
      this.transport.client.POST('/v1/webhooks', { body }),
    );
  }

  async list(): Promise<Webhook[]> {
    const page = await withRetry<{ data: Webhook[] }>(true, () =>
      this.transport.client.GET('/v1/webhooks', {}),
    );
    return page.data;
  }

  async get(webhookId: string): Promise<Webhook> {
    return withRetry(true, () =>
      this.transport.client.GET('/v1/webhooks/{webhook_id}', {
        params: { path: { webhook_id: webhookId } },
      }),
    );
  }

  async update(
    webhookId: string,
    patch: {
      url?: string;
      event_types?: Array<'message.received' | 'message.sent'>;
      inbox_ids?: string[] | null;
      enabled?: boolean;
    },
  ): Promise<Webhook> {
    return withRetry(false, () =>
      this.transport.client.PATCH('/v1/webhooks/{webhook_id}', {
        params: { path: { webhook_id: webhookId } },
        body: patch,
      }),
    );
  }

  async delete(webhookId: string): Promise<void> {
    await withRetry(false, () =>
      this.transport.client.DELETE('/v1/webhooks/{webhook_id}', {
        params: { path: { webhook_id: webhookId } },
      }),
    );
  }

  async deliveries(webhookId: string, query: { limit?: number } = {}): Promise<WebhookDelivery[]> {
    const page = await withRetry<{ data: WebhookDelivery[] }>(true, () =>
      this.transport.client.GET('/v1/webhooks/{webhook_id}/deliveries', {
        params: { path: { webhook_id: webhookId }, query: { limit: query.limit } },
      }),
    );
    return page.data;
  }

  async test(webhookId: string): Promise<{ event_id: string; delivery_id: string }> {
    return withRetry(false, () =>
      this.transport.client.POST('/v1/webhooks/{webhook_id}/test', {
        params: { path: { webhook_id: webhookId } },
      }),
    );
  }
}
