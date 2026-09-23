import { LocalMailTimeoutError } from './errors.js';
import type { Message, MessageSummary, MessagesResource } from './resources.js';
import { subscribe, type LocalMailEvent } from './subscribe.js';
import type { LocalMailTransport } from './client.js';

export interface WaitForEmailOptions {
  from?: string | RegExp;
  subject?: string | RegExp;
  labels?: string[];
  match?: (message: Message) => boolean;
  /** Default: call time. Capture this *before* triggering the email (e.g. a signup). */
  since?: Date;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function matchesText(pattern: string | RegExp | undefined, value: string | null): boolean {
  if (pattern === undefined) return true;
  if (value === null) return false;
  return typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value);
}

function passesSummaryFilters(summary: MessageSummary, options: WaitForEmailOptions): boolean {
  if (!matchesText(options.from, summary.from)) return false;
  if (!matchesText(options.subject, summary.subject)) return false;
  if (options.labels && !options.labels.every((label) => summary.labels.includes(label))) {
    return false;
  }
  return true;
}

/**
 * §3.4: subscribe first (closes the list→subscribe gap), then catch up with
 * a `direction=inbound` list since `since`, then keep polling on an interval
 * even while the WS stays connected (covers suppressed mail and dropped
 * pub/sub messages). A `labels` filter alone re-checks a message when its
 * `message.labeled` event arrives, without extra polling.
 */
export async function waitForEmail(
  transport: LocalMailTransport,
  messages: MessagesResource,
  inboxId: string,
  options: WaitForEmailOptions = {},
): Promise<Message> {
  const since = options.since ?? new Date();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const seen = new Set<string>();
  const labeledPending = new Set<string>();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  let resolveResult: ((message: Message) => void) | undefined;
  let rejectResult: ((error: unknown) => void) | undefined;
  const resultPromise = new Promise<Message>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let settled = false;
  function settle(message: Message): void {
    if (settled) return;
    settled = true;
    resolveResult?.(message);
  }
  function fail(error: unknown): void {
    if (settled) return;
    settled = true;
    rejectResult?.(error);
  }

  async function checkCandidate(summary: MessageSummary): Promise<void> {
    if (settled || seen.has(summary.id)) return;
    seen.add(summary.id);
    if (!passesSummaryFilters(summary, options)) {
      if (options.labels?.length) labeledPending.add(summary.id);
      return;
    }
    const full = await messages.get(inboxId, summary.id);
    if (options.match && !options.match(full)) return;
    settle(full);
  }

  async function catchUp(): Promise<void> {
    for await (const summary of messages.iterate(inboxId, {
      after: since,
      direction: 'inbound',
    })) {
      await checkCandidate(summary);
      if (settled) return;
    }
  }

  const pollTimer = setInterval(() => {
    catchUp().catch(() => undefined);
  }, pollIntervalMs);
  const stopPolling = () => clearInterval(pollTimer);

  let wsHandle: Awaited<ReturnType<typeof subscribe>> | undefined;
  (async () => {
    try {
      wsHandle = await subscribe(transport, {
        inboxIds: [inboxId],
        eventTypes: ['message.received', 'message.labeled'],
        signal: controller.signal,
        ackTimeoutMs: 3000,
      });
      await catchUp();
      if (settled) return;
      for await (const event of wsHandle.events) {
        if (settled) break;
        await handleEvent(event);
      }
    } catch {
      // §3.4 step 1: WS failed to connect within the ack window — fall back
      // to polling-only. The catch-up + interval poll above still resolves.
      await catchUp();
    }
  })().catch(() => undefined);

  async function handleEvent(event: LocalMailEvent): Promise<void> {
    const messageId = typeof event.data.message_id === 'string' ? event.data.message_id : undefined;
    if (!messageId) return;
    if (event.type === 'message.labeled' && labeledPending.has(messageId)) {
      labeledPending.delete(messageId);
      const full = await messages.get(inboxId, messageId);
      if (!options.labels?.every((label) => full.labels.includes(label))) return;
      if (options.match && !options.match(full)) return;
      settle(full);
      return;
    }
    if (event.type === 'message.received') {
      const full = await messages.get(inboxId, messageId);
      if (full.direction !== 'inbound') return;
      await checkCandidate({
        id: full.id,
        thread_id: full.thread_id,
        subject: full.subject,
        preview: full.preview,
        labels: full.labels,
        direction: full.direction,
        from: full.from,
        to: full.to,
        received_at: full.received_at,
        created_at: full.created_at,
      });
    }
  }

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new LocalMailTimeoutError(inboxId, since)), timeoutMs);
  });

  try {
    return await Promise.race([resultPromise, timeout]);
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    stopPolling();
    wsHandle?.close();
    options.signal?.removeEventListener('abort', onAbort);
  }
}
