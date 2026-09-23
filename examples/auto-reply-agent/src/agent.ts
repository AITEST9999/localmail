import type { LocalMailEvent, Message, SubscribeOptions } from '@localmail/sdk';

import { shouldAutoReply } from './policy.js';

export const DEFAULT_REPLY_TEXT =
  "Thanks for reaching out — we've received your message and will follow up shortly.";

/** The narrow slice of `LocalMail` this agent needs. */
export interface AutoReplySdk {
  messages: {
    get(inboxId: string, messageId: string): Promise<Message>;
    reply(
      inboxId: string,
      messageId: string,
      input: { text?: string | null },
      options?: { idempotencyKey?: string },
    ): Promise<Message>;
  };
  subscribe(
    options: SubscribeOptions,
  ): Promise<{ events: AsyncIterableIterator<LocalMailEvent>; close: () => void; ready: Promise<void> }>;
}

export interface AutoReplyAgentHandle {
  stop: () => void;
  /** Resolves once the WS subscribe ack lands, so a caller can deliver mail right after. */
  ready: Promise<void>;
}

/**
 * Watches an inbox and replies to support/billing mail. Triggers on
 * `message.labeled`, never `message.received` (P3-17: `auto` may only be
 * known once labels land). Server-side `Idempotency-Key` replay makes a
 * duplicate `message.labeled` delivery (e.g. after a restart) safe — the
 * same key always returns the first reply instead of sending a second one.
 *
 * A real agent would call an LLM to draft `text` here; this example is
 * fully deterministic on purpose (no LLM calls, agentmail.md §10 task 21).
 */
export function runAutoReplyAgent(
  sdk: AutoReplySdk,
  inboxId: string,
  options: { replyText?: string; onReply?: (message: Message) => void; onError?: (error: unknown) => void } = {},
): Promise<AutoReplyAgentHandle> {
  const replyText = options.replyText ?? DEFAULT_REPLY_TEXT;

  return sdk.subscribe({ inboxIds: [inboxId], eventTypes: ['message.labeled'] }).then(({ events, close, ready }) => {
    (async () => {
      for await (const event of events) {
        const messageId = typeof event.data.message_id === 'string' ? event.data.message_id : undefined;
        if (!messageId) continue;
        try {
          const message = await sdk.messages.get(inboxId, messageId);
          if (!shouldAutoReply(message)) continue;
          const reply = await sdk.messages.reply(
            inboxId,
            message.id,
            { text: replyText },
            { idempotencyKey: `auto-reply:${message.id}` },
          );
          options.onReply?.(reply);
        } catch (error) {
          options.onError?.(error);
        }
      }
    })().catch((error: unknown) => options.onError?.(error));

    return { stop: close, ready };
  });
}
