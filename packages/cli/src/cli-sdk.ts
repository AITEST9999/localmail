import type {
  Inbox,
  LocalMailEvent,
  Message,
  Page,
  SubscribeOptions,
  Thread,
  ThreadsResource,
  WaitForEmailOptions,
} from '@localmail/sdk';

/** The narrow slice of `LocalMail` the CLI commands use — a real `LocalMail` satisfies this structurally. */
export interface CliSdk {
  inboxes: {
    create(input: { username?: string; display_name?: string; client_id?: string }): Promise<Inbox>;
    list(query: { limit?: number; pageToken?: string }): Promise<Page<Inbox>>;
    resolve(idOrAddress: string): Promise<Inbox>;
  };
  threads: {
    list(
      inboxId: string,
      query: { labels?: string[]; limit?: number; pageToken?: string },
    ): Promise<Page<Thread>>;
    get: ThreadsResource['get'];
  };
  messages: {
    send(
      inboxId: string,
      input: {
        to: string[];
        cc?: string[];
        subject: string;
        text?: string | null;
        html?: string | null;
        attachments?: Array<{ filename: string; content: Uint8Array; contentType?: string }>;
      },
    ): Promise<Message>;
    reply(
      inboxId: string,
      messageId: string,
      input: { text?: string | null; html?: string | null; replyAll?: boolean },
    ): Promise<Message>;
  };
  subscribe(
    options: SubscribeOptions,
  ): Promise<{ events: AsyncIterableIterator<LocalMailEvent>; close: () => void; ready: Promise<void> }>;
  waitForEmail(inboxId: string, options: WaitForEmailOptions): Promise<Message>;
}
