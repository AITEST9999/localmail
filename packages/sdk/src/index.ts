import { LocalMailTransport, type LocalMailOptions, withRetry } from './client.js';
import {
  AttachmentsResource,
  InboxesResource,
  MessagesResource,
  ThreadsResource,
  WebhooksResource,
} from './resources.js';
import { replyToThread } from './reply-to-thread.js';
import { subscribe, type LocalMailEvent, type SubscribeOptions } from './subscribe.js';
import { waitForEmail, type WaitForEmailOptions } from './wait-for-email.js';

export * from './errors.js';
export * from './resources.js';
export type { LocalMailOptions, RequestOptions } from './client.js';
export type { LocalMailEvent, SubscribeOptions } from './subscribe.js';
export type { WaitForEmailOptions } from './wait-for-email.js';
export { verifyWebhookSignature } from './webhook-signature.js';
export type { paths, components } from './generated/openapi.js';

export class LocalMail {
  readonly inboxes: InboxesResource;
  readonly threads: ThreadsResource;
  readonly messages: MessagesResource;
  readonly attachments: AttachmentsResource;
  readonly webhooks: WebhooksResource;
  private readonly transport: LocalMailTransport;

  constructor(options: LocalMailOptions = {}) {
    this.transport = new LocalMailTransport(options);
    this.inboxes = new InboxesResource(this.transport);
    this.threads = new ThreadsResource(this.transport);
    this.messages = new MessagesResource(this.transport);
    this.attachments = new AttachmentsResource(this.transport);
    this.webhooks = new WebhooksResource(this.transport);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  async me(): Promise<{ pod_id: string; api_key_id: string; scopes: string[] }> {
    return withRetry(true, () => this.transport.client.GET('/v1/me', {}));
  }

  subscribe(
    options: SubscribeOptions = {},
  ): Promise<{ events: AsyncIterableIterator<LocalMailEvent>; close: () => void; ready: Promise<void> }> {
    return subscribe(this.transport, options);
  }

  waitForEmail(inboxId: string, options: WaitForEmailOptions = {}) {
    return waitForEmail(this.transport, this.messages, inboxId, options);
  }

  replyToThread(
    inboxId: string,
    threadId: string,
    input: { text?: string | null; html?: string | null; replyAll?: boolean },
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ) {
    return replyToThread(this.threads, this.messages, inboxId, threadId, input, options);
  }
}
