import { LocalMailError } from './errors.js';
import type { Message, ThreadsResource, MessagesResource } from './resources.js';
import type { RequestOptions } from './client.js';

/**
 * §3.5: picks the last `inbound` message in the thread (ascending order per
 * `listThreadMessages`), falling back to the last message of any direction
 * so a follow-up to your own sent mail still threads.
 */
export async function replyToThread(
  threads: ThreadsResource,
  messages: MessagesResource,
  inboxId: string,
  threadId: string,
  input: { text?: string | null; html?: string | null; replyAll?: boolean },
  options: RequestOptions = {},
): Promise<Message> {
  const { messages: threadMessages } = await threads.get(inboxId, threadId);
  if (threadMessages.length === 0) {
    throw new LocalMailError({
      status: 404,
      code: 'not_found',
      message: `Thread ${threadId} has no messages to reply to.`,
    });
  }
  const target =
    [...threadMessages].reverse().find((message) => message.direction === 'inbound') ??
    threadMessages[threadMessages.length - 1]!;

  return messages.reply(inboxId, target.id, input, options);
}
