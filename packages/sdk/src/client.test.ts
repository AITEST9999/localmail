import { describe, expect, it, vi } from 'vitest';

import { LocalMail } from './index.js';
import { LocalMailError } from './errors.js';

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function errorBody(code: string, message = code) {
  return { error: { code, message } };
}

describe('LocalMail client — retry policy (§3.3)', () => {
  it('never retries a POST without an idempotencyKey', async () => {
    const fetchImpl = vi.fn(() => jsonResponse(503, errorBody('rate_limited')));
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    await expect(client.inboxes.create({ username: 'a' })).rejects.toThrow(LocalMailError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a mutating call on 503 when given an idempotencyKey', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls += 1;
      if (calls < 2) return jsonResponse(503, errorBody('rate_limited'));
      return jsonResponse(201, {
        id: 'inb_1',
        address: 'a@localmail.test',
        username: 'a',
        domain: 'localmail.test',
        display_name: null,
        metadata: {},
        client_id: null,
        created_at: '2026-09-23T00:00:00.000Z',
      });
    });
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    const inbox = await client.inboxes.create({ username: 'a' }, { idempotencyKey: 'key-1' });
    expect(inbox.id).toBe('inb_1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never retries a 409 (idempotency_key_reused is a caller bug)', async () => {
    const fetchImpl = vi.fn(() => jsonResponse(409, errorBody('idempotency_key_reused')));
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    await expect(
      client.inboxes.create({ username: 'a' }, { idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a GET on 502', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls += 1;
      if (calls < 2) return jsonResponse(502, errorBody('http_error'));
      return jsonResponse(200, { data: [], next_page_token: null });
    });
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    const page = await client.inboxes.list();
    expect(page.data).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('LocalMail client — config', () => {
  it('throws LocalMailConfigError when no API key is configured', () => {
    const previous = process.env.LOCALMAIL_API_KEY;
    delete process.env.LOCALMAIL_API_KEY;
    try {
      expect(() => new LocalMail({ baseUrl: 'http://test.local' })).toThrow(
        /LocalMail API key/,
      );
    } finally {
      if (previous !== undefined) process.env.LOCALMAIL_API_KEY = previous;
    }
  });
});

describe('messages.send — multipart shape (§3 DoD 3)', () => {
  it('sends FormData with a payload field and attachment parts when attachments are present', async () => {
    let capturedBody: FormData | undefined;
    const fetchImpl = vi.fn((input: Request | URL | string, init?: RequestInit) => {
      capturedBody = init?.body as FormData;
      return jsonResponse(201, {
        id: 'msg_1',
        inbox_id: 'inb_1',
        thread_id: 'thr_1',
        message_id: '<msg_1@example.com>',
        in_reply_to: null,
        references: [],
        direction: 'outbound',
        from: 'a@localmail.test',
        to: ['b@example.com'],
        cc: [],
        bcc: [],
        subject: 'hi',
        text: 'hi',
        html: null,
        extracted_text: null,
        preview: 'hi',
        labels: [],
        size_bytes: 10,
        sent_at: '2026-09-23T00:00:00.000Z',
        received_at: null,
        created_at: '2026-09-23T00:00:00.000Z',
      });
    });
    const client = new LocalMail({ baseUrl: 'http://test.local', apiKey: 'lm_admin_x', fetch: fetchImpl });

    await client.messages.send('inb_1', {
      to: ['b@example.com'],
      subject: 'hi',
      text: 'hi',
      attachments: [{ filename: 'a.txt', content: new TextEncoder().encode('hello'), contentType: 'text/plain' }],
    });

    expect(capturedBody).toBeInstanceOf(FormData);
    const payloadField = capturedBody?.get('payload');
    expect(typeof payloadField).toBe('string');
    const parsedPayload = JSON.parse(payloadField as string) as { to: string[]; subject: string };
    expect(parsedPayload).toMatchObject({ to: ['b@example.com'], subject: 'hi' });
    const file = capturedBody?.get('attachments');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('a.txt');
  });
});
