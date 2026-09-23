import type { Inbox, LocalMailEvent, Message, MessageSummary, Thread } from '@localmail/sdk';

export function formatInbox(inbox: Inbox): string {
  const name = inbox.display_name ? ` (${inbox.display_name})` : '';
  return `${inbox.id}  ${inbox.address}${name}`;
}

export function formatInboxList(inboxes: Inbox[]): string {
  if (inboxes.length === 0) return 'No inboxes.';
  return inboxes.map(formatInbox).join('\n');
}

export function formatThreadRow(thread: Thread): string {
  return `${thread.id}  [${thread.labels.join(',')}]  ${thread.message_count} msg  ${thread.last_message_at}  ${thread.subject_normalized}`;
}

export function formatThreadList(threads: Thread[]): string {
  if (threads.length === 0) return 'No threads.';
  return threads.map(formatThreadRow).join('\n');
}

export function formatMessageSummaryRow(message: MessageSummary): string {
  return `${message.id}  ${message.direction}  from=${message.from ?? '?'}  [${message.labels.join(',')}]  ${message.subject ?? '(no subject)'}`;
}

export function formatThreadDetail(thread: Thread, messages: MessageSummary[]): string {
  const header = `Thread ${thread.id}  [${thread.labels.join(',')}]  ${thread.message_count} message(s)`;
  const body = messages.map(formatMessageSummaryRow).join('\n');
  return `${header}\n${body}`;
}

export function formatSentMessage(message: Message, verb: string): string {
  return `${verb} message ${message.id} in thread ${message.thread_id}`;
}

export function formatEvent(event: LocalMailEvent): string {
  const id = typeof event.data.message_id === 'string' ? event.data.message_id : undefined;
  return `[${event.created_at}] ${event.type}${id ? ` id=${id}` : ''}`;
}
