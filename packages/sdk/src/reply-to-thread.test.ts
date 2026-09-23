import { describe, expect, it, vi } from 'vitest';

import { LocalMail } from './index.js';

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function summary(id: string, direction: 'inbound' | 'outbound') {
  return {
    id,
    thread_id: 'thr_1',
    subject: 'hi',
    preview: 'hi',
    labels: [],
    direction,
    from: 'someone@example.com',
    to: ['inbox@localmail.test'],
    received_at: '2026-09-23T00:00:00.000Z',
    created_at: '2026-09-23T00:00:00.000Z',
  };
}

function message(id: string) {
  return {
    id,
    inbox_id: 'inb_1',
    thread_id: 'thr_1',
    message_id: `<${id}@example.com>`,
    in_reply_to: null,
    references: [],
    direction: 'outbound',
    from: 'inbox@localmail.test',
    to: ['someone@example.com'],
    cc: [],
    bcc: [],
    subject: 'Re: hi',
    text: 'reply',
    html: null,
    extracted_text: null,
    preview: 'reply',
    labels: [],
    size_bytes: 5,
    sent_at: '2026-09-23T00:00:01.000Z',
    received_at: null,
    created_at: '2026-09-23T00:00:01.000Z',
  };
}

describe('replyToThread (§3.5)', () => {
  it('picks the last inbound message in the thread', async () => {
    const fetchImpl = vi.fn((input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/threads/thr_1')) {
        return jsonResponse(200, {
          thread: { id: 'thr_1', subject_normalized: 'hi', last_message_at: '2026-09-23T00:00:00.000Z', message_count: 3, labels: [], preview: 'hi' },
          messages: [summary('msg_1', 'inbound'), summary('msg_2', 'outbound'), summary('msg_3', 'inbound')],
        });
      }
      if (url.includes('/messages/msg_3/reply')) return jsonResponse(201, message('msg_reply'));
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    const reply = await client.replyToThread('inb_1', 'thr_1', { text: 'reply' });
    expect(reply.id).toBe('msg_reply');
  });

  it('falls back to the last message of any direction when no inbound exists', async () => {
    const fetchImpl = vi.fn((input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/threads/thr_1')) {
        return jsonResponse(200, {
          thread: { id: 'thr_1', subject_normalized: 'hi', last_message_at: '2026-09-23T00:00:00.000Z', message_count: 2, labels: [], preview: 'hi' },
          messages: [summary('msg_1', 'outbound'), summary('msg_2', 'outbound')],
        });
      }
      if (url.includes('/messages/msg_2/reply')) return jsonResponse(201, message('msg_reply'));
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    const reply = await client.replyToThread('inb_1', 'thr_1', { text: 'reply' });
    expect(reply.id).toBe('msg_reply');
  });

  it('404s on an unknown thread', async () => {
    const fetchImpl = vi.fn(() =>
      jsonResponse(404, { error: { code: 'not_found', message: 'The requested thread was not found.' } }),
    );
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    await expect(client.replyToThread('inb_1', 'thr_missing', { text: 'x' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
