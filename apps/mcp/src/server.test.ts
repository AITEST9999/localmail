/* eslint-disable @typescript-eslint/require-await -- fake client methods intentionally resolve synchronously */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { LocalMailError, LocalMailTimeoutError, type Inbox, type Message, type Thread } from '@localmail/sdk';

import type { LocalMailClient } from './local-mail-client.js';
import { createServer } from './server.js';

const INBOX: Inbox = {
  id: 'inb_1',
  address: 'agent@localmail.test',
  username: 'agent',
  domain: 'localmail.test',
  display_name: null,
  client_id: null,
  metadata: {},
  created_at: '2026-09-23T00:00:00.000Z',
};

const BIG_TEXT = 'x'.repeat(25_000);

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg_1',
    inbox_id: INBOX.id,
    thread_id: 'thr_1',
    message_id: '<msg_1@localmail.test>',
    direction: 'inbound',
    from: 'customer@example.com',
    to: [INBOX.address],
    cc: [],
    bcc: [],
    subject: 'Hello',
    preview: 'hello world',
    text: 'hello world',
    html: '<p>hello world</p>',
    extracted_text: 'hello world',
    labels: ['inbox', 'unread'],
    in_reply_to: null,
    references: [],
    size_bytes: 128,
    received_at: '2026-09-23T00:00:00.000Z',
    sent_at: null,
    created_at: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

const THREAD: Thread = {
  id: 'thr_1',
  labels: ['inbox', 'unread'],
  last_message_at: '2026-09-23T00:00:00.000Z',
  message_count: 1,
  preview: 'hello world',
  subject_normalized: 'hello',
};

function createFakeClient(): { client: LocalMailClient; messages: Map<string, Message> } {
  const messages = new Map<string, Message>([
    ['msg_1', makeMessage({ id: 'msg_1', text: BIG_TEXT, extracted_text: BIG_TEXT })],
  ]);

  const client: LocalMailClient = {
    inboxes: {
      create: async (input) => ({ ...INBOX, ...input, id: 'inb_new' }),
      resolve: async (idOrAddress) => {
        if (idOrAddress === INBOX.id || idOrAddress === INBOX.address) return INBOX;
        throw new LocalMailError({ status: 404, code: 'not_found', message: `No inbox ${idOrAddress}` });
      },
    },
    threads: {
      get: async (_inboxId, threadId) => {
        if (threadId !== THREAD.id) {
          throw new LocalMailError({ status: 404, code: 'not_found', message: 'Thread not found' });
        }
        const summaries = [...messages.values()]
          .filter((message) => message.thread_id === threadId)
          .map((message) => ({
            id: message.id,
            thread_id: message.thread_id,
            subject: message.subject,
            preview: message.preview,
            labels: message.labels,
            direction: message.direction,
            from: message.from,
            to: message.to,
            received_at: message.received_at,
            created_at: message.created_at,
          }));
        return { thread: THREAD, messages: summaries };
      },
      list: async () => ({ data: [THREAD], next_page_token: null }),
    },
    messages: {
      get: async (_inboxId, messageId) => {
        const message = messages.get(messageId);
        if (!message) throw new LocalMailError({ status: 404, code: 'not_found', message: 'Message not found' });
        return message;
      },
      send: async (_inboxId, input) =>
        makeMessage({
          id: 'msg_sent',
          thread_id: 'thr_sent',
          direction: 'outbound',
          from: INBOX.address,
          to: input.to,
          subject: input.subject,
          text: input.text ?? null,
          html: input.html ?? null,
        }),
      reply: async (_inboxId, messageId, input) =>
        makeMessage({
          id: 'msg_reply',
          thread_id: messages.get(messageId)?.thread_id ?? 'thr_1',
          direction: 'outbound',
          text: input.text ?? null,
        }),
      updateLabels: async (_inboxId, messageId, updates) => {
        const message = messages.get(messageId);
        if (!message) throw new LocalMailError({ status: 404, code: 'not_found', message: 'Message not found' });
        const labels = new Set(message.labels);
        for (const label of updates.add ?? []) labels.add(label);
        for (const label of updates.remove ?? []) labels.delete(label);
        const updated = { ...message, labels: [...labels] };
        messages.set(messageId, updated);
        return updated;
      },
    },
    waitForEmail: async (inboxId, options) => {
      if (options.from === 'never-matches@example.com') {
        throw new LocalMailTimeoutError(inboxId, options.since ?? new Date('2026-09-23T00:00:00.000Z'));
      }
      return messages.get('msg_1')!;
    },
    replyToThread: async (_inboxId, threadId, input) =>
      makeMessage({ id: 'msg_thread_reply', thread_id: threadId, direction: 'outbound', text: input.text ?? null }),
  };

  return { client, messages };
}

async function connect(client: LocalMailClient): Promise<Client> {
  const server = createServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  const first = content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text content block');
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('localmail-mcp server', () => {
  it('lists exactly the 7 tools with object-typed JSON-schema inputs', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const { tools } = await mcpClient.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['add_label', 'create_inbox', 'get_thread', 'list_threads', 'reply', 'send_message', 'wait_for_email'].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('create_inbox returns the created inbox', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({ name: 'create_inbox', arguments: { client_id: 'sig-up-1' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchObject({ id: 'inb_new', client_id: 'sig-up-1' });
  });

  it('list_threads wraps subject/preview content as untrusted', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({ name: 'list_threads', arguments: { inbox: INBOX.id } });
    expect(result.isError).toBeFalsy();
    const body = textOf(result) as { untrusted_email_content: { threads: Array<Record<string, unknown>> } };
    expect(body.untrusted_email_content.threads[0]).toMatchObject({ id: THREAD.id, preview: 'hello world' });
  });

  it('get_thread truncates message text at 20k chars, flags it, and drops html', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'get_thread',
      arguments: { inbox: INBOX.address, thread_id: THREAD.id },
    });
    expect(result.isError).toBeFalsy();
    const body = textOf(result) as {
      untrusted_email_content: { messages: Array<Record<string, unknown>> };
    };
    const [message] = body.untrusted_email_content.messages;
    expect(message).toBeDefined();
    expect(message!.text_truncated).toBe(true);
    expect((message!.text as string).length).toBe(20_000);
    expect(message!.extracted_text_truncated).toBe(true);
    expect('html' in message!).toBe(false);
  });

  it('send_message returns only id/thread_id, no untrusted wrapper needed for own content', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'send_message',
      arguments: { inbox: INBOX.id, to: ['dest@example.com'], subject: 'Hi', text: 'hello' },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toEqual({ id: 'msg_sent', thread_id: 'thr_sent' });
  });

  it('reply accepts message_id', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'reply',
      arguments: { inbox: INBOX.id, message_id: 'msg_1', text: 'thanks' },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toEqual({ id: 'msg_reply', thread_id: 'thr_1' });
  });

  it('reply accepts thread_id via replyToThread', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'reply',
      arguments: { inbox: INBOX.id, thread_id: THREAD.id, text: 'thanks' },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toEqual({ id: 'msg_thread_reply', thread_id: THREAD.id });
  });

  it('reply rejects both message_id and thread_id together as a tool input error', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'reply',
      arguments: { inbox: INBOX.id, message_id: 'msg_1', thread_id: THREAD.id, text: 'x' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/exactly one of message_id or thread_id/);
  });

  it('reply rejects neither message_id nor thread_id as a tool input error', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({ name: 'reply', arguments: { inbox: INBOX.id, text: 'x' } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/exactly one of message_id or thread_id/);
  });

  it('add_label adds and removes labels', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'add_label',
      arguments: { inbox: INBOX.id, message_id: 'msg_1', add: ['triaged'], remove: ['unread'] },
    });
    expect(result.isError).toBeFalsy();
    const body = textOf(result) as { labels: string[] };
    expect(body.labels).toEqual(expect.arrayContaining(['inbox', 'triaged']));
    expect(body.labels).not.toContain('unread');
  });

  it('wait_for_email returns a found result wrapped as untrusted content', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'wait_for_email',
      arguments: { inbox: INBOX.id, timeout_seconds: 5 },
    });
    expect(result.isError).toBeFalsy();
    const body = textOf(result) as { status: string; untrusted_email_content: Record<string, unknown> };
    expect(body.status).toBe('found');
    expect(body.untrusted_email_content.id).toBe('msg_1');
    expect(body.untrusted_email_content.text_truncated).toBe(true);
  });

  it('wait_for_email returns a normal timeout result, not a tool error', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'wait_for_email',
      arguments: { inbox: INBOX.id, from: 'never-matches@example.com', timeout_seconds: 1 },
    });
    expect(result.isError).toBeFalsy();
    const body = textOf(result) as { status: string; since: string };
    expect(body.status).toBe('timeout');
    expect(typeof body.since).toBe('string');
  });

  it('an SDK error surfaces as isError:true with code: message', async () => {
    const { client } = createFakeClient();
    const mcpClient = await connect(client);
    const result = await mcpClient.callTool({
      name: 'list_threads',
      arguments: { inbox: 'inb_does_not_exist' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/^not_found:/);
  });
});
