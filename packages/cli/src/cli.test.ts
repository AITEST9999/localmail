/* eslint-disable @typescript-eslint/require-await -- fake sdk methods intentionally resolve synchronously */
import { describe, expect, it } from 'vitest';

import { LocalMailError, LocalMailTimeoutError, type Inbox, type LocalMailEvent, type Message, type MessageSummary, type Thread } from '@localmail/sdk';

import type { CliSdk } from './cli-sdk.js';
import type { CliDeps, CliOutput } from './cli.js';
import { runCli } from './cli.js';

const INBOX: Inbox = {
  id: 'inb_1',
  address: 'agent@localmail.test',
  username: 'agent',
  domain: 'localmail.test',
  display_name: null,
  client_id: null,
  metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
};

const THREAD: Thread = {
  id: 'thr_1',
  labels: ['inbox'],
  last_message_at: '2026-01-01T00:00:00.000Z',
  message_count: 1,
  preview: 'hi there',
  subject_normalized: 'hi',
};

const SUMMARY: MessageSummary = {
  id: 'msg_1',
  thread_id: 'thr_1',
  subject: 'Hi',
  preview: 'hi there',
  labels: ['inbox'],
  direction: 'inbound',
  from: 'customer@example.com',
  to: [INBOX.address],
  received_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
};

function makeMessage(overrides: Partial<Message> = {}): Message {
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
    subject: 'Hi',
    preview: 'hi there',
    text: 'hi there',
    html: '<p>hi there</p>',
    extracted_text: 'hi there',
    labels: ['inbox'],
    in_reply_to: null,
    references: [],
    size_bytes: 64,
    received_at: '2026-01-01T00:00:00.000Z',
    sent_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createSink(): CliOutput & { text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    text: () => chunks.join(''),
  };
}

function createFakeSdk(overrides: Partial<CliSdk> = {}): CliSdk {
  const base: CliSdk = {
    inboxes: {
      create: async (input) => ({ ...INBOX, ...input, id: 'inb_new' }),
      list: async () => ({ data: [INBOX], next_page_token: null }),
      resolve: async (idOrAddress) => {
        if (idOrAddress === 'inb_missing') {
          throw new LocalMailError({ status: 404, code: 'not_found', message: 'Inbox not found.' });
        }
        return INBOX;
      },
    },
    threads: {
      list: async () => ({ data: [THREAD], next_page_token: null }),
      get: async () => ({ thread: THREAD, messages: [SUMMARY] }),
    },
    messages: {
      send: async (inboxId, input) =>
        makeMessage({ id: 'msg_sent', thread_id: 'thr_sent', direction: 'outbound', to: input.to, subject: input.subject }),
      reply: async () => makeMessage({ id: 'msg_reply', direction: 'outbound' }),
    },
    subscribe: async () => {
      const events: LocalMailEvent[] = [
        { id: 'evt_1', type: 'message.received', created_at: '2026-01-01T00:00:00.000Z', pod_id: 'pod_1', data: { message_id: 'msg_1' } },
      ];
      let index = 0;
      const iterator: AsyncIterableIterator<LocalMailEvent> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: async () => {
          if (index < events.length) return { value: events[index++]!, done: false };
          return { value: undefined, done: true };
        },
      };
      return { events: iterator, close: () => undefined, ready: Promise.resolve() };
    },
    waitForEmail: async (inboxId, options) => {
      if (options.from === 'nope@example.com') {
        throw new LocalMailTimeoutError(inboxId, new Date('2026-01-01T00:00:00.000Z'));
      }
      return makeMessage();
    },
  };
  return { ...base, ...overrides };
}

function createDeps(sdk: CliSdk, env: Record<string, string | undefined> = {}) {
  const stdout = createSink();
  const stderr = createSink();
  const deps: CliDeps = {
    sdkFactory: () => sdk,
    stdout,
    stderr,
    env: { LOCALMAIL_API_KEY: 'test-key', ...env },
  };
  return { deps, stdout, stderr };
}

describe('localmail CLI', () => {
  it('inbox create --json prints the created inbox and exits 0', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout, stderr } = createDeps(sdk);
    const code = await runCli(['--json', 'inbox', 'create', '--client-id', 'signup-1'], deps);
    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
    expect(JSON.parse(stdout.text())).toMatchObject({ id: 'inb_new', client_id: 'signup-1' });
  });

  it('inbox create human output', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['inbox', 'create'], deps);
    expect(code).toBe(0);
    expect(stdout.text()).toContain('Created inbox inb_new');
  });

  it('inbox list --json', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['--json', 'inbox', 'list'], deps);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual([INBOX]);
  });

  it('send requires at least one --to (usage error, exit 2)', async () => {
    const sdk = createFakeSdk();
    const { deps, stderr } = createDeps(sdk);
    const code = await runCli(['send', INBOX.id, '--subject', 'Hi', '--text', 'hi'], deps);
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/At least one --to is required/);
  });

  it('send requires text, html, or text-file (usage error, exit 2)', async () => {
    const sdk = createFakeSdk();
    const { deps, stderr } = createDeps(sdk);
    const code = await runCli(['send', INBOX.id, '--subject', 'Hi', '--to', 'a@b.com'], deps);
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/Provide --text, --html, or --text-file/);
  });

  it('send succeeds and prints id/thread_id as JSON', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(
      ['--json', 'send', INBOX.id, '--subject', 'Hi', '--to', 'a@b.com', '--to', 'c@d.com', '--text', 'hello'],
      deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({ id: 'msg_sent', thread_id: 'thr_sent' });
  });

  it('send with a missing subject is a commander usage error (exit 2)', async () => {
    const sdk = createFakeSdk();
    const { deps } = createDeps(sdk);
    const code = await runCli(['send', INBOX.id, '--to', 'a@b.com', '--text', 'hi'], deps);
    expect(code).toBe(2);
  });

  it('reply requires text or html (usage error, exit 2)', async () => {
    const sdk = createFakeSdk();
    const { deps, stderr } = createDeps(sdk);
    const code = await runCli(['reply', INBOX.id, 'msg_1'], deps);
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/Provide --text or --html/);
  });

  it('reply succeeds', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['--json', 'reply', INBOX.id, 'msg_1', '--text', 'thanks', '--all'], deps);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({ id: 'msg_reply', thread_id: 'thr_1' });
  });

  it('threads lists threads for an inbox', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['--json', 'threads', INBOX.id], deps);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual([THREAD]);
  });

  it('threads <inbox> <threadId> shows one thread', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['--json', 'threads', INBOX.id, THREAD.id], deps);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({ thread: THREAD, messages: [SUMMARY] });
  });

  it('tail streams NDJSON and exits 0 when the socket closes', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout, stderr } = createDeps(sdk);
    const code = await runCli(['--json', 'tail', INBOX.id], deps);
    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
    const lines = stdout.text().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'message.received' });
  });

  it('tail human output formats events', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['tail', INBOX.id], deps);
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/message\.received id=msg_1/);
  });

  it('wait resolves and exits 0 on a found message', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['--json', 'wait', INBOX.id, '--timeout', '5'], deps);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ status: 'found' });
  });

  it('wait exits 1 on a clean timeout, not a crash', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout, stderr } = createDeps(sdk);
    const code = await runCli(['--json', 'wait', INBOX.id, '--from', 'nope@example.com', '--timeout', '1'], deps);
    expect(code).toBe(1);
    expect(stderr.text()).toBe('');
    expect(JSON.parse(stdout.text())).toEqual({ status: 'timeout' });
  });

  it('a missing API key is a usage error (exit 2), not a crash', async () => {
    const sdk = createFakeSdk();
    const { deps, stderr } = createDeps(sdk, { LOCALMAIL_API_KEY: undefined });
    const code = await runCli(['inbox', 'list'], deps);
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/Missing API key/);
  });

  it('an SDK error prints code: message to stderr and exits 1', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout, stderr } = createDeps(sdk);
    const code = await runCli(['threads', 'inb_missing'], deps);
    expect(code).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('not_found: Inbox not found.\n');
  });

  it('--help exits 0 and writes to stdout', async () => {
    const sdk = createFakeSdk();
    const { deps, stdout } = createDeps(sdk);
    const code = await runCli(['--help'], deps);
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/Usage: localmail/);
  });

  it('never prints the API key, even in --json output or error output (sentinel)', async () => {
    const sentinel = 'SENTINEL_TOKEN_DO_NOT_LEAK_9f3a';
    const sdk = createFakeSdk();
    const { deps, stdout, stderr } = createDeps(sdk, { LOCALMAIL_API_KEY: sentinel });

    const okCode = await runCli(['--json', 'inbox', 'create'], deps);
    expect(okCode).toBe(0);

    const errCode = await runCli(['--json', 'threads', 'inb_missing'], deps);
    expect(errCode).toBe(1);

    expect(stdout.text()).not.toContain(sentinel);
    expect(stderr.text()).not.toContain(sentinel);
  });
});
