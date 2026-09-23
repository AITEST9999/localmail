import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

import { LocalMail } from './index.js';
import { LocalMailTimeoutError } from './errors.js';

interface FakeMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  subject: string;
  labels: string[];
  received_at: string;
}

function summaryOf(m: FakeMessage) {
  return {
    id: m.id,
    thread_id: 'thr_1',
    subject: m.subject,
    preview: m.subject,
    labels: m.labels,
    direction: m.direction,
    from: m.from,
    to: ['inbox@localmail.test'],
    received_at: m.received_at,
    created_at: m.received_at,
  };
}

function fullOf(m: FakeMessage) {
  return {
    id: m.id,
    inbox_id: 'inb_1',
    thread_id: 'thr_1',
    message_id: `<${m.id}@example.com>`,
    in_reply_to: null,
    references: [],
    direction: m.direction,
    from: m.from,
    to: ['inbox@localmail.test'],
    cc: [],
    bcc: [],
    subject: m.subject,
    text: 'body',
    html: null,
    extracted_text: 'body',
    preview: m.subject,
    labels: m.labels,
    size_bytes: 4,
    sent_at: null,
    received_at: m.received_at,
    created_at: m.received_at,
  };
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/** Fake API: GET list/get against an in-memory message store, driven by URL matching. */
function makeFetch(store: FakeMessage[]) {
  return vi.fn((input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const getMatch = /\/v1\/inboxes\/[^/]+\/messages\/([^/]+)$/.exec(url.pathname);
    if (getMatch) {
      const message = store.find((m) => m.id === getMatch[1]);
      if (!message) return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
      return jsonResponse(200, fullOf(message));
    }
    if (url.pathname.endsWith('/messages')) {
      const direction = url.searchParams.get('direction');
      const data = store
        .filter((m) => !direction || m.direction === direction)
        .map(summaryOf);
      return jsonResponse(200, { data, next_page_token: null });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  });
}

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A minimal /v1/ws double: acks `subscribe`, and lets the test push events. */
function startFakeWsServer(): { port: number; broadcast: (event: unknown) => void } {
  const server = new WebSocketServer({ port: 0, path: '/v1/ws' });
  servers.push(server);
  const sockets: WsSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
      const parsed = JSON.parse(text) as { type: string; inbox_ids?: string[]; event_types?: string[] };
      if (parsed.type === 'subscribe') {
        socket.send(
          JSON.stringify({ type: 'subscribed', inbox_ids: parsed.inbox_ids ?? null, event_types: parsed.event_types ?? null }),
        );
      }
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    broadcast: (event: unknown) => {
      for (const socket of sockets) socket.send(JSON.stringify({ type: 'event', event }));
    },
  };
}

describe('waitForEmail (§3.4 race matrix)', () => {
  it('catch-up finds a message that arrived before subscribe', async () => {
    const { port } = startFakeWsServer();
    const store: FakeMessage[] = [
      { id: 'msg_1', direction: 'inbound', from: 'customer@example.com', subject: 'hi', labels: [], received_at: '2026-09-23T12:00:01.000Z' },
    ];
    const client = new LocalMail({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'lm_admin_x', fetch: makeFetch(store) });

    const found = await client.waitForEmail('inb_1', {
      from: 'customer@example.com',
      since: new Date('2026-09-23T12:00:00.000Z'),
      timeoutMs: 4000,
      pollIntervalMs: 200,
    });
    expect(found.id).toBe('msg_1');
  });

  it('resolves via the WS message.received path for mail that arrives after subscribe', async () => {
    const { port, broadcast } = startFakeWsServer();
    const store: FakeMessage[] = [];
    const client = new LocalMail({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'lm_admin_x', fetch: makeFetch(store) });

    const waitPromise = client.waitForEmail('inb_1', {
      from: 'customer@example.com',
      since: new Date('2026-09-23T12:00:00.000Z'),
      timeoutMs: 5000,
      pollIntervalMs: 10_000,
    });

    setTimeout(() => {
      const message: FakeMessage = {
        id: 'msg_2',
        direction: 'inbound',
        from: 'customer@example.com',
        subject: 'hi again',
        labels: [],
        received_at: '2026-09-23T12:00:02.000Z',
      };
      store.push(message);
      broadcast({ id: 'evt_1', type: 'message.received', created_at: message.received_at, pod_id: 'pod_test', data: { message_id: 'msg_2', inbox_id: 'inb_1' } });
    }, 100);

    const found = await waitPromise;
    expect(found.id).toBe('msg_2');
  });

  it('ignores an outbound message from the sender inbox itself', async () => {
    const { port } = startFakeWsServer();
    const store: FakeMessage[] = [
      { id: 'msg_out', direction: 'outbound', from: 'inbox@localmail.test', subject: 'sent', labels: [], received_at: '2026-09-23T12:00:01.000Z' },
      { id: 'msg_in', direction: 'inbound', from: 'customer@example.com', subject: 'hi', labels: [], received_at: '2026-09-23T12:00:02.000Z' },
    ];
    const client = new LocalMail({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'lm_admin_x', fetch: makeFetch(store) });

    const found = await client.waitForEmail('inb_1', {
      since: new Date('2026-09-23T12:00:00.000Z'),
      timeoutMs: 4000,
      pollIntervalMs: 200,
    });
    expect(found.id).toBe('msg_in');
  });

  it('resolves labels:[\'otp\'] on the message.labeled event', async () => {
    const { port, broadcast } = startFakeWsServer();
    const store: FakeMessage[] = [
      { id: 'msg_otp', direction: 'inbound', from: 'noreply@example.com', subject: 'code', labels: [], received_at: '2026-09-23T12:00:01.000Z' },
    ];
    const client = new LocalMail({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'lm_admin_x', fetch: makeFetch(store) });

    const waitPromise = client.waitForEmail('inb_1', {
      labels: ['otp'],
      since: new Date('2026-09-23T12:00:00.000Z'),
      timeoutMs: 5000,
      pollIntervalMs: 10_000,
    });

    setTimeout(() => {
      const message = store.find((m) => m.id === 'msg_otp')!;
      message.labels = ['otp'];
      broadcast({ id: 'evt_2', type: 'message.labeled', created_at: message.received_at, pod_id: 'pod_test', data: { message_id: 'msg_otp', inbox_id: 'inb_1', labels: ['otp'] } });
    }, 150);

    const found = await waitPromise;
    expect(found.id).toBe('msg_otp');
    expect(found.labels).toContain('otp');
  });

  it('falls back to polling-only when the WS connection is refused', async () => {
    const store: FakeMessage[] = [
      { id: 'msg_poll', direction: 'inbound', from: 'customer@example.com', subject: 'hi', labels: [], received_at: '2026-09-23T12:00:01.000Z' },
    ];
    // Port 1 is never listening — the WS ack times out quickly and waitForEmail
    // should still resolve through the reconcile poll.
    const client = new LocalMail({
      baseUrl: 'http://127.0.0.1:65500',
      apiKey: 'lm_admin_x',
      fetch: makeFetch(store),
    });

    const found = await client.waitForEmail('inb_1', {
      since: new Date('2026-09-23T12:00:00.000Z'),
      timeoutMs: 4000,
      pollIntervalMs: 200,
    });
    expect(found.id).toBe('msg_poll');
  });

  it('rejects LocalMailTimeoutError on timeout and leaves no open handles', async () => {
    const { port } = startFakeWsServer();
    const client = new LocalMail({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'lm_admin_x', fetch: makeFetch([]) });

    await expect(
      client.waitForEmail('inb_1', {
        since: new Date('2026-09-23T12:00:00.000Z'),
        timeoutMs: 500,
        pollIntervalMs: 100,
      }),
    ).rejects.toBeInstanceOf(LocalMailTimeoutError);
  });
});
