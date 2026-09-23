import type { Message } from '@localmail/sdk';

const MAX_UNTRUSTED_TEXT_LENGTH = 20_000;

export interface Truncated {
  value: string | null;
  truncated: boolean;
}

/** Truncates sender-controlled text to a bounded size before it reaches a tool result. */
export function truncateText(value: string | null | undefined): Truncated {
  if (value === null || value === undefined) return { value: null, truncated: false };
  if (value.length <= MAX_UNTRUSTED_TEXT_LENGTH) return { value, truncated: false };
  return { value: value.slice(0, MAX_UNTRUSTED_TEXT_LENGTH), truncated: true };
}

/**
 * Marks sender-controlled email content as untrusted data (agentmail.md §13):
 * a subject line, body, or extracted text is written by an external party
 * and must never be treated as an instruction to the calling agent.
 */
export function untrustedEmailContent<T extends Record<string, unknown>>(
  payload: T,
): { untrusted_email_content: T } {
  return { untrusted_email_content: payload };
}

/**
 * A message shape safe to hand to an MCP client: `html` is dropped entirely
 * (§P4-20 — `extracted_text` is enough for agents), and `text`/`extracted_text`
 * are truncated with a `*_truncated` flag alongside.
 */
export function toSafeMessage(message: Message) {
  const text = truncateText(message.text);
  const extractedText = truncateText(message.extracted_text);
  return {
    id: message.id,
    thread_id: message.thread_id,
    direction: message.direction,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    labels: message.labels,
    received_at: message.received_at,
    sent_at: message.sent_at,
    text: text.value,
    text_truncated: text.truncated,
    extracted_text: extractedText.value,
    extracted_text_truncated: extractedText.truncated,
  };
}
