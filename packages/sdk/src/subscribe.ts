import WebSocket from 'ws';

import type { LocalMailTransport } from './client.js';

export interface LocalMailEvent {
  id: string;
  type: string;
  created_at: string;
  pod_id: string;
  data: Record<string, unknown>;
}

export interface SubscribeOptions {
  inboxIds?: string[];
  eventTypes?: string[];
  signal?: AbortSignal;
  /** Milliseconds to wait for the `subscribed` ack. Default 3000 (§3.4 step 1). */
  ackTimeoutMs?: number;
}

/**
 * Opens `/v1/ws`, sends the `subscribe` frame, and yields events as they
 * arrive. §3.4: callers should treat a WS failure as "go to polling-only
 * mode", not a hard error — `waitForEmail` does this by racing this against
 * its reconcile poll.
 */
export function subscribe(
  transport: LocalMailTransport,
  options: SubscribeOptions = {},
): Promise<{
  events: AsyncIterableIterator<LocalMailEvent>;
  close: () => void;
  ready: Promise<void>;
}> {
  const wsUrl = new URL('/v1/ws', transport.baseUrl.replace(/^http/, 'ws'));
  const socket = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${transport.apiKey}` },
  });

  const queue: LocalMailEvent[] = [];
  const waiters: Array<(value: IteratorResult<LocalMailEvent>) => void> = [];
  let closed = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function push(event: LocalMailEvent): void {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  }

  function finish(): void {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined, done: true });
    }
  }

  socket.on('open', () => {
    socket.send(
      JSON.stringify({
        type: 'subscribe',
        inbox_ids: options.inboxIds,
        event_types: options.eventTypes,
      }),
    );
  });

  socket.on('message', (raw) => {
    const text = Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : Buffer.from(raw).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const message = parsed as { type?: string; event?: LocalMailEvent };
    if (message.type === 'subscribed') {
      readyResolve();
    } else if (message.type === 'event' && message.event) {
      push(message.event);
    }
  });

  socket.on('close', finish);
  socket.on('error', (error: Error) => {
    readyReject(error);
    finish();
  });

  options.signal?.addEventListener('abort', () => socket.close());

  const ackTimeoutMs = options.ackTimeoutMs ?? 3000;
  const ackTimer = setTimeout(
    () => readyReject(new Error('Timed out waiting for the WS subscribe ack.')),
    ackTimeoutMs,
  );
  ready.finally(() => clearTimeout(ackTimer)).catch(() => undefined);

  const events: AsyncIterableIterator<LocalMailEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<LocalMailEvent>> {
      const queued = queue.shift();
      if (queued) return Promise.resolve({ value: queued, done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };

  return Promise.resolve({
    events,
    close: () => socket.close(),
    ready,
  });
}
