import type { Inbox, Message, MessageSummary, Page, Thread, WaitForEmailOptions } from '@localmail/sdk';

/**
 * The narrow slice of `LocalMail`'s public surface the MCP tools use. A real
 * `LocalMail` instance satisfies this structurally (it has strictly more
 * members), and hermetic tests can implement it directly with an in-memory
 * fake instead of a mocked SDK client.
 */
export interface LocalMailClient {
  inboxes: {
    create(input: { username?: string; display_name?: string | null; client_id?: string }): Promise<Inbox>;
    resolve(idOrAddress: string): Promise<Inbox>;
  };
  threads: {
    get(inboxId: string, threadId: string): Promise<{ thread: Thread; messages: MessageSummary[] }>;
    list(
      inboxId: string,
      query: { labels?: string[]; limit?: number; pageToken?: string },
    ): Promise<Page<Thread>>;
  };
  messages: {
    get(inboxId: string, messageId: string): Promise<Message>;
    send(
      inboxId: string,
      input: { to: string[]; cc?: string[]; subject: string; text?: string | null; html?: string | null },
    ): Promise<Message>;
    reply(
      inboxId: string,
      messageId: string,
      input: { text?: string | null; html?: string | null; replyAll?: boolean },
    ): Promise<Message>;
    updateLabels(
      inboxId: string,
      messageId: string,
      updates: { add?: string[]; remove?: string[] },
    ): Promise<Message>;
  };
  waitForEmail(inboxId: string, options: WaitForEmailOptions): Promise<Message>;
  replyToThread(
    inboxId: string,
    threadId: string,
    input: { text?: string | null; html?: string | null; replyAll?: boolean },
  ): Promise<Message>;
}
