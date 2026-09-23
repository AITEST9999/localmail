export type MessageHeaderValue = string | readonly string[] | null | undefined;

export interface ThreadingMessage {
  /** The new message's own Message-ID. Used first to make retries idempotent. */
  messageId?: MessageHeaderValue;
  /** The immediate parent Message-ID, when supplied by the sender. */
  inReplyTo?: MessageHeaderValue;
  /** Ancestor Message-IDs, conventionally ordered oldest to newest. */
  references?: MessageHeaderValue;
  /** A decoded subject. MIME/RFC 2047 decoding belongs at the transport boundary. */
  subject?: string | null;
}

export type ThreadLookupQuery =
  | {
      kind: 'message-ids';
      /** Candidate IDs in match-priority order. */
      messageIds: readonly string[];
    }
  | {
      kind: 'subject';
      normalizedSubject: string;
    };

/** The lookup must be pre-scoped to the message's inbox (and therefore pod). */
export type ThreadLookup<TThread> = (
  query: ThreadLookupQuery,
) => Promise<TThread | null> | TThread | null;

export interface ThreadResolution<TThread> {
  thread: TThread | null;
  matchedBy: 'headers' | 'subject' | null;
}

/**
 * Resolve an existing thread without depending on a database or transport.
 *
 * Header candidates always win over subject fallback. A lookup implementation
 * should honor the supplied Message-ID order when more than one candidate is
 * present.
 */
export async function resolveThread<TThread>(
  message: ThreadingMessage,
  lookup: ThreadLookup<TThread>,
): Promise<ThreadResolution<TThread>> {
  const messageIds = getThreadingMessageIds(message);

  if (messageIds.length > 0) {
    const thread = await lookup({ kind: 'message-ids', messageIds });
    if (thread !== null) return { thread, matchedBy: 'headers' };
  }

  const normalizedSubject = normalizeSubject(message.subject ?? '');
  if (normalizedSubject.length > 0) {
    const thread = await lookup({ kind: 'subject', normalizedSubject });
    if (thread !== null) return { thread, matchedBy: 'subject' };
  }

  return { thread: null, matchedBy: null };
}

/**
 * Return canonical Message-ID candidates in threading priority order:
 * current message (retry), immediate parent, then newest-to-oldest ancestors.
 */
export function getThreadingMessageIds(message: ThreadingMessage): string[] {
  const current = parseMessageIds(message.messageId);
  const parents = parseMessageIds(message.inReplyTo);
  const ancestors = parseMessageIds(message.references).reverse();

  return [...new Set([...current, ...parents, ...ancestors])];
}

/** Normalize common reply/forward prefixes and insignificant whitespace. */
export function normalizeSubject(subject: string): string {
  let normalized = subject.trim().replaceAll(/\s+/g, ' ');
  let previous = '';

  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(/^(?:re|fw|fwd)(?:\[\d+\])?\s*:\s*/i, '').trim();
  }

  return normalized.toLowerCase();
}

function parseMessageIds(value: MessageHeaderValue): string[] {
  const values = typeof value === 'string' ? [value] : (value ?? []);
  const ids: string[] = [];

  for (const rawValue of values) {
    const bracketedIds = [...rawValue.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]);
    const candidates = bracketedIds.length > 0 ? bracketedIds : rawValue.split(/\s+/);

    for (const candidate of candidates) {
      const id = candidate?.trim().replace(/^<|>$/g, '');
      if (id && !/\s/.test(id)) ids.push(`<${id}>`);
    }
  }

  return ids;
}
